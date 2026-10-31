#!/usr/bin/env python3
"""FX area self-check (particles, particle atlas, sounds). Run: python3 tests/fx_assets_test.py

Checks
- every RP particle file parses, has format 1.10.0, a sym: identifier, a known material,
  an existing texture, only known components, a valid facing_camera_mode, valid child events;
- every Molang string parses (tools/fx/molang.py) and every effect evaluates to finite,
  in-range values (size >= 0, tint channels 0..1, UV rect inside the atlas) both with NO
  script variables and with typical script inputs (SPEC 2.4) — i.e. unguarded inputs fail;
- SPEC 2.4 identifiers all exist;
- sound_definitions.json: the 5 original entries are unchanged, every SPEC 2.5 id exists
  (category player, world sounds with distances), every referenced file exists;
- every new OGG is Vorbis, mono, 44.1 kHz, duration within tolerance; total < 1.5 MB.
"""
import glob
import json
import math
import os
import random
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
B = os.path.abspath(os.path.join(HERE, ".."))
RP = os.path.join(B, "pack", "Mark5_RP")
sys.path.insert(0, os.path.join(B, "tools", "fx"))
from molang import Ctx, MolangError, evaluate, parse  # noqa: E402

FAIL = []


def check(cond, msg):
    if not cond:
        FAIL.append(msg)
    return cond


KNOWN_COMPONENTS = {
    "minecraft:emitter_initialization", "minecraft:emitter_local_space",
    "minecraft:emitter_rate_instant", "minecraft:emitter_rate_steady", "minecraft:emitter_rate_manual",
    "minecraft:emitter_lifetime_once", "minecraft:emitter_lifetime_looping",
    "minecraft:emitter_lifetime_expression", "minecraft:emitter_lifetime_events",
    "minecraft:emitter_shape_point", "minecraft:emitter_shape_sphere", "minecraft:emitter_shape_box",
    "minecraft:emitter_shape_custom", "minecraft:emitter_shape_disc", "minecraft:emitter_shape_entity_aabb",
    "minecraft:particle_initialization", "minecraft:particle_lifetime_expression",
    "minecraft:particle_initial_speed", "minecraft:particle_initial_spin",
    "minecraft:particle_motion_dynamic", "minecraft:particle_motion_parametric",
    "minecraft:particle_motion_collision", "minecraft:particle_appearance_billboard",
    "minecraft:particle_appearance_tinting", "minecraft:particle_appearance_lighting",
    "minecraft:particle_lifetime_events", "minecraft:particle_kill_plane",
    "minecraft:particle_expire_if_in_blocks", "minecraft:particle_expire_if_not_in_blocks",
}
FACING = {"rotate_xyz", "rotate_y", "lookat_xyz", "lookat_y", "lookat_direction", "direction_x",
          "direction_y", "direction_z", "emitter_transform_xy", "emitter_transform_xz", "emitter_transform_yz"}
MATERIALS = {"particles_add", "particles_blend", "particles_alpha"}
NOT_MOLANG_KEYS = {"facing_camera_mode", "plane_normal", "mode", "creation_event", "expiration_event",
                   "effect", "type", "material", "texture", "identifier"}

SPEC_PARTICLES = ["sym:mk5_thrust", "sym:mk5_thrust_glow", "sym:mk5_smoke", "sym:mk5_boom", "sym:mk5_takeoff",
                  "sym:mk5_landing", "sym:mk5_scan_wave", "sym:mk5_scan_dome", "sym:mk5_mark", "sym:mk5_lock",
                  "sym:mk5_power_down", "sym:mk5_power_up", "sym:mk5_shield_hit", "sym:mk5_spark",
                  "sym:mk5_power_burst"]

SCRIPT_VARS = [
    {},  # nothing passed: every input must have an in-file default
    {"variable.dir.x": 0.0, "variable.dir.y": -1.0, "variable.dir.z": 0.0, "variable.power": 0.1},
    {"variable.dir.x": 0.6, "variable.dir.y": -0.2, "variable.dir.z": -0.77, "variable.power": 1.0,
     "variable.vel.x": -1.0, "variable.vel.y": 0.1, "variable.vel.z": 1.2},
    {"variable.dir.x": 0.0, "variable.dir.y": 1.0, "variable.dir.z": 0.0},  # straight up (boom degenerate)
    {"variable.radius": 32.0},
    {"variable.size": 1.95, "variable.width": 0.6, "variable.color.r": 1.0, "variable.color.g": 0.2,
     "variable.color.b": 0.2, "variable.color.a": 1.0},
    {"variable.size": 0.4},
]


def walk_molang(node, path, out):
    if isinstance(node, dict):
        for k, v in node.items():
            if k in NOT_MOLANG_KEYS:
                continue
            if k == "timeline":
                continue
            if k == "direction" and isinstance(v, str):  # "outwards"/"inwards"
                continue
            walk_molang(v, path + [k], out)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            walk_molang(v, path + [str(i)], out)
    elif isinstance(node, str):
        out.append((".".join(path), node))


def finite(v):
    return isinstance(v, float) and math.isfinite(v)


def simulate(ident, comp, tex_size, variables, rng):
    """Evaluate one emitter + a few particles; return list of problems."""
    probs = []
    ctx = Ctx(variables, rng)
    init = comp.get("minecraft:emitter_initialization", {})
    try:
        for key in ("creation_expression", "per_update_expression"):
            if key in init:
                evaluate(init[key], ctx)
        rate = comp.get("minecraft:emitter_rate_instant", {}).get("num_particles")
        if rate is not None:
            n = evaluate(rate, ctx)
            if not (finite(n) and 0 <= n <= 200):
                probs.append(f"num_particles={n}")
        steady = comp.get("minecraft:emitter_rate_steady")
        if steady:
            for k in ("spawn_rate", "max_particles"):
                v = evaluate(steady[k], ctx)
                if not (finite(v) and v >= 0):
                    probs.append(f"{k}={v}")
        for p in range(16):
            for i in range(1, 5):
                ctx.vars[f"variable.particle_random_{i}"] = rng.random()
            ctx.vars.pop("variable.particle_age", None)
            for shape_key in ("minecraft:emitter_shape_custom", "minecraft:emitter_shape_point",
                              "minecraft:emitter_shape_disc", "minecraft:emitter_shape_sphere"):
                shape = comp.get(shape_key)
                if not shape:
                    continue
                for k in ("offset", "direction"):
                    if isinstance(shape.get(k), list):
                        vec = [evaluate(e, ctx) for e in shape[k]]
                        if not all(finite(v) for v in vec):
                            probs.append(f"{shape_key}.{k}={vec}")
                        if k == "direction" and shape_key != "minecraft:emitter_shape_disc" \
                                and math.sqrt(sum(v * v for v in vec)) < 1e-6:
                            sp = evaluate(comp.get("minecraft:particle_initial_speed", 0), ctx)
                            if sp > 1e-6:
                                probs.append(f"zero direction with speed {sp}")
            speed = evaluate(comp.get("minecraft:particle_initial_speed", 0), ctx)
            if not (finite(speed) and speed >= 0):
                probs.append(f"initial_speed={speed}")
            life = evaluate(comp["minecraft:particle_lifetime_expression"]["max_lifetime"], ctx)
            if not (finite(life) and 0 < life <= 20):
                probs.append(f"lifetime={life}")
                continue
            spin = comp.get("minecraft:particle_initial_spin", {})
            for k in ("rotation", "rotation_rate"):
                if k in spin and not finite(evaluate(spin[k], ctx)):
                    probs.append(f"spin.{k}")
            ctx.vars["variable.particle_lifetime"] = life
            for frac in (0.0, 0.25, 0.5, 0.75, 0.999):
                ctx.vars["variable.particle_age"] = frac * life
                ctx.vars["variable.emitter_age"] = frac * life
                pi = comp.get("minecraft:particle_initialization", {})
                for key in ("per_update_expression", "per_render_expression"):
                    if key in pi:
                        evaluate(pi[key], ctx)
                par = comp.get("minecraft:particle_motion_parametric", {})
                if "rotation" in par and not finite(evaluate(par["rotation"], ctx)):
                    probs.append("parametric.rotation")
                bb = comp["minecraft:particle_appearance_billboard"]
                sx, sy = (evaluate(e, ctx) for e in bb["size"])
                if not (finite(sx) and finite(sy) and sx >= 0 and sy >= 0 and sx < 80 and sy < 80):
                    probs.append(f"size=({sx},{sy}) at {frac}")
                d = bb.get("direction", {})
                if d.get("mode") == "custom":
                    vec = [evaluate(e, ctx) for e in d["custom_direction"]]
                    if not all(finite(v) for v in vec) or math.sqrt(sum(v * v for v in vec)) < 1e-5:
                        probs.append(f"custom_direction={vec}")
                uvd = bb["uv"]
                tw, th = uvd["texture_width"], uvd["texture_height"]
                if (tw, th) != tex_size:
                    probs.append(f"texture_width/height {tw}x{th} != png {tex_size}")
                fb = uvd.get("flipbook")
                if fb:
                    mf = fb["max_frame"]
                    u0, v0 = fb["base_UV"]
                    w, h = fb["size_UV"]
                    u1 = u0 + fb["step_UV"][0] * (mf - 1) + w
                    v1 = v0 + fb["step_UV"][1] * (mf - 1) + h
                    if not (0 <= u0 and 0 <= v0 and u1 <= tw and v1 <= th):
                        probs.append(f"flipbook outside atlas ({u0},{v0})-({u1},{v1})")
                else:
                    u, v = (evaluate(e, ctx) for e in uvd["uv"])
                    w, h = (evaluate(e, ctx) for e in uvd["uv_size"])
                    if not (0 <= u and 0 <= v and u + w <= tw and v + h <= th):
                        probs.append(f"uv outside atlas ({u},{v},{w},{h})")
                tint = comp.get("minecraft:particle_appearance_tinting", {}).get("color")
                if isinstance(tint, list):
                    rgba = [evaluate(e, ctx) for e in tint]
                    if not all(finite(c) and -1e-6 <= c <= 1.0 + 1e-6 for c in rgba):
                        probs.append(f"tint={['%.3f' % c for c in rgba]} at {frac}")
    except MolangError as e:
        probs.append(f"molang: {e}")
    return probs


def check_particles():
    from PIL import Image
    files = sorted(glob.glob(os.path.join(RP, "particles", "*.json")))
    ids = {}
    for f in files:
        name = os.path.relpath(f, B)
        try:
            data = json.load(open(f, encoding="utf-8"))
        except Exception as e:  # noqa: BLE001
            check(False, f"{name}: JSON error {e}")
            continue
        pe = data.get("particle_effect", {})
        desc = pe.get("description", {})
        ident = desc.get("identifier", "")
        check(data.get("format_version") == "1.10.0", f"{name}: format_version {data.get('format_version')}")
        check(ident.startswith("sym:"), f"{name}: identifier {ident}")
        check(ident not in ids, f"{name}: duplicate identifier {ident}")
        ids[ident] = (name, pe)
    for ident, (name, pe) in ids.items():
        brp = pe["description"]["basic_render_parameters"]
        check(brp.get("material") in MATERIALS, f"{name}: material {brp.get('material')}")
        tex_path = os.path.join(RP, brp.get("texture", "") + ".png")
        if not check(os.path.isfile(tex_path), f"{name}: missing texture {brp.get('texture')}"):
            continue
        tex_size = Image.open(tex_path).size
        comp = pe.get("components", {})
        for k in comp:
            check(k in KNOWN_COMPONENTS, f"{name}: unknown component {k}")
        bb = comp.get("minecraft:particle_appearance_billboard")
        if check(bb is not None, f"{name}: no billboard"):
            check(bb.get("facing_camera_mode") in FACING, f"{name}: facing {bb.get('facing_camera_mode')}")
        events = pe.get("events", {})
        for ev_name, ev in events.items():
            eff = ev.get("particle_effect", {})
            check(eff.get("effect") in ids, f"{name}: event {ev_name} -> unknown effect {eff.get('effect')}")
            check(eff.get("type") in ("emitter", "emitter_bound", "particle", "particle_with_velocity"),
                  f"{name}: event type {eff.get('type')}")
        lev = comp.get("minecraft:emitter_lifetime_events", {})
        refs = []
        for k in ("creation_event", "expiration_event"):
            v = lev.get(k)
            refs += v if isinstance(v, list) else ([v] if v else [])
        refs += list(lev.get("timeline", {}).values())
        for r in refs:
            check(r in events, f"{name}: lifetime event {r} not defined")
        if lev.get("timeline"):
            active = comp.get("minecraft:emitter_lifetime_once", {}).get("active_time", 10)
            check(max(float(t) for t in lev["timeline"]) <= float(active),
                  f"{name}: timeline beyond emitter active_time")
        strings = []
        walk_molang(comp, [], strings)
        for path, src in strings:
            try:
                parse(src)
            except MolangError as e:
                check(False, f"{name}: {path}: {e}: {src[:80]}")
        if ident in ("sym:mk5_spark", "sym:mk5_power_burst"):
            continue  # pre-existing, not owned here (still parsed above)
        for i, sv in enumerate(SCRIPT_VARS):
            probs = simulate(ident, comp, tex_size, sv, random.Random(100 + i))
            for p in sorted(set(probs))[:4]:
                check(False, f"{name}: vars#{i}: {p}")
    for sid in SPEC_PARTICLES:
        check(sid in ids, f"missing SPEC particle {sid}")
    return len(ids)


ORIGINAL_SOUNDS = {
    "sym.mk5.suitup": {"category": "player", "sounds": [{"name": "sounds/sym/mk5_suitup", "load_on_low_memory": True}]},
    "sym.mk5.suitoff": {"category": "player", "sounds": [{"name": "sounds/sym/mk5_suitoff", "load_on_low_memory": True}]},
    "sym.mk5.helmet_close": {"category": "player", "sounds": ["sounds/sym/helmet_close"]},
    "sym.mk5.helmet_open": {"category": "player", "sounds": ["sounds/sym/helmet_open"]},
    "sym.mk5.power_on": {"category": "player", "sounds": ["sounds/sym/suit_power_on"]},
}
SPEC_SOUNDS = {  # id -> (file stem, nominal duration s)
    "sym.mk5.power_down": ("power_down", 1.3), "sym.mk5.power_up": ("power_up", 1.2),
    "sym.mk5.hud_boot": ("hud_boot", 1.0), "sym.mk5.hud_off": ("hud_off", 0.3), "sym.mk5.alarm": ("alarm", 0.5),
    "sym.mk5.scan": ("scan", 1.6), "sym.mk5.scan_ping": ("scan_ping", 0.15), "sym.mk5.lock_tick": ("lock_tick", 0.08),
    "sym.mk5.lock_on": ("lock_on", 0.6), "sym.mk5.lock_lost": ("lock_lost", 0.3), "sym.mk5.target": ("target", 0.1),
    "sym.mk5.thruster_start": ("thruster_start", 1.0), "sym.mk5.thruster_loop": ("thruster_loop", 1.0),
    "sym.mk5.thruster_boost": ("thruster_boost", 1.0), "sym.mk5.thruster_stop": ("thruster_stop", 0.8),
    "sym.mk5.sonic_boom": ("sonic_boom", 1.5), "sym.mk5.landing": ("landing", 0.8), "sym.mk5.shield": ("shield", 0.4),
    "sym.mk5.menu": ("menu", 0.2),
}
WORLD_SOUNDS = {"sym.mk5.thruster_start", "sym.mk5.thruster_loop", "sym.mk5.thruster_boost",
                "sym.mk5.thruster_stop", "sym.mk5.sonic_boom", "sym.mk5.landing"}


def sound_file_names(entry):
    for s in entry.get("sounds", []):
        yield s if isinstance(s, str) else s.get("name")


def check_sounds():
    path = os.path.join(RP, "sounds", "sound_definitions.json")
    data = json.load(open(path, encoding="utf-8"))
    sd = data["sound_definitions"]
    check(data.get("format_version") == "1.20.20", "sound_definitions format_version changed")
    for sid, entry in ORIGINAL_SOUNDS.items():
        check(sd.get(sid) == entry, f"original sound entry modified: {sid}")
    total = 0
    for sid, entry in sd.items():
        for nm in sound_file_names(entry):
            check(any(os.path.isfile(os.path.join(RP, nm + ext)) for ext in (".ogg", ".wav", ".fsb")),
                  f"{sid}: missing file {nm}")
    for sid, (stem, dur) in SPEC_SOUNDS.items():
        e = sd.get(sid)
        if not check(e is not None, f"missing sound id {sid}"):
            continue
        check(e.get("category") == "player", f"{sid}: category {e.get('category')}")
        check(list(sound_file_names(e)) == [f"sounds/sym/{stem}"], f"{sid}: file list {list(sound_file_names(e))}")
        if sid in WORLD_SOUNDS:
            check(isinstance(e.get("min_distance"), float) and isinstance(e.get("max_distance"), float)
                  and e["max_distance"] > e["min_distance"], f"{sid}: world sound distances")
        ogg = os.path.join(RP, "sounds", "sym", stem + ".ogg")
        if not check(os.path.isfile(ogg), f"missing {ogg}"):
            continue
        total += os.path.getsize(ogg)
        out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries",
                              "stream=codec_name,channels,sample_rate:format=duration", "-of", "json", ogg],
                             capture_output=True, text=True)
        info = json.loads(out.stdout or "{}")
        st = (info.get("streams") or [{}])[0]
        check(st.get("codec_name") == "vorbis", f"{stem}: codec {st.get('codec_name')}")
        check(st.get("channels") == 1, f"{stem}: channels {st.get('channels')}")
        check(st.get("sample_rate") == "44100", f"{stem}: rate {st.get('sample_rate')}")
        d = float(info.get("format", {}).get("duration", 0))
        check(abs(d - dur) <= max(0.06, dur * 0.12), f"{stem}: duration {d:.3f}s vs {dur}s")
    check(total < 1.5 * 1024 * 1024, f"new sounds total {total} B >= 1.5 MB")
    return len(sd), total


def main():
    n_particles = check_particles()
    n_sounds, total = check_sounds()
    if FAIL:
        print(f"FX CHECK FAILED ({len(FAIL)}):")
        for m in FAIL:
            print("  -", m)
        return 1
    print(f"FX CHECK OK: {n_particles} particle effects, {n_sounds} sound definitions, new OGG total {total} B")
    return 0


if __name__ == "__main__":
    sys.exit(main())
