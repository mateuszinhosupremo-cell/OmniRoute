#!/usr/bin/env python3
"""SPEC 11.1 — clean geometry flames: geometry.sym.mk5_flames, its texture and render controller.

The flame model is a solid tapered cone of stacked boxes (4 x 5 x 4 px outer, plus a thin white-hot
core that pokes out of the tip), one under each glove and each boot, exactly like the user's
reference `ref/user/flight_reference_clean.jpg`. Top-level bones repeat `geometry.sym.mk5`'s
`rightArm` / `leftArm` / `rightLeg` / `leftLeg` names and pivots, so the attachable's limb binding
drags the flames along with the armor in every flight pose. Each flame bone pivots AT the nozzle so
`animation.sym.mk5.flames_flicker` grows it away from the palm / sole.

Texture: 32 x 32 UV space rendered at 4x (128 x 128 px) — a clean white-hot -> yellow -> amber
gradient with a brighter core streak; every texel uses alpha 143..192 so `entity_emissive_alpha`
renders the whole cone as glowing.
"""

import os
import sys

sys.dont_write_bytecode = True  # keep tools/suit free of __pycache__
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (  # noqa: E402
    FLAMES_GEOMETRY,
    FLAMES_RC,
    FLAMES_TEXTURE,
    FLAME_BONES,
    FLAMES_ROOT_BONES,
    RP,
    report,
    write_json,
)

GEO_PATH = os.path.join(RP, "models", "entity", "sym_mk5_flames.geo.json")
TEX_PATH = os.path.join(RP, FLAMES_TEXTURE + ".png")
RC_PATH = os.path.join(RP, "render_controllers", "sym_mk5_flames.render_controllers.json")

TEX_UV = 32          # UV space declared in the geometry
SCALE = 4            # texture pixels per UV unit (128 x 128 png)
LENGTH = 5.75        # total flame length in px (tip of the core below the nozzle)

# name, width, height, depth, top offset below the nozzle, uv origin
SEGMENTS = [
    ("root", 3.5, 2.0, 3.5, 0.0, (0, 0)),
    ("mid", 3.0, 2.0, 3.0, 2.0, (0, 8)),
    ("tip", 2.5, 1.0, 2.5, 4.0, (0, 16)),
    ("core", 1.0, 5.0, 1.0, 0.75, (0, 21)),
]

# gradient stops: t (0 at the nozzle, 1 at the tip) -> (r, g, b, a)
STOPS = [
    (0.00, (255, 255, 246, 142)),
    (0.05, (255, 247, 172, 147)),
    (0.14, (251, 239, 98, 152)),
    (0.40, (247, 229, 58, 161)),
    (0.75, (247, 216, 46, 175)),
    (1.00, (255, 188, 44, 192)),
]
CORE_TINT = (255, 255, 235)


def lerp(a, b, f):
    return tuple(int(round(x + (y - x) * f)) for x, y in zip(a, b))


def grad(t):
    t = min(max(t, 0.0), 1.0)
    for (t0, c0), (t1, c1) in zip(STOPS, STOPS[1:]):
        if t <= t1:
            return lerp(c0, c1, 0.0 if t1 == t0 else (t - t0) / (t1 - t0))
    return STOPS[-1][1]


def hot(colour, f):
    r, g, b, a = colour
    rr, gg, bb = lerp((r, g, b), CORE_TINT, f)
    return (rr, gg, bb, max(143, int(round(a - 18 * f))))


def build_texture():
    from PIL import Image

    img = Image.new("RGBA", (TEX_UV * SCALE, TEX_UV * SCALE), (0, 0, 0, 0))
    px = img.load()

    def fill(rect, colour_at):
        u, v, w, h = rect
        for j in range(int(round(h * SCALE))):
            for i in range(int(round(w * SCALE))):
                px[int(u * SCALE) + i, int(v * SCALE) + j] = colour_at(
                    (i + 0.5) / (w * SCALE), (j + 0.5) / (h * SCALE)
                )

    for name, w, h, d, top, (u, v) in SEGMENTS:
        is_core = name == "core"
        t0, t1 = top / LENGTH, (top + h) / LENGTH
        boost = 0.62 if is_core else 0.0

        def side(fx, fy, t0=t0, t1=t1, boost=boost):
            base = grad(t0 + (t1 - t0) * fy)
            streak = max(0.0, 1.0 - abs(fx - 0.5) / 0.17)  # bright core streak down the middle
            return hot(base, min(0.92, boost + 0.40 * streak * streak))

        def cap(t, boost=boost, is_core=is_core):
            def inner(fx, fy, t=t, boost=boost):
                r = min(1.0, 2.0 * max(abs(fx - 0.5), abs(fy - 0.5)))
                return hot(grad(t), min(0.92, boost + (0.5 if is_core else 0.18) * (1.0 - r * r)))

            return inner

        fill((u + d, v, w, d), cap(t0))                       # up   (towards the nozzle)
        fill((u + d + w, v, w, d), cap(t1))                   # down (towards the tip)
        fill((u, v + d, d, h), side)                          # east
        fill((u + d, v + d, w, h), side)                      # north
        fill((u + d + w, v + d, d, h), side)                  # west
        fill((u + d + w + d, v + d, w, h), side)              # south
    return img


def write_png(path, img):
    import io

    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    data = buf.getvalue()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if os.path.exists(path) and open(path, "rb").read() == data:
        return False
    with open(path, "wb") as f:
        f.write(data)
    return True


def cubes_for(cx, y0, cz):
    out = []
    for _name, w, h, d, top, uv in SEGMENTS:
        out.append(
            {
                "origin": [round(cx - w / 2, 4), round(y0 - top - h, 4), round(cz - d / 2, 4)],
                "size": [w, h, d],
                "uv": list(uv),
            }
        )
    return out


def geometry():
    bones = [{"name": n, "pivot": p} for n, p in FLAMES_ROOT_BONES.items()]
    for bone, (parent, cx, y0, cz) in FLAME_BONES.items():
        bones.append(
            {"name": bone, "parent": parent, "pivot": [cx, y0, cz], "cubes": cubes_for(cx, y0, cz)}
        )
    return {
        "format_version": "1.12.0",
        "minecraft:geometry": [
            {
                "description": {
                    "identifier": FLAMES_GEOMETRY,
                    "texture_width": TEX_UV,
                    "texture_height": TEX_UV,
                    "visible_bounds_width": 4,
                    "visible_bounds_height": 4,
                    "visible_bounds_offset": [0, 1, 0],
                },
                "bones": bones,
            }
        ],
    }


def render_controller():
    return {
        "format_version": "1.10.0",
        "render_controllers": {
            FLAMES_RC: {
                "geometry": "Geometry.flames",
                "materials": [{"*": "Material.default"}],
                "textures": ["Texture.flames"],
            }
        },
    }


def main():
    report(GEO_PATH, write_json(GEO_PATH, geometry()))
    report(RC_PATH, write_json(RC_PATH, render_controller()))
    report(TEX_PATH, write_png(TEX_PATH, build_texture()))


if __name__ == "__main__":
    main()
