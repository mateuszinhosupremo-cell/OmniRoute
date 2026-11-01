#!/usr/bin/env python3
"""Orthographic preview of geometry.sym.mk5_flames over the suit silhouette -> dist/flames_preview.png

Point-splat rasterizer with a z-buffer: the armor is shaded as a flat grey silhouette, the flames
are sampled from textures/sym/mk5_flames.png through the Bedrock box-UV layout and drawn at full
brightness (that is what `entity_emissive_alpha` does in game). Usage:
    python3 -I tools/suit/preview_flames.py [--yaw 24] [--pitch 10] [--out dist/flames_preview.png]
"""

import math
import os
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import B, DIST, FLAMES_GEOMETRY, FLAMES_TEXTURE, RP, load_json  # noqa: E402

MODELS = os.path.join(RP, "models", "entity")
SS = 3                 # supersampling
PPU = 16               # pixels per model unit (before supersampling)
BG = (14, 18, 26)
SKIP = ("mk5_case_fx", "mk5_held_case")  # the suitcase bones are hidden by animation.sym.mk5.worn


def geo(path, ident):
    for g in load_json(path)["minecraft:geometry"]:
        if g["description"]["identifier"] == ident:
            return g
    raise SystemExit("geometry %s not found in %s" % (ident, path))


def bone_tree(g):
    bones = {b["name"]: b for b in g["bones"]}
    def hidden(name):
        seen = set()
        while name and name not in seen:
            if name in SKIP:
                return True
            seen.add(name)
            name = bones.get(name, {}).get("parent")
        return False
    return bones, hidden


def cube_boxes(g):
    """Rest-pose world boxes: (x0,y0,z0, x1,y1,z1, uv, size, texture_size) per cube."""
    bones, hidden = bone_tree(g)
    tw = g["description"].get("texture_width", 64)
    th = g["description"].get("texture_height", 64)
    out = []
    for b in g["bones"]:
        if hidden(b["name"]):
            continue
        for c in b.get("cubes", []):
            inf = c.get("inflate", 0)
            o = [c["origin"][i] - inf for i in range(3)]
            s = [c["size"][i] + 2 * inf for i in range(3)]
            out.append((o, s, c.get("uv"), c["size"], (tw, th)))
    return out


def face_rects(uv, size):
    """Bedrock box-UV layout -> {face: (u, v, w, h)} in UV units."""
    u, v = uv
    w, h, d = size
    return {
        "up": (u + d, v, w, d),
        "down": (u + d + w, v, w, d),
        "px": (u, v + d, d, h),
        "nz": (u + d, v + d, w, h),
        "nx": (u + d + w, v + d, d, h),
        "pz": (u + d + w + d, v + d, w, h),
    }


FACES = {  # face -> (axis, side, (a_axis, b_axis))  a/b span the face
    "up": (1, 1, (0, 2)),
    "down": (1, 0, (0, 2)),
    "px": (0, 1, (2, 1)),
    "nx": (0, 0, (2, 1)),
    "nz": (2, 0, (0, 1)),
    "pz": (2, 1, (0, 1)),
}
NORMALS = {"up": (0, 1, 0), "down": (0, -1, 0), "px": (1, 0, 0), "nx": (-1, 0, 0),
           "nz": (0, 0, -1), "pz": (0, 0, 1)}


def main():
    yaw = math.radians(float(_arg("--yaw", 24)))
    pitch = math.radians(float(_arg("--pitch", 10)))
    out_path = _arg("--out", os.path.join(DIST, "flames_preview.png"))
    from PIL import Image

    suit = cube_boxes(geo(os.path.join(MODELS, "sym_mk5.geo.json"), "geometry.sym.mk5"))
    flames = cube_boxes(geo(os.path.join(MODELS, "sym_mk5_flames.geo.json"), FLAMES_GEOMETRY))
    tex = Image.open(os.path.join(RP, FLAMES_TEXTURE + ".png")).convert("RGBA")
    tpx = tex.load()

    cy, sy_, cp, sp = math.cos(yaw), math.sin(yaw), math.cos(pitch), math.sin(pitch)

    def project(p):
        x, y, z = p
        xa = x * cy + z * sy_
        za = -x * sy_ + z * cy
        ya = y * cp - za * sp
        zb = y * sp + za * cp
        return xa, ya, zb

    X0, X1, Y0, Y1 = -11.0, 11.0, -8.0, 35.0
    W = int((X1 - X0) * PPU) * SS
    H = int((Y1 - Y0) * PPU) * SS
    buf = [[BG] * W for _ in range(H)]
    zbuf = [[1e9] * W for _ in range(H)]

    def put(p, colour):
        x, y, z = project(p)
        px = int((x - X0) * PPU * SS)
        py = int((Y1 - y) * PPU * SS)
        if 0 <= px < W and 0 <= py < H and z < zbuf[py][px]:
            zbuf[py][px] = z
            buf[py][px] = colour

    light = (-0.45, 0.78, -0.44)

    def splat(boxes, textured):
        step = 1.0 / (PPU * SS * 1.6)
        for o, s, uv, raw, (tw, th) in boxes:
            rects = face_rects(uv, raw) if (textured and uv) else None
            sx, sy2 = (tex.size[0] / tw, tex.size[1] / th) if rects else (1, 1)
            for face, (axis, side, (aa, bb)) in FACES.items():
                n = NORMALS[face]
                lam = max(0.0, sum(n[i] * light[i] for i in range(3)))
                shade = 0.34 + 0.66 * lam
                na = max(2, int(s[aa] / step))
                nb = max(2, int(s[bb] / step))
                r = rects[face] if rects else None
                for i in range(na + 1):
                    fa = i / na
                    for j in range(nb + 1):
                        fb = j / nb
                        p = [0, 0, 0]
                        p[axis] = o[axis] + (s[axis] if side else 0)
                        p[aa] = o[aa] + fa * s[aa]
                        p[bb] = o[bb] + fb * s[bb]
                        if r:
                            u = (r[0] + fa * r[2]) * sx
                            v = (r[1] + fb * r[3]) * sy2
                            c = tpx[min(int(u), tex.size[0] - 1), min(int(v), tex.size[1] - 1)]
                            if c[3] == 0:
                                continue
                            col = (c[0], c[1], c[2])  # emissive: no shading
                        else:
                            col = tuple(min(255, int(v * shade)) for v in (150, 152, 158))
                        put(p, col)

    splat(suit, False)
    splat(flames, True)

    img = Image.new("RGB", (W, H))
    img.putdata([c for row in buf for c in row])
    img = img.resize((W // SS, H // SS), Image.LANCZOS)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    img.save(out_path)
    print("wrote %s (%dx%d)" % (os.path.relpath(out_path, B), img.size[0], img.size[1]))


def _arg(flag, default):
    return sys.argv[sys.argv.index(flag) + 1] if flag in sys.argv else default


if __name__ == "__main__":
    main()
