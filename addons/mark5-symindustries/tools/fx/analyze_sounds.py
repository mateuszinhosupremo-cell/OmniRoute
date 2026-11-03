#!/usr/bin/env python3
"""Decode the shipped OGGs and produce objective checks + a spectrogram sheet.

Writes dist/fx_sounds_spectrograms.png and prints per-file metrics:
duration, peak dBFS, RMS dBFS, DC offset, edge sample levels, spectral centroid,
and for loop sounds the RMS ripple when retriggered every 0.9 s (script cadence).
"""
import os
import subprocess
import sys

import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from gen_sounds import EXPECTED_DUR, SND_DIR, SR  # noqa: E402

B = os.path.abspath(os.path.join(HERE, "..", ".."))


def decode(path):
    raw = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", path, "-f", "f32le", "-ac", "1",
                          "-ar", str(SR), "-"], check=True, capture_output=True).stdout
    return np.frombuffer(raw, dtype="<f4").astype(np.float64)


def db(v):
    return 20 * np.log10(max(v, 1e-9))


def spectrogram(x, nfft=1024, hop=256):
    win = np.hanning(nfft)
    if len(x) < nfft:
        x = np.pad(x, (0, nfft - len(x)))
    frames = 1 + (len(x) - nfft) // hop
    S = np.stack([np.abs(np.fft.rfft(x[i * hop:i * hop + nfft] * win)) for i in range(frames)], 1)
    return 20 * np.log10(S + 1e-7)


def _rms_db(seg):
    w = int(0.01 * SR)
    rms = np.sqrt(np.convolve(seg ** 2, np.ones(w) / w, mode="valid"))
    return 20 * np.log10(rms + 1e-9)


def loop_ripple(x, period=0.9, total=4.0):
    """(seam swell dB, seam dip dB, steady swell, steady dip): 10 ms RMS vs median, retriggered vs single."""
    P = int(period * SR)
    out = np.zeros(int(total * SR) + len(x))
    for k in range(int(total / period) + 1):
        out[k * P:k * P + len(x)] += x
    r = _rms_db(out[P:int(3 * P)])
    s = _rms_db(x[int(0.05 * SR):int(0.88 * SR)])
    return (float(r.max() - np.median(r)), float(np.median(r) - r.min()),
            float(s.max() - np.median(s)), float(np.median(s) - s.min()))


def main():
    names = list(EXPECTED_DUR)
    rows = []
    tiles = []
    for name in names:
        path = os.path.join(SND_DIR, f"{name}.ogg")
        x = decode(path)
        dur = len(x) / SR
        spec = np.abs(np.fft.rfft(x))
        freqs = np.fft.rfftfreq(len(x), 1 / SR)
        centroid = float((spec * freqs).sum() / (spec.sum() + 1e-9))
        info = dict(name=name, dur=dur, exp=EXPECTED_DUR[name], peak=db(np.max(np.abs(x))),
                    rms=db(np.sqrt(np.mean(x ** 2))), dc=float(np.mean(x)), head=float(np.max(np.abs(x[:16]))),
                    tail=float(np.max(np.abs(x[-16:]))), centroid=centroid, size=os.path.getsize(path))
        if name in ("thruster_loop", "thruster_boost"):
            info["ripple"] = loop_ripple(x)
        rows.append(info)
        S = spectrogram(x)
        S = np.clip((S - (S.max() - 80)) / 80, 0, 1)
        img = (S[::-1] * 255).astype(np.uint8)
        tile = Image.fromarray(img).resize((max(60, int(dur * 300)), 160), Image.BILINEAR).convert("RGB")
        arr = np.asarray(tile).astype(np.float64) / 255
        col = np.stack([arr[..., 0] ** 1.5, arr[..., 0] ** 0.9 * 0.9, arr[..., 0] ** 0.6], -1)
        tile = Image.fromarray((col * 255).astype(np.uint8))
        # waveform strip
        wv = Image.new("RGB", (tile.width, 50), (10, 10, 14))
        d = ImageDraw.Draw(wv)
        step = max(1, len(x) // tile.width)
        for i in range(tile.width):
            seg = x[i * step:(i + 1) * step]
            if len(seg):
                d.line([(i, 25 - seg.max() * 24), (i, 25 - seg.min() * 24)], fill=(120, 220, 255))
        t = Image.new("RGB", (tile.width, 230), (0, 0, 0))
        t.paste(tile, (0, 20))
        t.paste(wv, (0, 180))
        ImageDraw.Draw(t).text((3, 3), f"{name} {dur:.2f}s", fill=(255, 255, 255))
        tiles.append(t)
    # layout rows of max width 1500
    Wmax = 1500
    lines, cur, cw = [], [], 0
    for t in tiles:
        if cw + t.width + 8 > Wmax and cur:
            lines.append(cur)
            cur, cw = [], 0
        cur.append(t)
        cw += t.width + 8
    if cur:
        lines.append(cur)
    sheet = Image.new("RGB", (Wmax, len(lines) * 238), (25, 25, 30))
    for li, line in enumerate(lines):
        x0 = 0
        for t in line:
            sheet.paste(t, (x0, li * 238))
            x0 += t.width + 8
    out = os.path.join(B, "dist", "fx_sounds_spectrograms.png")
    sheet.save(out, optimize=True)
    total = 0
    for r in rows:
        total += r["size"]
        extra = (" loop +{:.1f}/-{:.1f} dB (single +{:.1f}/-{:.1f})".format(*r["ripple"])
                 if "ripple" in r else "")
        print(f"{r['name']:15s} {r['dur']:.3f}s (exp {r['exp']:.2f}) peak {r['peak']:+5.1f} rms {r['rms']:+5.1f} "
              f"dc {r['dc']:+.4f} edge {r['head']:.3f}/{r['tail']:.3f} cent {r['centroid']:6.0f}Hz {r['size']}B{extra}")
    print(f"total {total} B; sheet {os.path.relpath(out, B)}")


if __name__ == "__main__":
    main()
