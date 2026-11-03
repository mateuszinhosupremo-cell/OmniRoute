#!/usr/bin/env python3
"""Offline look-check of the thruster flame (sym:mk5_thrust + sym:mk5_thrust_glow).

Evaluates the generated particle JSON with tools/fx/molang.py, simulates ~4 ticks of
spawns (script spawns every tick), and composites the sprites additively with
orthographic projection. Writes dist/fx_thrust_preview.png. Not shipped.
"""
import json
import math
import os
import random
import sys

import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from molang import Ctx, evaluate  # noqa: E402

B = os.path.abspath(os.path.join(HERE, "..", ".."))
PDIR = os.path.join(B, "pack", "Mark5_RP", "particles")
ATLAS = np.asarray(Image.open(os.path.join(B, "pack", "Mark5_RP", "textures", "sym", "particle", "mk5_fx.png"))
                   .convert("RGBA")).astype(np.float64) / 255.0


def load(name):
    with open(os.path.join(PDIR, name)) as fh:
        return json.load(fh)["particle_effect"]["components"]


def sprite(uvd, age_frac, ctx):
    u = evaluate(uvd["uv"][0], ctx)
    v = evaluate(uvd["uv"][1], ctx)
    w, h = uvd["uv_size"]
    fb = uvd.get("flipbook")
    if fb:
        frame = min(int(age_frac * fb["max_frame"]), fb["max_frame"] - 1)
        u = fb["base_UV"][0] + fb["step_UV"][0] * frame
        v = fb["base_UV"][1] + fb["step_UV"][1] * frame
        w, h = fb["size_UV"]
    u, v = int(u), int(v)
    return ATLAS[v:v + int(h), u:u + int(w)]


def simulate(comp, variables, ticks, nozzle_vel, seed):
    """Return list of (pos(3), half_size, rgba, tex) at time T (age since spawn per tick)."""
    out = []
    rng = random.Random(seed)
    for k in range(ticks):
        t_spawn_age = k * 0.05 + 0.025  # time since that spawn
        ctx = Ctx(variables, rng)
        init = comp.get("minecraft:emitter_initialization", {}).get("creation_expression")
        if init:
            evaluate(init, ctx)
        rate = comp.get("minecraft:emitter_rate_instant", {}).get("num_particles", 1)
        n = int(evaluate(rate, ctx))
        # nozzle position at spawn time relative to nozzle now
        base = -np.array(nozzle_vel) * 20.0 * t_spawn_age
        for _ in range(n):
            for i in range(1, 5):
                ctx.vars[f"variable.particle_random_{i}"] = rng.random()
            shape = comp.get("minecraft:emitter_shape_custom") or comp.get("minecraft:emitter_shape_point") or {}
            off = np.array([evaluate(e, ctx) for e in shape.get("offset", [0, 0, 0])])
            d = np.array([evaluate(e, ctx) for e in shape.get("direction", [0, 0, 0])])
            dn = d / (np.linalg.norm(d) or 1.0)
            speed = evaluate(comp.get("minecraft:particle_initial_speed", 0), ctx)
            life = evaluate(comp["minecraft:particle_lifetime_expression"]["max_lifetime"], ctx)
            age = t_spawn_age
            if age >= life:
                continue
            ctx.vars["variable.particle_age"] = age
            ctx.vars["variable.particle_lifetime"] = life
            pi = comp.get("minecraft:particle_initialization", {})
            for key in ("per_update_expression", "per_render_expression"):
                if key in pi:
                    evaluate(pi[key], ctx)
            bb = comp["minecraft:particle_appearance_billboard"]
            hs = evaluate(bb["size"][0], ctx)
            col = [evaluate(c, ctx) for c in comp["minecraft:particle_appearance_tinting"]["color"]]
            pos = base + off + dn * speed * age
            out.append((pos, hs, col, sprite(bb["uv"], age / life, ctx)))
    return out


def render(parts, view, W, H, ppb, bg, center):
    img = np.zeros((H, W, 3))
    img[:] = bg
    acc = np.zeros((H, W, 3))
    for pos, hs, col, tex in parts:
        if view == "side":  # camera looks along +x: screen x = z, screen y = -y
            sx, sy = pos[2], -pos[1]
        else:  # from below looking up: screen x = x, screen y = z
            sx, sy = pos[0], pos[2]
        px = int(round(sx * ppb + center[0]))
        py = int(round(sy * ppb + center[1]))
        size = max(2, int(round(2 * hs * ppb)))
        t = np.asarray(Image.fromarray((tex * 255).astype(np.uint8), "RGBA").resize((size, size), Image.NEAREST),
                       dtype=np.float64) / 255.0
        x0, y0 = px - size // 2, py - size // 2
        xa, ya = max(x0, 0), max(y0, 0)
        xb, yb = min(x0 + size, W), min(y0 + size, H)
        if xa >= xb or ya >= yb:
            continue
        tt = t[ya - y0:yb - y0, xa - x0:xb - x0]
        a = tt[..., 3:4] * col[3]
        acc[ya:yb, xa:xb] += tt[..., :3] * np.array(col[:3]) * a
    img = 1 - (1 - img) * np.exp(-acc * 1.6) if False else np.clip(img + acc, 0, 1)
    return img


def panel(title, parts_flame, parts_glow, view, bg, block_rect):
    W, H, ppb = 320, 380, 420
    center = (W // 2, 70) if view == "side" else (W // 2, H // 2)
    base = np.zeros((H, W, 3))
    base[:] = bg
    im = Image.fromarray((base * 255).astype(np.uint8))
    d = ImageDraw.Draw(im)
    if block_rect:
        (x0, y0, x1, y1) = block_rect
        d.rectangle([center[0] + x0 * ppb, center[1] + y0 * ppb, center[0] + x1 * ppb, center[1] + y1 * ppb],
                    fill=(120, 18, 22))
    arr = np.asarray(im).astype(np.float64) / 255.0
    fl = render(parts_flame + parts_glow, view, W, H, ppb, 0, center)
    out = np.clip(arr + fl, 0, 1)
    im = Image.fromarray((out * 255).astype(np.uint8))
    ImageDraw.Draw(im).text((6, 6), title, fill=(230, 230, 230))
    return im


def main():
    thrust = load("sym_mk5_thrust.json")
    glow = load("sym_mk5_thrust_glow.json")
    panels = []
    scen = [
        ("hover p=0.6 side", {"variable.dir.x": 0, "variable.dir.y": -1, "variable.dir.z": 0,
                              "variable.power": 0.6}, (0, 0, 0), "side", (-0.125, -0.32, 0.125, 0.0)),
        ("hover p=0.6 from below", {"variable.dir.x": 0, "variable.dir.y": -1, "variable.dir.z": 0,
                                    "variable.power": 0.6}, (0, 0, 0), "below", (-0.125, -0.125, 0.125, 0.125)),
        ("boost p=1 vel 1.6b/t (no vel var)", {"variable.dir.x": 0, "variable.dir.y": 0, "variable.dir.z": -1,
                                              "variable.power": 1.0}, (0, 0, 1.6), "side", (0.0, -0.125, 0.32, 0.125)),
        ("boost p=1 + variable.vel", {"variable.dir.x": 0, "variable.dir.y": 0, "variable.dir.z": -1,
                                      "variable.power": 1.0, "variable.vel.x": 0, "variable.vel.y": 0,
                                      "variable.vel.z": 1.6}, (0, 0, 1.6), "side", (0.0, -0.125, 0.32, 0.125)),
    ]
    for i, (title, vars_, nv, view, rect) in enumerate(scen):
        pf = simulate(thrust, vars_, 4, nv, 10 + i)
        gv = {k: v for k, v in vars_.items() if k.startswith("variable.power") or k.startswith("variable.vel")}
        pg = simulate(glow, gv, 2, nv, 20 + i)
        for bg in ((0.05, 0.06, 0.09), (0.45, 0.55, 0.7)):
            panels.append(panel(title, pf, pg, view, bg, rect))
    W = 320 * 4
    out = Image.new("RGB", (W, 380 * 2), (0, 0, 0))
    for i, p in enumerate(panels):
        out.paste(p, ((i // 2) * 320, (i % 2) * 380))
    path = os.path.join(B, "dist", "fx_thrust_preview.png")
    out.save(path, optimize=True)
    print("wrote", os.path.relpath(path, B))


if __name__ == "__main__":
    main()
