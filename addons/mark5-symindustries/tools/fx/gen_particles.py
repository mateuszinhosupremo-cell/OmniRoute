#!/usr/bin/env python3
"""Mark V FX — particle effect generator (idempotent).

Writes pack/Mark5_RP/particles/sym_mk5_<name>.json for every effect of SPEC 2.4
(+ a few `sym:mk5_fx_*` child effects spawned through particle events).
Existing sym_mk5_spark.json / sym_mk5_power_burst.json are left untouched.

Only components/fields used by vanilla Bedrock particles are emitted
(cross-checked against Mojang/bedrock-samples resource_pack/particles and the
Snowstorm/Wintersky reference implementation):
  emitter_initialization, emitter_rate_instant/steady, emitter_lifetime_once,
  emitter_lifetime_events, emitter_shape_point/custom/sphere/disc,
  particle_initialization, particle_lifetime_expression, particle_initial_speed,
  particle_initial_spin, particle_motion_dynamic/parametric/collision,
  particle_appearance_billboard (lookat_xyz / direction_z / emitter_transform_xz),
  particle_appearance_tinting, particle_appearance_lighting, events.particle_effect.

Script inputs (SPEC 2.4) are all optional and defaulted in-file:
  variable.dir (vec3), variable.power, variable.size, variable.width,
  variable.radius, variable.color (rgba) and the OPTIONAL extra variable.vel
  (vec3, carrier velocity in blocks/tick — keeps thruster flames glued to the
  nozzles while the player moves; defaults to 0).
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from gen_particle_textures import ATLAS, ATLAS_W, ATLAS_H  # noqa: E402

B = os.path.abspath(os.path.join(HERE, "..", ".."))
OUT_DIR = os.path.join(B, "pack", "Mark5_RP", "particles")
TEX = "textures/sym/particle/mk5_fx"

LT = "variable.lt = math.clamp(variable.particle_age / variable.particle_lifetime, 0.0, 1.0);"
DIR_DEFAULT = ("variable.dir ?? {{ variable.dir.x = {x}; variable.dir.y = {y}; variable.dir.z = {z}; }}; ")
VEL_DEFAULT = "variable.vel ?? { variable.vel.x = 0.0; variable.vel.y = 0.0; variable.vel.z = 0.0; }; "


def uv(name, u_expr=None, v_expr=None):
    x, y, w, h = ATLAS[name]
    return {
        "texture_width": ATLAS_W,
        "texture_height": ATLAS_H,
        "uv": [u_expr if u_expr is not None else x, v_expr if v_expr is not None else y],
        "uv_size": [w, h],
    }


def uv_random(prefix, count, rnd="variable.particle_random_3"):
    """Pick one of `count` same-row cells prefix_0..prefix_{n-1} by a particle random."""
    x0, y0, w, h = ATLAS[f"{prefix}_0"]
    return uv(f"{prefix}_0", f"{x0} + math.floor({rnd} * {count - 0.01}) * {w}", y0)


def uv_flipbook(prefix, frames):
    x0, y0, w, h = ATLAS[f"{prefix}_0"]
    return {
        "texture_width": ATLAS_W,
        "texture_height": ATLAS_H,
        "uv": [0, 0],
        "uv_size": [1, 1],
        "flipbook": {
            "base_UV": [x0, y0],
            "size_UV": [w, h],
            "step_UV": [w, 0],
            "frames_per_second": 20,
            "max_frame": frames,
            "stretch_to_lifetime": True,
        },
    }


def billboard(size_x, size_y, uvd, mode="lookat_xyz", direction=None):
    b = {"size": [size_x, size_y], "facing_camera_mode": mode}
    if direction is not None:
        b["direction"] = direction
    b["uv"] = uvd
    return b


def effect(ident, material, components, events=None):
    pe = {
        "description": {
            "identifier": ident,
            "basic_render_parameters": {"material": material, "texture": TEX},
        }
    }
    if events:
        pe["events"] = events
    pe["components"] = components
    return {"format_version": "1.10.0", "particle_effect": pe}


def child(effect_id):
    return {"particle_effect": {"effect": effect_id, "type": "emitter"}}


def ease_out(p, t="variable.lt"):
    return f"(1.0 - math.pow(1.0 - {t}, {p}))"


EFFECTS = {}


def reg(name, data):
    EFFECTS[name] = data


# ============================================================ thrusters (SPEC 2.4 + 9)
# Speed of a flame sprite along the exhaust (blocks/s), per particle (random_1).
S = "((1.8 + variable.particle_random_1 * 2.2) * variable.spd)"
VX = f"(variable.dir.x * {S} + variable.vel.x * 20.0)"
VY = f"(variable.dir.y * {S} + variable.vel.y * 20.0)"
VZ = f"(variable.dir.z * {S} + variable.vel.z * 20.0)"

reg("thrust", effect("sym:mk5_thrust", "particles_add", {
    "minecraft:emitter_initialization": {
        "creation_expression": DIR_DEFAULT.format(x="0.0", y="-1.0", z="0.0") + VEL_DEFAULT +
        "variable.pw = math.clamp(variable.power ?? 1.0, 0.0, 1.0); variable.spd = 0.6 + 0.4 * variable.pw; "
        "variable.boost = math.clamp((variable.pw - 0.78) * 4.5, 0.0, 1.0);"
    },
    "minecraft:emitter_rate_instant": {"num_particles": "6 + 8 * math.clamp(variable.power ?? 1.0, 0.0, 1.0)"},
    "minecraft:emitter_lifetime_once": {"active_time": 0.05},
    "minecraft:emitter_shape_custom": {
        "offset": [
            "variable.dir.x * variable.particle_random_2 * 0.1 + math.random(-0.035, 0.035)",
            "variable.dir.y * variable.particle_random_2 * 0.1 + math.random(-0.035, 0.035)",
            "variable.dir.z * variable.particle_random_2 * 0.1 + math.random(-0.035, 0.035)",
        ],
        "direction": [f"{VX} + math.random(-0.45, 0.45)", f"{VY} + math.random(-0.45, 0.45)",
                      f"{VZ} + math.random(-0.45, 0.45)"],
    },
    "minecraft:particle_initialization": {
        "per_render_expression": LT +
        " variable.om = variable.particle_random_4 < 0.25 ? variable.boost : 0.0;"
    },
    "minecraft:particle_lifetime_expression": {"max_lifetime": "0.06 + variable.particle_random_3 * 0.08"},
    "minecraft:particle_initial_speed": f"math.sqrt({VX} * {VX} + {VY} * {VY} + {VZ} * {VZ}) + 0.01",
    "minecraft:particle_motion_dynamic": {},
    "minecraft:particle_appearance_billboard": billboard(
        "(0.135 - 0.04 * variable.particle_random_1) * (0.7 + 0.3 * variable.pw) * (1.0 - 0.6 * variable.lt) * (1.0 + 0.5 * variable.om)",
        "(0.135 - 0.04 * variable.particle_random_1) * (0.7 + 0.3 * variable.pw) * (1.0 - 0.6 * variable.lt) * (1.0 + 0.5 * variable.om)",
        uv_flipbook("flame", 8)),
    "minecraft:particle_appearance_tinting": {"color": [
        1.0,
        "math.lerp(0.97 - 0.12 * variable.lt - 0.25 * variable.lt * variable.lt, 0.55 - 0.15 * variable.lt, variable.om)",
        "math.lerp(0.75 * math.pow(1.0 - variable.lt, 4.0) + 0.05, 0.1, variable.om)",
        "math.lerp((1.0 - variable.lt * variable.lt) * (0.5 + 0.2 * variable.pw), 0.35 * (1.0 - variable.lt), variable.om)",
    ]},
}))

GVX, GVY, GVZ = "(variable.vel.x * 20.0)", "(variable.vel.y * 20.0 + 0.0001)", "(variable.vel.z * 20.0)"
reg("thrust_glow", effect("sym:mk5_thrust_glow", "particles_add", {
    "minecraft:emitter_initialization": {
        "creation_expression": VEL_DEFAULT + "variable.pw = math.clamp(variable.power ?? 1.0, 0.0, 1.0);"
    },
    "minecraft:emitter_rate_instant": {"num_particles": 1},
    "minecraft:emitter_lifetime_once": {"active_time": 0.05},
    "minecraft:emitter_shape_point": {"direction": [GVX, GVY, GVZ]},
    "minecraft:particle_initialization": {"per_render_expression": LT},
    "minecraft:particle_lifetime_expression": {"max_lifetime": 0.12},
    "minecraft:particle_initial_speed": f"math.sqrt({GVX} * {GVX} + {GVY} * {GVY} + {GVZ} * {GVZ})",
    "minecraft:particle_motion_dynamic": {},
    "minecraft:particle_appearance_billboard": billboard(
        "(0.09 + 0.07 * variable.pw) * (1.0 + 0.12 * math.sin(variable.particle_age * 2400.0 + variable.particle_random_1 * 360.0))",
        "(0.09 + 0.07 * variable.pw) * (1.0 + 0.12 * math.sin(variable.particle_age * 2400.0 + variable.particle_random_1 * 360.0))",
        uv("glow_star")),
    "minecraft:particle_appearance_tinting": {"color": [
        1.0, 0.95, "0.6 + 0.1 * variable.particle_random_1",
        "(0.6 + 0.2 * variable.pw) * (1.0 - variable.lt * variable.lt * variable.lt)",
    ]},
}))

reg("smoke", effect("sym:mk5_smoke", "particles_blend", {
    "minecraft:emitter_initialization": {"creation_expression": DIR_DEFAULT.format(x="0.0", y="-1.0", z="0.0")},
    "minecraft:emitter_rate_instant": {"num_particles": "math.random_integer(2, 4)"},
    "minecraft:emitter_lifetime_once": {"active_time": 0.05},
    "minecraft:emitter_shape_custom": {
        "offset": ["math.random(-0.1, 0.1)", "math.random(-0.1, 0.1)", "math.random(-0.1, 0.1)"],
        "direction": ["variable.dir.x * 1.2 + math.random(-0.4, 0.4)",
                      "variable.dir.y * 1.2 + math.random(0.2, 0.7)",
                      "variable.dir.z * 1.2 + math.random(-0.4, 0.4)"],
    },
    "minecraft:particle_initialization": {"per_render_expression": LT},
    "minecraft:particle_lifetime_expression": {"max_lifetime": "math.random(0.8, 1.4)"},
    "minecraft:particle_initial_speed": "math.random(0.8, 1.6)",
    "minecraft:particle_initial_spin": {"rotation": "math.random(0, 360)", "rotation_rate": "math.random(-40, 40)"},
    "minecraft:particle_motion_dynamic": {"linear_acceleration": [0, 0.6, 0], "linear_drag_coefficient": 1.2},
    "minecraft:particle_appearance_billboard": billboard(
        "(0.12 + 0.45 * math.sqrt(variable.lt)) * (0.8 + 0.4 * variable.particle_random_2)",
        "(0.12 + 0.45 * math.sqrt(variable.lt)) * (0.8 + 0.4 * variable.particle_random_2)",
        uv_random("smoke", 4)),
    "minecraft:particle_appearance_lighting": {},
    "minecraft:particle_appearance_tinting": {"color": [
        "0.42 + 0.12 * variable.particle_random_4", "0.42 + 0.12 * variable.particle_random_4",
        "0.44 + 0.12 * variable.particle_random_4",
        "0.55 * (1.0 - variable.lt) * math.clamp(variable.lt * 6.0, 0.0, 1.0)",
    ]},
}))

# ============================================================ sonic boom (SPEC 12.4 — sharp vapor cone)
# Three hard-edged rings staggered along -dir with shrinking radius read as a Mach cone.
BK = "variable.particle_random_1 * 1.15"
BOOM_DIR = ["variable.dir.x + 0.0001", "variable.dir.y", "variable.dir.z + 0.0001"]
BOOM_SIZE = f"(0.2 + 3.4 * {ease_out(2.6)}) * (1.0 - 0.5 * variable.particle_random_1)"
reg("boom", effect("sym:mk5_boom", "particles_blend", {
    "minecraft:emitter_initialization": {"creation_expression": DIR_DEFAULT.format(x="0.0", y="0.0", z="1.0")},
    "minecraft:emitter_rate_instant": {"num_particles": 3},
    "minecraft:emitter_lifetime_once": {"active_time": 0.05},
    "minecraft:emitter_lifetime_events": {"creation_event": "vapor"},
    "minecraft:emitter_shape_custom": {
        "offset": [f"0.0 - variable.dir.x * {BK}", f"0.0 - variable.dir.y * {BK}", f"0.0 - variable.dir.z * {BK}"],
        "direction": BOOM_DIR,
    },
    "minecraft:particle_initialization": {"per_render_expression": LT},
    "minecraft:particle_lifetime_expression": {"max_lifetime": "0.38 + variable.particle_random_2 * 0.07"},
    "minecraft:particle_initial_speed": 0,
    "minecraft:particle_appearance_billboard": billboard(
        BOOM_SIZE, BOOM_SIZE, uv("ring_crisp"), mode="direction_z",
        direction={"mode": "custom", "custom_direction": BOOM_DIR}),
    "minecraft:particle_appearance_tinting": {"color": [
        0.93, 0.97, 1.0,
        "0.95 * math.pow(1.0 - variable.lt, 1.5) * (1.0 - 0.3 * variable.particle_random_1)"]},
}, events={"vapor": child("sym:mk5_fx_vapor")}))

# clean vapor: a thin expanding shell of hard-edged white puffs (no drifting smoke)
reg("fx_vapor", effect("sym:mk5_fx_vapor", "particles_blend", {
    "minecraft:emitter_rate_instant": {"num_particles": 8},
    "minecraft:emitter_lifetime_once": {"active_time": 0.05},
    "minecraft:emitter_shape_sphere": {"radius": 0.35, "direction": "outwards"},
    "minecraft:particle_initialization": {"per_render_expression": LT},
    "minecraft:particle_lifetime_expression": {"max_lifetime": "0.24 + variable.particle_random_1 * 0.08"},
    "minecraft:particle_initial_speed": "9.0 + variable.particle_random_2 * 4.0",
    "minecraft:particle_motion_dynamic": {"linear_drag_coefficient": 7.0},
    "minecraft:particle_appearance_billboard": billboard(
        "0.22 + 0.34 * variable.lt", "0.22 + 0.34 * variable.lt", uv("puff")),
    "minecraft:particle_appearance_tinting": {"color": [
        0.95, 0.98, 1.0, "0.7 * math.pow(1.0 - variable.lt, 1.3)"]},
}))

# ============================================================ takeoff / landing (SPEC 12.4 — clean)
# takeoff = bright burst + one crisp shockwave ring + a low dust wash + a few sharp sparks.
TO_SIZE = f"0.35 + 3.1 * {ease_out(2.2)}"
reg("takeoff", effect("sym:mk5_takeoff", "particles_add", {
    "minecraft:emitter_rate_instant": {"num_particles": 1},
    "minecraft:emitter_lifetime_once": {"active_time": 0.05},
    "minecraft:emitter_lifetime_events": {"creation_event": ["flash", "dust_ring", "sparks"]},
    "minecraft:emitter_shape_point": {"offset": [0, 0.05, 0]},
    "minecraft:particle_initialization": {"per_render_expression": LT},
    "minecraft:particle_lifetime_expression": {"max_lifetime": 0.36},
    "minecraft:particle_initial_speed": 0,
    "minecraft:particle_appearance_billboard": billboard(
        TO_SIZE, TO_SIZE, uv("ring_crisp"), mode="emitter_transform_xz"),
    "minecraft:particle_appearance_tinting": {"color": [
        1.0, "1.0 - 0.3 * variable.lt", "0.78 - 0.6 * variable.lt", "math.pow(1.0 - variable.lt, 1.1)"]},
}, events={"flash": child("sym:mk5_fx_impact_flash"), "dust_ring": child("sym:mk5_fx_dust_ring"),
           "sparks": child("sym:mk5_fx_sparks_up")}))

# landing = crisp dust shockwave + white impact burst + short debris + a few clean puffs.
LD_SIZE = f"0.3 + 3.4 * {ease_out(2.8)}"
reg("landing", effect("sym:mk5_landing", "particles_blend", {
    "minecraft:emitter_rate_instant": {"num_particles": 1},
    "minecraft:emitter_lifetime_once": {"active_time": 0.05},
    "minecraft:emitter_lifetime_events": {"creation_event": ["flash", "debris", "puffs"]},
    "minecraft:emitter_shape_point": {"offset": [0, 0.06, 0]},
    "minecraft:particle_initialization": {"per_render_expression": LT},
    "minecraft:particle_lifetime_expression": {"max_lifetime": 0.55},
    "minecraft:particle_initial_speed": 0,
    "minecraft:particle_appearance_billboard": billboard(
        LD_SIZE, LD_SIZE, uv("ring_dust"), mode="emitter_transform_xz"),
    "minecraft:particle_appearance_lighting": {},
    "minecraft:particle_appearance_tinting": {"color": [
        0.82, 0.78, 0.71, "0.9 * math.pow(1.0 - variable.lt, 1.4)"]},
}, events={"flash": child("sym:mk5_fx_impact_flash"), "debris": child("sym:mk5_fx_debris"),
           "puffs": child("sym:mk5_fx_dust_puffs")}))

DR_SIZE = f"0.5 + 3.8 * {ease_out(2.6)}"
reg("fx_dust_ring", effect("sym:mk5_fx_dust_ring", "particles_blend", {
    "minecraft:emitter_rate_instant": {"num_particles": 1},
    "minecraft:emitter_lifetime_once": {"active_time": 0.05},
    "minecraft:emitter_shape_point": {"offset": [0, 0.06, 0]},
    "minecraft:particle_initialization": {"per_render_expression": LT},
    "minecraft:particle_lifetime_expression": {"max_lifetime": 0.6},
    "minecraft:particle_initial_speed": 0,
    "minecraft:particle_appearance_billboard": billboard(
        DR_SIZE, DR_SIZE, uv("ring_dust"), mode="emitter_transform_xz"),
    "minecraft:particle_appearance_lighting": {},
    "minecraft:particle_appearance_tinting": {"color": [
        0.8, 0.76, 0.69, "0.6 * math.pow(1.0 - variable.lt, 1.5)"]},
}))

reg("fx_dust_puffs", effect("sym:mk5_fx_dust_puffs", "particles_blend", {
    "minecraft:emitter_rate_instant": {"num_particles": 6},
    "minecraft:emitter_lifetime_once": {"active_time": 0.05},
    "minecraft:emitter_shape_disc": {"plane_normal": "y", "offset": [0, 0.12, 0], "radius": 0.55,
                                     "direction": "outwards"},
    "minecraft:particle_initialization": {"per_render_expression": LT},
    "minecraft:particle_lifetime_expression": {"max_lifetime": "math.random(0.3, 0.5)"},
    "minecraft:particle_initial_speed": "math.random(4.5, 7.0)",
    "minecraft:particle_initial_spin": {"rotation": "math.random(0, 360)", "rotation_rate": "math.random(-25, 25)"},
    "minecraft:particle_motion_dynamic": {"linear_drag_coefficient": 5.0},
    "minecraft:particle_appearance_billboard": billboard(
        "(0.2 + 0.34 * variable.lt) * (0.85 + 0.3 * variable.particle_random_2)",
        "(0.2 + 0.34 * variable.lt) * (0.85 + 0.3 * variable.particle_random_2)", uv("puff")),
    "minecraft:particle_appearance_lighting": {},
    "minecraft:particle_appearance_tinting": {"color": [
        0.76, 0.72, 0.65, "0.55 * math.pow(1.0 - variable.lt, 1.2)"]},
}))

reg("fx_sparks_up", effect("sym:mk5_fx_sparks_up", "particles_add", {
    "minecraft:emitter_rate_instant": {"num_particles": 9},
    "minecraft:emitter_lifetime_once": {"active_time": 0.05},
    "minecraft:emitter_shape_disc": {"plane_normal": "y", "radius": 0.3,
                                     "direction": ["math.random(-0.5, 0.5)", "math.random(1.4, 2.4)",
                                                   "math.random(-0.5, 0.5)"]},
    "minecraft:particle_initialization": {"per_render_expression": LT},
    "minecraft:particle_lifetime_expression": {"max_lifetime": "math.random(0.3, 0.55)"},
    "minecraft:particle_initial_speed": "math.random(6.0, 10.0)",
    "minecraft:particle_motion_dynamic": {"linear_acceleration": [0, -14, 0], "linear_drag_coefficient": 1.0},
    "minecraft:particle_appearance_billboard": billboard(
        "0.03 * (1.0 - 0.4 * variable.lt)", "0.17 * (1.0 - 0.5 * variable.lt)", uv("streak")),
    "minecraft:particle_appearance_tinting": {"color": [
        1.0, "1.0 - 0.35 * variable.lt", "0.72 - 0.6 * variable.lt", "math.pow(1.0 - variable.lt, 0.8)"]},
}))

reg("fx_debris", effect("sym:mk5_fx_debris", "particles_blend", {
    "minecraft:emitter_rate_instant": {"num_particles": 7},
    "minecraft:emitter_lifetime_once": {"active_time": 0.05},
    "minecraft:emitter_shape_disc": {"plane_normal": "y", "offset": [0, 0.1, 0], "radius": 0.55,
                                     "direction": ["math.random(-1.0, 1.0)", "math.random(1.6, 3.0)",
                                                   "math.random(-1.0, 1.0)"]},
    "minecraft:particle_initialization": {"per_render_expression": LT},
    "minecraft:particle_lifetime_expression": {"max_lifetime": "math.random(0.45, 0.75)"},
    "minecraft:particle_initial_speed": "math.random(4.0, 7.0)",
    "minecraft:particle_initial_spin": {"rotation": "math.random(0, 360)", "rotation_rate": "math.random(-300, 300)"},
    "minecraft:particle_motion_dynamic": {"linear_acceleration": [0, -20, 0], "linear_drag_coefficient": 0.4},
    "minecraft:particle_motion_collision": {"collision_radius": 0.05, "coefficient_of_restitution": 0.2,
                                            "collision_drag": 5},
    "minecraft:particle_appearance_billboard": billboard(
        "0.045 + 0.03 * variable.particle_random_2", "0.045 + 0.03 * variable.particle_random_2", uv("chunk")),
    "minecraft:particle_appearance_lighting": {},
    "minecraft:particle_appearance_tinting": {"color": [
        "0.72 + 0.14 * variable.particle_random_4", "0.67 + 0.12 * variable.particle_random_4",
        "0.58 + 0.1 * variable.particle_random_4", "math.clamp((1.0 - variable.lt) * 6.0, 0.0, 1.0)"]},
}))

FL_SIZE = f"0.45 + 1.15 * {ease_out(2.0)}"
reg("fx_impact_flash", effect("sym:mk5_fx_impact_flash", "particles_add", {
    "minecraft:emitter_rate_instant": {"num_particles": 1},
    "minecraft:emitter_lifetime_once": {"active_time": 0.05},
    "minecraft:emitter_shape_point": {"offset": [0, 0.25, 0]},
    "minecraft:particle_initialization": {"per_render_expression": LT},
    "minecraft:particle_lifetime_expression": {"max_lifetime": 0.18},
    "minecraft:particle_initial_speed": 0,
    "minecraft:particle_appearance_billboard": billboard(FL_SIZE, FL_SIZE, uv("burst")),
    "minecraft:particle_appearance_tinting": {"color": [
        1.0, "0.98 - 0.22 * variable.lt", "0.82 - 0.5 * variable.lt", "math.pow(1.0 - variable.lt, 1.7)"]},
}))

# ============================================================ boost contrail (SPEC 12.4, NEW)
# A short line of crisp beads laid along `dir` from the boot: yellow-white at the nozzle, fading to
# a faint cyan-white tail. It inherits 60 % of the suit velocity (`vel`, blocks/tick) and is dragged
# down from there, so at boost speed the segments stay readable instead of being left behind.
TVX, TVY, TVZ = "(variable.vel.x * 12.0)", "(variable.vel.y * 12.0 + 0.0001)", "(variable.vel.z * 12.0)"
TRAIL_SIZE = "(0.095 - 0.05 * variable.particle_random_1) * (1.0 - 0.4 * variable.lt)"
reg("trail", effect("sym:mk5_trail", "particles_add", {
    "minecraft:emitter_initialization": {
        "creation_expression": DIR_DEFAULT.format(x="0.0", y="-1.0", z="0.0") + VEL_DEFAULT},
    "minecraft:emitter_rate_instant": {"num_particles": 7},
    "minecraft:emitter_lifetime_once": {"active_time": 0.05},
    "minecraft:emitter_shape_custom": {
        "offset": ["variable.dir.x * variable.particle_random_1 * 0.85 + math.random(-0.015, 0.015)",
                   "variable.dir.y * variable.particle_random_1 * 0.85 + math.random(-0.015, 0.015)",
                   "variable.dir.z * variable.particle_random_1 * 0.85 + math.random(-0.015, 0.015)"],
        "direction": [TVX, TVY, TVZ],
    },
    "minecraft:particle_initialization": {"per_render_expression": LT},
    "minecraft:particle_lifetime_expression": {"max_lifetime": "0.2 + variable.particle_random_2 * 0.06"},
    "minecraft:particle_initial_speed": f"math.sqrt({TVX} * {TVX} + {TVY} * {TVY} + {TVZ} * {TVZ})",
    "minecraft:particle_motion_dynamic": {"linear_drag_coefficient": 3.0},
    "minecraft:particle_appearance_billboard": billboard(TRAIL_SIZE, TRAIL_SIZE, uv("dot")),
    "minecraft:particle_appearance_tinting": {"color": [
        "1.0 - 0.3 * variable.particle_random_1 - 0.2 * variable.lt",
        "1.0 - 0.05 * variable.particle_random_1",
        "math.clamp(0.66 + 0.3 * variable.particle_random_1 + 0.25 * variable.lt, 0.0, 1.0)",
        "(0.9 - 0.45 * variable.particle_random_1) * math.pow(1.0 - variable.lt, 1.3)"]},
}))

# ============================================================ scanner
RAD = "variable.rad = math.max(variable.radius ?? 32.0, 1.0);"
reg("scan_wave", effect("sym:mk5_scan_wave", "particles_add", {
    "minecraft:emitter_initialization": {"creation_expression": RAD},
    "minecraft:emitter_rate_steady": {"spawn_rate": 15, "max_particles": 3},
    "minecraft:emitter_lifetime_once": {"active_time": 0.2},
    "minecraft:emitter_lifetime_events": {"creation_event": "flash"},
    "minecraft:emitter_shape_point": {"offset": [0, 0.04, 0]},
    "minecraft:particle_initialization": {"per_render_expression": LT},
    "minecraft:particle_lifetime_expression": {"max_lifetime": 1.4},
    "minecraft:particle_initial_speed": 0,
    "minecraft:particle_appearance_billboard": billboard(
        "variable.rad / 0.9 * variable.lt + 0.05", "variable.rad / 0.9 * variable.lt + 0.05", uv("ring_wave"),
        mode="emitter_transform_xz"),
    "minecraft:particle_appearance_tinting": {"color": [
        0.25, 0.9, 1.0, "0.95 * (1.0 - variable.lt * variable.lt) * math.clamp(variable.lt * 10.0, 0.0, 1.0)"]},
}, events={"flash": child("sym:mk5_fx_flash_cyan")}))

reg("scan_dome", effect("sym:mk5_scan_dome", "particles_add", {
    "minecraft:emitter_initialization": {"creation_expression": RAD},
    "minecraft:emitter_rate_instant": {"num_particles": 1},
    "minecraft:emitter_lifetime_once": {"active_time": 0.05},
    "minecraft:emitter_shape_point": {},
    "minecraft:particle_initialization": {"per_render_expression": LT},
    "minecraft:particle_lifetime_expression": {"max_lifetime": 1.4},
    "minecraft:particle_initial_speed": 0,
    "minecraft:particle_motion_parametric": {"rotation": "variable.particle_age * 40.0"},
    "minecraft:particle_appearance_billboard": billboard(
        "variable.rad / 0.92 * variable.lt + 0.05", "variable.rad / 0.92 * variable.lt + 0.05", uv("ring_tech_hd")),
    "minecraft:particle_appearance_tinting": {"color": [
        0.3, 0.85, 1.0, "0.35 * (1.0 - variable.lt * variable.lt) * math.clamp(variable.lt * 8.0, 0.0, 1.0)"]},
}))

reg("fx_flash_cyan", effect("sym:mk5_fx_flash_cyan", "particles_add", {
    "minecraft:emitter_rate_instant": {"num_particles": 1},
    "minecraft:emitter_lifetime_once": {"active_time": 0.05},
    "minecraft:emitter_shape_point": {},
    "minecraft:particle_initialization": {"per_render_expression": LT},
    "minecraft:particle_lifetime_expression": {"max_lifetime": 0.3},
    "minecraft:particle_initial_speed": 0,
    "minecraft:particle_initial_spin": {"rotation": "math.random(0, 360)"},
    "minecraft:particle_appearance_billboard": billboard(
        "0.3 + 0.9 * math.sqrt(variable.lt)", "0.3 + 0.9 * math.sqrt(variable.lt)", uv("flash")),
    "minecraft:particle_appearance_tinting": {"color": [0.5, 0.92, 1.0, "math.pow(1.0 - variable.lt, 2.0)"]},
}))

# ============================================================ AR marks
reg("mark", effect("sym:mk5_mark", "particles_blend", {
    "minecraft:emitter_initialization": {
        "creation_expression": "variable.mw = math.max(variable.width ?? 0.9, 0.2); "
        "variable.mh = math.max(variable.size ?? 1.8, 0.2); "
        "variable.color ?? { variable.color.r = 1.0; variable.color.g = 1.0; variable.color.b = 1.0; variable.color.a = 1.0; };"
    },
    "minecraft:emitter_rate_instant": {"num_particles": 1},
    "minecraft:emitter_lifetime_once": {"active_time": 0.05},
    "minecraft:emitter_shape_point": {},
    "minecraft:particle_initialization": {
        "per_render_expression": LT + " variable.pulse = 1.0 + 0.04 * math.sin(variable.lt * 180.0);"
    },
    "minecraft:particle_lifetime_expression": {"max_lifetime": 0.35},
    "minecraft:particle_initial_speed": 0,
    "minecraft:particle_appearance_billboard": billboard(
        "(variable.mw * 0.59 + 0.08) * variable.pulse", "(variable.mh * 0.56 + 0.08) * variable.pulse", uv("brackets")),
    "minecraft:particle_appearance_tinting": {"color": [
        "variable.color.r", "variable.color.g", "variable.color.b",
        "variable.color.a * math.clamp(variable.particle_age / 0.1, 0.0, 1.0) * "
        "math.clamp((variable.particle_lifetime - variable.particle_age) / 0.1, 0.0, 1.0)"]},
}))

reg("lock", effect("sym:mk5_lock", "particles_add", {
    "minecraft:emitter_initialization": {"creation_expression": "variable.ls = math.max(variable.size ?? 1.8, 0.4);"},
    "minecraft:emitter_rate_instant": {"num_particles": 1},
    "minecraft:emitter_lifetime_once": {"active_time": 0.05},
    "minecraft:emitter_shape_point": {},
    "minecraft:particle_initialization": {
        "per_render_expression": "variable.snap = math.pow(1.0 - math.clamp(variable.particle_age / 0.12, 0.0, 1.0), 2.0);"
    },
    "minecraft:particle_lifetime_expression": {"max_lifetime": 0.3},
    "minecraft:particle_initial_speed": 0,
    "minecraft:particle_motion_parametric": {
        "rotation": "45.0 * math.pow(1.0 - math.clamp(variable.particle_age / 0.12, 0.0, 1.0), 2.0)"},
    "minecraft:particle_appearance_billboard": billboard(
        "variable.ls * 0.62 * (1.0 + 0.25 * variable.snap)", "variable.ls * 0.62 * (1.0 + 0.25 * variable.snap)",
        uv("lock")),
    "minecraft:particle_appearance_tinting": {"color": [
        1.0, 0.18, 0.15,
        "0.95 * math.clamp(variable.particle_age / 0.04, 0.0, 1.0) * "
        "math.clamp((variable.particle_lifetime - variable.particle_age) / 0.1, 0.0, 1.0)"]},
}))

# ============================================================ power / shield
reg("power_down", effect("sym:mk5_power_down", "particles_add", {
    "minecraft:emitter_rate_instant": {"num_particles": 22},
    "minecraft:emitter_lifetime_once": {"active_time": 0.8},
    "minecraft:emitter_lifetime_events": {
        "creation_event": ["arcs", "smoke"],
        "timeline": {"0.35": "crackle", "0.70": "crackle"},
    },
    "minecraft:emitter_shape_sphere": {"radius": 0.15, "direction": "outwards"},
    "minecraft:particle_initialization": {"per_render_expression": LT},
    "minecraft:particle_lifetime_expression": {"max_lifetime": "math.random(0.3, 0.7)"},
    "minecraft:particle_initial_speed": "math.random(2.0, 5.0)",
    "minecraft:particle_motion_dynamic": {"linear_acceleration": [0, -9, 0], "linear_drag_coefficient": 2.5},
    "minecraft:particle_appearance_billboard": billboard(
        "0.06 * (1.0 - variable.lt) + 0.015", "0.06 * (1.0 - variable.lt) + 0.015", uv("spark")),
    "minecraft:particle_appearance_tinting": {"color": [
        "math.lerp(0.7, 1.0, variable.lt)", "math.lerp(0.95, 0.55, variable.lt)",
        "math.lerp(1.0, 0.2, variable.lt)", "1.0 - variable.lt * variable.lt"]},
}, events={"arcs": child("sym:mk5_fx_arcs"), "smoke": child("sym:mk5_fx_smoke_dark"),
           "crackle": child("sym:mk5_spark")}))

reg("fx_arcs", effect("sym:mk5_fx_arcs", "particles_add", {
    "minecraft:emitter_rate_steady": {"spawn_rate": 30, "max_particles": 8},
    "minecraft:emitter_lifetime_once": {"active_time": 0.5},
    "minecraft:emitter_shape_sphere": {"radius": 0.35, "direction": "outwards"},
    "minecraft:particle_lifetime_expression": {"max_lifetime": "math.random(0.05, 0.12)"},
    "minecraft:particle_initial_speed": 0,
    "minecraft:particle_initial_spin": {"rotation": "math.random(0, 360)"},
    "minecraft:particle_appearance_billboard": billboard(
        "0.18 + variable.particle_random_1 * 0.16", "0.18 + variable.particle_random_1 * 0.16",
        uv_random("arc", 4, "variable.particle_random_2")),
    "minecraft:particle_appearance_tinting": {"color": [0.6, 0.9, 1.0, 1.0]},
}))

reg("fx_smoke_dark", effect("sym:mk5_fx_smoke_dark", "particles_blend", {
    "minecraft:emitter_rate_instant": {"num_particles": 6},
    "minecraft:emitter_lifetime_once": {"active_time": 0.05},
    "minecraft:emitter_shape_sphere": {"radius": 0.2, "direction": "outwards"},
    "minecraft:particle_initialization": {"per_render_expression": LT},
    "minecraft:particle_lifetime_expression": {"max_lifetime": "math.random(1.0, 1.6)"},
    "minecraft:particle_initial_speed": "math.random(0.3, 0.8)",
    "minecraft:particle_initial_spin": {"rotation": "math.random(0, 360)", "rotation_rate": "math.random(-30, 30)"},
    "minecraft:particle_motion_dynamic": {"linear_acceleration": [0, 0.8, 0], "linear_drag_coefficient": 1.5},
    "minecraft:particle_appearance_billboard": billboard(
        "0.15 + 0.4 * math.sqrt(variable.lt)", "0.15 + 0.4 * math.sqrt(variable.lt)", uv_random("smoke", 4)),
    "minecraft:particle_appearance_lighting": {},
    "minecraft:particle_appearance_tinting": {"color": [
        0.12, 0.12, 0.13, "0.7 * (1.0 - variable.lt) * math.clamp(variable.lt * 8.0, 0.0, 1.0)"]},
}))

reg("power_up", effect("sym:mk5_power_up", "particles_add", {
    "minecraft:emitter_rate_steady": {"spawn_rate": 10, "max_particles": 3},
    "minecraft:emitter_lifetime_once": {"active_time": 0.3},
    "minecraft:emitter_lifetime_events": {"creation_event": ["flash", "ring_xz"]},
    "minecraft:emitter_shape_point": {},
    "minecraft:particle_initialization": {"per_render_expression": LT},
    "minecraft:particle_lifetime_expression": {"max_lifetime": 0.6},
    "minecraft:particle_initial_speed": 0,
    "minecraft:particle_appearance_billboard": billboard(
        f"0.15 + 1.6 * {ease_out(2.5)}", f"0.15 + 1.6 * {ease_out(2.5)}", uv("ring_thin")),
    "minecraft:particle_appearance_tinting": {"color": [0.35, 0.9, 1.0, "math.pow(1.0 - variable.lt, 1.5)"]},
}, events={"flash": child("sym:mk5_fx_flash_cyan"), "ring_xz": child("sym:mk5_fx_ring_xz_cyan")}))

reg("fx_ring_xz_cyan", effect("sym:mk5_fx_ring_xz_cyan", "particles_add", {
    "minecraft:emitter_rate_instant": {"num_particles": 1},
    "minecraft:emitter_lifetime_once": {"active_time": 0.05},
    "minecraft:emitter_shape_point": {},
    "minecraft:particle_initialization": {"per_render_expression": LT},
    "minecraft:particle_lifetime_expression": {"max_lifetime": 0.7},
    "minecraft:particle_initial_speed": 0,
    "minecraft:particle_motion_parametric": {"rotation": "variable.particle_age * 90.0"},
    "minecraft:particle_appearance_billboard": billboard(
        f"0.2 + 2.6 * {ease_out(2.0)}", f"0.2 + 2.6 * {ease_out(2.0)}", uv("ring_tech"), mode="emitter_transform_xz"),
    "minecraft:particle_appearance_tinting": {"color": [0.3, 0.88, 1.0, "0.9 * math.pow(1.0 - variable.lt, 1.3)"]},
}))

reg("shield_hit", effect("sym:mk5_shield_hit", "particles_add", {
    "minecraft:emitter_rate_instant": {"num_particles": 1},
    "minecraft:emitter_lifetime_once": {"active_time": 0.05},
    "minecraft:emitter_lifetime_events": {"creation_event": ["sparks", "arcs"]},
    "minecraft:emitter_shape_point": {},
    "minecraft:particle_initialization": {"per_render_expression": LT},
    "minecraft:particle_lifetime_expression": {"max_lifetime": 0.38},
    "minecraft:particle_initial_speed": 0,
    "minecraft:particle_appearance_billboard": billboard(
        "1.05 + 0.15 * variable.lt", "1.05 + 0.15 * variable.lt", uv("hex_shield")),
    "minecraft:particle_appearance_tinting": {"color": [
        0.35, 0.85, 1.0,
        "math.pow(1.0 - variable.lt, 1.4) * (0.8 + 0.2 * math.sin(variable.particle_age * 3000.0))"]},
}, events={"sparks": child("sym:mk5_spark"), "arcs": child("sym:mk5_fx_arcs")}))


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    written = []
    for name, data in EFFECTS.items():
        path = os.path.join(OUT_DIR, f"sym_mk5_{name}.json")
        txt = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(txt)
        written.append(os.path.relpath(path, B))
    print(f"wrote {len(written)} particle files")
    return 0


if __name__ == "__main__":
    sys.exit(main())
