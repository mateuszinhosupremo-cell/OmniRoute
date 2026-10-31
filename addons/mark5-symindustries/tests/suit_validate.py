#!/usr/bin/env python3
"""Self-check for the suit area (SPEC 2.1-2.3, 8.1). Run: python3 tests/suit_validate.py

Checks: strict JSON, item/attachable pairs vs the SPEC table, referenced animations / textures /
bones exist, Molang identifiers are real (query list from ref/qlist.md), render-controller
expressions are balanced, only use real item ids, <= 4 names per is_item_name_any, and have the
exact truth table required (and identical behaviour to the original controllers for the original
ids), mk5_off.png differs from mk5.png only on the 20 LED pixels, existing animations unchanged,
generators idempotent. Exit code 1 on any failure.
"""

import glob
import json
import os
import re
import subprocess
import sys

B = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.dont_write_bytecode = True  # keep tools/suit free of __pycache__
sys.path.insert(0, os.path.join(B, "tools", "suit"))
import common as C  # noqa: E402

BP, RP, BASE = C.BP, C.RP, C.BASELINE
errors = []
checks = 0


def check(cond, msg):
    global checks
    checks += 1
    if not cond:
        errors.append(msg)


def strict_load(path):
    def bad_const(x):
        raise ValueError("non-standard constant %s" % x)

    with open(path, encoding="utf-8") as f:
        return json.loads(f.read(), parse_constant=bad_const)


# ------------------------------------------------------------------ 1. strict JSON everywhere I own
OWNED_JSON = (
    glob.glob(os.path.join(BP, "items", "*.json"))
    + glob.glob(os.path.join(RP, "attachables", "*.json"))
    + glob.glob(os.path.join(RP, "animations", "*.json"))
    + glob.glob(os.path.join(RP, "render_controllers", "*.json"))
    + [os.path.join(RP, "entity", "player.entity.json"), os.path.join(RP, "manifest.json"),
       os.path.join(RP, "textures", "item_texture.json"), os.path.join(RP, "texts", "languages.json")]
)
J = {}
for p in OWNED_JSON:
    try:
        J[p] = strict_load(p)
    except Exception as e:  # noqa: BLE001
        errors.append("JSON parse %s: %s" % (os.path.relpath(p, B), e))
    checks += 1

items = {}
for p in glob.glob(os.path.join(BP, "items", "*.json")):
    d = J.get(p)
    if d:
        items[d["minecraft:item"]["description"]["identifier"]] = d
atts = {}
for p in glob.glob(os.path.join(RP, "attachables", "*.json")):
    d = J.get(p)
    if d:
        atts[d["minecraft:attachable"]["description"]["identifier"]] = d

anims = {}
for p in glob.glob(os.path.join(RP, "animations", "*.json")):
    anims.update(J[p]["animations"])
item_ids = set(items)

# ------------------------------------------------------------------ 2. variant table
for vid, (prot, tex, extra_key, extra_anim) in C.VARIANTS.items():
    it = items.get(vid)
    check(it is not None, "missing BP item %s" % vid)
    check(vid in atts, "missing attachable %s" % vid)
    if it:
        comps = it["minecraft:item"]["components"]
        cat = it["minecraft:item"]["description"]["menu_category"]
        check(comps["minecraft:wearable"] == {"slot": "slot.armor.chest", "protection": prot}, "%s wearable" % vid)
        check(comps["minecraft:max_stack_size"] == 1, "%s stack" % vid)
        check(comps["minecraft:durability"]["max_durability"] == 1815, "%s durability" % vid)
        check(comps["minecraft:enchantable"] == {"slot": "armor_torso", "value": 10}, "%s enchantable" % vid)
        rep = comps["minecraft:repairable"]["repair_items"][0]
        check(rep["items"] == ["minecraft:diamond"] and rep["repair_amount"] == 454, "%s repairable" % vid)
        check("minecraft:is_armor" in comps["minecraft:tags"]["tags"], "%s tag" % vid)
        check(comps["minecraft:icon"]["textures"]["default"] == "sym_mk5_armor", "%s icon" % vid)
        check(comps["minecraft:display_name"]["value"] == "Armadura Mark V", "%s name" % vid)
        if vid == C.BASE_ID:
            check(cat == {"category": "equipment", "group": "minecraft:itemGroup.name.chestplate"}, "base menu")
        else:
            check(cat == {"category": "none", "is_hidden_in_commands": True}, "%s menu hidden" % vid)
    a = atts.get(vid)
    if a:
        desc = a["minecraft:attachable"]["description"]
        check(desc["textures"]["default"] == tex, "%s texture" % vid)
        check(desc["geometry"]["default"] == "geometry.sym.mk5", "%s geometry" % vid)
        check(desc["materials"]["default"] == "entity_emissive_alpha", "%s material" % vid)
        animate = desc["scripts"]["animate"]
        extras = [e for e in animate if isinstance(e, dict) and set(e) & set(C.EXTRA_ANIM_KEYS)]
        if extra_key:
            check(desc["animations"].get(extra_key) == extra_anim, "%s extra anim id" % vid)
            check(extras == [{extra_key: C.WORN_CONDITION}], "%s extra animate entry" % vid)
        else:
            check(not extras and not set(desc["animations"]) & set(C.EXTRA_ANIM_KEYS), "%s has no extra" % vid)
        base = atts[C.BASE_ID]["minecraft:attachable"]["description"]
        for k in ("held", "hidden", "first_person", "first_person_busy_hand", "worn"):
            check(desc["animations"][k] == base["animations"][k], "%s anim %s like base" % (vid, k))
        check(desc["render_controllers"] == base["render_controllers"], "%s rc like base" % vid)

# every attachable has a matching item and vice versa (for wearable sym items)
for aid in atts:
    check(aid in items, "attachable %s without BP item" % aid)
for iid, it in items.items():
    if "minecraft:wearable" in it["minecraft:item"]["components"]:
        check(iid in atts, "wearable item %s without attachable" % iid)

reactor = items.get(C.REACTOR_ID)
check(reactor and reactor["minecraft:item"]["components"]["minecraft:display_name"]["value"] == C.REACTOR_DISPLAY_NAME,
      "reactor display name")

# ------------------------------------------------------------------ 3. animations / textures / bones
for aid, a in atts.items():
    desc = a["minecraft:attachable"]["description"]
    for k, v in desc["animations"].items():
        check(v in anims, "%s: animation %s missing" % (aid, v))
    for k, v in desc["textures"].items():
        check(os.path.exists(os.path.join(RP, v + ".png")), "%s: texture %s missing" % (aid, v))
    used = set()
    for e in desc["scripts"]["animate"]:
        used.update(e if isinstance(e, dict) else [e])
    check(used <= set(desc["animations"]), "%s: animate keys not declared" % aid)

ent = J[os.path.join(RP, "entity", "player.entity.json")]["minecraft:client_entity"]["description"]
check(ent["animations"].get("sym_paperdoll_spin") == "animation.sym.player.paperdoll_spin", "spin registered")
check(ent["animations"]["sym_paperdoll_spin"] in anims, "spin animation exists")
spin_entries = [e for e in ent["scripts"]["animate"] if isinstance(e, dict) and "sym_paperdoll_spin" in e]
check(len(spin_entries) == 1 and spin_entries[0]["sym_paperdoll_spin"].startswith("variable.is_paperdoll && ("),
      "spin animate entry")
check("overlay_color" not in json.dumps(ent) and "is_hurt" not in json.dumps(ent), "no damage tint (8.2 cancelled)")
base_ent = strict_load(os.path.join(BASE, "Mark5_RP", "entity", "player.entity.json"))
ent_copy = json.loads(json.dumps(ent))
ent_copy["animations"].pop("sym_paperdoll_spin")
ent_copy["scripts"]["animate"] = [e for e in ent_copy["scripts"]["animate"] if e not in spin_entries]
check(ent_copy == base_ent["minecraft:client_entity"]["description"], "player.entity.json: only the spin was added")

texts = json.dumps(ent["textures"])
for t in ent["textures"].values():
    check(os.path.exists(os.path.join(RP, t + ".png")) or t.startswith("textures/entity/"), "entity texture %s" % t)

# script-referenced animation ids exist
for p in glob.glob(os.path.join(BP, "scripts", "**", "*.js"), recursive=True):
    src = open(p, encoding="utf-8").read()
    for aid in set(re.findall(r'"(animation\.sym\.[a-z0-9_.]+)"', src)):
        check(aid in anims, "%s references missing %s" % (os.path.relpath(p, B), aid))


def geo_bones(path, ident):
    for g in strict_load(path)["minecraft:geometry"]:
        if g["description"]["identifier"] == ident:
            return {b["name"].lower() for b in g["bones"]}
    return set()


mk5_bones = geo_bones(os.path.join(RP, "models", "entity", "sym_mk5.geo.json"), "geometry.sym.mk5")
tony_bones = geo_bones(os.path.join(RP, "models", "entity", "sym_tony_stark.geo.json"), "geometry.sym.tony_stark")
NEW_ATT = ["animation.sym.mk5." + n for n in ("visor_opened", "visor_opening", "visor_closing", "eyes_boot", "eyes_shutdown")]
NEW_PLAYER = ["animation.sym.player." + n for n in
              ("mk5_hover", "mk5_fly", "mk5_boost", "mk5_takeoff", "mk5_land", "mk5_flight_reset", "paperdoll_spin")]
for n in NEW_ATT:
    check(n in anims, "missing %s" % n)
    for b in anims.get(n, {}).get("bones", {}):
        check(b.lower() in mk5_bones, "%s: bone %s not in geometry.sym.mk5" % (n, b))
for n in NEW_PLAYER:
    check(n in anims, "missing %s" % n)
    for b in anims.get(n, {}).get("bones", {}):
        check(b.lower() in tony_bones, "%s: bone %s not in geometry.sym.tony_stark" % (n, b))
check(anims["animation.sym.player.mk5_flight_reset"].get("bones", {}) == {}, "reset has no bones")
for n, length in (("visor_opening", 0.8), ("visor_closing", 0.8), ("eyes_boot", 0.9), ("eyes_shutdown", 1.2)):
    a = anims["animation.sym.mk5." + n]
    check(a["loop"] == "hold_on_last_frame" and a["animation_length"] == length, "%s length/loop" % n)

# existing animations untouched (deep equality, order preserved)
for rel in ("sym_mk5.animation.json", "sym_mk5_player.animation.json"):
    old = strict_load(os.path.join(BASE, "Mark5_RP", "animations", rel))["animations"]
    new = J[os.path.join(RP, "animations", rel)]["animations"]
    check(list(new)[: len(old)] == list(old), "%s: existing order changed" % rel)
    for k, v in old.items():
        check(new.get(k) == v, "%s: existing %s altered" % (rel, k))

# ------------------------------------------------------------------ 4. Molang identifiers are real
qlist = open(os.path.join(B, "ref", "qlist.md"), encoding="utf-8").read()
REAL_QUERIES = set(re.findall(r"\[query\.([a-z0-9_]+)\]", qlist))
for vanilla in ("player.render_controllers.json", "player.entity.json", "player.animation.json",
                "player.animation_controllers.json"):  # queries used by vanilla files are real too
    REAL_QUERIES |= set(re.findall(r"query\.([a-z0-9_]+)", open(os.path.join(B, "ref", vanilla), encoding="utf-8").read()))
REAL_MATH = {"sin", "cos", "clamp", "mod", "pow", "sqrt", "abs", "lerp", "min", "max"}
REAL_VARS = {"is_first_person", "is_paperdoll", "attack_time", "item_use_normalized"}  # vanilla player


def molang_strings(obj):
    if isinstance(obj, str):
        yield obj
    elif isinstance(obj, dict):
        for v in obj.values():
            yield from molang_strings(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from molang_strings(v)


def check_molang(expr, where):
    for q in re.findall(r"\b(?:query|q)\.([a-z0-9_]+)", expr):
        check(q in REAL_QUERIES, "%s: unknown query.%s" % (where, q))
    for m in re.findall(r"\bmath\.([a-z0-9_]+)", expr):
        check(m in REAL_MATH, "%s: unknown math.%s" % (where, m))
    for v in re.findall(r"\b(?:variable|v)\.([a-z0-9_]+)", expr):
        check(v in REAL_VARS, "%s: unexpected variable.%s" % (where, v))
    check(expr.count("(") == expr.count(")"), "%s: unbalanced parens" % where)
    check(expr.count("'") % 2 == 0, "%s: unbalanced quotes" % where)
    depth = 0
    for ch in expr:
        depth += {"(": 1, ")": -1}.get(ch, 0)
        check(depth >= 0, "%s: ')' before '('" % where) if depth < 0 else None


for n in NEW_PLAYER + NEW_ATT:
    for s in molang_strings(anims[n].get("bones", {})):
        check_molang(s, n)
rc_doc = J[os.path.join(RP, "render_controllers", "sym_mk5_player.render_controllers.json")]
for s in molang_strings(rc_doc):
    if "query." in s or "variable." in s:
        check_molang(s, "render controller")
check_molang(spin_entries[0]["sym_paperdoll_spin"], "spin condition")
# first-person / paper-doll gating on every flight channel
for n in NEW_PLAYER[:5]:
    for bone, chs in anims[n]["bones"].items():
        for s in molang_strings(chs):
            if any(c.isalpha() for c in s):
                check("variable.is_first_person" in s, "%s %s: channel not gated for first person" % (n, bone))
                if bone == "root":
                    check("variable.is_paperdoll" in s, "%s root: not gated for paper doll" % n)

# ------------------------------------------------------------------ 5. render controllers
ITEM_CALL = re.compile(r"query\.is_item_name_any\('slot\.armor\.chest', 0, ([^)]*)\)")
for s in molang_strings(rc_doc):
    for m in ITEM_CALL.finditer(s):
        names = re.findall(r"'([^']+)'", m.group(1))
        check(len(names) <= 4, "is_item_name_any with %d names" % len(names))
        for n in names:
            check(n in item_ids, "render controller references unknown item %s" % n)
check("overlay_color" not in json.dumps(rc_doc) and '"color"' not in json.dumps(rc_doc), "rc: no tint")

HAND_R = "(query.get_equipped_item_name(0, 1) == '' || query.get_equipped_item_name(0, 1) == 'filled_map')"
HAND_L = ("((query.get_equipped_item_name(0, 1) == 'filled_map' && query.get_equipped_item_name('off_hand') != 'shield')"
          " || (query.get_equipped_item_name('off_hand') == 'filled_map' && !query.item_is_charged)"
          " || (!query.item_is_charged && (variable.item_use_normalized > 0 && variable.item_use_normalized < 1.0)))")


def evaluate(expr, worn, hand_r, hand_l):
    """Tiny boolean evaluator (no eval): atoms are item checks and the two vanilla hand conditions."""
    if isinstance(expr, bool):
        return expr
    s = expr.replace(HAND_L, " L ").replace(HAND_R, " R ")
    s = ITEM_CALL.sub(lambda m: " T " if worn in re.findall(r"'([^']+)'", m.group(1)) else " F ", s)
    toks = re.findall(r"\(|\)|!|&&|\|\||[TFLR]|\S+", s)
    vals = {"T": True, "F": False, "L": hand_l, "R": hand_r}
    pos = [0]

    def peek():
        return toks[pos[0]] if pos[0] < len(toks) else None

    def take():
        pos[0] += 1
        return toks[pos[0] - 1]

    def p_or():
        v = p_and()
        while peek() == "||":
            take()
            v = p_and() or v
        return v

    def p_and():
        v = p_not()
        while peek() == "&&":
            take()
            v = p_not() and v
        return v

    def p_not():
        if peek() == "!":
            take()
            return not p_not()
        t = take()
        if t == "(":
            v = p_or()
            assert take() == ")", "missing )"
            return v
        if t not in vals:
            raise ValueError("unexpected token %r" % t)
        return vals[t]

    v = p_or()
    if pos[0] != len(toks):
        raise ValueError("trailing tokens")
    return v


def parts(doc):
    out = {}
    for cname, c in doc["render_controllers"].items():
        for pv in c["part_visibility"]:
            for k, v in pv.items():
                out[(cname, k)] = v
    return out


new_parts = parts(rc_doc)
old_parts = parts(strict_load(os.path.join(BASE, "Mark5_RP", "render_controllers", "sym_mk5_player.render_controllers.json")))
check(set(new_parts) == set(old_parts), "render controllers: part list changed")
OLD_IDS = ["sym:mark_5", "sym:mark_5_assembling_1", "sym:mark_5_assembling_2", "sym:mark_5_assembling_3",
           "sym:mark_5_assembling_4", "sym:mark_5_disassembling_1", "sym:mark_5_disassembling_2",
           "sym:mark_5_disassembling_3", "sym:mark_5_disassembling_4", "", "minecraft:diamond_chestplate"]
for key in new_parts:
    for worn in OLD_IDS + C.NEW_VARIANTS:
        for hr in (False, True):
            for hl in (False, True):
                try:
                    nv = evaluate(new_parts[key], worn, hr, hl)
                except Exception as e:  # noqa: BLE001
                    errors.append("rc %s: %s" % (key, e))
                    continue
                if worn in OLD_IDS:
                    check(nv == evaluate(old_parts[key], worn, hr, hl), "rc %s changed for %s" % (key, worn))
                else:  # new variants: behave like sym:mark_5, except FACE VISIBLE heads
                    expect = evaluate(old_parts[key], "sym:mark_5", hr, hl)
                    if key[1] == "head" and key[0].endswith("third_person") and worn in C.FACE_VISIBLE:
                        expect = key[0] == "controller.render.player.third_person"
                    check(nv == expect, "rc %s wrong for %s (got %s)" % (key, worn, nv))
# explicit spot checks
TP, STP = "controller.render.player.third_person", "controller.render.player.sym_mk5_third_person"
for w in C.FACE_VISIBLE:
    check(evaluate(new_parts[(TP, "head")], w, 0, 0) and not evaluate(new_parts[(TP, "hat")], w, 0, 0), "face head " + w)
    check(not evaluate(new_parts[(STP, "head")], w, 0, 0), "undersuit head hidden " + w)
for w in C.FULL:
    check(not evaluate(new_parts[(TP, "hat")], w, 0, 0) and not evaluate(new_parts[(TP, "body")], w, 0, 0), "full " + w)

# ------------------------------------------------------------------ 6. texture, lang, manifest
try:
    import numpy as np
    from PIL import Image

    a = np.array(Image.open(os.path.join(RP, "textures", "sym", "mk5.png")).convert("RGBA"))
    b = np.array(Image.open(os.path.join(RP, "textures", "sym", "mk5_off.png")).convert("RGBA"))
    check(a.shape == b.shape, "mk5_off size")
    ys, xs = np.where(np.any(a != b, axis=2))
    changed = set(zip(xs.tolist(), ys.tolist()))
    ys, xs = np.where(a[:, :, 3] == 140)
    leds = set(zip(xs.tolist(), ys.tolist()))
    check(len(leds) == 20 and changed == leds, "mk5_off changes exactly the 20 LED pixels")
    check(all(b[y, x, 3] == 255 and max(b[y, x, :3]) < 80 for x, y in leds), "LED pixels opaque and dark")
except ImportError:
    errors.append("PIL/numpy missing")

for lang in ("en_US.lang", "pt_BR.lang"):
    lines = open(os.path.join(RP, "texts", lang), encoding="utf-8").read().splitlines()
    kv = [line.split("=", 1) for line in lines if "=" in line]
    keys = [k for k, _ in kv]
    check(len(keys) == len(set(keys)), "%s duplicate keys" % lang)
    d = dict(kv)
    check(d.get("item." + C.REACTOR_ID) == C.REACTOR_DISPLAY_NAME, "%s reactor name" % lang)
    for vid in C.VARIANTS:
        check(d.get("item." + vid) == "Armadura Mark V", "%s %s" % (lang, vid))

man = J[os.path.join(RP, "manifest.json")]
old_man = strict_load(os.path.join(BASE, "Mark5_RP", "manifest.json"))
check(man["header"]["version"] == [2, 0, 0] and all(m["version"] == [2, 0, 0] for m in man["modules"]), "RP version")
check(man["header"]["uuid"] == old_man["header"]["uuid"], "RP header uuid kept")
check([m["uuid"] for m in man["modules"]] == [m["uuid"] for m in old_man["modules"]], "RP module uuids kept")
check(man["header"]["min_engine_version"] == [1, 26, 0], "min engine")

# ------------------------------------------------------------------ 7. idempotency
if "--no-regen" not in sys.argv:
    for gen in ("gen_variants.py", "gen_led_texture.py", "gen_animations.py", "gen_player_rc.py"):
        out = subprocess.run([sys.executable, os.path.join(B, "tools", "suit", gen)], capture_output=True, text=True)
        check(out.returncode == 0, "%s failed: %s" % (gen, out.stderr[-400:]))
        bad = [line for line in out.stdout.splitlines() if line.startswith("updated")]
        check(not bad, "%s not idempotent: %s" % (gen, bad))

if errors:
    print("SUIT VALIDATION FAILED (%d of %d checks)" % (len(errors), checks))
    for e in errors[:60]:
        print("  - " + e)
    sys.exit(1)
print("suit validation OK (%d checks)" % checks)
