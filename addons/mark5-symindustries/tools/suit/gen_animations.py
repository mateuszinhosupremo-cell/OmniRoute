#!/usr/bin/env python3
"""Attachable visor/eye animations (SPEC 2.2) and player flight/paper-doll animations (SPEC 2.3,
8.1, 9). New entries are (re)written into the existing animation files; existing animations are
left byte-identical (the files keep their 1-space indentation).

Attachable keyframes are DERIVED from the original cinematic clips (suitoff_1 / suitup_3) by
re-timing their mask / side-plate / eye channels, so the visor moves exactly like the suit-up.

Player animations are ADDITIVE (no override_previous_animation) and every channel is multiplied by
`(1 - variable.is_first_person)`; limbs use `(X - this)` to pin an absolute pose in third person
while adding exactly 0 in first person (first-person arms stay vanilla). `root` tilt/offset is
also disabled for the HUD paper doll (`variable.is_paperdoll`).
"""

import copy
import os
import sys

sys.dont_write_bytecode = True  # keep tools/suit free of __pycache__
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import FLAME_BONES, G_FP, G_ROOT, RP, load_json, report, write_json  # noqa: E402

ATT_PATH = os.path.join(RP, "animations", "sym_mk5.animation.json")
PLAYER_PATH = os.path.join(RP, "animations", "sym_mk5_player.animation.json")

MASK, EYES, LMASK, RMASK = "mk5_mask", "mk5_eyes", "mk5_Left_mask", "mk5_Right_mask"
ZERO, ONE = [0, 0, 0], [1, 1, 1]
# SPEC 14.2: faceplate bones pinned by visor_shut / visor_up (eyes handled separately)
FACE_BONES = [MASK, LMASK, RMASK, "mk5_mainframe", "mk5_upper_face", "mk5_lower_face",
              "mk5_Lower_face_left", "mk5_Lower_face_right"]
# SPEC 11.1: flicker phases (deg) so the four nozzles never pulse in sync
FLAME_PHASES = {"mk5_flame_rh": 0, "mk5_flame_lh": 97, "mk5_flame_rf": 211, "mk5_flame_lf": 304}


def flame_flicker():
    """Fast, subtle per-nozzle flicker; the bone pivot sits at the nozzle so it grows away from it."""
    bones = {}
    for bone, ph in FLAME_PHASES.items():
        y = ("0.86 + math.sin(query.life_time * 1100 + %d) * 0.13"
             " + math.sin(query.life_time * 2050 + %d) * 0.06") % (ph, (ph * 17) % 360)
        xz = "0.95 + math.sin(query.life_time * 1450 + %d) * 0.055" % ((ph * 7 + 60) % 360)
        bones[bone] = {"scale": [xz, y, xz]}
    return bones


# ---------------------------------------------------------------- keyframe helpers
def fmt(t):
    s = ("%.4f" % t).rstrip("0")
    return s + "0" if s.endswith(".") else s


def remap(channel, t0, t1, n0, n1):
    """Keys of `channel` with t0 <= t <= t1, linearly re-timed into [n0, n1]."""
    out = {}
    for k, v in channel.items():
        t = float(k)
        if t0 - 1e-6 <= t <= t1 + 1e-6:
            out[fmt(n0 + (t - t0) * (n1 - n0) / (t1 - t0))] = copy.deepcopy(v)
    if not out:
        raise ValueError("no keys in [%s, %s]" % (t0, t1))
    return out


def merged(*parts):
    keys = {}
    for p in parts:
        keys.update(p)
    return {k: keys[k] for k in sorted(keys, key=float)}


def step(before, after):
    return {"pre": before, "post": after}


def flicker_off(t0, t1, transitions=5):
    """Crisp LED flicker 1 -> 0 -> 1 ... ending OFF at t1 (odd number of transitions)."""
    keys = {fmt(t0): ONE}
    state = ONE
    for i in range(1, transitions + 1):
        nxt = ZERO if state is ONE else ONE
        keys[fmt(t0 + (t1 - t0) * i / transitions)] = step(state, nxt)
        state = nxt
    assert state is ZERO
    return keys


def flicker_on(t0, t1, transitions=5):
    """Crisp LED flicker 0 -> 1 -> 0 ... ending ON at t1 (odd number of transitions)."""
    keys = {fmt(t0): ZERO}
    state = ZERO
    for i in range(1, transitions + 1):
        nxt = ONE if state is ZERO else ZERO
        keys[fmt(t0 + (t1 - t0) * i / transitions)] = step(state, nxt)
        state = nxt
    assert state is ONE
    return keys


def last_value(channel):
    v = channel[max(channel, key=float)]
    return v["post"] if isinstance(v, dict) else v


# ---------------------------------------------------------------- attachable animations
def attachable_animations(src):
    off = src["animation.sym.mk5.suitoff_1"]["bones"]
    up3 = src["animation.sym.mk5.suitup_3"]["bones"]

    def ch(bones, bone, name):
        return bones[bone][name]

    # suitoff_1: plates unlatch 1.75-2.1667 s, mask lifts 2.25-2.75 s, eyes die 0.625-1.5 s
    # suitup_3: mask comes down 0.55-1.05 s (with the -0.5 overshoot), plates latch 1.1333-1.55 s,
    #           eyes boot 1.8-2.675 s
    opened = {
        MASK: {"rotation": [-75, 0, 0], "position": [0, 5, 3]},
        EYES: {"scale": ZERO},
    }
    for bone in (MASK,):  # the static pose must equal the end of the original lift
        assert last_value(ch(off, bone, "rotation")) == opened[bone]["rotation"]
        assert last_value(remap(ch(off, bone, "position"), 2.25, 2.75, 0, 1)) == opened[bone]["position"]

    opening = {}
    for bone in (LMASK, RMASK):
        unl_rot = remap(ch(off, bone, "rotation"), 1.75, 2.1667, 0.15, 0.35)
        unl_pos = remap(ch(off, bone, "position"), 1.75, 2.1667, 0.15, 0.35)
        opening[bone] = {
            "rotation": merged(unl_rot, {"0.65": last_value(unl_rot), "0.8": ZERO}),
            "position": merged(unl_pos, {"0.65": last_value(unl_pos), "0.8": ZERO}),
        }
    opening[MASK] = {
        "rotation": remap(ch(off, MASK, "rotation"), 2.25, 2.75, 0.35, 0.65),
        "position": remap(ch(off, MASK, "position"), 2.25, 2.75, 0.35, 0.65),
    }
    opening[EYES] = {"scale": flicker_off(0.0, 0.2)}

    closing = {}
    for bone in (LMASK, RMASK):
        unl_rot = remap(ch(off, bone, "rotation"), 1.75, 2.1667, 0.0, 0.12)
        unl_pos = remap(ch(off, bone, "position"), 1.75, 2.1667, 0.0, 0.12)
        latch_rot = remap(ch(up3, bone, "rotation"), 1.1333, 1.55, 0.52, 0.72)
        latch_pos = remap(ch(up3, bone, "position"), 1.1333, 1.55, 0.52, 0.72)
        closing[bone] = {"rotation": merged(unl_rot, latch_rot), "position": merged(unl_pos, latch_pos)}
    closing[MASK] = {
        "rotation": remap(ch(up3, MASK, "rotation"), 0.55, 1.05, 0.12, 0.52),
        "position": remap(ch(up3, MASK, "position"), 0.55, 1.05, 0.12, 0.52),
    }
    # SPEC 11.1: sym:mark_5 no longer carries eyes_boot, so the closing clip lights the eyes
    closing[EYES] = {"scale": merged({"0.0": ZERO}, flicker_on(0.6, 0.8))}

    eyes_boot = {EYES: {"scale": remap(ch(up3, EYES, "scale"), 1.8, 2.675, 0.0, 0.875)}}
    eyes_shutdown = {EYES: {"scale": remap(ch(off, EYES, "scale"), 0.625, 1.5, 0.0, 1.2)}}

    # sanity: end poses
    assert last_value(opening[MASK]["rotation"]) == [-75, 0, 0]
    assert last_value(opening[MASK]["position"]) == [0, 5, 3]
    assert last_value(closing[MASK]["position"]) == ZERO and last_value(closing[MASK]["rotation"]) == ZERO
    assert last_value(eyes_boot[EYES]["scale"]) == ONE
    assert last_value(eyes_shutdown[EYES]["scale"]) == ZERO
    for bone in (LMASK, RMASK):
        for c in ("rotation", "position"):
            assert last_value(opening[bone][c]) == ZERO and last_value(closing[bone][c]) == ZERO

    # SPEC 14.2: pin the faceplate on every worn non-transition variant so a chest-item swap
    # can never show the mask in the wrong pose for a frame.
    rest = {"rotation": ZERO, "position": ZERO, "scale": ONE}
    visor_shut = {b: dict(rest) for b in FACE_BONES}
    visor_up = {b: dict(rest) for b in FACE_BONES}
    visor_up[MASK] = {"rotation": [-75, 0, 0], "position": [0, 5, 3], "scale": ONE}
    visor_up[EYES] = {"scale": ZERO}  # same effect as the old visor_opened clip it replaces
    assert visor_up[MASK]["rotation"] == opened[MASK]["rotation"]
    assert visor_up[MASK]["position"] == opened[MASK]["position"]

    hold = "hold_on_last_frame"
    return {
        "animation.sym.mk5.visor_opened": {"loop": True, "bones": opened},
        "animation.sym.mk5.visor_opening": {"loop": hold, "animation_length": 0.8, "bones": opening},
        "animation.sym.mk5.visor_closing": {"loop": hold, "animation_length": 0.8, "bones": closing},
        "animation.sym.mk5.eyes_boot": {"loop": hold, "animation_length": 0.9, "bones": eyes_boot},
        "animation.sym.mk5.eyes_shutdown": {"loop": hold, "animation_length": 1.2, "bones": eyes_shutdown},
        "animation.sym.mk5.visor_shut": {"loop": True, "bones": visor_shut},
        "animation.sym.mk5.visor_up": {"loop": True, "bones": visor_up},
        "animation.sym.mk5.flames_flicker": {"loop": True, "bones": flame_flicker()},
        "animation.sym.mk5.flames_hidden": {"loop": True, "bones": {b: {"scale": ZERO} for b in FLAME_BONES}},
    }


# ---------------------------------------------------------------- player animations
H = 15  # px: tilt pivot height above the feet (body centre) -> model stays centred on the hitbox
PITCH = "query.target_x_rotation"
R_FLY = "math.clamp(30 + %s * 0.3, 20, 45)" % PITCH  # SPEC 9: moderate lean 20-45 deg
R_BOOST = "math.clamp(90 + %s, 20, 160)" % PITCH  # SPEC 9: lie down like vanilla swim
SHAKE = "math.sin(query.life_time * 1900) * 0.6"
T = "query.anim_time"
# vanilla right-arm swing (animation.player.attack.rotations) so punching still works mid-air
PUNCH = "(math.sin((1 - math.pow((1 - variable.attack_time), 4)) * 180) * 1.2 + math.sin(variable.attack_time * 180)) * 30"


def _is_number(expr):
    try:
        float(expr)
        return True
    except ValueError:
        return False


def absolute(expr):
    """Third person: channel == expr. First person: adds 0 (vanilla pose untouched)."""
    expr = str(expr)
    if _is_number(expr) and float(expr) == 0:
        return "-this * %s" % G_FP
    if _is_number(expr):
        return "(%s - this) * %s" % (expr, G_FP)
    return "((%s) - this) * %s" % (expr, G_FP)


def additive(expr):
    expr = str(expr)
    return ("%s * %s" if _is_number(expr) else "(%s) * %s") % (expr, G_FP)


def limb(x, y, z):
    return {"rotation": [absolute(x), absolute(y), absolute(z)]}


def root_tilt(r, extra=None):
    rot = "(%s%s) * %s" % (r, (" + " + extra) if extra else "", G_ROOT)
    return {
        "rotation": [rot, 0, 0],
        "position": [0, "%d * (1 - math.cos(%s)) * %s" % (H, r, G_ROOT), "%d * math.sin(%s) * %s" % (H, r, G_ROOT)],
    }


# SPEC 14.1: NO head channel in mk5_fly / mk5_boost. Vanilla
# `animation.humanoid.look_at_target.default` is already `"relative_to": {"rotation": "entity"}`,
# so the head is oriented against the ENTITY, not against our rotated `root` bone. The old
# `head_counter()` compensation double-corrected and pitched the helmet up to 75 deg backwards
# ("the helmet opens / tilts way back" in the user's video). Removed; never reintroduce.


def key_pose(keys, kind):
    """Keyframed channel; kind 'abs' pins absolute values, 'add' adds; None value = add 0."""
    out = {}
    for t, vec in keys:
        if vec is None:
            out[fmt(t)] = [0, 0, 0]
        else:
            f = absolute if kind == "abs" else additive
            out[fmt(t)] = [f(str(v)) if v != 0 or kind == "abs" else 0 for v in vec]
    return out


def root_keys(keys):
    return {fmt(t): [0, ("%s * %s" % (y, G_ROOT)) if y else 0, 0] for t, y in keys}


def player_animations():
    hover = {
        "loop": True,
        "animation_length": 2.0,
        "bones": {
            "root": {"position": [0, "math.sin(%s * 180) * 0.4 * %s" % (T, G_ROOT), 0]},
            "rightArm": limb("-8 + math.sin(%s * 180) * 1.5 - %s" % (T, PUNCH), "0", "24 + math.sin(%s * 180) * 1.5" % T),
            "leftArm": limb("-8 + math.sin(%s * 180 + 40) * 1.5" % T, "0", "-24 - math.sin(%s * 180 + 40) * 1.5" % T),
            "rightLeg": limb("3 + math.sin(%s * 180 + 90) * 1.5" % T, "0", "2"),
            "leftLeg": limb("2 + math.sin(%s * 180 + 130) * 1.5" % T, "0", "-2"),
        },
    }
    fly = {
        "loop": True,
        "animation_length": 2.0,
        "bones": {
            "root": root_tilt(R_FLY),
            "rightArm": limb("30 + math.sin(%s * 180) * 2 - %s" % (T, PUNCH), "0", "10"),
            "leftArm": limb("30 + math.sin(%s * 180 + 60) * 2" % T, "0", "-10"),
            "rightLeg": limb("10 + math.sin(%s * 180 + 90) * 2" % T, "0", "1.5"),
            "leftLeg": limb("5 + math.sin(%s * 180 + 150) * 2" % T, "0", "-1.5"),
        },
    }
    boost = {
        "loop": True,
        "animation_length": 1.0,
        "bones": {
            "root": root_tilt(R_BOOST, SHAKE),
            "rightArm": limb("10 + math.sin(query.life_time * 2300) * 0.8", "0", "6"),
            "leftArm": limb("10 + math.sin(query.life_time * 2300 + 90) * 0.8", "0", "-6"),
            "rightLeg": limb("3 + math.sin(query.life_time * 2100) * 0.6", "0", "1"),
            "leftLeg": limb("3 + math.sin(query.life_time * 2100 + 120) * 0.6", "0", "-1"),
        },
    }
    takeoff = {
        "loop": False,
        "animation_length": 0.5,
        "bones": {
            "root": {"position": root_keys([(0, 0), (0.12, -2), (0.28, 0.6), (0.5, 0)])},
            # lean on `waist` (pivot at the hips) so the torso tips without detaching from the legs
            "waist": {"rotation": key_pose([(0, None), (0.12, (18, 0, 0)), (0.3, None)], "add")},
            "head": {"rotation": key_pose([(0, None), (0.12, (15, 0, 0)), (0.32, (-8, 0, 0)), (0.5, None)], "add")},
            "rightArm": {"rotation": key_pose([(0, None), (0.12, (-30, 0, 14)), (0.26, (12, 0, 26)), (0.5, (-8, 0, 24))], "abs")},
            "leftArm": {"rotation": key_pose([(0, None), (0.12, (-30, 0, -14)), (0.26, (12, 0, -26)), (0.5, (-8, 0, -24))], "abs")},
            "rightLeg": {"rotation": key_pose([(0, None), (0.12, (-14, 0, 3)), (0.32, (4, 0, 2)), (0.5, (3, 0, 2))], "abs")},
            "leftLeg": {"rotation": key_pose([(0, None), (0.12, (-14, 0, -3)), (0.32, (4, 0, -2)), (0.5, (2, 0, -2))], "abs")},
        },
    }
    land = {
        "loop": False,
        "animation_length": 1.0,
        "bones": {
            # hips drop 7.5 px -> both 12 px legs at +-68 deg put the feet on the ground
            # (cos 68 * 12 = 4.5); the torso leans 38 deg on `waist` (hip pivot), so a right arm at
            # -34 deg relative to it (4 deg in the world) puts the fist on the ground:
            # 4.5 + 10 * cos 38 - 12 * cos 4 = 0.4 px
            "root": {"position": root_keys([(0, 0), (0.1, -8), (0.18, -7.5), (0.62, -7.5), (0.92, 0), (1.0, 0)])},
            "waist": {"rotation": key_pose([(0, None), (0.1, (42, 0, 0)), (0.18, (38, 0, 0)), (0.62, (38, 0, 0)), (0.92, None)], "add")},
            "head": {"rotation": key_pose([(0, None), (0.1, (10, 0, 0)), (0.4, (10, 0, 0)), (0.55, (-14, 0, 0)), (0.75, (-14, 0, 0)), (0.95, None)], "add")},
            # right knee down (leg back), left leg forward bent, right fist to the ground, left arm out back
            "rightLeg": {"rotation": key_pose([(0, None), (0.1, (68, 0, 6)), (0.62, (68, 0, 6)), (0.92, (0, 0, 0)), (1.0, None)], "abs")},
            "leftLeg": {"rotation": key_pose([(0, None), (0.1, (-68, 0, -4)), (0.62, (-68, 0, -4)), (0.92, (0, 0, 0)), (1.0, None)], "abs")},
            "rightArm": {"rotation": key_pose([(0, None), (0.1, (-34, 0, 6)), (0.62, (-34, 0, 6)), (0.92, (0, 0, 0)), (1.0, None)], "abs")},
            "leftArm": {"rotation": key_pose([(0, None), (0.1, (55, 0, -35)), (0.62, (55, 0, -35)), (0.92, (0, 0, 0)), (1.0, None)], "abs")},
        },
    }
    reset = {"loop": False, "animation_length": 0.05}
    spin = {
        "loop": True,
        "bones": {"root": {"rotation": [0, "math.mod(query.time_stamp * 2 + query.life_time * 40, 360)", 0]}},
    }
    return {
        "animation.sym.player.mk5_hover": hover,
        "animation.sym.player.mk5_fly": fly,
        "animation.sym.player.mk5_boost": boost,
        "animation.sym.player.mk5_takeoff": takeoff,
        "animation.sym.player.mk5_land": land,
        "animation.sym.player.mk5_flight_reset": reset,
        "animation.sym.player.paperdoll_spin": spin,
    }


def merge_into(path, new):
    data = load_json(path)
    anims = data["animations"]
    for k, v in new.items():
        anims[k] = v  # replaces only our own keys; dict order of existing entries preserved
    return write_json(path, data, indent=1)


def main():
    att = load_json(ATT_PATH)
    report(ATT_PATH, merge_into(ATT_PATH, attachable_animations(att["animations"])))
    report(PLAYER_PATH, merge_into(PLAYER_PATH, player_animations()))


if __name__ == "__main__":
    main()
