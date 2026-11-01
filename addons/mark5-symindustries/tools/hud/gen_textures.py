#!/usr/bin/env python3
"""Mark V HUD + control-panel texture generator (hud agent).

Writes every PNG under:
  pack/Mark5_RP/textures/sym/hud/**   (visor HUD pieces, gauges, frames, overlays)
  pack/Mark5_RP/textures/sym/ui/**    (ActionFormData menu icons)

Everything is drawn procedurally with PIL at SUPERSAMPLE x the target size and downscaled with
LANCZOS in premultiplied-alpha space, then the colour of fully transparent texels is "bled" from
their neighbours so bilinear filtering in-game never produces dark fringes.

Idempotent: re-running overwrites the same files with identical content. Stale files that this
script no longer produces are removed from the two directories it owns.

Usage:  python3 tools/hud/gen_textures.py
"""
from __future__ import annotations

import math
import os
import re
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
RP = os.path.join(ROOT, "pack", "Mark5_RP")
HUD_DIR = os.path.join(RP, "textures", "sym", "hud")
UI_DIR = os.path.join(RP, "textures", "sym", "ui")

SS = 4  # supersampling factor

# ---------------------------------------------------------------- palette (RGB) --
CYAN = (63, 216, 255)
ICE = (196, 242, 255)
AMBER = (255, 178, 56)
RED = (255, 62, 62)
GREEN = (84, 255, 140)
WHITE = (236, 246, 255)
NAVY = (3, 14, 26)
STEEL = (70, 84, 98)
HOT = (255, 120, 40)

CLASS_COL = {"h": RED, "n": WHITE, "p": GREEN, "j": ICE}

written: list[str] = []


def rgba(c, a):
    """RGB tuple + alpha (0..1) -> RGBA tuple of ints."""
    return (int(c[0]), int(c[1]), int(c[2]), int(round(max(0.0, min(1.0, a)) * 255)))


def mix(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


# ------------------------------------------------------------------ canvas ------
class Canvas:
    """A supersampled RGBA surface. Coordinates are in OUTPUT texels (floats)."""

    def __init__(self, w, h, ss=SS):
        self.w, self.h, self.ss = w, h, ss
        self.im = Image.new("RGBA", (w * ss, h * ss), (0, 0, 0, 0))

    # each primitive is drawn on its own layer and alpha-composited ("over")
    def _layer(self):
        lay = Image.new("RGBA", self.im.size, (0, 0, 0, 0))
        return lay, ImageDraw.Draw(lay)

    def _p(self, pts):
        s = self.ss
        return [(x * s, y * s) for (x, y) in pts]

    def put(self, lay):
        self.im = Image.alpha_composite(self.im, lay)

    def line(self, pts, col, width=1.0, glow=0.0, glow_a=0.6):
        lay, d = self._layer()
        d.line(self._p(pts), fill=col, width=max(1, int(round(width * self.ss))), joint="curve")
        self._finish(lay, glow, glow_a)

    def poly(self, pts, fill=None, outline=None, width=1.0, glow=0.0, glow_a=0.6):
        lay, d = self._layer()
        if fill is not None:
            d.polygon(self._p(pts), fill=fill)
        if outline is not None:
            p = self._p(pts)
            d.line(p + [p[0]], fill=outline, width=max(1, int(round(width * self.ss))), joint="curve")
        self._finish(lay, glow, glow_a)

    def ellipse(self, cx, cy, rx, ry, fill=None, outline=None, width=1.0, glow=0.0, glow_a=0.6):
        lay, d = self._layer()
        s = self.ss
        if fill is not None:
            d.ellipse([(cx - rx) * s, (cy - ry) * s, (cx + rx) * s, (cy + ry) * s], fill=fill)
        if outline is not None:
            hw = width / 2
            d.ellipse(
                [(cx - rx - hw) * s, (cy - ry - hw) * s, (cx + rx + hw) * s, (cy + ry + hw) * s],
                outline=outline,
                width=max(1, int(round(width * s))),
            )
        self._finish(lay, glow, glow_a)

    def arc(self, cx, cy, r, a0, a1, col, width=1.0, glow=0.0, glow_a=0.6):
        """Arc centred on radius r. Angles in degrees, 0 = east, clockwise (screen space)."""
        pts = arc_pts(cx, cy, r, a0, a1)
        self.line(pts, col, width, glow, glow_a)

    def annulus_seg(self, cx, cy, r0, r1, a0, a1, fill=None, outline=None, width=0.6, glow=0.0, glow_a=0.6):
        outer = arc_pts(cx, cy, r1, a0, a1)
        inner = arc_pts(cx, cy, r0, a1, a0)
        self.poly(outer + inner, fill=fill, outline=outline, width=width, glow=glow, glow_a=glow_a)

    def _finish(self, lay, glow, glow_a):
        if glow > 0:
            g = blur_rgba(lay, glow * self.ss)
            g = scale_alpha(g, glow_a)
            self.im = Image.alpha_composite(self.im, g)
        self.im = Image.alpha_composite(self.im, lay)

    def add_glow(self, radius, strength):
        """Glow of everything drawn so far (placed underneath)."""
        g = scale_alpha(blur_rgba(self.im, radius * self.ss), strength)
        self.im = Image.alpha_composite(g, self.im)

    def paste_array(self, arr_rgba_float):
        """Composite a float RGBA (0..1) numpy array at supersampled resolution."""
        im = Image.fromarray(np.clip(arr_rgba_float * 255 + 0.5, 0, 255).astype(np.uint8), "RGBA")
        self.im = Image.alpha_composite(self.im, im)

    def grid(self):
        """Pixel-centre coordinates (output texel units) of the supersampled image."""
        H, W = self.im.size[1], self.im.size[0]
        ys, xs = np.mgrid[0:H, 0:W].astype(np.float32)
        return (xs + 0.5) / self.ss, (ys + 0.5) / self.ss

    def result(self):
        small = self.im.convert("RGBa").resize((self.w, self.h), Image.LANCZOS).convert("RGBA")
        return alpha_bleed(small)


def arc_pts(cx, cy, r, a0, a1, step=2.0):
    n = max(2, int(abs(a1 - a0) / step) + 1)
    out = []
    for i in range(n + 1):
        a = math.radians(a0 + (a1 - a0) * i / n)
        out.append((cx + math.cos(a) * r, cy + math.sin(a) * r))
    return out


def blur_rgba(im, radius):
    a = np.asarray(im).astype(np.float32) / 255.0
    alpha = a[..., 3:4]
    pre = a[..., :3] * alpha
    chans = []
    for i in range(3):
        chans.append(Image.fromarray((pre[..., i] * 255 + 0.5).astype(np.uint8), "L"))
    chans.append(Image.fromarray((alpha[..., 0] * 255 + 0.5).astype(np.uint8), "L"))
    chans = [c.filter(ImageFilter.GaussianBlur(radius)) for c in chans]
    arr = np.stack([np.asarray(c).astype(np.float32) / 255.0 for c in chans], -1)
    al = arr[..., 3:4]
    rgb = np.where(al > 1e-4, arr[..., :3] / np.maximum(al, 1e-4), 0.0)
    out = np.concatenate([np.clip(rgb, 0, 1), al], -1)
    return Image.fromarray((out * 255 + 0.5).astype(np.uint8), "RGBA")


def scale_alpha(im, k):
    a = np.asarray(im).copy()
    a[..., 3] = np.clip(a[..., 3].astype(np.float32) * k, 0, 255).astype(np.uint8)
    return Image.fromarray(a, "RGBA")


def alpha_bleed(im, iters=6):
    """Fill RGB of transparent texels with the average of opaque neighbours (no visual change,
    prevents dark fringes under bilinear filtering)."""
    a = np.asarray(im).astype(np.float32)
    rgb = a[..., :3].copy()
    known = a[..., 3] > 0
    if known.all() or not known.any():
        return im
    for _ in range(iters):
        acc = np.zeros_like(rgb)
        cnt = np.zeros(known.shape, np.float32)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dx == 0 and dy == 0:
                    continue
                sk = np.roll(np.roll(known, dy, 0), dx, 1)
                sr = np.roll(np.roll(rgb, dy, 0), dx, 1)
                acc += sr * sk[..., None]
                cnt += sk
        new = (~known) & (cnt > 0)
        rgb[new] = acc[new] / cnt[new][:, None]
        known = known | new
        if known.all():
            break
    out = np.concatenate([rgb, a[..., 3:4]], -1)
    return Image.fromarray(np.clip(out + 0.5, 0, 255).astype(np.uint8), "RGBA")


_PADDED_FRAME = re.compile(r"^(.*_)(0\d+)$")


def unpadded_twin(rel):
    """Name of the leading-zero-free twin of a zero-padded frame name, or None.

    JSON UI coerces numeric-looking strings, so in game ``'textures/sym/hud/energy_' + '09'`` can
    become ``energy_9`` (SPEC 11 item 1). Every padded frame (``energy_09``, ``hp_h_00``,
    ``thrust_05`` ...) is therefore written twice: ``energy_09`` and ``energy_9``, ``hp_h_00`` and
    ``hp_h_0``. Names without a leading zero (``energy_12``, ``lock_3``) need no twin.
    """
    m = _PADDED_FRAME.match(rel)
    return f"{m.group(1)}{int(m.group(2))}" if m else None


def save(im, rel, base=HUD_DIR):
    names = [rel]
    twin = unpadded_twin(rel)
    if twin is not None:
        names.append(twin)
    for name in names:
        path = os.path.join(base, name + ".png")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        im.save(path, optimize=True)
        written.append(os.path.relpath(path, RP).replace(os.sep, "/"))


def blank(rel, size=4):
    save(Image.new("RGBA", (size, size), (0, 0, 0, 0)), rel)


def mirror(im, how):
    if how == "x":
        return im.transpose(Image.FLIP_LEFT_RIGHT)
    if how == "y":
        return im.transpose(Image.FLIP_TOP_BOTTOM)
    return im.transpose(Image.ROTATE_180)


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def hex_grid_alpha(xs, ys, size, line=0.35):
    """Alpha mask (0..1) of a flat-top hexagon grid outline, cell radius `size` (texel units)."""
    # axial coordinates of the nearest hex centre, distance to its edge
    q = (2.0 / 3.0 * xs) / size
    r = (-1.0 / 3.0 * xs + math.sqrt(3) / 3.0 * ys) / size
    # cube round
    x, z = q, r
    y = -x - z
    rx, ry, rz = np.round(x), np.round(y), np.round(z)
    dx, dy, dz = np.abs(rx - x), np.abs(ry - y), np.abs(rz - z)
    m1 = (dx > dy) & (dx > dz)
    m2 = (~m1) & (dy > dz)
    rx = np.where(m1, -ry - rz, rx)
    ry = np.where(m2, -rx - rz, ry)
    rz = np.where(~m1 & ~m2, -rx - ry, rz)
    cx = size * 1.5 * rx
    cy = size * math.sqrt(3) * (rz + rx / 2.0)
    px, py = np.abs(xs - cx), np.abs(ys - cy)
    # distance to flat-top hexagon boundary (inradius = size*sqrt(3)/2)
    d = np.maximum(py, (px * math.sqrt(3) + py) / 2.0)
    inr = size * math.sqrt(3) / 2.0
    return 1.0 - smoothstep(line * 0.5, line * 1.5, np.abs(inr - d))


# =================================================================== VISOR FRAME ==
ASSET_VISOR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets", "user_visor_base_2560x1440.png")
VISOR_SIZE = (1280, 720)


def gen_visor_base():
    """THE full-screen visor frame is the user's own artwork (tools/hud/assets/...2560x1440.png):
    LANCZOS-downscaled in premultiplied-alpha space to 1280x720, otherwise untouched. A red copy
    (cyan -> emergency red, black helmet notches unchanged) is used for the power-failure mode."""
    src = Image.open(ASSET_VISOR).convert("RGBA")
    small = src.convert("RGBa").resize(VISOR_SIZE, Image.LANCZOS).convert("RGBA")
    save(alpha_bleed(small, iters=2), "visor_base")
    a = np.asarray(small).astype(np.float32)
    m = a[..., :3].max(-1)
    out = a.copy()
    out[..., 0] = m
    out[..., 1] = m * 0.26
    out[..., 2] = m * 0.20
    fail = Image.fromarray(np.clip(out + 0.5, 0, 255).astype(np.uint8), "RGBA")
    save(alpha_bleed(fail, iters=2), "visor_base_fail")


def rounded_poly(pts, r, steps=6):
    """Polygon with every corner rounded by a quadratic curve of 'radius' r (same units as pts)."""
    out = []
    n = len(pts)
    for i in range(n):
        p0, p1, p2 = pts[i - 1], pts[i], pts[(i + 1) % n]
        def toward(a, b, d):
            dx, dy = b[0] - a[0], b[1] - a[1]
            ln = math.hypot(dx, dy) or 1.0
            d = min(d, ln / 2)
            return (a[0] + dx / ln * d, a[1] + dy / ln * d)
        a = toward(p1, p0, r)
        b = toward(p1, p2, r)
        for k in range(steps + 1):
            t = k / steps
            x = (1 - t) ** 2 * a[0] + 2 * (1 - t) * t * p1[0] + t ** 2 * b[0]
            y = (1 - t) ** 2 * a[1] + 2 * (1 - t) * t * p1[1] + t ** 2 * b[1]
            out.append((x, y))
    return out


def gen_danger():
    """Red threat glow in exactly the shape of the user's visor tint (their radial cyan gradient),
    so the warning reads as the visor itself turning red. It is drawn ABOVE the visor artwork but
    is cut out around the user's cyan polylines and black helmet notches, so those stay crisp."""
    src = np.asarray(Image.open(ASSET_VISOR).convert("RGBA").convert("RGBa").resize(VISOR_SIZE, Image.LANCZOS).convert("RGBA")).astype(np.float32) / 255
    alpha = src[..., 3]
    rgb = src[..., :3]
    notch = (alpha > 0.6) & (rgb.sum(-1) < 0.35)
    line = (alpha > 0.45) & (rgb[..., 0] < 0.35) & (rgb[..., 2] > 0.6)
    keep = Image.fromarray(((notch | line) * 255).astype(np.uint8), "L").filter(ImageFilter.MaxFilter(5))
    keep = np.asarray(keep.filter(ImageFilter.GaussianBlur(0.8))).astype(np.float32) / 255
    tint = np.clip(alpha, 0, 0.40)
    tint_im = Image.fromarray((tint * 255 + 0.5).astype(np.uint8), "L").filter(ImageFilter.GaussianBlur(3.0))
    a = np.clip(np.asarray(tint_im).astype(np.float32) / 255 * 1.3, 0, 0.52) * (1 - keep)
    out = np.zeros(a.shape + (4,), np.float32)
    out[..., 0] = 1.0
    out[..., 1] = 0.16
    out[..., 2] = 0.12
    out[..., 3] = a
    save(Image.fromarray((out * 255 + 0.5).astype(np.uint8), "RGBA"), "danger_edge")


def panel(w, h, col, k=2.0, cut=5.0, header=0.0, fill_a=(0.50, 0.30), border_a=0.55, hex_corner=True,
          stripes=True, accent=None):
    """Tech panel at k texels per GUI px. w,h in GUI px."""
    W, H = int(round(w * k)), int(round(h * k))
    c = Canvas(W, H)
    xs, ys = c.grid()
    gx, gy = xs / k, ys / k  # GUI units
    # shape mask (cut top-left and bottom-right corners)
    inside = (gx >= 0.5) & (gx <= w - 0.5) & (gy >= 0.5) & (gy <= h - 0.5)
    inside &= (gx + gy) >= cut + 0.5
    inside &= ((w - gx) + (h - gy)) >= cut + 0.5
    t = gy / h
    a_fill = fill_a[0] + (fill_a[1] - fill_a[0]) * t
    arr = np.zeros(xs.shape + (4,), np.float32)
    navy = np.array(NAVY, np.float32) / 255
    tint = np.array(col, np.float32) / 255
    base = navy * 0.85 + tint * 0.15
    arr[..., :3] = base
    arr[..., 3] = np.where(inside, a_fill, 0)
    if header > 0:
        hm = inside & (gy < header)
        arr[..., :3] = np.where(hm[..., None], navy * 0.55 + tint * 0.45, arr[..., :3])
        arr[..., 3] = np.where(hm, fill_a[0] * 0.75 + 0.12, arr[..., 3])
    if hex_corner:
        m = hex_grid_alpha(gx, gy, 2.4, 0.26)
        fall = np.clip(1 - np.sqrt(((gx - w) / (w * 0.42)) ** 2 + ((gy - h) / (h * 0.9)) ** 2), 0, 1) ** 1.6
        hx = m * fall * 0.22 * inside
        arr[..., :3] = arr[..., :3] * (1 - hx[..., None]) + tint * hx[..., None]
        arr[..., 3] = np.maximum(arr[..., 3], hx)
    c.paste_array(arr)
    # border
    pts = [(cut * k, 0.5 * k), ((w - 0.5) * k, 0.5 * k), ((w - 0.5) * k, (h - cut) * k),
           ((w - cut) * k, (h - 0.5) * k), (0.5 * k, (h - 0.5) * k), (0.5 * k, cut * k)]
    c.poly(pts, outline=rgba(col, border_a), width=0.5 * k)
    # bright corner accents
    acc = rgba(accent or col, 0.95)
    L = min(10.0, w * 0.18)
    c.line([(0.5 * k, (cut + L * 0.6) * k), (0.5 * k, cut * k), (cut * k, 0.5 * k), ((cut + L) * k, 0.5 * k)], acc, 1.0 * k, glow=1.2 * k, glow_a=0.5)
    c.line([((w - 0.5) * k, (h - cut - L * 0.6) * k), ((w - 0.5) * k, (h - cut) * k), ((w - cut) * k, (h - 0.5) * k), ((w - cut - L) * k, (h - 0.5) * k)], acc, 1.0 * k, glow=1.2 * k, glow_a=0.5)
    c.line([((w - L * 0.7) * k, 0.5 * k), ((w - 0.5) * k, 0.5 * k), ((w - 0.5) * k, (L * 0.5) * k)], acc, 0.8 * k)
    c.line([(0.5 * k, (h - L * 0.5) * k), (0.5 * k, (h - 0.5) * k), ((L * 0.7) * k, (h - 0.5) * k)], acc, 0.8 * k)
    if header > 0:
        c.line([(2 * k, header * k), ((w - 2) * k, header * k)], rgba(col, 0.45), 0.4 * k)
        c.line([(2 * k, header * k), ((w * 0.35) * k, header * k)], rgba(col, 0.9), 0.6 * k)
    if stripes:
        # small diagonal stripes at the top right (hazard-ish), 4 strokes
        for i in range(4):
            x0 = w - 7 - i * 2.2
            c.line([(x0 * k, 2.2 * k), ((x0 - 1.4) * k, 4.6 * k)], rgba(col, 0.55), 0.55 * k)
    return c.result()


def gen_panels():
    save(panel(152, 86, CYAN, header=10), "panel_suit")
    save(panel(152, 38, CYAN, header=0, cut=4, stripes=False), "panel_energy")
    save(panel(150, 50, CYAN, header=8, cut=4), "panel_systems")
    save(panel(150, 66, CYAN, header=11), "panel_scan")
    save(panel(166, 31, CYAN, header=0, cut=5, stripes=False), "panel_flight")
    for cls, col in CLASS_COL.items():
        save(panel(150, 54, col, header=11, border_a=0.7, accent=col), f"target_frame_{cls}")
    blank("target_frame_0")
    save(panel(230, 106, CYAN, header=14, cut=8, fill_a=(0.72, 0.55)), "boot_frame_2")
    save(panel(230, 106, RED, header=14, cut=8, fill_a=(0.78, 0.62), accent=(255, 110, 90)), "boot_frame_3")


def gen_viewport():
    w, h, k = 46, 70, 3.0
    W, H = int(w * k), int(h * k)
    c = Canvas(W, H)
    xs, ys = c.grid()
    gx, gy = xs / k, ys / k
    arr = np.zeros(xs.shape + (4,), np.float32)
    tint = np.array(CYAN, np.float32) / 255
    # radial backdrop glow behind the model
    r = np.sqrt(((gx - w / 2) / (w * 0.55)) ** 2 + ((gy - h * 0.48) / (h * 0.55)) ** 2)
    glow_a = np.clip(1 - r, 0, 1) ** 1.8 * 0.20
    hexa = hex_grid_alpha(gx, gy, 3.0, 0.22) * 0.10 * np.clip(1.2 - r, 0, 1)
    base_a = 0.28
    arr[..., :3] = np.array(NAVY, np.float32) / 255 * (1 - glow_a[..., None] * 2) + tint * glow_a[..., None] * 2
    arr[..., 3] = base_a + glow_a + hexa
    arr[..., :3] = arr[..., :3] * (1 - hexa[..., None]) + tint * hexa[..., None]
    # vertical beams from the platform
    beam = np.exp(-((gx - w / 2) / 9.0) ** 2) * smoothstep(h * 0.30, h * 0.92, gy) * 0.16
    arr[..., :3] = arr[..., :3] * (1 - beam[..., None]) + tint * beam[..., None]
    arr[..., 3] = np.clip(arr[..., 3] + beam, 0, 1)
    c.paste_array(arr)
    # holo platform
    c.ellipse(w / 2 * k, (h - 6) * k, 17 * k, 3.4 * k, outline=rgba(CYAN, 0.95), width=0.7 * k, glow=1.4 * k, glow_a=0.7)
    c.ellipse(w / 2 * k, (h - 6) * k, 11 * k, 2.1 * k, outline=rgba(ICE, 0.6), width=0.45 * k)
    c.ellipse(w / 2 * k, (h - 6) * k, 20.5 * k, 4.3 * k, outline=rgba(CYAN, 0.35), width=0.4 * k)
    for ang in range(0, 360, 30):
        a = math.radians(ang)
        x0, y0 = w / 2 + math.cos(a) * 17, (h - 6) + math.sin(a) * 3.4
        x1, y1 = w / 2 + math.cos(a) * 19.5, (h - 6) + math.sin(a) * 4.1
        c.line([(x0 * k, y0 * k), (x1 * k, y1 * k)], rgba(CYAN, 0.6), 0.4 * k)
    # corner brackets
    br = rgba(CYAN, 0.9)
    L = 6
    for (x, y, sx, sy) in ((0.6, 0.6, 1, 1), (w - 0.6, 0.6, -1, 1), (0.6, h - 0.6, 1, -1), (w - 0.6, h - 0.6, -1, -1)):
        c.line([(x * k, (y + sy * L) * k), (x * k, y * k), ((x + sx * L) * k, y * k)], br, 0.7 * k)
    # side rulers
    for i in range(14):
        y = 8 + i * 3.6
        ln = 2.2 if i % 3 == 0 else 1.2
        c.line([(1.8 * k, y * k), ((1.8 + ln) * k, y * k)], rgba(CYAN, 0.45), 0.35 * k)
        c.line([((w - 1.8) * k, y * k), ((w - 1.8 - ln) * k, y * k)], rgba(CYAN, 0.45), 0.35 * k)
    save(c.result(), "armor_viewport")


def gen_scanbars():
    # horizontal holographic scan bar (armor view + scan panel sweep + boot sweep)
    def bar(w, h, col, k, name, core_a=0.95):
        W, H = int(w * k), int(h * k)
        c = Canvas(W, H)
        xs, ys = c.grid()
        gx, gy = xs / k, ys / k
        dy = np.abs(gy - h / 2) / (h / 2)
        ends = smoothstep(0.0, w * 0.18, gx) * smoothstep(0.0, w * 0.18, w - gx)
        a = (np.exp(-(dy * 2.6) ** 2) * 0.55 + np.exp(-(dy * 9) ** 2) * core_a) * ends
        arr = np.zeros(xs.shape + (4,), np.float32)
        core = np.exp(-(dy * 9) ** 2)
        cc = np.array(col, np.float32) / 255
        wc = np.array(WHITE, np.float32) / 255
        arr[..., :3] = cc * (1 - core[..., None] * 0.6) + wc * core[..., None] * 0.6
        arr[..., 3] = np.clip(a, 0, 1)
        c.paste_array(arr)
        save(c.result(), name)

    bar(46, 6, CYAN, 3, "armor_scanbar", 0.8)
    bar(146, 6, CYAN, 2, "scan_sweep")
    bar(226, 8, CYAN, 2, "boot_scan_2")
    bar(226, 8, RED, 2, "boot_scan_3")


# ======================================================================= GAUGES ==
def seg_bar(w, h, n, lit, col, k=3.0, skew=1.2, gap=1.0, vertical=False, cols=None):
    """Segmented bar; `lit` segments filled with `col` (or per-segment cols[i])."""
    if vertical:
        W, H = int(round(w * k)), int(round(h * k))
        c = Canvas(W, H)
        sh = (h - gap * (n - 1) - 1) / n
        for i in range(n):
            y1 = h - 0.5 - i * (sh + gap)
            y0 = y1 - sh
            pts = [(0.6 * k, y1 * k), ((w - 0.6) * k, (y1 - skew * 0.6) * k), ((w - 0.6) * k, (y0 - skew * 0.6) * k), (0.6 * k, y0 * k)]
            cc = cols[i] if cols else col
            if i < lit:
                c.poly(pts, fill=rgba(cc, 0.95), glow=0.9 * k, glow_a=0.55)
                c.poly(pts, outline=rgba(mix(cc, WHITE, 0.45), 0.9), width=0.35 * k)
            else:
                c.poly(pts, fill=rgba(cc, 0.10), outline=rgba(cc, 0.35), width=0.35 * k)
        return c.result()
    W, H = int(round(w * k)), int(round(h * k))
    c = Canvas(W, H)
    sw = (w - skew - gap * (n - 1) - 1) / n
    for i in range(n):
        x0 = 0.5 + i * (sw + gap)
        pts = [((x0 + skew) * k, 0.5 * k), ((x0 + skew + sw) * k, 0.5 * k), ((x0 + sw) * k, (h - 0.5) * k), (x0 * k, (h - 0.5) * k)]
        cc = cols[i] if cols else col
        if i < lit:
            c.poly(pts, fill=rgba(cc, 0.95))
            c.poly(pts, outline=rgba(mix(cc, WHITE, 0.5), 0.85), width=0.3 * k)
        else:
            c.poly(pts, fill=rgba(cc, 0.10), outline=rgba(cc, 0.32), width=0.3 * k)
    return c.result()


def level_col(frac):
    if frac <= 0.25:
        return RED
    if frac <= 0.5:
        return AMBER
    return CYAN


def gen_bars():
    for f in range(11):
        save(seg_bar(92, 5, 10, f, level_col(f / 10) if f else RED, k=3, skew=1.4), f"integrity_{f:02d}")
    for cls, col in CLASS_COL.items():
        for f in range(11):
            cc = col
            if cls != "h" and f <= 2:
                cc = mix(col, AMBER, 0.55)  # wounded non-hostile: warm tint
            save(seg_bar(140, 5, 10, f, cc, k=2, skew=1.5), f"hp_{cls}_{f:02d}")
    for f in range(11):
        blank(f"hp_0_{f:02d}")
    tcols = [mix(CYAN, ICE, i / 6) for i in range(7)] + [AMBER, AMBER, HOT]
    for f in range(11):
        save(seg_bar(8, 26, 10, f, CYAN, k=3, skew=1.0, gap=0.8, vertical=True, cols=tcols), f"thrust_{f:02d}")


def energy_seg_col(i):  # i = 1..20
    if i <= 2:
        return RED
    if i <= 5:
        return AMBER
    return mix(CYAN, ICE, (i - 6) / 14 * 0.7)


def gen_energy():
    D, k = 36, 4.0
    cx = cy = D / 2
    a_start, a_span = 135.0, 270.0
    n = 20
    gapdeg = 2.2
    seg = a_span / n
    for f in range(21):
        c = Canvas(int(D * k), int(D * k))
        for i in range(1, n + 1):
            a0 = a_start + (i - 1) * seg + gapdeg / 2
            a1 = a_start + i * seg - gapdeg / 2
            col = energy_seg_col(i)
            if i <= f:
                c.annulus_seg(cx * k, cy * k, 12.6 * k, 16.2 * k, a0, a1, fill=rgba(col, 0.97), glow=1.1 * k, glow_a=0.55)
                c.annulus_seg(cx * k, cy * k, 15.1 * k, 16.2 * k, a0, a1, fill=rgba(mix(col, WHITE, 0.55), 0.95))
            else:
                c.annulus_seg(cx * k, cy * k, 12.6 * k, 16.2 * k, a0, a1, fill=rgba(col, 0.08), outline=rgba(col, 0.30), width=0.3 * k)
        # tip marker on the last lit segment
        if f > 0:
            a = math.radians(a_start + f * seg - gapdeg / 2)
            p0 = (cx + math.cos(a) * 11.2, cy + math.sin(a) * 11.2)
            p1 = (cx + math.cos(a) * 17.6, cy + math.sin(a) * 17.6)
            c.line([(p0[0] * k, p0[1] * k), (p1[0] * k, p1[1] * k)], rgba(WHITE, 0.95), 0.6 * k, glow=0.8 * k)
        save(c.result(), f"energy_{f:02d}")

    for state, col in (("n", CYAN), ("w", AMBER), ("c", RED)):
        c = Canvas(int(D * k), int(D * k))
        # outer bezel + tick ring
        c.arc(cx * k, cy * k, 17.4 * k, 0, 360, rgba(col, 0.45), 0.35 * k)
        for i in range(0, 21, 5):
            a = math.radians(a_start + i * seg)
            c.line([((cx + math.cos(a) * 16.9) * k, (cy + math.sin(a) * 16.9) * k),
                    ((cx + math.cos(a) * 18.0) * k, (cy + math.sin(a) * 18.0) * k)], rgba(WHITE, 0.8), 0.45 * k)
        # bottom gap label bar
        c.line([((cx - 4) * k, (cy + 15.6) * k), ((cx + 4) * k, (cy + 15.6) * k)], rgba(col, 0.8), 0.6 * k)
        # arc reactor core (Mark V: round, segmented coil ring)
        c.ellipse(cx * k, cy * k, 10.4 * k, 10.4 * k, fill=rgba(NAVY, 0.75))
        c.ellipse(cx * k, cy * k, 9.6 * k, 9.6 * k, outline=rgba(mix(col, WHITE, 0.3), 0.85), width=0.45 * k, glow=0.8 * k)
        for i in range(10):
            a0 = i * 36 + 4
            c.annulus_seg(cx * k, cy * k, 5.4 * k, 8.6 * k, a0, a0 + 28, fill=rgba(col, 0.85), glow=1.0 * k, glow_a=0.6)
        c.ellipse(cx * k, cy * k, 4.4 * k, 4.4 * k, fill=rgba(mix(col, WHITE, 0.35), 0.9), glow=2.2 * k, glow_a=0.9)
        c.ellipse(cx * k, cy * k, 2.4 * k, 2.4 * k, fill=rgba(WHITE, 1.0))
        save(c.result(), f"energy_ring_{state}")

    # critical pulse halo
    P = 46
    c = Canvas(int(P * 3), int(P * 3))
    c.arc(P / 2 * 3, P / 2 * 3, 19.0 * 3, 0, 360, rgba(RED, 0.95), 2.4 * 3, glow=3.0 * 3, glow_a=1.0)
    save(c.result(), "energy_pulse")


def gen_leds():
    S, k = 7, 4.0
    for state in (0, 1):
        c = Canvas(int(S * k), int(S * k))
        m = S / 2
        if state:
            c.ellipse(m * k, m * k, 2.4 * k, 2.4 * k, fill=rgba(CYAN, 1.0), glow=1.3 * k, glow_a=0.95)
            c.ellipse(m * k, m * k, 1.1 * k, 1.1 * k, fill=rgba(WHITE, 1.0))
        else:
            c.ellipse(m * k, m * k, 2.3 * k, 2.3 * k, fill=rgba((34, 40, 48), 0.95), outline=rgba(STEEL, 0.9), width=0.45 * k)
            c.ellipse(m * k, m * k, 0.9 * k, 0.9 * k, fill=rgba((60, 68, 78), 0.9))
        save(c.result(), f"led_{state}")


# ====================================================================== RETICLE ==
def reticle(kind):
    D, k = 32, 4.0
    c = Canvas(int(D * k), int(D * k))
    m = D / 2

    def K(v):
        return v * k

    def dot(col, r=0.9):
        c.ellipse(K(m), K(m), K(r), K(r), fill=rgba(col, 1.0), glow=K(0.7), glow_a=0.8)

    def arcs(col, r, centers, span, w=0.8, a=0.95):
        for ctr in centers:
            c.arc(K(m), K(m), K(r), ctr - span / 2, ctr + span / 2, rgba(col, a), K(w), glow=K(1.0), glow_a=0.6)

    if kind == "i":
        col = CYAN
        arcs(col, 8.5, (45, 135, 225, 315), 58, 0.75)
        for ang in (0, 90, 180, 270):
            a = math.radians(ang)
            c.line([(K(m + math.cos(a) * 10.5), K(m + math.sin(a) * 10.5)), (K(m + math.cos(a) * 13.5), K(m + math.sin(a) * 13.5))], rgba(ICE, 0.9), K(0.7))
        dot(ICE, 0.85)
    elif kind == "h":
        col = RED
        arcs(col, 9.5, (45, 135, 225, 315), 50, 0.9)
        for ang in (0, 90, 180, 270):
            a = math.radians(ang)
            p = lambda r, da=0.0: (K(m + math.cos(a + da) * r), K(m + math.sin(a + da) * r))
            c.poly([p(5.2), p(9.4, 0.20), p(9.4, -0.20)], fill=rgba(col, 0.95), glow=K(0.8))
        for (sx, sy) in ((-1, -1), (1, -1), (-1, 1), (1, 1)):
            x, y = m + sx * 14.5, m + sy * 14.5
            c.line([(K(x), K(y - sy * 3.6)), (K(x), K(y)), (K(x - sx * 3.6), K(y))], rgba(col, 0.9), K(0.75), glow=K(0.8))
        dot(mix(RED, WHITE, 0.5), 0.9)
    elif kind == "n":
        col = WHITE
        arcs(col, 8.8, (0, 90, 180, 270), 50, 0.75, 0.9)
        c.line([(K(m - 15), K(m)), (K(m - 11), K(m))], rgba(col, 0.9), K(0.75))
        c.line([(K(m + 11), K(m)), (K(m + 15), K(m))], rgba(col, 0.9), K(0.75))
        dot(col, 0.85)
    elif kind == "p":
        col = GREEN
        c.arc(K(m), K(m), K(8.5), 0, 360, rgba(col, 0.85), K(0.6), glow=K(1.0))
        for ang in (0, 90, 180, 270):
            a = math.radians(ang)
            c.line([(K(m + math.cos(a) * 10.2), K(m + math.sin(a) * 10.2)), (K(m + math.cos(a) * 12.6), K(m + math.sin(a) * 12.6))], rgba(col, 0.9), K(0.7))
        dot(col, 0.85)
    elif kind == "j":
        col = ICE
        r = 10.0
        c.poly([(K(m), K(m - r)), (K(m + r), K(m)), (K(m), K(m + r)), (K(m - r), K(m))], outline=rgba(col, 0.95), width=K(0.75), glow=K(1.0))
        r2 = 4.2
        c.poly([(K(m), K(m - r2)), (K(m + r2), K(m)), (K(m), K(m + r2)), (K(m - r2), K(m))], outline=rgba(CYAN, 0.85), width=K(0.5))
        dot(WHITE, 0.8)
    elif kind == "l":
        col = AMBER
        arcs(col, 10.0, (45, 135, 225, 315), 40, 0.9)
        arcs(col, 13.2, (0, 90, 180, 270), 26, 0.55, 0.75)
        for ang in (0, 90, 180, 270):
            a = math.radians(ang)
            c.line([(K(m + math.cos(a) * 3.0), K(m + math.sin(a) * 3.0)), (K(m + math.cos(a) * 7.0), K(m + math.sin(a) * 7.0))], rgba(col, 0.95), K(0.7))
        dot(mix(AMBER, WHITE, 0.5), 0.75)
    elif kind == "k":
        col = RED
        c.arc(K(m), K(m), K(10.0), 0, 360, rgba(col, 0.95), K(1.0), glow=K(1.4), glow_a=0.8)
        c.arc(K(m), K(m), K(13.0), 0, 360, rgba(col, 0.6), K(0.5))
        r2 = 6.0
        c.poly([(K(m), K(m - r2)), (K(m + r2), K(m)), (K(m), K(m + r2)), (K(m - r2), K(m))], outline=rgba(mix(RED, WHITE, 0.35), 0.95), width=K(0.8), glow=K(1.0))
        for ang in (45, 135, 225, 315):
            a = math.radians(ang)
            c.line([(K(m + math.cos(a) * 1.2), K(m + math.sin(a) * 1.2)), (K(m + math.cos(a) * 3.0), K(m + math.sin(a) * 3.0))], rgba(WHITE, 0.95), K(0.6))
        for ang in (0, 90, 180, 270):
            a = math.radians(ang)
            c.line([(K(m + math.cos(a) * 13.6), K(m + math.sin(a) * 13.6)), (K(m + math.cos(a) * 15.6), K(m + math.sin(a) * 15.6))], rgba(col, 0.95), K(0.9))
    return c.result()


def gen_reticles():
    for kind in "ihnpjlk":
        save(reticle(kind), f"reticle_{kind}")


def gen_lock():
    D, k = 50, 3.0
    m = D / 2
    blank("lock_0")
    for f in range(1, 6):
        c = Canvas(int(D * k), int(D * k))
        col = RED if f == 5 else mix(AMBER, RED, (f - 1) / 6)
        frac = f / 5
        # background track + progress arc (from top, clockwise)
        c.arc(m * k, m * k, 21.5 * k, 0, 360, rgba(col, 0.18), 0.6 * k)
        c.arc(m * k, m * k, 21.5 * k, -90, -90 + 360 * frac, rgba(col, 0.95), 1.3 * k, glow=1.4 * k, glow_a=0.7)
        # segment ticks on the track
        for i in range(20):
            a = math.radians(-90 + i * 18)
            r0, r1 = 23.2, 24.3 if i % 5 == 0 else 23.8
            c.line([((m + math.cos(a) * r0) * k, (m + math.sin(a) * r0) * k), ((m + math.cos(a) * r1) * k, (m + math.sin(a) * r1) * k)], rgba(col, 0.55), 0.4 * k)
        # converging brackets
        d = 18.5 - (f - 1) * 1.6
        L = 4.2
        for (sx, sy) in ((-1, -1), (1, -1), (-1, 1), (1, 1)):
            x, y = m + sx * d * 0.72, m + sy * d * 0.72
            c.line([(x * k, (y - sy * L) * k), (x * k, y * k), ((x - sx * L) * k, y * k)], rgba(col, 0.95), 0.9 * k, glow=1.0 * k)
        if f == 5:
            for ang in (0, 90, 180, 270):
                a = math.radians(ang)
                px, py = m + math.cos(a) * 21.5, m + math.sin(a) * 21.5
                s = 1.8
                c.poly([(px * k, (py - s) * k), ((px + s) * k, py * k), (px * k, (py + s) * k), ((px - s) * k, py * k)], fill=rgba(mix(RED, WHITE, 0.4), 1.0), glow=1.0 * k)
        save(c.result(), f"lock_{f}")


def gen_reticle_ring():
    # 8-fold symmetric ring, ONE static frame (SPEC 11 item 3: no flip_book uv animation; the UI
    # gives it a slow alpha pulse instead of a rotation)
    D, k = 60, 1.6
    FR = 1
    fw = int(D * k)
    strip = Image.new("RGBA", (fw * FR, fw), (0, 0, 0, 0))
    m = D / 2
    for f in range(FR):
        rot = 0.0
        c = Canvas(fw, fw)
        K = lambda v: v * k
        for i in range(8):
            a0 = rot + i * 45
            c.arc(K(m), K(m), K(26.5), a0, a0 + 18, rgba(CYAN, 0.9), K(0.7))
            a = math.radians(a0 + 31.5)
            c.line([(K(m + math.cos(a) * 24.4), K(m + math.sin(a) * 24.4)), (K(m + math.cos(a) * 25.8), K(m + math.sin(a) * 25.8))], rgba(ICE, 0.8), K(0.5))
        # counter-rotating inner dashes (4-fold within the same period)
        for i in range(4):
            a0 = -rot * 2 + i * 90 + 30
            c.arc(K(m), K(m), K(21.0), a0, a0 + 10, rgba(CYAN, 0.55), K(0.45))
        strip.paste(c.result(), (f * fw, 0))
    save(alpha_bleed(strip), "reticle_ring")


def gen_radar():
    S, k = 12, 4.0
    m = S / 2

    def base(c):
        c.arc(m * k, m * k, 5.3 * k, 0, 360, rgba(CYAN, 0.9), 0.55 * k, glow=0.6 * k)
        c.arc(m * k, m * k, 2.9 * k, 0, 360, rgba(CYAN, 0.45), 0.35 * k)
        c.line([((m - 5.3) * k, m * k), ((m + 5.3) * k, m * k)], rgba(CYAN, 0.35), 0.3 * k)
        c.line([(m * k, (m - 5.3) * k), (m * k, (m + 5.3) * k)], rgba(CYAN, 0.35), 0.3 * k)

    c = Canvas(int(S * k), int(S * k))
    base(c)
    c.ellipse(m * k, m * k, 0.8 * k, 0.8 * k, fill=rgba(ICE, 1.0))
    c.ellipse((m + 2.6) * k, (m - 1.6) * k, 0.6 * k, 0.6 * k, fill=rgba(RED, 1.0), glow=0.5 * k)
    c.ellipse((m - 1.8) * k, (m + 2.4) * k, 0.55 * k, 0.55 * k, fill=rgba(GREEN, 1.0))
    save(c.result(), "radar_idle")
    # ONE static sweep frame (no flip_book uv animation: SPEC 11 item 3); the UI blinks it
    fw = int(S * k)
    FR = 1
    strip = Image.new("RGBA", (fw * FR, fw), (0, 0, 0, 0))
    for f in range(FR):
        c = Canvas(fw, fw)
        base(c)
        ang = -45.0
        for j in range(10):  # fading wedge trail
            a0 = ang - j * 6
            c.annulus_seg(m * k, m * k, 0.3 * k, 5.0 * k, a0 - 6, a0, fill=rgba(CYAN, 0.55 * (1 - j / 10)))
        a = math.radians(ang)
        c.line([(m * k, m * k), ((m + math.cos(a) * 5.3) * k, (m + math.sin(a) * 5.3) * k)], rgba(WHITE, 1.0), 0.5 * k, glow=0.6 * k)
        strip.paste(c.result(), (f * fw, 0))
    save(alpha_bleed(strip), "radar_sweep")


# ======================================================================= BANNERS ==
def banner(col, kind, w=204, h=15, k=3.0):
    c = Canvas(int(w * k), int(h * k))
    K = lambda v: v * k
    pts = [(K(5), K(0.6)), (K(w - 5), K(0.6)), (K(w - 0.6), K(h / 2)), (K(w - 5), K(h - 0.6)), (K(5), K(h - 0.6)), (K(0.6), K(h / 2))]
    c.poly(pts, fill=rgba(mix(NAVY, col, 0.22), 0.72))
    c.poly(pts, outline=rgba(col, 0.95), width=K(0.6), glow=K(1.0), glow_a=0.55)
    # inner highlight line
    c.line([(K(16), K(2.4)), (K(w - 22), K(2.4))], rgba(col, 0.35), K(0.4))
    # icon block on the left
    c.poly([(K(4), K(h / 2)), (K(7.5), K(1.6)), (K(16.5), K(1.6)), (K(16.5), K(h - 1.6)), (K(7.5), K(h - 1.6))], fill=rgba(col, 0.28))
    ix, iy = 11.0, h / 2
    if kind == "i":
        c.arc(K(ix), K(iy), K(4.6), 0, 360, rgba(col, 1.0), K(0.7))
        c.ellipse(K(ix), K(iy - 2.3), K(0.65), K(0.65), fill=rgba(WHITE, 1.0))
        c.line([(K(ix), K(iy - 0.6)), (K(ix), K(iy + 2.8))], rgba(WHITE, 1.0), K(1.0))
    else:
        tri = [(K(ix), K(iy - 4.8)), (K(ix + 5.2), K(iy + 4.2)), (K(ix - 5.2), K(iy + 4.2))]
        c.poly(tri, fill=rgba(col, 0.95), glow=K(0.9))
        c.line([(K(ix), K(iy - 1.9)), (K(ix), K(iy + 1.2))], rgba(NAVY, 1.0), K(1.0))
        c.ellipse(K(ix), K(iy + 2.7), K(0.6), K(0.6), fill=rgba(NAVY, 1.0))
    # right-end chevrons
    for i in range(3):
        x = w - 14 + i * 3
        c.line([(K(x), K(4.5)), (K(x + 2), K(h / 2)), (K(x), K(h - 4.5))], rgba(col, 0.4 + 0.2 * i), K(0.6))
    return c.result()


def gen_alerts():
    blank("alert_0")
    save(banner(CYAN, "i"), "alert_i")
    save(banner(AMBER, "w"), "alert_w")
    save(banner(RED, "c"), "alert_c")
    # flash overlay (critical blink)
    w, h, k = 204, 15, 2.0
    c = Canvas(int(w * k), int(h * k))
    xs, ys = c.grid()
    gx, gy = xs / k, ys / k
    a = (1 - np.abs(gy - h / 2) / (h / 2)) ** 0.6 * smoothstep(0, 30, gx) * smoothstep(0, 30, w - gx) * 0.55
    arr = np.zeros(xs.shape + (4,), np.float32)
    arr[..., :3] = np.array(RED, np.float32) / 255
    arr[..., 3] = a
    c.paste_array(arr)
    save(c.result(), "alert_flash")


def gen_compass_notch():
    """Compass housing: an opaque black tab that extends the user's top-centre helmet notch
    downwards (same pure black, so it reads as part of the helmet), with a thin cyan rail and an
    amber heading pointer on its lower edge. The compass tape text is drawn inside it."""
    w, h, k = 150, 12, 3.0
    c = Canvas(int(w * k), int(h * k))
    K = lambda v: v * k
    shape = rounded_poly([(-2, -2), (w + 2, -2), (w - 7, h - 0.6), (7, h - 0.6)], 3.2)
    c.poly([(K(x), K(y)) for (x, y) in shape], fill=(0, 0, 0, 255))
    # inner rail just above the lower edge, fading towards both ends
    n = 36
    for i in range(n):
        x0 = 12 + (w - 24) * i / n
        x1 = 12 + (w - 24) * (i + 1) / n
        t = 1 - abs((x0 + x1) / 2 - w / 2) / (w / 2 - 12)
        c.line([(K(x0), K(h - 2.0)), (K(x1), K(h - 2.0))], rgba(CYAN, 0.75 * max(t, 0) ** 0.9), K(0.45))
    # slanted side accents following the tab edges
    for sx in (-1, 1):
        xa, xb = w / 2 + sx * (w / 2 - 2.5), w / 2 + sx * (w / 2 - 8.5)
        c.line([(K(xa), K(1.5)), (K(xb), K(h - 3.0))], rgba(CYAN, 0.55), K(0.45))
    # heading pointer (amber) on the rail
    c.poly([(K(w / 2 - 2.2), K(h - 0.9)), (K(w / 2 + 2.2), K(h - 0.9)), (K(w / 2), K(h - 3.4))], fill=rgba(AMBER, 1.0))
    save(c.result(), "compass_notch")


def tag(w, h, col, name, fill_mix=0.22):
    """Small hexagonal tag (label plate)."""
    k = 3.0
    c = Canvas(int(w * k), int(h * k))
    K = lambda v: v * k
    pts = [(K(3.5), K(0.6)), (K(w - 3.5), K(0.6)), (K(w - 0.6), K(h / 2)), (K(w - 3.5), K(h - 0.6)), (K(3.5), K(h - 0.6)), (K(0.6), K(h / 2))]
    c.poly(pts, fill=rgba(mix(NAVY, col, fill_mix), 0.78), outline=rgba(col, 0.95), width=K(0.5), glow=K(0.8), glow_a=0.5)
    save(c.result(), name)


def gen_integrity_extras():
    # blinking "ARMADURA CRÍTICA" plate next to the big resistance readout
    tag(54, 10, RED, "armor_crit_tag", 0.35)

def gen_lock_tag():
    w, h, k = 86, 10, 3.0
    c = Canvas(int(w * k), int(h * k))
    K = lambda v: v * k
    pts = [(K(4), K(0.6)), (K(w - 4), K(0.6)), (K(w - 0.6), K(h / 2)), (K(w - 4), K(h - 0.6)), (K(4), K(h - 0.6)), (K(0.6), K(h / 2))]
    c.poly(pts, fill=rgba(mix(NAVY, AMBER, 0.18), 0.6), outline=rgba(AMBER, 0.9), width=K(0.5), glow=K(0.8), glow_a=0.45)
    for sx in (-1, 1):
        x = w / 2 + sx * (w / 2 - 6.5)
        s = 1.6
        c.poly([(K(x), K(h / 2 - s)), (K(x + s), K(h / 2)), (K(x), K(h / 2 + s)), (K(x - s), K(h / 2))], fill=rgba(AMBER, 1.0))
    save(c.result(), "lock_tag")


def gen_flight_badges():
    S, k = 24, 3.0
    m = S / 2
    blank("flight_0")
    for mode, col in (("h", CYAN), ("f", CYAN), ("b", AMBER), ("e", RED)):
        c = Canvas(int(S * k), int(S * k))
        K = lambda v: v * k
        c.ellipse(K(m), K(m), K(10.6), K(10.6), fill=rgba(NAVY, 0.7))
        c.arc(K(m), K(m), K(10.6), 0, 360, rgba(col, 0.95), K(0.8), glow=K(1.1), glow_a=0.6)
        for i in range(12):
            a = math.radians(i * 30)
            c.line([(K(m + math.cos(a) * 8.8), K(m + math.sin(a) * 8.8)), (K(m + math.cos(a) * 9.6), K(m + math.sin(a) * 9.6))], rgba(col, 0.5), K(0.4))
        if mode == "h":
            c.line([(K(m - 5.5), K(m - 2.5)), (K(m + 5.5), K(m - 2.5))], rgba(WHITE, 1.0), K(1.0))
            for dx in (-3.5, 0, 3.5):
                c.poly([(K(m + dx - 1.4), K(m - 0.6)), (K(m + dx + 1.4), K(m - 0.6)), (K(m + dx), K(m + 4.8))], fill=rgba(mix(col, WHITE, 0.3), 0.95), glow=K(0.8))
        elif mode == "f":
            c.line([(K(m - 5), K(m + 2.5)), (K(m), K(m - 3.5)), (K(m + 5), K(m + 2.5))], rgba(WHITE, 1.0), K(1.3), glow=K(0.8))
            c.line([(K(m - 3.2), K(m + 5.6)), (K(m), K(m + 2.0)), (K(m + 3.2), K(m + 5.6))], rgba(col, 0.8), K(0.8))
        elif mode == "b":
            for dy in (-3.2, 1.0):
                c.line([(K(m - 5), K(m + dy + 3.5)), (K(m), K(m + dy - 1.5)), (K(m + 5), K(m + dy + 3.5))], rgba(WHITE if dy < 0 else col, 1.0), K(1.2), glow=K(0.9))
            c.poly([(K(m - 1.6), K(m + 5.5)), (K(m + 1.6), K(m + 5.5)), (K(m), K(m + 8.8))], fill=rgba(HOT, 0.95), glow=K(0.9))
        elif mode == "e":
            c.line([(K(m), K(m - 6)), (K(m), K(m + 3))], rgba(WHITE, 1.0), K(1.2))
            c.line([(K(m - 3.6), K(m - 0.2)), (K(m), K(m + 3.8)), (K(m + 3.6), K(m - 0.2))], rgba(WHITE, 1.0), K(1.2))
            c.line([(K(m - 5.5), K(m + 6.2)), (K(m + 5.5), K(m + 6.2))], rgba(col, 1.0), K(1.0), glow=K(0.9))
        save(c.result(), f"flight_{mode}")


def gen_boot_extras():
    S, k = 26, 3.0
    m = S / 2
    for mode, col in (("2", CYAN), ("3", RED)):
        c = Canvas(int(S * k), int(S * k))
        K = lambda v: v * k
        c.arc(K(m), K(m), K(11.6), 0, 360, rgba(col, 0.5), K(0.4))
        for i in range(10):
            a0 = i * 36 + 4
            alive = mode == "2" or i in (0, 3, 4, 8)
            c.annulus_seg(K(m), K(m), K(6.2), K(9.8), a0, a0 + 28, fill=rgba(col, 0.9 if alive else 0.15), glow=K(1.0) if alive else 0)
        core = mix(col, WHITE, 0.4) if mode == "2" else (70, 30, 30)
        c.ellipse(K(m), K(m), K(4.6), K(4.6), fill=rgba(core, 0.95), glow=K(2.0) if mode == "2" else 0)
        if mode == "3":
            # crack across the reactor
            c.line([(K(m - 7), K(m - 5)), (K(m - 1), K(m - 0.5)), (K(m + 1), K(m + 2)), (K(m + 7), K(m + 6))], rgba(WHITE, 0.8), K(0.5))
        save(c.result(), f"boot_ring_{mode}")
    # loading bar: ONE static frame of a 64x5 segmented bar (no flip_book uv animation: SPEC 11
    # item 3; the UI pulses its alpha). Boot: bright ramp toward the right; failure: alternating.
    w, h, k, FR = 64, 5, 2.0, 1
    fw = int(w * k)
    for mode, col in (("2", CYAN), ("3", RED)):
        strip = Image.new("RGBA", (fw * FR, int(h * k)), (0, 0, 0, 0))
        for f in range(FR):
            c = Canvas(fw, int(h * k))
            n = 16
            sw = (w - n + 1) / n
            for i in range(n):
                x0 = i * (sw + 1)
                inten = (0.35 + 0.65 * i / (n - 1)) if mode == "2" else (0.9 if (i % 2 == 0) else 0.25)
                c.poly([((x0 + 1) * k, 0.5 * k), ((x0 + 1 + sw) * k, 0.5 * k), ((x0 + sw) * k, (h - 0.5) * k), (x0 * k, (h - 0.5) * k)],
                       fill=rgba(col, 0.15 + 0.8 * inten))
            strip.paste(c.result(), (f * fw, 0))
        save(alpha_bleed(strip), f"boot_load_{mode}")
    # The boot overlay picks its textures by HUD mode; in modes 0/1 it is hidden but its bindings
    # still compute a path, so those paths must exist too (transparent placeholders).
    for mode in ("0", "1"):
        for name in ("boot_frame", "boot_ring", "boot_load", "boot_scan"):
            blank(f"{name}_{mode}")


# =================================================================== MENU ICONS ==
def icon_base(S=64, col=CYAN):
    """64x64 icon: coordinates are output texels (supersampled internally)."""
    c = Canvas(S, S)
    m = S / 2
    c.ellipse(m, m, 29.5, 29.5, fill=rgba(NAVY, 0.88))
    xs, ys = c.grid()
    r = np.sqrt((xs - m) ** 2 + (ys - m) ** 2)
    arr = np.zeros(xs.shape + (4,), np.float32)
    arr[..., :3] = np.array(col, np.float32) / 255
    arr[..., 3] = np.clip(1 - r / 29.5, 0, 1) ** 2 * 0.25 * (r < 29.5)
    c.paste_array(arr)
    hx = hex_grid_alpha(xs, ys, 4.0, 0.35) * (r < 28) * 0.10
    arr2 = np.zeros(xs.shape + (4,), np.float32)
    arr2[..., :3] = np.array(col, np.float32) / 255
    arr2[..., 3] = hx
    c.paste_array(arr2)
    c.arc(m, m, 29.5, 0, 360, rgba(col, 0.95), 1.6, glow=2.0, glow_a=0.6)
    c.arc(m, m, 26.2, -60, 60, rgba(col, 0.5), 0.8)
    c.arc(m, m, 26.2, 120, 240, rgba(col, 0.5), 0.8)
    return c, m


def gen_icons():
    # icon_visor: Mark V faceplate with lift arrow
    c, m = icon_base()
    gold = (226, 170, 60)
    red = (190, 40, 40)
    face = [(m - 13, m - 14), (m + 13, m - 14), (m + 15, m - 4), (m + 12, m + 9), (m + 6, m + 17), (m - 6, m + 17), (m - 12, m + 9), (m - 15, m - 4)]
    c.poly(face, fill=rgba(red, 1.0), outline=rgba((255, 120, 110), 0.9), width=1.0)
    plate = [(m - 9, m - 11), (m + 9, m - 11), (m + 11, m - 2), (m + 8, m + 9), (m + 4, m + 14), (m - 4, m + 14), (m - 8, m + 9), (m - 11, m - 2)]
    c.poly(plate, fill=rgba(gold, 1.0), outline=rgba((255, 225, 140), 0.9), width=0.8)
    c.poly([(m - 9, m - 3), (m - 2.5, m - 1.5), (m - 3, m + 0.6), (m - 8.6, m - 0.8)], fill=rgba(ICE, 1.0), glow=2.0, glow_a=0.9)
    c.poly([(m + 9, m - 3), (m + 2.5, m - 1.5), (m + 3, m + 0.6), (m + 8.6, m - 0.8)], fill=rgba(ICE, 1.0), glow=2.0, glow_a=0.9)
    c.line([(m - 4, m + 9), (m + 4, m + 9)], rgba((120, 80, 30), 1.0), 1.0)
    c.line([(m + 17, m - 6), (m + 17, m - 17)], rgba(CYAN, 1.0), 2.0, glow=1.5)
    c.line([(m + 13.5, m - 13.5), (m + 17, m - 17.5), (m + 20.5, m - 13.5)], rgba(CYAN, 1.0), 2.0, glow=1.5)
    save(c.result(), "icon_visor", UI_DIR)

    # icon_hud: visor rectangle with brackets + reticle
    c, m = icon_base()
    for (sx, sy) in ((-1, -1), (1, -1), (-1, 1), (1, 1)):
        x, y = m + sx * 17, m + sy * 12
        c.line([(x, y - sy * 6), (x, y), (x - sx * 7, y)], rgba(CYAN, 1.0), 1.8, glow=1.5)
    c.arc(m, m, 7.0, 0, 360, rgba(ICE, 1.0), 1.4, glow=1.5)
    for ang in (0, 90, 180, 270):
        a = math.radians(ang)
        c.line([(m + math.cos(a) * 9, m + math.sin(a) * 9), (m + math.cos(a) * 12.5, m + math.sin(a) * 12.5)], rgba(ICE, 1.0), 1.4)
    c.ellipse(m, m, 1.5, 1.5, fill=rgba(WHITE, 1.0))
    c.line([(m - 14, m - 7), (m - 9, m - 7)], rgba(AMBER, 1.0), 1.2)
    c.line([(m + 9, m + 7), (m + 14, m + 7)], rgba(AMBER, 1.0), 1.2)
    save(c.result(), "icon_hud", UI_DIR)

    # icon_flight: boot thruster with flame + up arrow
    c, m = icon_base()
    boot = [(m - 7, m - 12), (m + 3, m - 12), (m + 4, m + 1), (m + 10, m + 4), (m + 10, m + 8), (m - 8, m + 8)]
    c.poly(boot, fill=rgba((150, 30, 30), 1.0), outline=rgba((255, 120, 110), 0.95), width=1.0)
    c.line([(m - 7, m - 4), (m + 3.5, m - 4)], rgba((226, 170, 60), 1.0), 1.4)
    for i, (dx, ln) in enumerate(((-5, 13), (0, 17), (5, 12))):
        c.poly([(m + dx - 3, m + 9), (m + dx + 3, m + 9), (m + dx, m + 9 + ln)], fill=rgba(HOT, 0.95), glow=2.5, glow_a=0.8)
        c.poly([(m + dx - 1.5, m + 9), (m + dx + 1.5, m + 9), (m + dx, m + 9 + ln * 0.6)], fill=rgba((255, 240, 200), 1.0))
    c.ellipse(m, m + 9.5, 9.5, 2.2, fill=rgba(ICE, 0.95), glow=2.0)
    c.line([(m + 16, m + 2), (m + 16, m - 16)], rgba(CYAN, 1.0), 2.0, glow=1.5)
    c.line([(m + 12, m - 12), (m + 16, m - 16.5), (m + 20, m - 12)], rgba(CYAN, 1.0), 2.0, glow=1.5)
    save(c.result(), "icon_flight", UI_DIR)

    # icon_scan: radar with sweep and blips
    c, m = icon_base()
    for r, a in ((19, 0.9), (13, 0.6), (7, 0.45)):
        c.arc(m, m, r, 0, 360, rgba(CYAN, a), 1.0)
    c.line([(m - 20, m), (m + 20, m)], rgba(CYAN, 0.35), 0.7)
    c.line([(m, m - 20), (m, m + 20)], rgba(CYAN, 0.35), 0.7)
    for j in range(14):
        a0 = -50 - j * 5
        c.annulus_seg(m, m, 1, 18.5, a0 - 5, a0, fill=rgba(CYAN, 0.6 * (1 - j / 14)))
    a = math.radians(-50)
    c.line([(m, m), (m + math.cos(a) * 19, m + math.sin(a) * 19)], rgba(WHITE, 1.0), 1.4, glow=1.5)
    c.ellipse(m + 9, m - 9, 2.2, 2.2, fill=rgba(RED, 1.0), glow=2.0, glow_a=0.9)
    c.ellipse(m - 10, m + 6, 1.9, 1.9, fill=rgba(GREEN, 1.0), glow=1.6)
    c.ellipse(m + 5, m + 12, 1.7, 1.7, fill=rgba(WHITE, 1.0), glow=1.4)
    save(c.result(), "icon_scan", UI_DIR)

    # icon_lock: homing reticle with diamond + converging brackets
    c, m = icon_base(col=RED)
    c.arc(m, m, 12, 0, 360, rgba(RED, 1.0), 1.6, glow=2.0)
    r2 = 6.5
    c.poly([(m, m - r2), (m + r2, m), (m, m + r2), (m - r2, m)], outline=rgba((255, 170, 160), 1.0), width=1.3)
    c.ellipse(m, m, 1.4, 1.4, fill=rgba(WHITE, 1.0))
    for (sx, sy) in ((-1, -1), (1, -1), (-1, 1), (1, 1)):
        x, y = m + sx * 17, m + sy * 17
        c.line([(x, y - sy * 6), (x, y), (x - sx * 6, y)], rgba(AMBER, 1.0), 1.8, glow=1.4)
    for ang in (0, 90, 180, 270):
        a = math.radians(ang)
        c.line([(m + math.cos(a) * 14, m + math.sin(a) * 14), (m + math.cos(a) * 18, m + math.sin(a) * 18)], rgba(RED, 1.0), 1.4)
    save(c.result(), "icon_lock", UI_DIR)

    # icon_diag: arc reactor + ECG power trace
    c, m = icon_base()
    c.ellipse(m, m - 5, 10, 10, fill=rgba(NAVY, 1.0), outline=rgba(ICE, 0.9), width=1.0)
    for i in range(10):
        a0 = i * 36 + 4
        c.annulus_seg(m, m - 5, 5.0, 8.4, a0, a0 + 28, fill=rgba(CYAN, 0.95), glow=1.4, glow_a=0.6)
    c.ellipse(m, m - 5, 3.8, 3.8, fill=rgba(ICE, 1.0), glow=3.0, glow_a=0.9)
    trace = [(m - 21, m + 12), (m - 9, m + 12), (m - 6, m + 7), (m - 3, m + 18), (m + 1, m + 4), (m + 4, m + 14), (m + 7, m + 12), (m + 21, m + 12)]
    c.line(trace, rgba(GREEN, 1.0), 1.4, glow=1.6, glow_a=0.8)
    save(c.result(), "icon_diag", UI_DIR)

    # icon_suitoff: the Mark V suitcase + down arrow
    c, m = icon_base(col=AMBER)
    case = [(m - 15, m - 4), (m + 15, m - 4), (m + 15, m + 15), (m - 15, m + 15)]
    c.poly(case, fill=rgba((176, 182, 190), 1.0), outline=rgba((235, 240, 245), 1.0), width=1.0)
    c.line([(m - 15, m + 3), (m + 15, m + 3)], rgba((120, 20, 20), 1.0), 2.4)
    c.line([(m - 15, m + 3), (m + 15, m + 3)], rgba((226, 170, 60), 1.0), 0.8)
    c.line([(m - 5, m - 4), (m - 5, m - 8), (m + 5, m - 8), (m + 5, m - 4)], rgba((235, 240, 245), 1.0), 1.6)
    c.ellipse(m, m + 9, 2.4, 2.4, fill=rgba(CYAN, 1.0), glow=2.0)
    c.line([(m, m - 22), (m, m - 11)], rgba(AMBER, 1.0), 2.0, glow=1.4)
    c.line([(m - 4.5, m - 15.5), (m, m - 10.5), (m + 4.5, m - 15.5)], rgba(AMBER, 1.0), 2.0, glow=1.4)
    save(c.result(), "icon_suitoff", UI_DIR)


# ========================================================================= MAIN ==
def clean_stale():
    for base in (HUD_DIR, UI_DIR):
        keep = {os.path.join(RP, p) for p in written}
        for dirpath, _, files in os.walk(base):
            for fn in files:
                full = os.path.join(dirpath, fn)
                if full not in keep and fn.endswith(".png"):
                    os.remove(full)


def main():
    gen_visor_base()
    gen_danger()
    gen_panels()
    gen_viewport()
    gen_scanbars()
    gen_bars()
    gen_energy()
    gen_leds()
    gen_reticles()
    gen_lock()
    gen_reticle_ring()
    gen_radar()
    gen_alerts()
    gen_compass_notch()
    gen_integrity_extras()
    gen_lock_tag()
    gen_flight_badges()
    gen_boot_extras()
    gen_icons()
    clean_stale()
    total = sum(os.path.getsize(os.path.join(RP, p)) for p in written)
    print(f"wrote {len(written)} PNGs ({total / 1024:.1f} KiB)")


if __name__ == "__main__":
    sys.exit(main())
