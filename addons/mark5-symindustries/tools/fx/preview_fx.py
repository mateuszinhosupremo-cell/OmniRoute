#!/usr/bin/env python3
"""Preview the SPEC 12.4 "clean" effects (takeoff / landing / sonic boom / boost contrail).

Small orthographic particle renderer: it reads the SHIPPED particle json (not the generator),
evaluates every Molang expression with tools/fx/molang.py, integrates the documented motion
(initial speed + linear acceleration + linear drag), builds each sprite quad from its
facing_camera_mode and rasterizes it with the real atlas texture, additive or alpha blended.

Writes dist/fx_clean_preview.png. Run: python3 -I tools/fx/preview_fx.py
"""
import json
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
                   .convert("RGBA"), dtype=np.float64) / 255.0


def load(ident):
    for f in sorted(os.listdir(PDIR)):
        d = json.load(open(os.path.join(PDIR, f), encoding="utf-8"))
        if d.get("particle_effect", {}).get("description", {}).get("identifier") == ident:
            return d["particle_effect"]
    raise KeyError(ident)


def sprite(uvd, frac):
    u, v = (int(evaluate(e, Ctx())) for e in uvd["uv"])
    w, h = (int(evaluate(e, Ctx())) for e in uvd["uv_size"])
    fb = uvd.get("flipbook")
    if fb:
        i = min(int(frac * fb["max_frame"]), fb["max_frame"] - 1)
        u, v = fb["base_UV"][0] + fb["step_UV"][0] * i, fb["base_UV"][1] + fb["step_UV"][1] * i
        w, h = fb["size_UV"]
    return ATLAS[v:v + h, u:u + w]


def vec(expr, ctx, default=(0.0, 0.0, 0.0)):
    if not isinstance(expr, list):
        return np.array(default, dtype=np.float64)
    return np.array([evaluate(e, ctx) for e in expr], dtype=np.float64)


def move(v0, acc, drag, t):
    """Documented Bedrock dynamic motion: dv/dt = acc - drag * v."""
    if drag > 1e-6:
        k = drag
        term = acc / k
        return (v0 - term) * (1 - np.exp(-k * t)) / k + term * t
    return v0 * t + 0.5 * acc * t * t


def emit(pe, t, rng, variables, origin):
    """Return the particles of `pe` (and its creation-event children) alive at time t."""
    comp = pe["components"]
    out = []
    ctx = Ctx(variables, rng)
    init = comp.get("minecraft:emitter_initialization", {}).get("creation_expression")
    if init:
        evaluate(init, ctx)
    spawns = []  # (spawn_time, index)
    inst = comp.get("minecraft:emitter_rate_instant")
    active = float(comp.get("minecraft:emitter_lifetime_once", {}).get("active_time", 0.05))
    if inst is not None:
        spawns = [(0.0, i) for i in range(int(round(evaluate(inst.get("num_particles", 1), ctx))))]
    steady = comp.get("minecraft:emitter_rate_steady")
    if steady is not None:
        rate = evaluate(steady.get("spawn_rate", 1), ctx)
        cap = int(evaluate(steady.get("max_particles", 1), ctx))
        n = min(cap, max(1, int(rate * active)))
        spawns = [(i / rate, i) for i in range(n)]
    for st, _i in spawns:
        if t < st:
            continue
        age = t - st
        for j in range(1, 5):
            ctx.vars[f"variable.particle_random_{j}"] = rng.random()
        shape = {}
        for key in ("minecraft:emitter_shape_custom", "minecraft:emitter_shape_point",
                    "minecraft:emitter_shape_disc", "minecraft:emitter_shape_sphere"):
            if key in comp:
                shape = dict(comp[key], _kind=key)
                break
        off = vec(shape.get("offset"), ctx)
        kind = shape.get("_kind", "")
        if kind.endswith("_disc"):
            a, rr = rng.uniform(0, 2 * np.pi), np.sqrt(rng.random()) * float(shape.get("radius", 0))
            off = off + np.array([np.cos(a) * rr, 0.0, np.sin(a) * rr])
            d = np.array([off[0], 0.0, off[2]]) if shape.get("direction") == "outwards" else vec(
                shape.get("direction"), ctx)
        elif kind.endswith("_sphere"):
            d = np.array([rng.gauss(0, 1) for _ in range(3)])
            d /= np.linalg.norm(d) or 1.0
            off = off + d * float(shape.get("radius", 0))
        else:
            d = vec(shape.get("direction"), ctx)
        nrm = np.linalg.norm(d)
        d = d / nrm if nrm > 1e-9 else np.zeros(3)
        speed = evaluate(comp.get("minecraft:particle_initial_speed", 0), ctx)
        life = evaluate(comp["minecraft:particle_lifetime_expression"]["max_lifetime"], ctx)
        if age >= life:
            continue
        dyn = comp.get("minecraft:particle_motion_dynamic", {})
        acc = vec(dyn.get("linear_acceleration"), ctx)
        drag = evaluate(dyn.get("linear_drag_coefficient", 0), ctx)
        pos = origin + off + move(d * speed, acc, drag, age)
        if "minecraft:particle_motion_collision" in comp and pos[1] < origin[1]:
            pos[1] = origin[1]
        ctx.vars["variable.particle_age"] = age
        ctx.vars["variable.particle_lifetime"] = life
        ctx.vars["variable.emitter_age"] = t
        pi = comp.get("minecraft:particle_initialization", {})
        for key in ("per_update_expression", "per_render_expression"):
            if key in pi:
                evaluate(pi[key], ctx)
        bb = comp["minecraft:particle_appearance_billboard"]
        sx, sy = (evaluate(e, ctx) for e in bb["size"])
        col = [evaluate(e, ctx) for e in comp["minecraft:particle_appearance_tinting"]["color"]]
        spin = comp.get("minecraft:particle_initial_spin", {})
        rot = np.deg2rad(evaluate(spin["rotation"], ctx) + evaluate(spin.get("rotation_rate", 0), ctx) * age) \
            if "rotation" in spin else 0.0
        cdir = None
        dmode = bb.get("direction", {})
        if dmode.get("mode") == "custom":
            cdir = vec(dmode["custom_direction"], ctx)
        out.append(dict(pos=pos, sx=sx, sy=sy, col=col, rot=rot, mode=bb["facing_camera_mode"], cdir=cdir,
                        tex=sprite(bb["uv"], age / life),
                        add=pe["description"]["basic_render_parameters"]["material"] == "particles_add"))
    for ev in pe.get("events", {}).values():
        eff = ev.get("particle_effect", {})
        if eff.get("effect"):
            out += emit(load(eff["effect"]), t, random.Random(hash(eff["effect"]) & 0xFFFF), variables, origin)
    return out


def basis(p, cam):
    """World-space half-extent vectors of the sprite quad."""
    right, up = cam["right"], cam["up"]
    if p["mode"].startswith("emitter_transform"):
        e1, e2 = np.array([1.0, 0, 0]), np.array([0, 0, 1.0])
    elif p["mode"].startswith("direction") and p["cdir"] is not None:
        n = p["cdir"] / (np.linalg.norm(p["cdir"]) or 1.0)
        e1 = np.cross(n, [0, 1.0, 0])
        e1 = e1 / (np.linalg.norm(e1) or 1.0) if np.linalg.norm(e1) > 1e-6 else np.array([1.0, 0, 0])
        e2 = np.cross(n, e1)
    else:
        c, s = np.cos(p["rot"]), np.sin(p["rot"])
        e1, e2 = right * c + up * s, up * c - right * s
    return e1 * p["sx"], e2 * p["sy"]  # billboard `size` is the half-extent (quad spans 2*size)


def camera(yaw, pitch):
    y, q = np.deg2rad(yaw), np.deg2rad(pitch)
    fwd = np.array([np.cos(q) * np.sin(y), -np.sin(q), np.cos(q) * np.cos(y)])
    right = np.array([np.cos(y), 0.0, -np.sin(y)])
    up = np.cross(fwd, right)
    return {"fwd": fwd, "right": right, "up": up}


def draw(parts, cam, W, H, ppb, center, bg):
    img = np.array(bg, dtype=np.float64)[None, None, :] * np.ones((H, W, 1))
    for p in sorted(parts, key=lambda p: -float(np.dot(p["pos"], cam["fwd"]))):
        ex, ey = basis(p, cam)
        c2 = np.array([np.dot(p["pos"], cam["right"]) * ppb + center[0],
                       -np.dot(p["pos"], cam["up"]) * ppb + center[1]])
        a2 = np.array([np.dot(ex, cam["right"]) * ppb, -np.dot(ex, cam["up"]) * ppb])
        b2 = np.array([np.dot(ey, cam["right"]) * ppb, -np.dot(ey, cam["up"]) * ppb])
        M = np.array([a2, b2]).T
        if abs(np.linalg.det(M)) < 1e-6:
            continue
        inv = np.linalg.inv(M)
        rad = np.abs(a2) + np.abs(b2)
        x0, y0 = int(max(0, c2[0] - rad[0] - 1)), int(max(0, c2[1] - rad[1] - 1))
        x1, y1 = int(min(W, c2[0] + rad[0] + 2)), int(min(H, c2[1] + rad[1] + 2))
        if x1 <= x0 or y1 <= y0:
            continue
        ys, xs = np.mgrid[y0:y1, x0:x1]
        d = np.stack([xs + 0.5 - c2[0], ys + 0.5 - c2[1]], -1)
        uvq = d @ inv.T
        m = (np.abs(uvq[..., 0]) < 1) & (np.abs(uvq[..., 1]) < 1)
        if not m.any():
            continue
        th, tw = p["tex"].shape[:2]
        tu = np.clip(((uvq[..., 0] + 1) * 0.5 * tw).astype(int), 0, tw - 1)
        tv = np.clip(((uvq[..., 1] + 1) * 0.5 * th).astype(int), 0, th - 1)
        texel = p["tex"][tv, tu]
        a = texel[..., 3] * p["col"][3] * m
        rgb = texel[..., :3] * np.array(p["col"][:3])
        tile = img[y0:y1, x0:x1]
        img[y0:y1, x0:x1] = tile + rgb * a[..., None] if p["add"] else \
            tile * (1 - a[..., None]) + rgb * a[..., None]
    return np.clip(img, 0, 1)


SCEN = [
    ("sym:mk5_takeoff", "DECOLAGEM", {}, [0.05, 0.15, 0.32], (28, 18), 42, (0.0, -0.1), True),
    ("sym:mk5_landing", "POUSO", {}, [0.06, 0.2, 0.45], (28, 18), 42, (0.0, -0.1), True),
    ("sym:mk5_boom", "SONIC BOOM", {"variable.dir.x": 0.0, "variable.dir.y": 0.12, "variable.dir.z": 1.0},
     [0.06, 0.18, 0.34], (52, 18), 26, (0.0, 0.0), False),
    ("sym:mk5_trail", "CONTRAIL (boost, 4 ticks)",
     {"variable.dir.x": 0.0, "variable.dir.y": 0.25, "variable.dir.z": 1.0,
      "variable.vel.x": 0.0, "variable.vel.y": -0.35, "variable.vel.z": -1.5},
     [0.03, 0.10, 0.20], (90, 10), 95, (1.1, 0.15), False),
]


def main():
    cols, PW, PH = 3, 300, 300
    sheet = Image.new("RGB", (PW * cols, PH * len(SCEN)), (8, 9, 12))
    for row, (ident, title, vars_, times, (yaw, pitch), ppb, shift, ground) in enumerate(SCEN):
        pe = load(ident)
        cam = camera(yaw, pitch)
        for col, t in enumerate(times):
            if ident == "sym:mk5_trail":
                vel = np.array([vars_["variable.vel.x"], vars_["variable.vel.y"], vars_["variable.vel.z"]]) * 20.0
                parts = []
                for k in range(4):  # the boot emitted k ticks ago, from further back along the path
                    parts += emit(pe, t + 0.05 * k, random.Random(7 + k), dict(vars_), -vel * 0.05 * k)
            else:
                parts = emit(pe, t, random.Random(7), dict(vars_), np.zeros(3))
            center = (PW // 2 + shift[0] * ppb, (PH * 0.62 if ground else PH // 2) + shift[1] * ppb)
            bg = (0.07, 0.09, 0.13)
            img = draw(parts, cam, PW, PH, ppb, center, bg)
            im = Image.fromarray((img * 255).astype(np.uint8))
            d = ImageDraw.Draw(im)
            if ground:  # ground line + a player-sized silhouette for scale
                d.line([(0, center[1]), (PW, center[1])], fill=(42, 46, 54))
                d.rectangle([center[0] - 0.3 * ppb, center[1] - 1.85 * ppb, center[0] + 0.3 * ppb, center[1]],
                            outline=(70, 60, 60))
            else:  # suit marker at the emission point
                d.rectangle([center[0] - 0.25 * ppb, center[1] - 0.9 * ppb, center[0] + 0.25 * ppb,
                             center[1] + 0.9 * ppb], outline=(64, 54, 54))
            d.text((6, 6), f"{title}  t={t:.2f}s  ({len(parts)} p)", fill=(210, 225, 245))
            sheet.paste(im, (col * PW, row * PH))
    out = os.path.join(B, "dist", "fx_clean_preview.png")
    sheet.save(out, optimize=True)
    print("wrote", os.path.relpath(out, B))
    return 0


if __name__ == "__main__":
    sys.exit(main())
