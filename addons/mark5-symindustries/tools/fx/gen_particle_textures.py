#!/usr/bin/env python3
"""Mark V FX — particle texture atlas generator (idempotent, deterministic).

Writes:
  pack/Mark5_RP/textures/sym/particle/mk5_fx.png   (256x384 RGBA atlas)
  dist/fx_atlas_preview.png                         (labelled preview on dark + light bg)

Every cell is rendered at 4x supersampling and box-filtered down (premultiplied),
so edges are smooth even though Bedrock samples particles with point filtering.
Glow-type cells are white RGB with the intensity in alpha (tinted in the particle
JSON); smoke/dust/debris cells carry grey shading in RGB.

The cell table ATLAS below is the single source of truth for UV rectangles and is
imported by gen_particles.py.
"""
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
B = os.path.abspath(os.path.join(HERE, "..", ".."))
OUT = os.path.join(B, "pack", "Mark5_RP", "textures", "sym", "particle", "mk5_fx.png")
PREVIEW = os.path.join(B, "dist", "fx_atlas_preview.png")

ATLAS_W, ATLAS_H = 256, 576
SS = 4  # supersampling

# name -> (x, y, w, h) in atlas pixels
ATLAS = {
    "burst": (0, 0, 64, 64),
    "ring_soft": (64, 0, 64, 64),
    "hex_shield": (128, 0, 64, 64),
    "brackets": (192, 0, 64, 64),
    "lock": (0, 64, 64, 64),
    "boom": (64, 64, 64, 64),
    "glow_soft": (128, 64, 32, 32),
    "glow_star": (160, 64, 32, 32),
    "spark": (192, 64, 32, 32),
    "debris": (224, 64, 32, 32),
    "smoke_0": (128, 96, 32, 32),
    "smoke_1": (160, 96, 32, 32),
    "smoke_2": (192, 96, 32, 32),
    "smoke_3": (224, 96, 32, 32),
}
for i in range(8):
    ATLAS[f"flame_{i}"] = (i * 32, 128, 32, 32)
for i in range(4):
    ATLAS[f"arc_{i}"] = (i * 32, 160, 32, 32)
for i in range(4):
    ATLAS[f"dust_{i}"] = (128 + i * 32, 160, 32, 32)
ATLAS["ring_thin"] = (0, 192, 64, 64)
ATLAS["ring_tech"] = (64, 192, 64, 64)
ATLAS["ring_fire"] = (128, 192, 64, 64)
ATLAS["flash"] = (192, 192, 64, 64)
# 128 px rings for the 32-block scanner pulse (quad up to ~71 blocks wide)
ATLAS["ring_wave"] = (0, 256, 128, 128)
ATLAS["ring_tech_hd"] = (128, 256, 128, 128)
# SPEC 12.4 "clean" set: hard-edged shapes, no noise — shockwave rings, needles, chunks, dots
ATLAS["ring_crisp"] = (0, 384, 128, 128)
ATLAS["ring_dust"] = (128, 384, 128, 128)
ATLAS["streak"] = (0, 512, 32, 32)
ATLAS["chunk"] = (32, 512, 32, 32)
ATLAS["dot"] = (64, 512, 32, 32)
ATLAS["puff"] = (96, 512, 32, 32)


def _assert_no_overlap():
    """Cells silently overwriting each other used to be invisible until rendered (lock vs row 96)."""
    rects = sorted(ATLAS.items())
    for i, (n1, (x1, y1, w1, h1)) in enumerate(rects):
        assert 0 <= x1 and 0 <= y1 and x1 + w1 <= ATLAS_W and y1 + h1 <= ATLAS_H, f"{n1} outside atlas"
        for n2, (x2, y2, w2, h2) in rects[i + 1:]:
            if x1 < x2 + w2 and x2 < x1 + w1 and y1 < y2 + h2 and y2 < y1 + h1:
                raise AssertionError(f"atlas cells overlap: {n1} {ATLAS[n1]} / {n2} {ATLAS[n2]}")


_assert_no_overlap()


# ----------------------------------------------------------------------------- helpers
def grid(w, h):
    """Normalized coords: x,y in [-1,1] (y down), r radius, a angle."""
    W, H = w * SS, h * SS
    ys, xs = np.mgrid[0:H, 0:W].astype(np.float64)
    x = (xs + 0.5) / W * 2 - 1
    y = (ys + 0.5) / H * 2 - 1
    r = np.sqrt(x * x + y * y)
    a = np.arctan2(y, x)
    return x, y, r, a


def smooth(e0, e1, v):
    t = np.clip((v - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def gauss(v, mu, sigma):
    return np.exp(-0.5 * ((v - mu) / sigma) ** 2)


def value_noise(shape, cells, rng, periodic_x=False):
    """Smooth value noise sampled on an (H,W) grid with `cells` lattice cells per axis."""
    H, W = shape
    gw = cells + 1
    lat = rng.random((gw + 1, gw + 1))
    if periodic_x:
        lat[:, cells] = lat[:, 0]
    ys = np.linspace(0, cells, H, endpoint=False)
    xs = np.linspace(0, cells, W, endpoint=False)
    yi = np.floor(ys).astype(int)
    xi = np.floor(xs).astype(int)
    fy = ys - yi
    fx = xs - xi
    fy = fy * fy * (3 - 2 * fy)
    fx = fx * fx * (3 - 2 * fx)
    a = lat[yi][:, xi]
    b = lat[yi][:, xi + 1]
    c = lat[yi + 1][:, xi]
    d = lat[yi + 1][:, xi + 1]
    top = a + (b - a) * fx[None, :]
    bot = c + (d - c) * fx[None, :]
    return top + (bot - top) * fy[:, None]


def fbm(shape, base_cells, octaves, rng, periodic_x=False):
    out = np.zeros(shape)
    amp, tot = 1.0, 0.0
    cells = base_cells
    for _ in range(octaves):
        out += amp * value_noise(shape, cells, rng, periodic_x)
        tot += amp
        amp *= 0.5
        cells *= 2
    return out / tot


def seg_dist(px, py, ax, ay, bx, by):
    """Distance from points to segment AB."""
    abx, aby = bx - ax, by - ay
    t = ((px - ax) * abx + (py - ay) * aby) / max(abx * abx + aby * aby, 1e-12)
    t = np.clip(t, 0, 1)
    dx = px - (ax + t * abx)
    dy = py - (ay + t * aby)
    return np.sqrt(dx * dx + dy * dy)


def polyline_dist(px, py, pts):
    d = np.full(px.shape, 1e9)
    for (ax, ay), (bx, by) in zip(pts[:-1], pts[1:]):
        d = np.minimum(d, seg_dist(px, py, ax, ay, bx, by))
    return d


def line_alpha(d, half_w, glow_w, glow_amt=0.45):
    """Crisp line core (anti-aliased by supersampling) + soft exponential glow."""
    core = (d <= half_w).astype(np.float64)
    glow = np.exp(-np.maximum(d - half_w, 0) / glow_w) * glow_amt
    return np.clip(np.maximum(core, glow), 0, 1)


def down(rgb, alpha, w, h):
    """Premultiplied box downsample from SS-res to (w,h). rgb float 0..1 (H,W,3), alpha (H,W)."""
    pre = rgb * alpha[..., None]
    pre = pre.reshape(h, SS, w, SS, 3).mean(axis=(1, 3))
    al = alpha.reshape(h, SS, w, SS).mean(axis=(1, 3))
    out_rgb = np.where(al[..., None] > 1e-6, pre / np.maximum(al[..., None], 1e-6), 1.0)
    return out_rgb, al


def white(alpha):
    return np.ones(alpha.shape + (3,))


# ----------------------------------------------------------------------------- cells
def cell_ring_wave(w, h, rng):
    x, y, r, a = grid(w, h)
    r0 = 0.9
    rim = line_alpha(np.abs(r - r0), 0.022, 0.03, 0.55)
    trail = np.where(r < r0, np.exp(-(r0 - r) / 0.16) * 0.32, 0)
    alpha = np.clip(rim + trail, 0, 1) * (1 - smooth(0.97, 1.0, r))
    return white(alpha), alpha


def cell_ring_soft(w, h, rng):
    x, y, r, a = grid(w, h)
    H, W = r.shape
    # polar noise so the turbulence follows the ring
    n = fbm((H, W), 5, 4, rng)
    ang = (a + np.pi) / (2 * np.pi)
    # angular noise (periodic): sample a 1D periodic noise by angle
    k = 64
    lat = rng.random(k + 1)
    lat[k] = lat[0]
    p = ang * k
    i0 = np.floor(p).astype(int) % k
    f = p - np.floor(p)
    f = f * f * (3 - 2 * f)
    an = lat[i0] + (lat[i0 + 1] - lat[i0]) * f
    mu = 0.70 + (an - 0.5) * 0.08
    prof = gauss(r, mu, 0.12 + 0.05 * n)
    alpha = prof * (0.55 + 0.45 * n) * (0.75 + 0.25 * an)
    alpha *= 1 - smooth(0.9, 1.0, r)
    alpha = np.clip(alpha * 1.25, 0, 1)
    shade = 0.82 + 0.18 * n
    rgb = np.stack([shade] * 3, -1)
    return rgb, alpha


def hexagon_dist(x, y, R):
    """Signed-ish distance to a flat-top regular hexagon outline of circumradius R."""
    q = np.abs(x)
    p = np.abs(y)
    # flat-top hexagon: edges at |y| = R*sin60, and slanted edges
    s60 = np.sqrt(3) / 2
    d1 = p - R * s60
    d2 = (q * s60 + p * 0.5) - R * s60
    return np.maximum(d1, d2)


def cell_hex_shield(w, h, rng):
    x, y, r, a = grid(w, h)
    R = 0.95
    d = hexagon_dist(x, y, R)
    outline = line_alpha(np.abs(d + 0.02), 0.022, 0.035, 0.6)
    inside = (d < 0).astype(np.float64)
    # inner lattice of small hexes (pointy-top honeycomb)
    s = 0.19
    hx = x / (s * np.sqrt(3))
    hy = y / (s * 1.5)
    # axial rounding
    qf = (np.sqrt(3) / 3 * x - 1.0 / 3 * y) / s
    rf = (2.0 / 3 * y) / s
    xf, zf = qf, rf
    yf = -xf - zf
    rx, ry, rz = np.round(xf), np.round(yf), np.round(zf)
    dx, dy, dz = np.abs(rx - xf), np.abs(ry - yf), np.abs(rz - zf)
    m1 = (dx > dy) & (dx > dz)
    m2 = (~m1) & (dy > dz)
    rx = np.where(m1, -ry - rz, rx)
    ry = np.where(m2, -rx - rz, ry)
    rz = np.where(~m1 & ~m2, -rx - ry, rz)
    cx = s * np.sqrt(3) * (rx + rz / 2)
    cy = s * 1.5 * rz
    lx, ly = x - cx, y - cy
    # distance to the cell border (pointy-top hex => swap axes of flat-top)
    cd = hexagon_dist(ly, lx, s * 0.98)
    lattice = line_alpha(np.abs(cd), 0.008, 0.02, 0.5) * 0.45
    fres = smooth(0.15, 1.0, np.clip(-d / R, 0, 1) * -1 + 1)  # brighter near the edge
    fill = 0.10 + 0.22 * fres
    alpha = np.maximum(outline, inside * np.clip(fill + lattice * (0.4 + 0.6 * fres), 0, 1))
    return white(alpha), np.clip(alpha, 0, 1)


def cell_brackets(w, h, rng):
    x, y, r, a = grid(w, h)
    L = 0.42  # arm length (of the 2-unit side)
    t = 0.035  # half thickness
    e = 0.93  # corner position
    d = np.full(x.shape, 1e9)
    for sx in (-1, 1):
        for sy in (-1, 1):
            cx, cy = sx * e, sy * e
            d = np.minimum(d, seg_dist(x, y, cx, cy, cx - sx * L, cy))
            d = np.minimum(d, seg_dist(x, y, cx, cy, cx, cy - sy * L))
    alpha = line_alpha(d, t, 0.03, 0.35)
    # small centre ticks on the edges (tech look)
    tick = np.full(x.shape, 1e9)
    for (ax, ay, bx, by) in ((0, -e, 0, -e + 0.08), (0, e, 0, e - 0.08), (-e, 0, -e + 0.08, 0), (e, 0, e - 0.08, 0)):
        tick = np.minimum(tick, seg_dist(x, y, ax, ay, bx, by))
    alpha = np.maximum(alpha, line_alpha(tick, 0.02, 0.02, 0.25) * 0.8)
    return white(alpha), alpha


def cell_lock(w, h, rng):
    x, y, r, a = grid(w, h)
    # diamond = L1 norm
    l1 = np.abs(x) + np.abs(y)
    outer = line_alpha(np.abs(l1 - 0.86), 0.03, 0.035, 0.5)
    # cut gaps at the 4 tips
    tipgap = (np.minimum(np.abs(x), np.abs(y)) < 0.10)
    outer = np.where(tipgap, 0, outer)
    inner = line_alpha(np.abs(l1 - 0.42), 0.022, 0.03, 0.45) * 0.85
    # inner ticks pointing to the centre from each tip
    tick = np.full(x.shape, 1e9)
    for (ax, ay, bx, by) in ((0, -0.98, 0, -0.62), (0, 0.98, 0, 0.62), (-0.98, 0, -0.62, 0), (0.98, 0, 0.62, 0)):
        tick = np.minimum(tick, seg_dist(x, y, ax, ay, bx, by))
    ticks = line_alpha(tick, 0.03, 0.03, 0.45)
    dot = gauss(r, 0, 0.05)
    alpha = np.clip(np.maximum.reduce([outer, inner, ticks, dot]), 0, 1)
    return white(alpha), alpha


def cell_boom(w, h, rng):
    x, y, r, a = grid(w, h)
    rim = line_alpha(np.abs(r - 0.88), 0.03, 0.045, 0.55)
    streak = np.zeros_like(r)
    for _ in range(40):
        th = rng.uniform(-np.pi, np.pi)
        r1 = rng.uniform(0.35, 0.6)
        r2 = rng.uniform(0.7, 0.86)
        da = np.abs(np.angle(np.exp(1j * (a - th))))
        dl = da * r  # arc distance
        along = smooth(r1, r2, r) * (r < r2 + 0.02)
        streak = np.maximum(streak, np.exp(-dl / 0.012) * along * rng.uniform(0.35, 0.8))
    haze = np.where(r < 0.88, smooth(0.2, 0.88, r) * 0.12, 0)
    alpha = np.clip(np.maximum(rim, streak) + haze, 0, 1) * (1 - smooth(0.97, 1.0, r))
    return white(alpha), alpha


def cell_glow_soft(w, h, rng):
    x, y, r, a = grid(w, h)
    alpha = np.exp(-(r * r) / 0.16) * (1 - smooth(0.85, 1.0, r))
    return white(alpha), alpha


def cell_glow_star(w, h, rng):
    x, y, r, a = grid(w, h)
    core = np.exp(-(r * r) / 0.035)
    halo = np.exp(-(r * r) / 0.22) * 0.55
    spikes = (np.exp(-np.abs(y) / 0.035) * np.exp(-np.abs(x) / 0.55) +
              np.exp(-np.abs(x) / 0.035) * np.exp(-np.abs(y) / 0.55)) * 0.45
    alpha = np.clip(core + halo + spikes, 0, 1) * (1 - smooth(0.88, 1.0, r))
    # white-hot centre, faint warm edge (tint does the rest)
    warm = np.clip(r * 1.2, 0, 1)
    rgb = np.stack([np.ones_like(r), 1 - 0.06 * warm, 1 - 0.22 * warm], -1)
    return rgb, alpha


def cell_spark(w, h, rng):
    x, y, r, a = grid(w, h)
    core = (r < 0.22).astype(float)
    halo = np.exp(-(r * r) / 0.09) * 0.6
    cross = (np.exp(-np.abs(y) / 0.04) + np.exp(-np.abs(x) / 0.04)) * np.exp(-r / 0.35) * 0.35
    alpha = np.clip(np.maximum(core, halo + cross), 0, 1) * (1 - smooth(0.9, 1.0, r))
    return white(alpha), alpha


def cell_debris(w, h, rng):
    x, y, r, a = grid(w, h)
    n = 7
    angs = np.sort(rng.uniform(0, 2 * np.pi, n))
    rads = rng.uniform(0.55, 0.85, n)
    # polygon radius as a function of angle (piecewise linear between vertices)
    aa = np.mod(a, 2 * np.pi)
    angs_ext = np.concatenate([angs - 2 * np.pi, angs, angs + 2 * np.pi])
    rads_ext = np.concatenate([rads, rads, rads])
    pr = np.interp(aa, angs_ext, rads_ext)
    inside = smooth(pr, pr - 0.04, r)
    tex = fbm(r.shape, 4, 3, rng)
    light = np.clip(0.75 - 0.35 * (x + y) * 0.5 + (tex - 0.5) * 0.5, 0.25, 1)
    rgb = np.stack([light * 0.95, light * 0.92, light * 0.88], -1)
    return rgb, inside


def cell_smoke(w, h, rng):
    x, y, r, a = grid(w, h)
    n = fbm(r.shape, 3, 4, rng)
    n2 = fbm(r.shape, 6, 3, rng)
    edge = 0.62 + (n - 0.5) * 0.55
    alpha = smooth(edge + 0.25, edge - 0.15, r) * (0.55 + 0.45 * n2)
    alpha = np.clip(alpha * 1.15, 0, 1)
    light = np.clip(0.88 - 0.22 * (x + y) * 0.5 + (n2 - 0.5) * 0.3, 0.45, 1)
    rgb = np.stack([light] * 3, -1)
    return rgb, alpha


def cell_dust(w, h, rng):
    x, y, r, a = grid(w, h)
    n = fbm(r.shape, 4, 4, rng)
    grain = rng.random(r.shape)
    edge = 0.6 + (n - 0.5) * 0.6
    alpha = smooth(edge + 0.2, edge - 0.2, r) * (0.45 + 0.55 * n) * (0.75 + 0.25 * grain)
    alpha = np.clip(alpha * 1.2, 0, 1)
    light = np.clip(0.9 - 0.25 * (x + y) * 0.5 + (n - 0.5) * 0.35, 0.4, 1)
    rgb = np.stack([light, light * 0.97, light * 0.92], -1)
    return rgb, alpha


def norm01(v):
    lo, hi = np.percentile(v, 1), np.percentile(v, 99)
    return np.clip((v - lo) / max(hi - lo, 1e-9), 0, 1)


def cell_flame(w, h, rng, f):
    """Flame wisp frame f in [0,1]: dense hot blob -> broken tongues -> fading wisps.

    Direction-agnostic (the sprites are camera-facing and the flame can point anywhere).
    """
    x, y, r, a = grid(w, h)
    n = norm01(fbm(r.shape, 3, 4, rng))
    n2 = norm01(fbm(r.shape, 5, 3, rng))
    radius = 0.80 - 0.22 * f
    edge = radius + (n - 0.5) * (0.30 + 0.45 * f)
    body = smooth(edge + 0.10, edge - 0.22, r)
    th = 0.05 + 0.55 * f  # erosion threshold grows as the flame dies
    keep = smooth(th - 0.12, th + 0.12, n2)
    alpha = body * (keep if f > 0.0 else 1.0) * (1.0 - 0.35 * f)
    core = np.exp(-(r * r) / (0.10 * (1 - 0.75 * f) + 0.01)) * (1 - f) ** 1.5
    alpha = np.clip(alpha + core * 0.6, 0, 1)
    warm = np.clip(r / max(radius, 0.2), 0, 1)
    rgb = np.stack([np.ones_like(r), 1 - 0.10 * warm, 1 - 0.30 * warm], -1)
    return rgb, alpha


def cell_arc(w, h, rng):
    x, y, r, a = grid(w, h)

    def bolt(p0, p1, depth, jitter):
        pts = [p0, p1]
        for _ in range(depth):
            new = [pts[0]]
            for (ax, ay), (bx, by) in zip(pts[:-1], pts[1:]):
                mx, my = (ax + bx) / 2, (ay + by) / 2
                nx, ny = -(by - ay), (bx - ax)
                ln = max(np.hypot(nx, ny), 1e-9)
                off = rng.uniform(-jitter, jitter)
                new += [(mx + nx / ln * off, my + ny / ln * off), (bx, by)]
            pts = new
            jitter *= 0.55
        return pts

    th = rng.uniform(0, np.pi)
    p0 = (np.cos(th) * -0.85, np.sin(th) * -0.85)
    p1 = (np.cos(th) * 0.85, np.sin(th) * 0.85)
    main = bolt(p0, p1, 5, 0.45)
    d = polyline_dist(x, y, main)
    alpha = line_alpha(d, 0.03, 0.05, 0.6)
    for _ in range(2):
        k = rng.integers(4, len(main) - 4)
        bx0, by0 = main[k]
        ang = np.arctan2(p1[1] - p0[1], p1[0] - p0[0]) + rng.choice([-1, 1]) * rng.uniform(0.5, 1.1)
        bl = rng.uniform(0.35, 0.6)
        br = bolt((bx0, by0), (bx0 + np.cos(ang) * bl, by0 + np.sin(ang) * bl), 3, 0.15)
        alpha = np.maximum(alpha, line_alpha(polyline_dist(x, y, br), 0.018, 0.035, 0.5) * 0.8)
    alpha *= 1 - smooth(0.92, 1.0, np.maximum(np.abs(x), np.abs(y)))
    return white(alpha), np.clip(alpha, 0, 1)


def cell_ring_thin(w, h, rng):
    x, y, r, a = grid(w, h)
    alpha = line_alpha(np.abs(r - 0.9), 0.018, 0.035, 0.5) * (1 - smooth(0.97, 1.0, r))
    return white(alpha), alpha


def cell_ring_tech(w, h, rng):
    x, y, r, a = grid(w, h)
    ang = (a + np.pi) / (2 * np.pi)  # 0..1
    outer = line_alpha(np.abs(r - 0.92), 0.016, 0.03, 0.45)
    dash = (np.mod(ang * 48, 1.0) < 0.7).astype(float)
    outer *= dash
    inner = line_alpha(np.abs(r - 0.84), 0.01, 0.02, 0.35) * 0.7
    arcs = ((np.mod(ang * 4 + 0.08, 1.0) < 0.62)).astype(float)
    inner *= arcs
    ticks = np.zeros_like(r)
    tk = np.mod(ang * 16, 1.0)
    tickmask = (np.minimum(tk, 1 - tk) * 16 * 2 * np.pi * r / 16 < 0.02) & (r > 0.74) & (r < 0.8)
    ticks = tickmask.astype(float) * 0.9
    alpha = np.clip(np.maximum.reduce([outer, inner, ticks]), 0, 1) * (1 - smooth(0.97, 1.0, r))
    return white(alpha), alpha


def cell_ring_fire(w, h, rng):
    x, y, r, a = grid(w, h)
    ang = (a + np.pi) / (2 * np.pi)
    k = 48
    lat = rng.random(k + 1)
    lat[k] = lat[0]
    p = ang * k
    i0 = np.floor(p).astype(int) % k
    f = p - np.floor(p)
    f = f * f * (3 - 2 * f)
    tongue = lat[i0] + (lat[i0 + 1] - lat[i0]) * f  # 0..1 per angle
    n = fbm(r.shape, 6, 3, rng)
    inner = 0.55
    outer = 0.68 + tongue * 0.27
    band = smooth(inner - 0.08, inner + 0.02, r) * smooth(outer, outer - 0.2, r)
    alpha = np.clip(band * (0.6 + 0.4 * n) * 1.3, 0, 1)
    alpha = np.maximum(alpha, line_alpha(np.abs(r - inner), 0.015, 0.03, 0.4))
    alpha *= 1 - smooth(0.96, 1.0, r)
    hot = smooth(outer, inner, r)
    rgb = np.stack([np.ones_like(r), 0.82 + 0.18 * hot, 0.55 + 0.45 * hot], -1)
    return rgb, np.clip(alpha, 0, 1)


def cell_flash(w, h, rng):
    x, y, r, a = grid(w, h)
    rays = np.zeros_like(r)
    for _ in range(18):
        th = rng.uniform(-np.pi, np.pi)
        da = np.abs(np.angle(np.exp(1j * (a - th))))
        width = rng.uniform(0.02, 0.06)
        ln = rng.uniform(0.55, 0.95)
        rays = np.maximum(rays, np.exp(-da / width) * smooth(ln, 0.0, r) * rng.uniform(0.4, 0.9))
    core = np.exp(-(r * r) / 0.05)
    halo = np.exp(-(r * r) / 0.3) * 0.35
    alpha = np.clip(core + halo + rays, 0, 1) * (1 - smooth(0.9, 1.0, r))
    return white(alpha), alpha


# ------------------------------------------------- SPEC 12.4 "clean" cells (hard edges, no noise)
def cell_ring_crisp(w, h, rng):
    """Shockwave rim: one solid hard-edged ring + a thin inner echo. Nothing random."""
    x, y, r, a = grid(w, h)
    rim = 0.89
    core = (np.abs(r - rim) <= 0.058).astype(np.float64)
    echo = (np.abs(r - 0.70) <= 0.016).astype(np.float64) * 0.5
    wash = np.exp(-np.maximum(rim - r, 0) / 0.11) * 0.30 * (r <= rim)
    glow = np.exp(-np.maximum(r - rim, 0) / 0.035) * 0.25 * (r > rim)
    al = np.clip(np.maximum(np.maximum(core, echo), np.maximum(wash, glow)), 0, 1) * (r <= 1.0)
    return white(al), al


def cell_ring_dust(w, h, rng):
    """Ground shockwave: crisp leading rim + clean radial spokes sweeping inward (no smoke blobs)."""
    x, y, r, a = grid(w, h)
    rim = 0.88
    core = (np.abs(r - rim) <= 0.055).astype(np.float64)
    spokes = np.clip(np.cos(a * 22.0), 0, 1) ** 1.6
    body = spokes * smooth(0.34, rim, r) * (r < rim) * 0.6
    inner = np.exp(-np.maximum(rim - r, 0) / 0.09) * 0.28 * (r < rim)
    al = np.clip(np.maximum(core, np.maximum(body, inner)), 0, 1) * (r <= 1.0)
    return white(al), al


def cell_burst(w, h, rng):
    """Impact flash: hard white core + 4 long / 4 short sharp spikes."""
    x, y, r, a = grid(w, h)
    core = smooth(0.30, 0.17, r)
    long_s = np.clip(np.cos(a * 4.0), 0, 1) ** 7 * np.exp(-r / 0.34)
    short_s = np.clip(np.cos((a + np.pi / 4.0) * 4.0), 0, 1) ** 11 * np.exp(-r / 0.20)
    halo = np.exp(-r / 0.15) * 0.45
    al = np.clip(core + long_s * 0.95 + short_s * 0.6 + halo, 0, 1) * (r <= 1.0)
    return white(al), al


def cell_streak(w, h, rng):
    """Sharp tapered needle pointing up (spark / vapor streak); brightest at the head."""
    x, y, r, a = grid(w, h)
    taper = np.clip(1.0 - np.abs(y), 0, 1) ** 0.55
    half = 0.44 * taper
    core = (np.abs(x) <= half * 0.45).astype(np.float64)
    body = smooth(half, half * 0.5, np.abs(x))
    al = np.clip(np.maximum(core, body), 0, 1) * (np.abs(y) <= 0.97)
    al *= 0.55 + 0.45 * np.clip(-y * 0.5 + 0.5, 0, 1)
    return white(al), al


def cell_chunk(w, h, rng):
    """Debris chunk: one solid hard-edged polygon with a lighter top-left facet."""
    x, y, r, a = grid(w, h)
    edge = 0.66 + 0.13 * np.cos(3.0 * a + 0.7) + 0.07 * np.cos(5.0 * a - 2.1)
    al = (r <= edge).astype(np.float64)
    facet = (x + y < -0.12) & (r <= edge)
    rgb = np.ones(al.shape + (3,)) * 0.72
    rgb[facet] = 1.0
    return rgb, al


def cell_dot(w, h, rng):
    """Contrail bead: solid core, hard rim, tight halo."""
    x, y, r, a = grid(w, h)
    core = (r <= 0.40).astype(np.float64)
    halo = np.exp(-np.maximum(r - 0.40, 0) / 0.08) * 0.6
    al = np.clip(np.maximum(core, halo), 0, 1) * (r <= 1.0)
    return white(al), al


def cell_puff(w, h, rng):
    """Clean dust / vapor puff: one rounded blob with a hard edge (no noise, no wisps)."""
    x, y, r, a = grid(w, h)
    rr = r / (0.86 + 0.07 * np.cos(3.0 * a + 0.9) + 0.035 * np.cos(5.0 * a - 2.0))
    al = smooth(1.0, 0.84, rr)
    al = al * (0.6 + 0.4 * smooth(1.0, 0.3, rr))
    return white(al), al


RENDER = {
    "ring_wave": cell_ring_wave,
    "ring_soft": cell_ring_soft,
    "hex_shield": cell_hex_shield,
    "brackets": cell_brackets,
    "lock": cell_lock,
    "boom": cell_boom,
    "glow_soft": cell_glow_soft,
    "glow_star": cell_glow_star,
    "spark": cell_spark,
    "debris": cell_debris,
    "ring_thin": cell_ring_thin,
    "ring_tech": cell_ring_tech,
    "ring_tech_hd": cell_ring_tech,
    "ring_fire": cell_ring_fire,
    "flash": cell_flash,
    "burst": cell_burst,
    "streak": cell_streak,
    "chunk": cell_chunk,
    "dot": cell_dot,
    "puff": cell_puff,
    "ring_crisp": cell_ring_crisp,
    "ring_dust": cell_ring_dust,
}


def build_atlas():
    atlas = np.zeros((ATLAS_H, ATLAS_W, 4), dtype=np.float64)
    atlas[..., :3] = 1.0  # white RGB under transparent texels (no dark fringes)
    for idx, (name, (x0, y0, w, h)) in enumerate(sorted(ATLAS.items())):
        rng = np.random.default_rng(1000 + sum(ord(c) * (i + 1) for i, c in enumerate(name)))
        if name.startswith("flame_"):
            i = int(name.split("_")[1])
            rgb, al = cell_flame(w, h, rng, i / 7.0)
        elif name.startswith("smoke_"):
            rgb, al = cell_smoke(w, h, rng)
        elif name.startswith("dust_"):
            rgb, al = cell_dust(w, h, rng)
        elif name.startswith("arc_"):
            rgb, al = cell_arc(w, h, rng)
        else:
            rgb, al = RENDER[name](w, h, rng)
        rgb_d, al_d = down(np.clip(rgb, 0, 1), np.clip(al, 0, 1), w, h)
        atlas[y0:y0 + h, x0:x0 + w, :3] = rgb_d
        atlas[y0:y0 + h, x0:x0 + w, 3] = al_d
    img = (np.clip(atlas, 0, 1) * 255 + 0.5).astype(np.uint8)
    # fully transparent texels: force white RGB (keeps PNG small & fringe-free)
    img[img[..., 3] == 0, :3] = 255
    return Image.fromarray(img, "RGBA")


def preview(atlas):
    S = 3
    big = atlas.resize((ATLAS_W * S, ATLAS_H * S), Image.NEAREST)
    pad = 24
    W = ATLAS_W * S * 2 + pad * 3
    H = ATLAS_H * S + pad * 2 + 20
    out = Image.new("RGBA", (W, H), (18, 20, 26, 255))
    # left: on dark (as additive glow); right: on light checker (as blend)
    dark = Image.new("RGBA", big.size, (8, 10, 16, 255))
    dark.alpha_composite(big)
    chk = Image.new("RGBA", big.size, (170, 170, 170, 255))
    d = ImageDraw.Draw(chk)
    for yy in range(0, big.size[1], 24):
        for xx in range(0, big.size[0], 24):
            if (xx // 24 + yy // 24) % 2:
                d.rectangle([xx, yy, xx + 23, yy + 23], fill=(120, 124, 130, 255))
    # tint the light-bg copy a little so white shapes are visible
    tinted = big.copy()
    arr = np.array(tinted).astype(np.float64)
    arr[..., 0] *= 0.25
    arr[..., 1] *= 0.55
    arr[..., 2] *= 0.85
    chk.alpha_composite(Image.fromarray(arr.astype(np.uint8), "RGBA"))
    out.alpha_composite(dark, (pad, pad + 20))
    out.alpha_composite(chk, (pad * 2 + big.size[0], pad + 20))
    dd = ImageDraw.Draw(out)
    dd.text((pad, 6), "mk5_fx.png on dark (additive look)", fill=(200, 220, 255, 255))
    dd.text((pad * 2 + big.size[0], 6), "on light checker, tinted", fill=(200, 220, 255, 255))
    for name, (x0, y0, w, h) in ATLAS.items():
        for ox in (pad, pad * 2 + big.size[0]):
            dd.rectangle([ox + x0 * S, pad + 20 + y0 * S, ox + (x0 + w) * S - 1, pad + 20 + (y0 + h) * S - 1],
                         outline=(255, 80, 80, 90))
        dd.text((pad + x0 * S + 2, pad + 20 + y0 * S + 1), name, fill=(255, 120, 120, 255))
    return out


def main():
    atlas = build_atlas()
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    atlas.save(OUT, optimize=True)
    os.makedirs(os.path.dirname(PREVIEW), exist_ok=True)
    preview(atlas).convert("RGB").save(PREVIEW, optimize=True)
    print(f"wrote {os.path.relpath(OUT, B)} ({os.path.getsize(OUT)} B) and {os.path.relpath(PREVIEW, B)}")


if __name__ == "__main__":
    sys.exit(main())
