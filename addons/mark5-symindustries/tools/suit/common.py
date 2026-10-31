"""Shared constants and helpers for the suit-area generators (SPEC 2.1-2.3, 8.1).

All generators are idempotent: they rebuild their outputs from the identifier table below and
from the untouched parts of the existing pack files, and only write a file when its bytes change.
"""

import json
import os

B = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
BP = os.path.join(B, "pack", "Mark5_BP")
RP = os.path.join(B, "pack", "Mark5_RP")
DIST = os.path.join(B, "dist")
BASELINE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "baseline")

BASE_ID = "sym:mark_5"

# SPEC 2.1 variant table: id -> (protection, attachable texture, extra animation key, animation id)
VARIANTS = {
    "sym:mark_5": (20, "textures/sym/mk5", "eyes_boot", "animation.sym.mk5.eyes_boot"),
    "sym:mark_5_open": (20, "textures/sym/mk5", "visor_opened", "animation.sym.mk5.visor_opened"),
    "sym:mark_5_opening": (20, "textures/sym/mk5", "visor_opening", "animation.sym.mk5.visor_opening"),
    "sym:mark_5_closing": (20, "textures/sym/mk5", "visor_closing", "animation.sym.mk5.visor_closing"),
    "sym:mark_5_powerdown": (20, "textures/sym/mk5", "eyes_shutdown", "animation.sym.mk5.eyes_shutdown"),
    "sym:mark_5_offline": (8, "textures/sym/mk5_off", None, None),
    "sym:mark_5_offline_open": (8, "textures/sym/mk5_off", "visor_opened", "animation.sym.mk5.visor_opened"),
    "sym:mark_5_offline_opening": (8, "textures/sym/mk5_off", "visor_opening", "animation.sym.mk5.visor_opening"),
    "sym:mark_5_offline_closing": (8, "textures/sym/mk5_off", "visor_closing", "animation.sym.mk5.visor_closing"),
}
NEW_VARIANTS = [v for v in VARIANTS if v != BASE_ID]
EXTRA_ANIM_KEYS = sorted({v[2] for v in VARIANTS.values() if v[2]})

SUIT_DISPLAY_NAME = "Armadura Mark V"
REACTOR_ID = "sym:mark_5_reactor"
REACTOR_DISPLAY_NAME = "Reator Arc (Painel Mark V)"

# Render-controller sets (SPEC 2.1)
FULL = list(VARIANTS) + ["sym:mark_5_assembling_4", "sym:mark_5_disassembling_1"]
FACE_VISIBLE = [
    "sym:mark_5_open",
    "sym:mark_5_opening",
    "sym:mark_5_closing",
    "sym:mark_5_offline_open",
    "sym:mark_5_offline_opening",
    "sym:mark_5_offline_closing",
]
FULL_CLOSED = [i for i in FULL if i not in FACE_VISIBLE]
STAGE3 = ["sym:mark_5_assembling_3", "sym:mark_5_disassembling_2"]
STAGE2 = ["sym:mark_5_assembling_2", "sym:mark_5_disassembling_3"]
LEGS_SET = FULL + STAGE3  # legs are armored from stage 3 on (unchanged stage logic)
ANY_STAGE = FULL + STAGE3 + STAGE2

WORN_CONDITION = "!(c.item_slot == 'main_hand' || c.item_slot == 'off_hand')"

# Gates for player animations: never move first-person arms; never tilt/offset the paper doll.
G_FP = "(1 - variable.is_first_person)"
G_ROOT = "(1 - variable.is_first_person) * (1 - variable.is_paperdoll)"


def item_file(identifier):
    return identifier.split(":", 1)[1] + ".json"


def attachable_file(identifier):
    name = identifier.split(":", 1)[1]
    return ("sym_" + name if identifier == BASE_ID else name) + ".json"


def is_item_name_any(ids, slot="slot.armor.chest", chunk=4):
    """OR-ed query.is_item_name_any calls with at most `chunk` names each, wrapped in parens."""
    calls = []
    for i in range(0, len(ids), chunk):
        names = ", ".join("'%s'" % n for n in ids[i : i + chunk])
        calls.append("query.is_item_name_any('%s', 0, %s)" % (slot, names))
    return "(" + " || ".join(calls) + ")"


def load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def dumps(data, indent=2):
    return json.dumps(data, indent=indent, ensure_ascii=False) + "\n"


def write_text(path, text):
    """Write only when the content changes; return True when written."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            if f.read() == text:
                return False
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    return True


def write_json(path, data, indent=2):
    return write_text(path, dumps(data, indent))


def report(path, changed):
    print(("updated  " if changed else "unchanged") + " " + os.path.relpath(path, B))
