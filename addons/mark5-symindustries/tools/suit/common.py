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

# SPEC 2.2 / 11.1 / 14.2 attachable extra animations: short key -> animation id
EXTRA_ANIMS = {
    "visor_opened": "animation.sym.mk5.visor_opened",
    "visor_opening": "animation.sym.mk5.visor_opening",
    "visor_closing": "animation.sym.mk5.visor_closing",
    "eyes_boot": "animation.sym.mk5.eyes_boot",
    "eyes_shutdown": "animation.sym.mk5.eyes_shutdown",
    "visor_shut": "animation.sym.mk5.visor_shut",
    "visor_up": "animation.sym.mk5.visor_up",
    "flames_flicker": "animation.sym.mk5.flames_flicker",
    "flames_hidden": "animation.sym.mk5.flames_hidden",
}
EXTRA_ANIM_KEYS = sorted(EXTRA_ANIMS)

# SPEC 2.1 + 11.1 variant table: id -> (protection, attachable texture, [extra animation keys])
# `visor_shut` / `visor_up` pin the faceplate on every non-transition worn variant (SPEC 14.2);
# `visor_up` carries the whole open pose (mask + eyes hidden), replacing `visor_opened` so the two
# never stack on the same bone.
VARIANTS = {
    "sym:mark_5": (20, "textures/sym/mk5", ["visor_shut"]),
    "sym:mark_5_powerup": (20, "textures/sym/mk5", ["eyes_boot", "visor_shut"]),
    "sym:mark_5_flying": (20, "textures/sym/mk5", ["visor_shut", "flames_flicker", "flames_hidden"]),
    "sym:mark_5_open": (20, "textures/sym/mk5", ["visor_up"]),
    "sym:mark_5_open_flying": (20, "textures/sym/mk5", ["visor_up", "flames_flicker", "flames_hidden"]),
    "sym:mark_5_opening": (20, "textures/sym/mk5", ["visor_opening"]),
    "sym:mark_5_closing": (20, "textures/sym/mk5", ["visor_closing"]),
    "sym:mark_5_powerdown": (20, "textures/sym/mk5", ["eyes_shutdown", "visor_shut"]),
    "sym:mark_5_offline": (8, "textures/sym/mk5_off", ["visor_shut"]),
    "sym:mark_5_offline_open": (8, "textures/sym/mk5_off", ["visor_up"]),
    "sym:mark_5_offline_opening": (8, "textures/sym/mk5_off", ["visor_opening"]),
    "sym:mark_5_offline_closing": (8, "textures/sym/mk5_off", ["visor_closing"]),
}
NEW_VARIANTS = [v for v in VARIANTS if v != BASE_ID]

# SPEC 11.1: the two flying variants render the suit AND the flame geometry
FLAMES_VARIANTS = ["sym:mark_5_flying", "sym:mark_5_open_flying"]
FLAMES_GEOMETRY = "geometry.sym.mk5_flames"
FLAMES_TEXTURE = "textures/sym/mk5_flames"
FLAMES_RC = "controller.render.sym_mk5_flames"
FLAME_BONES = {  # bone -> (nozzle x, nozzle y, nozzle z); read from sym_mk5.geo.json cube bounds
    "mk5_flame_rh": ("rightArm", -6.0, 12.0, 0.0325),
    "mk5_flame_lh": ("leftArm", 6.0, 12.0, 0.0325),
    "mk5_flame_rf": ("rightLeg", -1.9775, 0.0, -0.025),
    "mk5_flame_lf": ("leftLeg", 1.9775, 0.0, -0.025),
}
# top-level bones of geometry.sym.mk5_flames: same names and pivots as geometry.sym.mk5
FLAMES_ROOT_BONES = {
    "rightArm": [-5, 22, 0],
    "leftArm": [5, 22, 0],
    "rightLeg": [-1.9, 12, 0],
    "leftLeg": [1.9, 12, 0],
}

# SPEC 14.2: which faceplate pin each worn variant declares (None = transition clip owns the pose)
TRANSITIONS = [v for v in VARIANTS if v.endswith("_opening") or v.endswith("_closing")]
PINNED = {
    v: (None if v in TRANSITIONS else ("visor_up" if "_open" in v else "visor_shut")) for v in VARIANTS
}

SUIT_DISPLAY_NAME = "Armadura Mark V"
REACTOR_ID = "sym:mark_5_reactor"
REACTOR_DISPLAY_NAME = "Reator Arc (Painel Mark V)"

# Render-controller sets (SPEC 2.1 + 11.1)
FULL = list(VARIANTS) + ["sym:mark_5_assembling_4", "sym:mark_5_disassembling_1"]
FACE_VISIBLE = [
    "sym:mark_5_open",
    "sym:mark_5_open_flying",
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
# the flame geometry only burns on the worn third-person suit
FLAMES_ON_CONDITION = WORN_CONDITION + " && !c.is_first_person"
FLAMES_OFF_CONDITION = "c.item_slot == 'main_hand' || c.item_slot == 'off_hand' || c.is_first_person"
EXTRA_CONDITION = dict(
    {k: WORN_CONDITION for k in EXTRA_ANIMS},
    flames_flicker=FLAMES_ON_CONDITION,
    flames_hidden=FLAMES_OFF_CONDITION,
)

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
