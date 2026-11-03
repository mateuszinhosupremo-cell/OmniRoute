#!/usr/bin/env python3
"""Player render controllers (SPEC 2.1) + paper-doll spin registration (SPEC 8.1).

Render controllers are regenerated from scratch (idempotent):
  - every suit variant behaves like sym:mark_5 (FULL set: body/arms/legs hidden -> undersuit);
  - FACE VISIBLE variants (visor open/opening/closing) show Tony's head instead of the undersuit
    head; Tony's hat layer stays hidden for every armored stage;
  - the assembling/disassembling stage logic is unchanged (stage 3 armors the legs, stage 2 only
    the torso/arms, stage 4 / disassembling 1 are full).
player.entity.json: only adds the `sym_paperdoll_spin` animation + its scripts.animate entry. No
tint / overlay of any kind (SPEC 8.2 cancelled).
"""

import os
import sys

sys.dont_write_bytecode = True  # keep tools/suit free of __pycache__
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (  # noqa: E402
    ANY_STAGE,
    FULL,
    FULL_CLOSED,
    LEGS_SET,
    RP,
    is_item_name_any,
    load_json,
    report,
    write_json,
)

RC_PATH = os.path.join(RP, "render_controllers", "sym_mk5_player.render_controllers.json")
ENTITY_PATH = os.path.join(RP, "entity", "player.entity.json")

SPIN_KEY = "sym_paperdoll_spin"
SPIN_ANIM = "animation.sym.player.paperdoll_spin"

# vanilla first-person arm conditions (unchanged from the original controllers)
RIGHT_HAND_FREE = "(query.get_equipped_item_name(0, 1) == '' || query.get_equipped_item_name(0, 1) == 'filled_map')"
LEFT_ARM_SHOWN = (
    "((query.get_equipped_item_name(0, 1) == 'filled_map' && query.get_equipped_item_name('off_hand') != 'shield')"
    " || (query.get_equipped_item_name('off_hand') == 'filled_map' && !query.item_is_charged)"
    " || (!query.item_is_charged && (variable.item_use_normalized > 0 && variable.item_use_normalized < 1.0)))"
)

ANY_STAGE_X = is_item_name_any(ANY_STAGE)
LEGS_X = is_item_name_any(LEGS_SET)
CLOSED_X = is_item_name_any(FULL_CLOSED)
FULL_X = is_item_name_any(FULL)


def controller(texture, parts):
    return {
        "geometry": "Geometry.sym_tony",
        "materials": [{"*": "Material.default"}],
        "textures": [texture],
        "part_visibility": [{"*": False}] + [{k: v} for k, v in parts],
    }


def render_controllers():
    tony, suit = "Texture.sym_tony", "Texture.sym_mk5"
    return {
        "format_version": "1.8.0",
        "render_controllers": {
            "controller.render.player.first_person": controller(
                tony,
                [
                    ("rightArm", "%s && !%s" % (RIGHT_HAND_FREE, ANY_STAGE_X)),
                    ("rightSleeve", "%s && !%s" % (RIGHT_HAND_FREE, ANY_STAGE_X)),
                    ("leftArm", "%s && !%s" % (LEFT_ARM_SHOWN, ANY_STAGE_X)),
                    ("leftSleeve", "%s && !%s" % (LEFT_ARM_SHOWN, ANY_STAGE_X)),
                ],
            ),
            "controller.render.player.sym_mk5_first_person": controller(
                suit,
                [
                    ("rightArm", "%s && %s" % (RIGHT_HAND_FREE, ANY_STAGE_X)),
                    ("leftArm", "%s && %s" % (LEFT_ARM_SHOWN, ANY_STAGE_X)),
                ],
            ),
            "controller.render.player.third_person": controller(
                tony,
                [
                    ("head", "!" + CLOSED_X),
                    ("hat", "!" + ANY_STAGE_X),
                    ("body", "!" + ANY_STAGE_X),
                    ("jacket", "!" + ANY_STAGE_X),
                    ("rightArm", "!" + ANY_STAGE_X),
                    ("rightSleeve", "!" + ANY_STAGE_X),
                    ("leftArm", "!" + ANY_STAGE_X),
                    ("leftSleeve", "!" + ANY_STAGE_X),
                    ("rightLeg", "!" + LEGS_X),
                    ("leftLeg", "!" + LEGS_X),
                    ("rightPants", "!" + ANY_STAGE_X),
                    ("leftPants", "!" + ANY_STAGE_X),
                ],
            ),
            "controller.render.player.sym_mk5_third_person": controller(
                suit,
                [
                    ("head", CLOSED_X),
                    ("body", ANY_STAGE_X),
                    ("rightArm", ANY_STAGE_X),
                    ("leftArm", ANY_STAGE_X),
                    ("rightLeg", LEGS_X),
                    ("leftLeg", LEGS_X),
                ],
            ),
            "controller.render.player.map": controller(tony, [("head", True), ("hat", True)]),
        },
    }


def update_entity():
    data = load_json(ENTITY_PATH)
    desc = data["minecraft:client_entity"]["description"]
    desc["animations"][SPIN_KEY] = SPIN_ANIM
    animate = desc["scripts"]["animate"]
    animate[:] = [e for e in animate if not (isinstance(e, dict) and SPIN_KEY in e)]
    animate.append({SPIN_KEY: "variable.is_paperdoll && " + FULL_X})
    return write_json(ENTITY_PATH, data)


def main():
    report(RC_PATH, write_json(RC_PATH, render_controllers()))
    report(ENTITY_PATH, update_entity())


if __name__ == "__main__":
    main()
