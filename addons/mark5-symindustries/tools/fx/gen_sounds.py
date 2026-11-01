#!/usr/bin/env python3
"""Mark V FX — procedural sound synthesizer (numpy only, deterministic, idempotent).

Renders every sound of SPEC 2.5 to mono 44.1 kHz 16-bit WAV (temporary tools/fx/_build/),
encodes with ffmpeg libvorbis -q:a 5 into pack/Mark5_RP/sounds/sym/<name>.ogg and
merges the definitions into pack/Mark5_RP/sounds/sound_definitions.json (existing
entries are kept byte-for-byte equal as JSON values).

DSP building blocks are hand-written: phase-accumulating oscillators, RBJ biquads
(static or swept, coefficients updated every 32 samples), one-pole filters,
block-vectorised Schroeder reverb, envelopes, tanh saturation.
"""
import json
import math
import os
import shutil
import subprocess
import sys
import wave

import numpy as np

SR = 44100
HERE = os.path.dirname(os.path.abspath(__file__))
B = os.path.abspath(os.path.join(HERE, "..", ".."))
BUILD = os.path.join(HERE, "_build")
SND_DIR = os.path.join(B, "pack", "Mark5_RP", "sounds", "sym")
DEFS = os.path.join(B, "pack", "Mark5_RP", "sounds", "sound_definitions.json")


# ============================================================================ primitives
def T(dur):
    return np.arange(int(round(dur * SR))) / SR


def n_of(dur):
    return int(round(dur * SR))


def rng_for(name):
    return np.random.default_rng(abs(hash_str(name)) % (2 ** 32))


def hash_str(s):
    h = 2166136261
    for ch in s.encode():
        h = ((h ^ ch) * 16777619) & 0xFFFFFFFF
    return h


def phase(freq, n=None):
    """Phase (radians) of an oscillator with (possibly time-varying) frequency in Hz."""
    f = np.broadcast_to(np.asarray(freq, dtype=np.float64), (n,)) if n is not None else np.asarray(freq, float)
    return 2 * np.pi * np.cumsum(f) / SR


def sine(freq, n, ph0=0.0):
    return np.sin(phase(freq, n) + ph0)


def harm(freq, n, amps, ph0=0.0):
    """Additive oscillator: sum of harmonics (band-limited below Nyquist)."""
    f = np.broadcast_to(np.asarray(freq, dtype=np.float64), (n,))
    p = phase(f, n) + ph0
    out = np.zeros(n)
    for k, a in enumerate(amps, start=1):
        if a == 0:
            continue
        mask = (f * k) < SR * 0.45
        out += a * np.sin(k * p) * mask
    return out


def sweep_exp(f0, f1, n, curve=1.0):
    x = np.linspace(0, 1, n) ** curve
    return f0 * (f1 / f0) ** x


def env_lin(n, pts):
    """Piecewise-linear envelope from [(time_s, value), ...]."""
    ts = np.array([p[0] for p in pts]) * SR
    vs = np.array([p[1] for p in pts])
    return np.interp(np.arange(n), ts, vs)


def env_exp(n, tau, delay=0.0, attack=0.002):
    t = np.arange(n) / SR - delay
    e = np.where(t < 0, 0.0, np.exp(-np.maximum(t, 0) / tau))
    if attack > 0:
        e *= np.clip((t) / attack, 0, 1)
    return e


def fade(x, fin=0.004, fout=0.004, shape="cos"):
    x = x.copy()
    a, b = n_of(fin), n_of(fout)
    def curve(r):
        if shape == "cos":  # raised cosine (amplitude-complementary)
            return 0.5 - 0.5 * np.cos(np.pi * r)
        if shape == "eqp":  # quarter sine (equal-power for uncorrelated material)
            return np.sin(0.5 * np.pi * r)
        return r

    if a > 0:
        x[:a] *= curve(np.linspace(0, 1, a))
    if b > 0:
        x[-b:] *= curve(np.linspace(1, 0, b))
    return x


def place(dst, src, at):
    i = n_of(at)
    j = min(len(dst), i + len(src))
    if i < len(dst):
        dst[i:j] += src[: j - i]
    return dst


def sat(x, drive=1.5):
    return np.tanh(x * drive) / np.tanh(drive)


# ----------------------------------------------------------------------------- filters
def _biquad_coefs(kind, f, q, gain_db=0.0):
    f = min(max(f, 10.0), SR * 0.49)
    w0 = 2 * math.pi * f / SR
    cw, sw = math.cos(w0), math.sin(w0)
    alpha = sw / (2 * q)
    if kind == "lp":
        b0, b1, b2 = (1 - cw) / 2, 1 - cw, (1 - cw) / 2
        a0, a1, a2 = 1 + alpha, -2 * cw, 1 - alpha
    elif kind == "hp":
        b0, b1, b2 = (1 + cw) / 2, -(1 + cw), (1 + cw) / 2
        a0, a1, a2 = 1 + alpha, -2 * cw, 1 - alpha
    elif kind == "bp":  # constant 0 dB peak gain
        b0, b1, b2 = alpha, 0.0, -alpha
        a0, a1, a2 = 1 + alpha, -2 * cw, 1 - alpha
    elif kind == "peak":
        A = 10 ** (gain_db / 40)
        b0, b1, b2 = 1 + alpha * A, -2 * cw, 1 - alpha * A
        a0, a1, a2 = 1 + alpha / A, -2 * cw, 1 - alpha / A
    else:
        raise ValueError(kind)
    return b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0


def biquad(x, kind, freq, q=0.707, gain_db=0.0, block=32):
    """RBJ biquad; `freq` may be a scalar or an array (swept, updated every `block` samples)."""
    x = np.asarray(x, dtype=np.float64)
    n = len(x)
    y = np.empty(n)
    fr = np.broadcast_to(np.asarray(freq, dtype=np.float64), (n,))
    x1 = x2 = y1 = y2 = 0.0
    xs = x.tolist()
    out = [0.0] * n
    for s in range(0, n, block):
        b0, b1, b2, a1, a2 = _biquad_coefs(kind, float(fr[s]), q, gain_db)
        for i in range(s, min(n, s + block)):
            xi = xs[i]
            yi = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
            x2, x1 = x1, xi
            y2, y1 = y1, yi
            out[i] = yi
    y[:] = out
    return y


def onepole_lp(x, freq):
    a = 1 - math.exp(-2 * math.pi * freq / SR)
    out = np.empty(len(x))
    y = 0.0
    for i, v in enumerate(x.tolist()):
        y += a * (v - y)
        out[i] = y
    return out


def comb(x, delay_s, g):
    D = max(1, n_of(delay_s))
    y = np.zeros(len(x) + D)
    xp = np.concatenate([np.zeros(D), x])
    for k in range(D, len(y), D):
        e = min(len(y), k + D)
        y[k:e] = xp[k:e] + g * y[k - D:e - D]
    return y[D:]


def allpass(x, delay_s, g):
    D = max(1, n_of(delay_s))
    n = len(x)
    xp = np.concatenate([np.zeros(D), x])
    y = np.zeros(n + D)
    for k in range(D, n + D, D):
        e = min(n + D, k + D)
        y[k:e] = -g * xp[k:e] + xp[k - D:e - D] + g * y[k - D:e - D]
    return y[D:]


def reverb(x, mix=0.25, size=1.0, damp=4500.0, decay=0.78):
    """Small Schroeder reverb (4 combs + 2 allpasses), damped."""
    combs = [0.0297, 0.0371, 0.0411, 0.0437]
    wet = np.zeros(len(x))
    for i, d in enumerate(combs):
        wet += comb(x, d * size, decay - 0.02 * i)
    wet = allpass(wet, 0.005 * size, 0.7)
    wet = allpass(wet, 0.0017 * size, 0.7)
    wet = onepole_lp(wet, damp) * 0.25
    return x * (1 - mix) + wet * mix


def noise(n, rng):
    return rng.standard_normal(n)


def brown(n, rng):
    b = np.cumsum(rng.standard_normal(n))
    b -= onepole_lp(b, 8.0)  # remove drift
    return b / (np.max(np.abs(b)) + 1e-9)


def bandnoise(n, rng, f, q):
    return biquad(noise(n, rng), "bp", f, q)


def shaped_noise(n, rng, mag_fn):
    """Random-phase noise with magnitude spectrum mag_fn(freq_hz) (circular => seamless)."""
    freqs = np.fft.rfftfreq(n, 1 / SR)
    mag = mag_fn(np.maximum(freqs, 1.0))
    mag[0] = 0.0
    spec = mag * np.exp(1j * rng.uniform(0, 2 * np.pi, len(freqs)))
    x = np.fft.irfft(spec, n)
    return x / (np.max(np.abs(x)) + 1e-9)


def hump(f, fc, width_oct):
    return np.exp(-0.5 * (np.log2(f / fc) / width_oct) ** 2)


def crackle(n, rng, rate_env, burst_ms=(1.5, 5.0), hp=2500.0, amp=1.0):
    """Sparse electric crackle; rate_env = events/second per sample (array)."""
    out = np.zeros(n)
    p = rate_env / SR
    hits = np.nonzero(rng.random(n) < p)[0]
    for h in hits:
        L = n_of(rng.uniform(*burst_ms) / 1000.0)
        seg = rng.standard_normal(L) * np.exp(-np.linspace(0, 5, L)) * rng.uniform(0.3, 1.0)
        place(out, seg, h / SR)
    out = biquad(out, "hp", hp, 0.7)
    return out * amp


def normalize(x, peak_db=-1.0):
    m = np.max(np.abs(x))
    if m < 1e-9:
        return x
    return x / m * (10 ** (peak_db / 20))


def dc_block(x):
    return biquad(x, "hp", 25.0, 0.707)


def blip(n_dur, f0, f1=None, tau=0.03, amps=(1.0, 0.25), attack=0.003, curve=1.0):
    n = n_of(n_dur)
    f = sweep_exp(f0, f1 or f0, n, curve)
    return fade(harm(f, n, list(amps)) * env_exp(n, tau, attack=attack), 0.0, min(0.008, n_dur * 0.3))


def bell(n_dur, f, tau=0.35, attack=0.003, detune=2.5):
    n = n_of(n_dur)
    e = env_exp(n, tau, attack=attack)
    s = (np.sin(phase(f, n)) + 0.6 * np.sin(phase(f + detune, n)) +
         0.35 * np.sin(phase(2 * f, n)) * env_exp(n, tau * 0.5) +
         0.12 * np.sin(phase(3.01 * f, n)) * env_exp(n, tau * 0.3))
    return fade(s * e, 0.0, 0.03)


# ============================================================================ sounds
def snd_power_down(rng):
    dur = 1.3
    n = n_of(dur)
    t = T(dur)
    out = np.zeros(n)
    # descending whine 1.2 kHz -> 80 Hz with growing wobble
    wn = n_of(1.15)
    f = sweep_exp(1200, 80, wn, 0.8)
    wob = 1 + 0.025 * np.sin(2 * np.pi * 7 * T(1.15)) * np.linspace(0.3, 1.5, wn)
    whine = harm(f * wob, wn, [1.0, 0.35, 0.18, 0.08])
    whine *= (1 - np.linspace(0, 1, wn)) ** 0.7 * (1 + 0.18 * np.sin(2 * np.pi * 9 * T(1.15)))
    whine *= env_lin(wn, [(0, 0), (0.02, 1), (1.15, 1)])
    place(out, whine * 0.8, 0.0)
    # mains-like buzz stuttering out
    bz = harm(100 * np.ones(n), n, [1, 0, 0.5, 0, 0.3, 0, 0.2]) * 0.12
    gate = (rng.random(n // 1200 + 1) > np.linspace(0.05, 1.1, n // 1200 + 1)).astype(float)
    gate = np.repeat(gate, 1200)[:n]
    gate = onepole_lp(gate, 200)
    out += bz * gate * env_lin(n, [(0, 1), (0.7, 0.6), (0.9, 0)])
    # electric crackle, dense then sparse
    rate = env_lin(n, [(0, 70), (0.4, 40), (0.9, 6), (1.05, 0), (dur, 0)])
    out += biquad(crackle(n, rng, rate, hp=1800, amp=0.4), "lp", 7000, 0.7)
    # sizzle bed
    out += bandnoise(n, rng, 4200, 1.5) * 0.05 * env_lin(n, [(0, 1), (0.8, 0.2), (1.0, 0)])
    # final relay click at 1.18 s
    ck = n_of(0.08)
    click = noise(ck, rng) * env_exp(ck, 0.0015, attack=0.0002)
    click = biquad(click, "hp", 1800, 0.7) * 0.9
    click += np.sin(phase(2300, ck)) * env_exp(ck, 0.012, attack=0.0002) * 0.35
    click += np.sin(phase(sweep_exp(220, 140, ck), ck)) * env_exp(ck, 0.025, attack=0.0005) * 0.45
    place(out, click, 1.18)
    out = reverb(out, 0.18, 0.8)
    return fade(dc_block(out), 0.002, 0.04), -1.0


def snd_power_up(rng):
    dur = 1.2
    n = n_of(dur)
    out = np.zeros(n)
    # relay thump
    th = n_of(0.2)
    out[:th] += np.sin(phase(sweep_exp(90, 50, th), th)) * env_exp(th, 0.06, attack=0.001) * 0.5
    # rising whine
    wn = n_of(1.0)
    f = sweep_exp(90, 1400, wn, 0.75)
    whine = harm(f, wn, [1.0, 0.3, 0.12, 0.05])
    whine *= env_lin(wn, [(0, 0), (0.15, 0.5), (0.7, 0.8), (0.85, 0.5), (1.0, 0)])
    place(out, whine * 0.45, 0.02)
    # charging hiss
    out += bandnoise(n, rng, sweep_exp(500, 4000, n), 2.0) * 0.04 * env_lin(n, [(0, 0), (0.6, 1), (0.8, 0)])
    # three ascending chimes
    for at, fr in ((0.55, 659.25), (0.73, 880.0), (0.91, 1318.5)):
        place(out, bell(0.6, fr, tau=0.22) * 0.55, at)
    out = reverb(out, 0.28, 1.0)
    return fade(dc_block(out), 0.002, 0.05), -1.0


def snd_hud_boot(rng):
    dur = 1.0
    n = n_of(dur)
    out = np.zeros(n)
    t0 = 0.0
    for i in range(9):
        L = rng.uniform(0.018, 0.034)
        f0 = rng.uniform(1800, 3800)
        f1 = f0 * rng.choice([0.7, 1.0, 1.35, 1.6])
        amps = (1.0, 0.0, 0.3) if i % 3 else (1.0, 0.4)
        place(out, blip(L + 0.03, f0, f1, tau=L * 0.5, amps=amps, attack=0.0015) * rng.uniform(0.18, 0.3), t0)
        t0 += rng.uniform(0.03, 0.05)
    # soft swell pad
    pn = n_of(0.9)
    pad = sum(np.sin(phase(f, pn) + rng.uniform(0, 6)) * a for f, a in ((440, 0.5), (660, 0.35), (880, 0.25), (1320, 0.1)))
    pad *= env_lin(pn, [(0, 0), (0.55, 1), (0.9, 0)]) ** 1.5
    breath = biquad(noise(pn, rng), "lp", sweep_exp(400, 3000, pn), 0.8) * 0.15 * env_lin(pn, [(0, 0), (0.5, 1), (0.9, 0)])
    place(out, (pad * 0.22 + breath), 0.08)
    # confirm two-tone
    place(out, blip(0.09, 1760, tau=0.03, amps=(1, 0.2)) * 0.35, 0.62)
    place(out, blip(0.2, 2637, tau=0.06, amps=(1, 0.2)) * 0.35, 0.69)
    out = reverb(out, 0.22, 0.7)
    return fade(dc_block(out), 0.002, 0.05), -1.0


def snd_hud_off(rng):
    dur = 0.3
    n = n_of(dur)
    out = np.zeros(n)
    bn = n_of(0.26)
    f = sweep_exp(1800, 300, bn, 0.7)
    out[:bn] += harm(f, bn, [1.0, 0.25, 0.1]) * env_lin(bn, [(0, 0), (0.004, 1), (0.26, 0)]) ** 1.3 * 0.7
    out += biquad(noise(n, rng), "lp", sweep_exp(3000, 400, n), 0.7) * env_exp(n, 0.05) * 0.15
    return fade(dc_block(out), 0.002, 0.02), -1.0


def snd_alarm(rng):
    dur = 0.5
    n = n_of(dur)
    out = np.zeros(n)
    for at, f, L in ((0.0, 1046.5, 0.19), (0.25, 784.0, 0.2)):
        bn = n_of(L)
        tone = harm(f * np.ones(bn), bn, [1.0, 0, 0.33, 0, 0.18, 0, 0.08])
        tone = biquad(tone, "lp", 4500, 0.7)
        tone *= env_lin(bn, [(0, 0), (0.006, 1), (L - 0.02, 0.9), (L, 0)])
        place(out, tone * 0.6, at)
    return fade(dc_block(out), 0.001, 0.01), -1.0


def snd_scan(rng):
    dur = 1.6
    n = n_of(dur)
    out = np.zeros(n)
    pn = n_of(0.9)
    f = sweep_exp(1500, 1380, pn, 0.5)
    ping = (np.sin(phase(f, pn)) + 0.2 * np.sin(phase(2 * f, pn)) * env_exp(pn, 0.08)) * env_exp(pn, 0.22, attack=0.002)
    place(out, ping * 0.55, 0.0)
    # echoes (darker each time)
    e = ping.copy()
    for k, (at, g) in enumerate(((0.32, 0.42), (0.64, 0.22), (0.96, 0.11))):
        e = biquad(e, "lp", 3500 - 900 * k, 0.7)
        place(out, e * 0.55 * g, at)
    # shimmer sweep: rising band-passed noise + glittering partials
    sw = bandnoise(n, rng, sweep_exp(700, 7000, n, 0.9), 4.0)
    out += sw * 0.22 * env_lin(n, [(0, 0), (0.1, 0.6), (0.6, 1.0), (1.3, 0.3), (1.6, 0)])
    gl = np.zeros(n)
    for i in range(10):
        fr = rng.uniform(3000, 7500)
        trem = 0.5 + 0.5 * np.sin(2 * np.pi * rng.uniform(5, 13) * T(dur) + rng.uniform(0, 6))
        gl += np.sin(phase(fr, n)) * trem * env_lin(n, [(0, 0), (0.15 + 0.05 * i, 0), (0.4 + 0.06 * i, 1), (1.6, 0)])
    out += gl * 0.025
    out = reverb(out, 0.35, 1.3, damp=6000, decay=0.82)
    return fade(dc_block(out), 0.002, 0.08), -1.0


def snd_scan_ping(rng):
    dur = 0.15
    n = n_of(dur)
    f = sweep_exp(2400, 2750, n, 0.3)
    out = (np.sin(phase(f, n)) + 0.22 * np.sin(phase(2 * f, n))) * env_exp(n, 0.035, attack=0.002)
    return fade(dc_block(out), 0.001, 0.01), -1.0


def snd_lock_tick(rng):
    dur = 0.08
    n = n_of(dur)
    tone = harm(1900 * np.ones(n), n, [1.0, 0, 0.25, 0, 0.1])
    tone *= env_lin(n, [(0, 0), (0.003, 1), (0.05, 0.8), (0.07, 0), (0.08, 0)])
    return fade(dc_block(tone), 0.0005, 0.005), -1.0


def snd_lock_on(rng):
    dur = 0.6
    n = n_of(dur)
    t = T(dur)
    trem = 0.62 + 0.38 * np.sin(2 * np.pi * 18 * t)
    tone = (np.sin(phase(2093 * np.ones(n), n)) * 0.75 + np.sin(phase(1046.5 * np.ones(n), n)) * 0.35 +
            np.sin(phase(4186 * np.ones(n), n)) * 0.08)
    tone *= trem * env_lin(n, [(0, 0), (0.01, 1), (0.5, 1), (0.6, 0)])
    # quick confirm chirp on top
    place(tone, blip(0.06, 2400, 3200, tau=0.02, amps=(1.0,)) * 0.3, 0.0)
    return fade(dc_block(tone), 0.001, 0.01), -1.0


def snd_lock_lost(rng):
    dur = 0.3
    n = n_of(dur)
    out = np.zeros(n)
    place(out, blip(0.12, 1320, 1250, tau=0.05, amps=(1, 0.25)), 0.0)
    place(out, blip(0.16, 880, 780, tau=0.06, amps=(1, 0.25)), 0.14)
    return fade(dc_block(out), 0.001, 0.01), -1.0


def snd_target(rng):
    dur = 0.1
    n = n_of(dur)
    out = blip(dur, 1400, 1550, tau=0.028, amps=(1.0, 0.18), attack=0.004)
    out = biquad(out, "lp", 6000, 0.7)
    return fade(dc_block(out), 0.001, 0.01), -1.0


def _roar(n, rng, bright=0.0, hum_f=95.0, flutter_hz=23.0, flutter_depth=0.14):
    """Jet / repulsor roar: spectrally shaped noise (rumble + roar hump, steep HF roll-off),
    harmonic hum, flutter AM. `bright` (0..1) lifts the roar hump and the 2-5 kHz band."""
    t = np.arange(n) / SR
    fc = 650.0 * (1 + 0.9 * bright)

    def mag(f):
        rumble = 1.0 * hump(f, 110.0, 0.9)
        roar = 0.85 * hump(f, fc, 1.1)
        rolloff = 1.0 / (1.0 + (f / (1800.0 + 2200.0 * bright)) ** (2.2 - 0.6 * bright))
        hiss = (0.025 + 0.06 * bright) * hump(f, 6500.0, 0.8)
        return (rumble + roar) * rolloff + hiss

    body = shaped_noise(n, rng, mag)
    vib = 1 + 0.01 * np.sin(2 * np.pi * 5.3 * t)
    hum = harm(hum_f * vib, n, [1.0, 0.55, 0.35, 0.22, 0.12, 0.07]) * 0.22
    jitter = onepole_lp(rng.standard_normal(n), 30.0)
    jitter /= np.max(np.abs(jitter)) + 1e-9
    flutter = 1 + flutter_depth * np.sin(2 * np.pi * flutter_hz * t) + 0.08 * jitter
    return body * flutter + hum


def loopify(x, fin=0.1, fout=0.1):
    """Retriggered every 18 ticks (0.9 s) by flight.js: the 0.1 s overlap is an equal-power crossfade."""
    return fade(x, fin, fout, "eqp")


def snd_thruster_loop(rng):
    n = n_of(1.0)
    x = _roar(n, rng, bright=0.0)
    x = sat(x / (np.max(np.abs(x)) + 1e-9) * 1.2, 1.3)
    return loopify(dc_block(x)), -6.0


def snd_thruster_boost(rng):
    n = n_of(1.0)
    x = _roar(n, rng, bright=1.0, hum_f=140.0, flutter_hz=31.0, flutter_depth=0.2)
    whistle = bandnoise(n, rng, 2250, 14.0) * 1.1
    pops = biquad(crackle(n, rng, np.full(n, 12.0), burst_ms=(2.0, 6.0), hp=300, amp=1.0), "lp", 2500, 0.7)
    x = x + whistle + pops
    x = sat(x / (np.max(np.abs(x)) + 1e-9) * 1.4, 1.6)
    return loopify(dc_block(x)), -4.5


def snd_thruster_start(rng):
    dur = 1.0
    n = n_of(dur)
    out = np.zeros(n)
    # whoosh
    wh = biquad(noise(n, rng), "bp", sweep_exp(250, 1800, n, 0.6), 1.6)
    out += wh * 0.45 * env_lin(n, [(0, 0), (0.25, 1), (0.45, 0.35), (1.0, 0.2)])
    # low boom at 0.12 s
    bn = n_of(0.7)
    boom = np.sin(phase(sweep_exp(85, 38, bn, 0.5), bn)) * env_exp(bn, 0.22, attack=0.004)
    boom += biquad(noise(bn, rng), "lp", 420, 0.8) * env_exp(bn, 0.12, attack=0.002) * 1.2
    place(out, boom * 0.9, 0.12)
    # rising roar into loop level (same core as thruster_loop)
    roar = _roar(n, rng)
    roar /= np.max(np.abs(roar)) + 1e-9
    out += roar * 0.55 * env_lin(n, [(0, 0), (0.25, 0.15), (0.85, 1.0), (1.0, 1.0)]) ** 1.2
    out = sat(out, 1.3)
    # flight.js starts the loop 16 ticks (0.8 s) after ignition: hand over with an equal-power tail
    return fade(fade(dc_block(out), 0.003, 0.0), 0.0, 0.2, "eqp"), -2.0


def snd_thruster_stop(rng):
    dur = 0.8
    n = n_of(dur)
    t = T(dur)
    base = _roar(n, rng, flutter_depth=0.1)
    rumble = biquad(base, "lp", sweep_exp(2400, 160, n, 0.7), 0.8)
    roar = biquad(base, "bp", sweep_exp(900, 160, n, 0.7), 1.2) * 0.6
    hum = harm(sweep_exp(110, 38, n, 0.8), n, [1.0, 0.45, 0.25, 0.12]) * 0.3
    env = env_lin(n, [(0, 1), (0.15, 0.8), (0.6, 0.25), (0.8, 0)]) ** 1.4
    out = (rumble + roar + hum) * env
    # sputter pops
    rate = env_lin(n, [(0, 0), (0.25, 10), (0.6, 4), (0.8, 0)])
    out += biquad(crackle(n, rng, rate, burst_ms=(3, 8), hp=300, amp=0.5), "lp", 2000, 0.7)
    out = sat(out / (np.max(np.abs(out)) + 1e-9), 1.2)
    return fade(dc_block(out), 0.02, 0.04), -3.0


def _nwave(L_ms, rng):
    L = n_of(L_ms / 1000.0)
    w = np.linspace(1, -1, L)
    return np.concatenate([[0.0], w, [0.0]])


def snd_sonic_boom(rng):
    dur = 1.5
    n = n_of(dur)
    out = np.zeros(n)
    for at, g, L in ((0.004, 1.0, 5.0), (0.115, 0.8, 4.0)):
        crack = _nwave(L, rng)
        crack = np.concatenate([crack, np.zeros(n_of(0.05))])
        body = biquad(noise(n_of(0.25), rng), "lp", 1800, 0.7) * env_exp(n_of(0.25), 0.03, attack=0.0005)
        place(out, crack * g, at)
        place(out, body * 0.6 * g, at)
    # sub thump
    sn = n_of(0.8)
    place(out, np.sin(phase(sweep_exp(55, 30, sn, 0.6), sn)) * env_exp(sn, 0.25, attack=0.003) * 0.9, 0.0)
    # rolling rumble tail
    rum = biquad(brown(n, rng), "lp", 220, 0.7)
    roll = 0.7 + 0.3 * onepole_lp(rng.standard_normal(n), 6.0) / 0.05
    roll = np.clip(roll, 0.3, 1.3)
    out += rum * 1.1 * roll * env_lin(n, [(0, 0), (0.05, 1), (1.5, 0)]) ** 1.8
    out = sat(out, 1.8)
    out = reverb(out, 0.2, 1.4, damp=2500)
    return fade(dc_block(out), 0.0005, 0.08), -1.0


def snd_landing(rng):
    dur = 0.8
    n = n_of(dur)
    out = np.zeros(n)
    # ground thud
    tn = n_of(0.6)
    thud = np.sin(phase(sweep_exp(95, 42, tn, 0.5), tn)) * env_exp(tn, 0.14, attack=0.002)
    thud += biquad(noise(tn, rng), "lp", 500, 0.8) * env_exp(tn, 0.09, attack=0.001) * 1.3
    place(out, thud * 0.9, 0.0)
    # metal impact: inharmonic partials
    mn = n_of(0.7)
    metal = np.zeros(mn)
    for f, tau, a in ((418, 0.32, 0.5), (1131, 0.18, 0.35), (2207, 0.1, 0.25), (3479, 0.06, 0.2), (5230, 0.035, 0.15)):
        metal += np.sin(phase(f * np.ones(mn), mn) + rng.uniform(0, 6)) * env_exp(mn, tau, attack=0.0005) * a
    metal += biquad(noise(mn, rng), "hp", 2500, 0.7) * env_exp(mn, 0.012, attack=0.0002) * 0.6
    place(out, metal * 0.55, 0.005)
    # debris rattle
    rate = env_lin(n, [(0, 0), (0.05, 60), (0.4, 10), (0.7, 0)])
    out += biquad(crackle(n, rng, rate, burst_ms=(1, 3), hp=900, amp=0.14), "lp", 5000, 0.7)
    # hydraulic hiss settling
    hs = biquad(noise(n, rng), "bp", 2400, 2.0) * env_lin(n, [(0, 0), (0.15, 0), (0.25, 0.25), (0.75, 0)]) * 0.22
    out += hs
    out = sat(out, 1.4)
    out = reverb(out, 0.15, 0.9)
    return fade(dc_block(out), 0.0005, 0.05), -1.0


def snd_shield(rng):
    dur = 0.4
    n = n_of(dur)
    t = T(dur)
    fc = sweep_exp(950, 280, n, 0.6)
    mod = np.sin(phase(fc * 1.41, n)) * env_lin(n, [(0, 6), (0.4, 1)])
    zap = np.sin(phase(fc, n) + mod) * env_exp(n, 0.12, attack=0.001)
    shimmer = bandnoise(n, rng, 6500, 2.0) * env_exp(n, 0.06) * 0.6
    whump = np.sin(phase(sweep_exp(160, 70, n), n)) * env_exp(n, 0.07, attack=0.002) * 0.6
    cr = biquad(crackle(n, rng, env_lin(n, [(0, 80), (0.25, 10), (0.4, 0)]), hp=2500, amp=0.3), "lp", 8000, 0.7)
    out = zap * 0.75 + shimmer * 0.6 + whump + cr
    out = reverb(out, 0.2, 0.8)
    return fade(dc_block(out), 0.0005, 0.03), -1.0


def snd_menu(rng):
    dur = 0.2
    n = n_of(dur)
    out = np.zeros(n)
    place(out, blip(0.07, 1200, 1800, tau=0.03, amps=(1.0, 0.2), curve=0.6) * 0.8, 0.0)
    place(out, blip(0.12, 1800, 2400, tau=0.035, amps=(1.0, 0.2), curve=0.6) * 0.8, 0.055)
    out = reverb(out, 0.15, 0.5)
    return fade(dc_block(out), 0.001, 0.01), -1.0


def snd_night_vision(rng):
    """Optical night-vision engaging: soft rising servo whirr + a small lens click (0.4 s)."""
    dur = 0.4
    n = n_of(dur)
    # servo whirr: a resonant tone sweeping up with a little motor flutter
    f = sweep_exp(430.0, 1480.0, n, 1.25)
    whirr = np.sin(phase(f, n)) + 0.18 * np.sin(phase(f * 2.0, n)) + 0.07 * np.sin(phase(f * 3.0, n))
    whirr *= 0.86 + 0.14 * np.sin(phase(np.full(n, 57.0), n))
    whirr *= env_lin(n, [(0, 0.0), (0.05, 0.85), (0.26, 1.0), (0.33, 0.2), (0.4, 0.0)])
    # iris air: a breathy band of noise following the same sweep
    air = biquad(noise(n, rng), "bp", sweep_exp(1200.0, 3400.0, n), 1.1)
    air *= env_lin(n, [(0, 0.0), (0.07, 1.0), (0.3, 0.7), (0.4, 0.0)]) * 0.5
    out = biquad(whirr * 0.55 + air * 0.35, "lp", 5200.0, 0.8)
    # lens click: tiny transient + a high tick, right at the end of the sweep
    place(out, blip(0.05, 2700, 1900, tau=0.012, amps=(1.0, 0.45, 0.15), attack=0.0006) * 0.5, 0.292)
    place(out, biquad(noise(n_of(0.02), rng), "hp", 3800.0, 0.8) * env_exp(n_of(0.02), 0.004, attack=0.0004) * 0.3,
          0.292)
    out = reverb(out, 0.14, 0.45)
    return fade(dc_block(out), 0.004, 0.04), -3.0


# id -> (file stem, renderer, extra definition fields)
WORLD = {"min_distance": 4.0, "max_distance": 48.0}
SOUNDS = {
    "sym.mk5.power_down": ("power_down", snd_power_down, {}),
    "sym.mk5.power_up": ("power_up", snd_power_up, {}),
    "sym.mk5.hud_boot": ("hud_boot", snd_hud_boot, {}),
    "sym.mk5.hud_off": ("hud_off", snd_hud_off, {}),
    "sym.mk5.alarm": ("alarm", snd_alarm, {}),
    "sym.mk5.scan": ("scan", snd_scan, {}),
    "sym.mk5.scan_ping": ("scan_ping", snd_scan_ping, {}),
    "sym.mk5.lock_tick": ("lock_tick", snd_lock_tick, {}),
    "sym.mk5.lock_on": ("lock_on", snd_lock_on, {}),
    "sym.mk5.lock_lost": ("lock_lost", snd_lock_lost, {}),
    "sym.mk5.target": ("target", snd_target, {}),
    "sym.mk5.thruster_start": ("thruster_start", snd_thruster_start, WORLD),
    "sym.mk5.thruster_loop": ("thruster_loop", snd_thruster_loop, WORLD),
    "sym.mk5.thruster_boost": ("thruster_boost", snd_thruster_boost, WORLD),
    "sym.mk5.thruster_stop": ("thruster_stop", snd_thruster_stop, WORLD),
    "sym.mk5.sonic_boom": ("sonic_boom", snd_sonic_boom, {"min_distance": 16.0, "max_distance": 160.0}),
    "sym.mk5.landing": ("landing", snd_landing, {"min_distance": 4.0, "max_distance": 40.0}),
    "sym.mk5.shield": ("shield", snd_shield, {}),
    "sym.mk5.menu": ("menu", snd_menu, {}),
    "sym.mk5.night_vision": ("night_vision", snd_night_vision, {}),
}

EXPECTED_DUR = {
    "power_down": 1.3, "power_up": 1.2, "hud_boot": 1.0, "hud_off": 0.3, "alarm": 0.5, "scan": 1.6,
    "scan_ping": 0.15, "lock_tick": 0.08, "lock_on": 0.6, "lock_lost": 0.3, "target": 0.1,
    "thruster_start": 1.0, "thruster_loop": 1.0, "thruster_boost": 1.0, "thruster_stop": 0.8,
    "sonic_boom": 1.5, "landing": 0.8, "shield": 0.4, "menu": 0.2,
    "night_vision": 0.4,
}


def write_wav(path, x):
    pcm = np.clip(np.round(x * 32767), -32768, 32767).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def encode(wav, ogg):
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", wav, "-map_metadata", "-1",
                    "-fflags", "+bitexact", "-flags:a", "+bitexact", "-c:a", "libvorbis", "-q:a", "5",
                    "-ac", "1", "-ar", str(SR), ogg], check=True)


def merge_definitions():
    with open(DEFS, encoding="utf-8") as fh:
        data = json.load(fh)
    sd = data.setdefault("sound_definitions", {})
    for sid, (stem, _fn, extra) in SOUNDS.items():
        entry = {"category": "player"}
        entry.update(extra)
        entry["sounds"] = [{"name": f"sounds/sym/{stem}", "load_on_low_memory": True}]
        sd[sid] = entry
    with open(DEFS, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, ensure_ascii=False)
        fh.write("\n")


def main(argv):
    only = set(argv[1:])
    if not shutil.which("ffmpeg"):
        print("ffmpeg not found", file=sys.stderr)
        return 1
    os.makedirs(BUILD, exist_ok=True)
    os.makedirs(SND_DIR, exist_ok=True)
    for sid, (stem, fn, _extra) in SOUNDS.items():
        if only and stem not in only:
            continue
        rng = rng_for(stem)
        x, peak_db = fn(rng)
        x = normalize(np.nan_to_num(x), peak_db)
        wav = os.path.join(BUILD, f"{stem}.wav")
        ogg = os.path.join(SND_DIR, f"{stem}.ogg")
        write_wav(wav, x)
        encode(wav, ogg)
        os.remove(wav)
        print(f"{stem:15s} {len(x) / SR:5.2f}s peak {peak_db:+.1f} dBFS -> {os.path.getsize(ogg):6d} B")
    merge_definitions()
    shutil.rmtree(BUILD, ignore_errors=True)  # intermediate WAVs only
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
