#!/usr/bin/env python3
"""Cross-reference checker for the Mark V addon.

Parses every pack JSON strictly, collects every identifier that is DEFINED (items, attachables,
animations, particles, sounds, textures, render controllers, geometries) and every identifier that
is REFERENCED (by scripts, attachables, particles, sound definitions, UI, render controllers) and
reports anything referenced but missing. Exit code 1 on any problem.

Usage: python3 -I tools/check_refs.py [pack_dir]
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PACK = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "pack")
BP = os.path.join(PACK, "Mark5_BP")
RP = os.path.join(PACK, "Mark5_RP")

problems = []
warnings = []


def rel(p):
    return os.path.relpath(p, PACK)


def load_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:  # noqa: BLE001
        problems.append(f"invalid JSON {rel(path)}: {e}")
        return None


def walk(base, exts):
    for d, _, files in os.walk(base):
        for name in files:
            if os.path.splitext(name)[1].lower() in exts:
                yield os.path.join(d, name)


# ------------------------------------------------------------------ parse everything
jsons = {p: load_json(p) for p in walk(PACK, {".json"})}

# textures defined (path without extension, relative to RP)
textures = set()
for p in walk(os.path.join(RP, "textures"), {".png", ".tga", ".jpg"}):
    textures.add(os.path.splitext(os.path.relpath(p, RP))[0].replace(os.sep, "/"))

items, attachables, animations, anim_ctrls, particles, sounds, rcs, geos = (set() for _ in range(8))
item_files = {}
for p, d in jsons.items():
    if not isinstance(d, dict):
        continue
    if "minecraft:item" in d:
        ident = d["minecraft:item"]["description"]["identifier"]
        items.add(ident)
        item_files[ident] = d
    if "minecraft:attachable" in d:
        attachables.add(d["minecraft:attachable"]["description"]["identifier"])
    if "animations" in d and isinstance(d["animations"], dict) and p.startswith(RP):
        animations.update(d["animations"].keys())
    if "animation_controllers" in d:
        anim_ctrls.update(d["animation_controllers"].keys())
    if "particle_effect" in d:
        particles.add(d["particle_effect"]["description"]["identifier"])
    if "sound_definitions" in d:
        sounds.update(d["sound_definitions"].keys())
    if "render_controllers" in d and isinstance(d["render_controllers"], dict):
        rcs.update(d["render_controllers"].keys())
    if "minecraft:geometry" in d:
        for g in d["minecraft:geometry"]:
            geos.add(g["description"]["identifier"])

VANILLA_RC_PREFIX = "controller.render."

# ------------------------------------------------------------------ attachables
for p, d in jsons.items():
    if not isinstance(d, dict) or "minecraft:attachable" not in d:
        continue
    desc = d["minecraft:attachable"]["description"]
    ident = desc["identifier"]
    if ident not in items:
        problems.append(f"attachable {ident} has no BP item")
    for k, v in desc.get("textures", {}).items():
        if v not in textures:
            problems.append(f"{rel(p)} texture '{v}' missing")
    for k, v in desc.get("geometry", {}).items():
        if v not in geos:
            problems.append(f"{rel(p)} geometry '{v}' missing")
    for k, v in desc.get("animations", {}).items():
        if v not in animations and v not in anim_ctrls:
            problems.append(f"{rel(p)} animation '{v}' missing")
    short = set(desc.get("animations", {}).keys())
    for entry in desc.get("scripts", {}).get("animate", []):
        name = entry if isinstance(entry, str) else next(iter(entry))
        if name not in short:
            problems.append(f"{rel(p)} scripts.animate uses '{name}' not declared in animations")
    for r in desc.get("render_controllers", []):
        name = r if isinstance(r, str) else next(iter(r))
        if name not in rcs:
            problems.append(f"{rel(p)} render controller '{name}' missing")

# every wearable/held item that the scripts equip should have an attachable (warn only)
for ident, d in item_files.items():
    comps = d["minecraft:item"].get("components", {})
    if "minecraft:wearable" in comps and ident not in attachables:
        warnings.append(f"wearable item {ident} has no attachable")

# ------------------------------------------------------------------ client entities
for p, d in jsons.items():
    if not isinstance(d, dict) or "minecraft:client_entity" not in d:
        continue
    desc = d["minecraft:client_entity"]["description"]
    for k, v in desc.get("textures", {}).items():
        if v.startswith("textures/sym") and v not in textures:
            problems.append(f"{rel(p)} texture '{v}' missing")
    for k, v in desc.get("geometry", {}).items():
        if v.startswith("geometry.sym") and v not in geos:
            problems.append(f"{rel(p)} geometry '{v}' missing")
    for r in desc.get("render_controllers", []):
        name = r if isinstance(r, str) else next(iter(r))
        if name.startswith("controller.render.sym") and name not in rcs:
            problems.append(f"{rel(p)} render controller '{name}' missing")
        if name.startswith(VANILLA_RC_PREFIX + "player.") and name not in rcs:
            pass  # vanilla controller, fine

# ------------------------------------------------------------------ particles
for p, d in jsons.items():
    if not isinstance(d, dict) or "particle_effect" not in d:
        continue
    tex = d["particle_effect"]["description"].get("basic_render_parameters", {}).get("texture")
    if tex and tex.startswith("textures/sym") and tex not in textures:
        problems.append(f"{rel(p)} particle texture '{tex}' missing")

# ------------------------------------------------------------------ sounds
for p, d in jsons.items():
    if not isinstance(d, dict) or "sound_definitions" not in d:
        continue
    for sid, sdef in d["sound_definitions"].items():
        for s in sdef.get("sounds", []):
            name = s if isinstance(s, str) else s.get("name")
            if not name:
                problems.append(f"sound {sid} entry without name")
                continue
            if not any(os.path.exists(os.path.join(RP, name + ext)) for ext in (".ogg", ".wav", ".fsb")):
                problems.append(f"sound {sid} file '{name}' missing")

# ------------------------------------------------------------------ item icons
item_tex = jsons.get(os.path.join(RP, "textures", "item_texture.json")) or {}
icon_names = set((item_tex.get("texture_data") or {}).keys())
for k, v in (item_tex.get("texture_data") or {}).items():
    t = v.get("textures")
    for tt in t if isinstance(t, list) else [t]:
        if isinstance(tt, str) and tt not in textures:
            problems.append(f"item_texture '{k}' -> '{tt}' missing")
for ident, d in item_files.items():
    icon = d["minecraft:item"].get("components", {}).get("minecraft:icon")
    if icon:
        tex = icon.get("textures", {}).get("default") if isinstance(icon, dict) else icon
        if isinstance(icon, dict) and "texture" in icon:
            tex = icon["texture"]
        if tex and tex not in icon_names:
            problems.append(f"item {ident} icon '{tex}' not in item_texture.json")

# ------------------------------------------------------------------ UI static textures
for p, d in jsons.items():
    if not p.startswith(os.path.join(RP, "ui")):
        continue

    def scan(node):
        if isinstance(node, dict):
            for k, v in node.items():
                if k == "texture" and isinstance(v, str) and v.startswith("textures/sym"):
                    if v not in textures:
                        problems.append(f"{rel(p)} UI texture '{v}' missing")
                scan(v)
        elif isinstance(node, list):
            for v in node:
                scan(v)

    scan(d)
ui_defs = jsons.get(os.path.join(RP, "ui", "_ui_defs.json"))
if ui_defs:
    for f in ui_defs.get("ui_defs", []):
        if not os.path.exists(os.path.join(RP, f)):
            problems.append(f"_ui_defs lists missing file {f}")

# ------------------------------------------------------------------ scripts
script_text = ""
for p in walk(os.path.join(BP, "scripts"), {".js"}):
    with open(p, encoding="utf-8") as f:
        script_text += f"\n//@@ {rel(p)}\n" + f.read()

lit = re.findall(r"""["'`]([^"'`\n]{3,120})["'`]""", script_text)
VANILLA_OK_SOUNDS = re.compile(r"^(armor\.|random\.|mob\.|block\.|ambient\.|note\.|beacon\.|conduit\.|dig\.|step\.|fire\.|item\.|bucket\.|liquid\.|damage\.|game\.|ui\.|portal\.|use\.|break\.|hit\.|jump\.|land\.|fall\.)")
for s in sorted(set(lit)):
    if s.startswith("sym.mk5.") and s not in sounds:
        problems.append(f"script sound '{s}' not in sound_definitions")
    elif re.fullmatch(r"sym:mk5_[a-z0-9_]+", s) and s not in particles and s not in {
        "sym:mk5_suitcase", "sym:mk5_reactor", "sym:mk5_case", "sym:mk5_welcome", "sym:mk5_state",
        "sym:mk5_damage",
    }:
        # dynamic-property / script-event ids also look like sym:mk5_*; only flag if used as particle
        if re.search(r"spawnParticle\([^)]*['\"]" + re.escape(s), script_text):
            problems.append(f"script particle '{s}' not defined")
    elif re.fullmatch(r"sym:mark_5[a-z0-9_]*", s) and s not in items:
        problems.append(f"script item '{s}' not defined")
    elif s.startswith("animation.sym.") and s not in animations:
        problems.append(f"script animation '{s}' not defined")
    elif s.startswith("textures/sym/") and s not in textures:
        problems.append(f"script texture '{s}' missing")

# particles referenced via helper calls with a variable name: list all particle-looking ids
for m in re.finditer(r"spawnParticle\(\s*['\"]([^'\"]+)['\"]", script_text):
    pid = m.group(1)
    if pid.startswith("sym:") and pid not in particles:
        problems.append(f"script particle '{pid}' not defined")
for m in re.finditer(r"playAnimation\(\s*['\"]([^'\"]+)['\"]", script_text):
    aid = m.group(1)
    if aid.startswith("animation.sym") and aid not in animations:
        problems.append(f"script animation '{aid}' not defined")

# ------------------------------------------------------------------ manifests
bpm = jsons.get(os.path.join(BP, "manifest.json")) or {}
rpm = jsons.get(os.path.join(RP, "manifest.json")) or {}
rp_uuid = rpm.get("header", {}).get("uuid")
rp_ver = rpm.get("header", {}).get("version")
dep_ok = any(d.get("uuid") == rp_uuid and d.get("version") == rp_ver for d in bpm.get("dependencies", []))
if not dep_ok:
    problems.append(f"BP manifest does not depend on RP {rp_uuid} {rp_ver}")
mods = {d.get("module_name"): d.get("version") for d in bpm.get("dependencies", []) if "module_name" in d}
if "@minecraft/server-ui" in script_text and "@minecraft/server-ui" not in mods:
    problems.append("scripts import @minecraft/server-ui but manifest lacks the dependency")

print(f"items={len(items)} attachables={len(attachables)} animations={len(animations)} "
      f"particles={len(particles)} sounds={len(sounds)} textures={len(textures)} rcs={len(rcs)}")
for w in warnings:
    print("WARN", w)
for pr in problems:
    print("FAIL", pr)
print("OK" if not problems else f"{len(problems)} problem(s)")
sys.exit(1 if problems else 0)
