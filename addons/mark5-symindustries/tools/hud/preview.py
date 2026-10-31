#!/usr/bin/env python3
"""Mark V HUD preview renderer (hud agent).

Renders the GENERATED JSON UI (pack/Mark5_RP/ui/sym_mk5_hud.json) for the sample HUD states of
tools/hud/sample_states.mjs over a mock Minecraft scene + mock vanilla hotbar/hearts, so the layout
can be judged without the game. Binding values (visible / text / texture) come from the same JSON
UI expression evaluator the decoder test uses (tools/hud/dump_resolved.mjs); layout (anchors,
offsets incl. "15% + 4px", stack panels, layers), images and Minecraft bitmap-font labels
(§ colour codes, bold, shadow, font_scale_factor, wrapping) are emulated here.

Approximations: the live_player_renderer doll is drawn as a stylised Mark V silhouette; alpha /
offset animations are shown at their first frame; flip-book images show their first frame.

Also prints layout diagnostics: missing textures, labels overflowing their panel, panels crossing
the cyan polylines of the user's visor artwork, and overlaps between top-level HUD blocks.

Usage: python3 tools/hud/preview.py            -> dist/hud_preview_<state>.png (+ phone variants)
"""
from __future__ import annotations

import json
import math
import os
import re
import subprocess
import sys

import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
RP = os.path.join(ROOT, "pack", "Mark5_RP")
DIST = os.path.join(ROOT, "dist")
FONT_DIR = os.path.join(HERE, "vanilla_ref", "font")

PREVIEWS = ["idle", "combat", "flight", "critical", "boot", "failure"]
PHONE_PREVIEWS = ["combat", "flight"]

# ------------------------------------------------------------------ font --------
MC_COLORS = {
    "0": (0, 0, 0), "1": (0, 0, 170), "2": (0, 170, 0), "3": (0, 170, 170), "4": (170, 0, 0),
    "5": (170, 0, 170), "6": (255, 170, 0), "7": (170, 170, 170), "8": (85, 85, 85),
    "9": (85, 85, 255), "a": (85, 255, 85), "b": (85, 255, 255), "c": (255, 85, 85),
    "d": (255, 85, 255), "e": (255, 255, 85), "f": (255, 255, 255), "g": (221, 214, 5),
    "h": (227, 212, 209), "i": (206, 202, 202), "j": (68, 58, 59), "m": (151, 22, 7),
    "n": (180, 104, 77), "p": (222, 177, 45), "q": (71, 160, 54), "s": (44, 186, 168),
    "t": (33, 73, 123), "u": (154, 92, 198),
}
LINE_H = 10  # font px per line


class Font:
    def __init__(self):
        inc = json.load(open(os.path.join(FONT_DIR, "default_include.json"), encoding="utf-8"))
        self.glyphs = {}
        for prov in inc["providers"]:
            fn = prov["file"].split("/")[-1]
            path = os.path.join(FONT_DIR, fn)
            if not os.path.exists(path):
                continue
            sheet = np.asarray(Image.open(path).convert("RGBA"))[..., 3] > 0
            rows = prov["chars"]
            ch_h = sheet.shape[0] // len(rows)
            ch_w = sheet.shape[1] // len(rows[0])
            ascent = prov.get("ascent", 7)
            for r, row in enumerate(rows):
                for c, ch in enumerate(row):
                    if ch in self.glyphs or ch == "\u0000":
                        continue
                    cell = sheet[r * ch_h:(r + 1) * ch_h, c * ch_w:(c + 1) * ch_w]
                    cols = np.where(cell.any(0))[0]
                    w = int(cols.max()) + 1 if len(cols) else 0
                    self.glyphs[ch] = (cell, w, 7 - ascent)
        self._fallbacks()

    def _fallbacks(self):
        def mk(rows):
            a = np.array([[c == "#" for c in r] for r in rows], bool)
            return (a, a.shape[1], 0)
        self.glyphs.setdefault("•", mk(["   ", "   ", "   ", " ##", " ##", "   ", "   ", "   "]))
        self.glyphs["●"] = mk(["     ", " ### ", "#####", "#####", "#####", " ### ", "     ", "     "])
        self.glyphs["■"] = mk(["     ", "#####", "#####", "#####", "#####", "#####", "     ", "     "])
        self.glyphs.setdefault("—", mk(["        ", "        ", "        ", "########", "        ", "        ", "        ", "        "]))
        self.glyphs.setdefault("·", mk(["  ", "  ", "  ", "##", "  ", "  ", "  ", "  "]))

    def glyph(self, ch):
        if ch == " ":
            return None, 3, 0
        g = self.glyphs.get(ch)
        if g is None:
            g = self.glyphs["?"]
        return g

    def parse(self, text, base_col):
        """-> list of lines, each a list of (char, rgb, bold)."""
        out, cur = [], []
        col, bold = base_col, False
        i = 0
        while i < len(text):
            ch = text[i]
            if ch == "§" and i + 1 < len(text):
                code = text[i + 1].lower()
                if code in MC_COLORS:
                    col = MC_COLORS[code]
                elif code == "l":
                    bold = True
                elif code == "r":
                    col, bold = base_col, False
                i += 2
                continue
            if ch == "\n":
                out.append(cur)
                cur = []
            else:
                cur.append((ch, col, bold))
            i += 1
        out.append(cur)
        return out

    def adv(self, ch, bold):
        _, w, _ = self.glyph(ch)
        return w + 1 + (1 if bold and ch != " " else 0)

    def wrap(self, lines, max_w):
        if max_w is None:
            return lines
        res = []
        for line in lines:
            cur, cur_w, last_space = [], 0, -1
            for item in line:
                a = self.adv(item[0], item[2])
                if cur_w + a > max_w and cur:
                    if item[0] == " ":
                        res.append(cur)
                        cur, cur_w, last_space = [], 0, -1
                        continue
                    if last_space >= 0:
                        res.append(cur[:last_space])
                        cur = cur[last_space + 1:]
                    else:
                        res.append(cur)
                        cur = []
                    cur_w = sum(self.adv(c, b) for c, _, b in cur)
                    last_space = -1
                if item[0] == " ":
                    last_space = len(cur)
                cur.append(item)
                cur_w += a
            res.append(cur)
        return res

    def line_w(self, line):
        w = sum(self.adv(c, b) for c, _, b in line)
        return max(0, w - 1)

    def render(self, lines, align, box_w, shadow=True):
        """RGBA image in font px."""
        W = max([self.line_w(l) for l in lines] + [box_w or 0]) + 2
        H = len(lines) * LINE_H + 2
        img = np.zeros((H, W, 4), np.float32)

        def blit(mask, x, y, rgb):
            h, w = mask.shape
            x0, y0 = max(0, x), max(0, y)
            x1, y1 = min(W, x + w), min(H, y + h)
            if x1 <= x0 or y1 <= y0:
                return
            m = mask[y0 - y:y1 - y, x0 - x:x1 - x]
            reg = img[y0:y1, x0:x1]
            reg[m] = (*[c / 255 for c in rgb], 1.0)

        for pass_shadow in ((True, False) if shadow else (False,)):
            for li, line in enumerate(lines):
                lw = self.line_w(line)
                bw = box_w if box_w else W - 2
                x = 0
                if align == "center":
                    x = int(round((bw - lw) / 2))
                elif align == "right":
                    x = bw - lw
                y = li * LINE_H + 1
                for ch, rgb, bold in line:
                    mask, w, dy = self.glyph(ch)
                    if mask is not None:
                        c = tuple(int(v * 0.25) for v in rgb) if pass_shadow else rgb
                        o = 1 if pass_shadow else 0
                        blit(mask, x + o, y + dy + o, c)
                        if bold:
                            blit(mask, x + 1 + o, y + dy + o, c)
                    x += self.adv(ch, bold)
        return Image.fromarray((img * 255).astype(np.uint8), "RGBA")


FONT = None

# ---------------------------------------------------------------- layout ---------
ANCHORS = {
    "top_left": (0, 0), "top_middle": (0.5, 0), "top_right": (1, 0),
    "left_middle": (0, 0.5), "center": (0.5, 0.5), "right_middle": (1, 0.5),
    "bottom_left": (0, 1), "bottom_middle": (0.5, 1), "bottom_right": (1, 1),
}
TERM = re.compile(r"([+-]?)(\d+(?:\.\d+)?)(%|px)?")


def length(v, parent):
    if isinstance(v, (int, float)):
        return float(v)
    s = v.replace(" ", "")
    total, pos = 0.0, 0
    for m in TERM.finditer(s):
        if m.start() != pos:
            raise ValueError(f"bad length {v!r}")
        pos = m.end()
        n = float(m.group(2)) * (-1 if m.group(1) == "-" else 1)
        total += n * parent / 100 if m.group(3) == "%" else n
    if pos != len(s):
        raise ValueError(f"bad length {v!r}")
    return total


class Ctx:
    def __init__(self, W, H, S, nodes):
        self.W, self.H, self.S, self.nodes = W, H, S, nodes
        self.draws = []  # (abs_layer, order, kind, payload)
        self.rects = {}  # path -> (x, y, w, h)
        self.order = 0
        self.errors = []


def label_lines(ctx, d, text):
    scale = d.get("font_scale_factor", 1.0)
    base = tuple(int(c * 255) for c in d.get("color", [1, 1, 1]))
    lines = FONT.parse(text or "", base)
    size = d.get("size")
    box_w = None
    if isinstance(size, list) and size[0] != "default":
        box_w = length(size[0], ctx.W) / scale
        lines = FONT.wrap(lines, box_w)
    # padding spaces are invisible: trim them for measuring (text fields are never centred)
    lines = [l[:max([i + 1 for i, it in enumerate(l) if it[0] != " "] + [0])] for l in lines]
    while lines and not lines[-1] and len(lines) > 1:
        lines.pop()
    return lines, scale, box_w


def layout(ctx, path, name, d, prect, abs_layer, forced_pos=None):
    node = ctx.nodes.get(path)
    if node is None:
        raise KeyError(path)
    if not node["visible"]:
        return None
    px, py, pw, ph = prect
    typ = d.get("type")
    size = d.get("size", ["100%", "100%"] if typ != "label" else ["default", "default"])
    lines = None
    if typ == "label":
        lines, scale, box_w = label_lines(ctx, d, node["text"])
        tw = max([FONT.line_w(l) for l in lines] + [0]) * scale
        th = len(lines) * LINE_H * scale
        w = tw if size[0] == "default" else length(size[0], pw)
        h = th if size[1] == "default" else length(size[1], ph)
    else:
        w = pw if size[0] == "default" else length(size[0], pw)
        h = ph if size[1] == "default" else length(size[1], ph)
    if forced_pos is not None:
        x, y = forced_pos
    else:
        fx, fy = ANCHORS[d.get("anchor_from", "center")]
        tx, ty = ANCHORS[d.get("anchor_to", "center")]
        off = d.get("offset", [0, 0])
        x = px + pw * fx - w * tx + length(off[0], pw)
        y = py + ph * fy - h * ty + length(off[1], ph)
    rect = (x, y, w, h)
    ctx.rects[path] = rect
    lay = abs_layer + d.get("layer", 0)
    ctx.order += 1
    if typ == "image":
        ctx.draws.append((lay, ctx.order, "image", (path, d, node, rect)))
    elif typ == "label":
        ctx.draws.append((lay, ctx.order, "label", (path, d, node, rect, lines)))
    elif typ == "custom":
        ctx.draws.append((lay, ctx.order, "doll", (path, d, node, rect)))
    children = []
    for c in d.get("controls", []):
        for cn, cd in c.items():
            children.append((cn, cd))
    if typ == "stack_panel":
        cur = 0.0
        vertical = d.get("orientation", "vertical") == "vertical"
        for cn, cd in children:
            cp = f"{path}/{cn}"
            pos = (x, y + cur) if vertical else (x + cur, y)
            r = layout(ctx, cp, cn, cd, rect, lay, forced_pos=pos)
            if r is not None:
                cur += r[3] if vertical else r[2]
    else:
        for cn, cd in children:
            layout(ctx, f"{path}/{cn}", cn, cd, rect, lay)
    return rect


# ---------------------------------------------------------------- drawing --------
_tex_cache = {}


def texture(ctx, tex):
    if tex in _tex_cache:
        return _tex_cache[tex]
    p = os.path.join(RP, tex + ".png")
    if not os.path.exists(p):
        ctx.errors.append(f"missing texture {tex}")
        im = None
    else:
        im = Image.open(p).convert("RGBA")
    _tex_cache[tex] = im
    return im


def paste(canvas, im, x, y, alpha=1.0):
    if alpha < 1.0:
        a = np.asarray(im).copy()
        a[..., 3] = (a[..., 3].astype(np.float32) * alpha).astype(np.uint8)
        im = Image.fromarray(a, "RGBA")
    canvas.alpha_composite(im, (int(round(x)), int(round(y))))


def draw_image(ctx, canvas, path, d, node, rect, anims):
    tex = node["texture"]
    im = texture(ctx, tex)
    x, y, w, h = rect
    S = ctx.S
    if im is None:
        ImageDraw.Draw(canvas).rectangle([x * S, y * S, (x + w) * S, (y + h) * S], outline=(255, 0, 255, 255), width=2)
        return
    if "uv_size" in d:
        uw, uh = d["uv_size"]
        im = im.crop((0, 0, uw, uh))
    tw, th = max(1, int(round(w * S))), max(1, int(round(h * S))
                                             )
    im = im.convert("RGBa").resize((tw, th), Image.LANCZOS).convert("RGBA")
    paste(canvas, im, x * S, y * S, d.get("alpha", 1.0) if isinstance(d.get("alpha", 1.0), (int, float)) else 1.0)


def draw_label(ctx, canvas, path, d, node, rect, lines):
    x, y, w, h = rect
    scale = d.get("font_scale_factor", 1.0)
    size = d.get("size")
    box_w = None
    if isinstance(size, list) and size[0] != "default":
        box_w = int(round(length(size[0], ctx.W) / scale))
    align = d.get("text_alignment", "left")
    img = FONT.render(lines, align, box_w, d.get("shadow", False))
    U = 8
    big = img.resize((img.width * U, img.height * U), Image.NEAREST)
    f = scale * ctx.S
    tw, th = max(1, int(round(img.width * f))), max(1, int(round(img.height * f)))
    small = big.convert("RGBa").resize((tw, th), Image.LANCZOS).convert("RGBA")
    # the render has a 1 font-px margin at the top/left
    paste(canvas, small, (x - scale) * ctx.S, (y - scale) * ctx.S)


def draw_doll(ctx, canvas, rect):
    """Stylised Mark V (red/gold) standing on the viewport platform. Approximation of the
    live_player_renderer output; size chosen like the vanilla inventory doll."""
    x, y, w, h = rect
    S = ctx.S
    # assumed like the vanilla inventory doll: model head at the panel top, model height = 2x panel
    cx = (x + w / 2) * S
    top = y * S
    u = 2 * h / 32 * S  # one model pixel
    d = ImageDraw.Draw(canvas)
    RED_, DRED, GOLD, EYE = (178, 28, 30, 255), (120, 16, 20, 255), (226, 180, 70, 255), (210, 250, 255, 255)

    def box(x0, y0, x1, y1, col):
        d.rectangle([cx + x0 * u, top + y0 * u, cx + x1 * u - 1, top + y1 * u - 1], fill=col)
    box(-4, 0, 4, 8, RED_)          # helmet
    box(-3, 2, 3, 7, GOLD)          # faceplate
    box(-2.5, 3.6, -0.6, 4.4, EYE)
    box(0.6, 3.6, 2.5, 4.4, EYE)
    box(-4, 8, 4, 20, RED_)         # torso
    box(-2, 9, 2, 13, DRED)
    d.ellipse([cx - 1.2 * u, top + 10 * u, cx + 1.2 * u, top + 12.4 * u], fill=EYE)  # arc reactor
    box(-8, 8, -4, 20, RED_)        # arms
    box(4, 8, 8, 20, RED_)
    box(-8, 14, -4, 17, GOLD)
    box(4, 14, 8, 17, GOLD)
    box(-4, 20, 0, 32, DRED)        # legs
    box(0, 20, 4, 32, DRED)
    box(-4, 24, 0, 28, GOLD)
    box(0, 24, 4, 28, GOLD)


# ---------------------------------------------------------------- scene ----------
def scene(W, H, S, kind):
    w, h = W * S, H * S
    rng = np.random.default_rng(7)
    ys = np.linspace(0, 1, h)[:, None]
    horizon = 0.62 if kind != "flight" else 0.80
    sky_top = np.array([88, 140, 222]) if kind != "failure" else np.array([40, 52, 80])
    sky_bot = np.array([170, 205, 245]) if kind != "failure" else np.array([80, 92, 120])
    t = np.clip(ys / horizon, 0, 1)
    img = (sky_top * (1 - t) + sky_bot * t)[:, None, :].repeat(w, 1)
    img = np.broadcast_to(img.reshape(h, 1, 3) if img.ndim == 2 else img, (h, w, 3)).copy()
    # clouds
    for _ in range(9):
        cxp, cyp = rng.uniform(0, w), rng.uniform(0.05, horizon * 0.7) * h
        for _k in range(4):
            bw, bh = rng.uniform(40, 110) * S / 2, rng.uniform(10, 22) * S / 2
            ox, oy = rng.uniform(-60, 60) * S / 2, rng.uniform(-8, 8) * S / 2
            x0, y0 = int(cxp + ox), int(cyp + oy)
            img[max(0, y0):max(0, int(y0 + bh)), max(0, x0):max(0, int(x0 + bw))] = (235, 240, 248)
    # blocky terrain
    blk = 8 * S
    hy = int(horizon * h)
    level = 0
    for bx in range(0, w, blk):
        level = int(np.clip(level + rng.integers(-1, 2), -3, 3))
        top = hy - level * blk // 2
        img[top:top + blk // 2, bx:bx + blk] = (92, 160, 62)
        img[top + blk // 2:, bx:bx + blk] = (110, 82, 56)
        if rng.random() < 0.12:  # tree
            img[top - 3 * blk:top, bx + blk // 3:bx + 2 * blk // 3] = (96, 70, 40)
            img[top - 5 * blk:top - 2 * blk, max(0, bx - blk // 2):bx + blk + blk // 2] = (52, 118, 44)
    gy = np.arange(h)[:, None, None]
    fade = np.clip((gy - hy) / (h - hy + 1), 0, 1) * 0.35
    img = img * (1 - fade) + np.array([60, 110, 50]) * fade * (gy > hy)
    if kind == "failure":
        img *= 0.55
    out = Image.fromarray(np.clip(img, 0, 255).astype(np.uint8), "RGB").convert("RGBA")
    d = ImageDraw.Draw(out)
    if kind in ("combat", "critical"):
        cx, cy = w / 2, h / 2
        u = 3.2 * S
        col = (64, 120, 60, 255) if kind == "combat" else (190, 190, 186, 255)
        d.rectangle([cx - 4 * u, cy - 9 * u, cx + 4 * u, cy - 1 * u], fill=col)
        d.rectangle([cx - 4 * u, cy - 1 * u, cx + 4 * u, cy + 11 * u], fill=(40, 90, 150, 255) if kind == "combat" else col)
        d.rectangle([cx - 12 * u, cy - 1 * u, cx - 4 * u, cy + 2.5 * u], fill=col)
        d.rectangle([cx + 4 * u, cy - 1 * u, cx + 12 * u, cy + 2.5 * u], fill=col)
        d.rectangle([cx - 4 * u, cy + 11 * u, cx + 4 * u, cy + 23 * u], fill=(60, 50, 120, 255) if kind == "combat" else col)
    if kind == "flight":
        cx, cy = w * 0.53, h * 0.47
        u = 1.2 * S
        d.rectangle([cx - 6 * u, cy - 4 * u, cx + 6 * u, cy + 4 * u], fill=(240, 240, 240, 255))
        d.rectangle([cx - 6 * u, cy + 4 * u, cx + 6 * u, cy + 10 * u], fill=(60, 50, 40, 255))
    return out


def vanilla_hud(canvas, W, H, S, phone):
    d = ImageDraw.Draw(canvas, "RGBA")
    hx = W / 2 - 91
    # hotbar
    d.rectangle([hx * S, (H - 22) * S, (hx + 182) * S, H * S - 1], fill=(20, 20, 20, 150), outline=(140, 140, 140, 255), width=S)
    for i in range(9):
        x = hx + 1 + i * 20
        d.rectangle([(x + 2) * S, (H - 20) * S, (x + 18) * S, (H - 3) * S], outline=(90, 90, 90, 255), width=1)
    d.rectangle([(hx - 1) * S, (H - 23) * S, (hx + 23) * S, H * S - 1], outline=(250, 250, 250, 255), width=S)
    # item icons (a few colored squares)
    for i, col in [(0, (200, 40, 40)), (1, (120, 120, 130)), (2, (170, 120, 60)), (4, (90, 200, 220))]:
        x = hx + 1 + i * 20
        d.rectangle([(x + 5) * S, (H - 17) * S, (x + 15) * S, (H - 6) * S], fill=col + (255,))
    # xp bar
    d.rectangle([hx * S, (H - 29) * S, (hx + 182) * S, (H - 25) * S], fill=(30, 30, 30, 220))
    d.rectangle([hx * S, (H - 29) * S, (hx + 120) * S, (H - 25) * S], fill=(110, 230, 60, 255))
    # hearts, hunger, armor
    for i in range(10):
        x = hx + i * 8
        d.rectangle([x * S, (H - 39) * S, (x + 7) * S, (H - 32) * S], fill=(210, 30, 30, 255), outline=(40, 0, 0, 255))
        x2 = hx + 182 - 8 - i * 8
        d.rectangle([x2 * S, (H - 39) * S, (x2 + 7) * S, (H - 32) * S], fill=(170, 110, 50, 255), outline=(50, 30, 0, 255))
        d.rectangle([x * S, (H - 49) * S, (x + 7) * S, (H - 42) * S], fill=(200, 205, 215, 255), outline=(60, 60, 70, 255))


def touch_controls(canvas, W, H, S):
    """Phone touch buttons (drawn on top, like the game does)."""
    lay = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(lay)
    o = (255, 255, 255, 150)
    f = (255, 255, 255, 45)
    d.rectangle([10 * S, (H - 100) * S, 100 * S, (H - 10) * S], outline=o, fill=f, width=S)  # move pad
    d.text((40 * S, (H - 70) * S), "D-PAD", fill=o)
    d.ellipse([(W - 70) * S, (H - 80) * S, (W - 20) * S, (H - 30) * S], outline=o, fill=f, width=S)  # jump
    d.ellipse([(W - 112) * S, (H - 48) * S, (W - 80) * S, (H - 16) * S], outline=o, fill=f, width=S)  # sneak
    for i in range(3):
        x = W - 100 + i * 33
        d.rectangle([x * S, 4 * S, (x + 28) * S, 32 * S], outline=o, fill=f, width=S)
    canvas.alpha_composite(lay)


# ------------------------------------------------------------ diagnostics --------
_visor_lines = None


def visor_line_mask():
    global _visor_lines
    if _visor_lines is None:
        a = np.asarray(Image.open(os.path.join(RP, "textures/sym/hud/visor_base.png")).convert("RGBA")).astype(int)
        _visor_lines = (a[..., 2] > 200) & (a[..., 1] > 150) & (a[..., 0] < 90) & (a[..., 3] > 160)
    return _visor_lines


def diagnostics(ctx, ns_root):
    msgs = []
    m = visor_line_mask()
    mh, mw = m.shape
    blocks = {
        "root/main/left_column/suit_panel": "armor panel",
        "root/main/left_column/energy_panel": "energy panel",
        "root/main/right_column/systems_panel": "systems panel",
        "root/main/right_column/scan_panel": "scan panel",
        "root/main/right_column/target_panel": "target panel",
        "root/main/top_center/alert_box": "alert banner",
        "root/main/flight_panel": "flight panel",
        "root/main/center/lock_tag": "lock tag",
    }
    vis = {k: ctx.rects[k] for k in blocks if k in ctx.rects}
    for k, (x, y, w, h) in vis.items():
        x0, x1 = int(max(0, x / ctx.W * mw)), int(min(mw, (x + w) / ctx.W * mw))
        y0, y1 = int(max(0, y / ctx.H * mh)), int(min(mh, (y + h) / ctx.H * mh))
        if m[y0:y1, x0:x1].any():
            msgs.append(f"{blocks[k]} crosses a visor polyline")
        if x < 0 or y < 0 or x + w > ctx.W or y + h > ctx.H:
            msgs.append(f"{blocks[k]} is off-screen {tuple(round(v, 1) for v in (x, y, w, h))}")
    keys = list(vis)
    for i in range(len(keys)):
        for j in range(i + 1, len(keys)):
            a, b = vis[keys[i]], vis[keys[j]]
            if a[0] < b[0] + b[2] and b[0] < a[0] + a[2] and a[1] < b[1] + b[3] and b[1] < a[1] + a[3]:
                msgs.append(f"overlap: {blocks[keys[i]]} / {blocks[keys[j]]}")
    # labels overflowing their nearest image ancestor
    for path, r in ctx.rects.items():
        node = ctx.nodes[path]
        if node["text"] is None or not node["visible"]:
            continue
        parent = path.rsplit("/", 1)[0]
        while parent and parent not in ctx.rects:
            parent = parent.rsplit("/", 1)[0]
        pr = ctx.rects.get(parent)
        if pr is None or parent in ("root", "root/main", "root/main/top_center", "root/boot"):
            continue
        if r[0] + r[2] > pr[0] + pr[2] + 0.5 or r[1] + r[3] > pr[1] + pr[3] + 0.5:
            msgs.append(f"label overflows its panel: {path} ({r[2]:.0f}x{r[3]:.0f} at {r[0] - pr[0]:.0f},{r[1] - pr[1]:.0f} in {pr[2]:.0f}x{pr[3]:.0f})")
    return msgs


# ------------------------------------------------------------------ main ---------
def render(state_key, data, ns, W, H, S, phone=False):
    nodes = data[state_key]["nodes"]
    ctx = Ctx(W, H, S, nodes)
    layout(ctx, "root", "root", ns["root"], (0, 0, W, H), 0)
    canvas = scene(W, H, S, {"flight": "flight", "script_texts": "flight", "combat": "combat", "critical": "critical", "failure": "failure"}.get(state_key, "idle"))
    hud = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    draws = sorted(ctx.draws, key=lambda t: (t[0], t[1]))
    # the visor artwork (absolute layer 0) goes below the vanilla HUD, everything else above it
    under = [t for t in draws if t[0] <= 0]
    over = [t for t in draws if t[0] > 0]
    for lst, target in ((under, canvas), (over, None)):
        for lay, _, kind, payload in lst:
            dst = canvas
            if kind == "image":
                draw_image(ctx, dst, *payload, anims=None)
            elif kind == "label":
                draw_label(ctx, dst, *payload)
            elif kind == "doll":
                draw_doll(ctx, dst, payload[3])
        if lst is under:
            vanilla_hud(canvas, W, H, S, phone)
    del hud
    if phone:
        touch_controls(canvas, W, H, S)
    return canvas.convert("RGB"), ctx, diagnostics(ctx, ns)


def main():
    global FONT
    FONT = Font()
    os.makedirs(DIST, exist_ok=True)
    raw = subprocess.run(["node", os.path.join(HERE, "dump_resolved.mjs")], check=True, capture_output=True, text=True).stdout
    data = json.loads(raw)
    ns = json.load(open(os.path.join(RP, "ui", "sym_mk5_hud.json"), encoding="utf-8"))
    problems = 0
    jobs = [(k, 640, 360, 2, False, f"hud_preview_{k}.png") for k in PREVIEWS]
    jobs += [(k, 533, 240, 3, True, f"hud_preview_phone_{k}.png") for k in PHONE_PREVIEWS]
    if "script_texts" in data:  # texts produced by the real script builders
        jobs.append(("script_texts", 640, 360, 2, False, "hud_preview_script_texts.png"))
    for key, W, H, S, phone, fn in jobs:
        img, ctx, msgs = render(key, data, ns, W, H, S, phone)
        img.save(os.path.join(DIST, fn), optimize=True)
        msgs = ctx.errors + msgs
        problems += len(ctx.errors)
        print(f"{fn}: {data[key]['title']} ({W}x{H} GUI px)" + ("" if not msgs else ""))
        for m in msgs:
            print("   - " + m)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
