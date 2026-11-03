#!/usr/bin/env python3
"""textures/sym/mk5_off.png (SPEC 2.1): mk5.png with the 20 emissive LED pixels switched off.

With the `entity_emissive_alpha` material, alpha 140 pixels glow; the offline texture makes them
opaque (alpha 255 = not emissive) dark glass / dark metal with a subtle highlight so they read as
"dead" lenses rather than flat holes. Every other pixel is copied unchanged (verified).
Also writes dist/suit_led_compare.png (before / after, magnified, LED regions boxed).
"""

import os
import sys

import numpy as np
from PIL import Image, ImageDraw

sys.dont_write_bytecode = True  # keep tools/suit free of __pycache__
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import DIST, RP  # noqa: E402

SRC = os.path.join(RP, "textures", "sym", "mk5.png")
DST = os.path.join(RP, "textures", "sym", "mk5_off.png")
COMPARE = os.path.join(DIST, "suit_led_compare.png")

GLASS = [(34, 46, 63), (30, 40, 55), (30, 40, 55), (24, 32, 45)]  # TL, TR, BL, BR shading
METAL = [(45, 51, 60), (38, 44, 52), (38, 44, 52), (31, 36, 43)]

# name -> (pixels (x, y), palette); 2x2 blocks list TL, TR, BL, BR
LED_GROUPS = {
    "eyes": ([(3, 89), (4, 89), (7, 89), (8, 89)], [GLASS[0], GLASS[1], GLASS[0], GLASS[1]]),
    "reactor": ([(23, 22), (24, 22), (23, 23), (24, 23)], GLASS),
    "palms": ([(41, 49), (42, 49), (41, 50), (42, 50)], METAL),
    "boots": ([(9, 17), (10, 17), (9, 18), (10, 18)], METAL),
    "unused": ([(49, 17), (50, 17), (49, 18), (50, 18)], METAL),
}
LED_ALPHA = 140


def build():
    src = np.array(Image.open(SRC).convert("RGBA"))
    out = src.copy()
    expected = set()
    for pixels, palette in LED_GROUPS.values():
        for (x, y), rgb in zip(pixels, palette):
            expected.add((x, y))
            out[y, x] = (*rgb, 255)

    # verification: the LED list is exactly the set of alpha-140 pixels, nothing else changed
    ys, xs = np.where(src[:, :, 3] == LED_ALPHA)
    found = set(zip(xs.tolist(), ys.tolist()))
    assert found == expected, "LED pixel table mismatch: %s" % sorted(found ^ expected)
    diff = np.any(out != src, axis=2)
    dys, dxs = np.where(diff)
    assert set(zip(dxs.tolist(), dys.tolist())) == expected, "unexpected pixels changed"
    assert not np.any(out[:, :, 3] == LED_ALPHA), "emissive pixels left in mk5_off"
    return src, out, sorted(expected)


def save_png(path, arr):
    img = Image.fromarray(arr, "RGBA")
    if os.path.exists(path):
        cur = np.array(Image.open(path).convert("RGBA"))
        if cur.shape == arr.shape and np.array_equal(cur, arr):
            return False
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, optimize=True)
    return True


def compare_sheet(src, out, pixels):
    s = 6
    bg = (40, 40, 46, 255)

    def render(arr, glow):
        a = arr.astype(np.float32)
        rgb, alpha = a[:, :, :3], a[:, :, 3:4] / 255.0
        # preview: emissive pixels drawn at full brightness, transparent drawn as checker
        check = ((np.indices(arr.shape[:2]).sum(axis=0) // 4) % 2)[:, :, None] * 20 + 60
        em = (arr[:, :, 3] == LED_ALPHA)[:, :, None]
        disp = np.where(em, rgb, rgb * np.minimum(alpha * 1.0, 1) + check * (1 - alpha))
        if glow:
            disp = np.where(em, np.array([150, 230, 255]), disp)
        img = Image.fromarray(disp.clip(0, 255).astype(np.uint8), "RGB").resize(
            (arr.shape[1] * s, arr.shape[0] * s), Image.NEAREST
        )
        d = ImageDraw.Draw(img)
        for x, y in pixels:
            d.rectangle([x * s - 1, y * s - 1, (x + 1) * s, (y + 1) * s], outline=(255, 60, 60))
        return img

    a, b = render(src, True), render(out, False)
    w, h = a.size
    sheet = Image.new("RGBA", (w * 2 + 30, h + 40), bg)
    sheet.paste(a, (10, 30))
    sheet.paste(b, (w + 20, 30))
    d = ImageDraw.Draw(sheet)
    d.text((10, 8), "mk5.png (LEDs ON: emissive alpha 140)", fill=(220, 240, 255))
    d.text((w + 20, 8), "mk5_off.png (LEDs OFF: opaque dark glass/metal)", fill=(220, 240, 255))
    os.makedirs(DIST, exist_ok=True)
    sheet.save(COMPARE)


def main():
    src, out, pixels = build()
    changed = save_png(DST, out)
    print(("updated  " if changed else "unchanged") + " pack/Mark5_RP/textures/sym/mk5_off.png")
    compare_sheet(src, out, pixels)
    print("wrote     dist/suit_led_compare.png (%d LED pixels switched off)" % len(pixels))


if __name__ == "__main__":
    main()
