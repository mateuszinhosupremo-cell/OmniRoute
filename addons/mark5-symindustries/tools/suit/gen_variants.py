#!/usr/bin/env python3
"""Suit variants (SPEC 2.1 / 2.2): BP items, RP attachables, reactor rename, .lang, RP manifest.

Templates are the existing `sym:mark_5` item and attachable. Idempotent: re-running produces
byte-identical files.
"""

import copy
import os
import sys

sys.dont_write_bytecode = True  # keep tools/suit free of __pycache__
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (  # noqa: E402
    BASE_ID,
    BP,
    EXTRA_ANIM_KEYS,
    NEW_VARIANTS,
    REACTOR_DISPLAY_NAME,
    REACTOR_ID,
    RP,
    SUIT_DISPLAY_NAME,
    VARIANTS,
    WORN_CONDITION,
    attachable_file,
    item_file,
    load_json,
    report,
    write_json,
    write_text,
)

RP_VERSION = [2, 0, 0]
RP_DESCRIPTION = (
    "Mark V v2.0 — montagem cinematográfica, HUD holográfico com armadura 3D, energia, "
    "voo com propulsores, scanners e mira teleguiada"
)
LANG_PACK_DESCRIPTION = RP_DESCRIPTION


def build_item(template, identifier):
    protection = VARIANTS[identifier][0]
    item = copy.deepcopy(template)
    desc = item["minecraft:item"]["description"]
    desc["identifier"] = identifier
    if identifier == BASE_ID:
        desc["menu_category"] = {"category": "equipment", "group": "minecraft:itemGroup.name.chestplate"}
    else:
        desc["menu_category"] = {"category": "none", "is_hidden_in_commands": True}
    comps = item["minecraft:item"]["components"]
    comps["minecraft:display_name"] = {"value": SUIT_DISPLAY_NAME}
    comps["minecraft:wearable"] = {"slot": "slot.armor.chest", "protection": protection}
    return item


def strip_extras(attachable):
    """Remove the variant extra animations so the base attachable can be re-derived."""
    a = copy.deepcopy(attachable)
    desc = a["minecraft:attachable"]["description"]
    for key in EXTRA_ANIM_KEYS:
        desc["animations"].pop(key, None)
    desc["scripts"]["animate"] = [
        e for e in desc["scripts"]["animate"] if not (isinstance(e, dict) and set(e) & set(EXTRA_ANIM_KEYS))
    ]
    return a


def build_attachable(template, identifier):
    _, texture, extra_key, extra_anim = VARIANTS[identifier]
    a = copy.deepcopy(template)
    desc = a["minecraft:attachable"]["description"]
    desc["identifier"] = identifier
    desc["textures"] = {"default": texture}
    if extra_key:
        desc["animations"][extra_key] = extra_anim
        animate = desc["scripts"]["animate"]
        worn_idx = next(i for i, e in enumerate(animate) if isinstance(e, dict) and "worn" in e)
        animate.insert(worn_idx + 1, {extra_key: WORN_CONDITION})
    return a


def update_lang(path):
    with open(path, encoding="utf-8") as f:
        lines = f.read().splitlines()
    wanted = {"pack.description": LANG_PACK_DESCRIPTION, "item." + REACTOR_ID: REACTOR_DISPLAY_NAME}
    for vid in VARIANTS:
        wanted["item." + vid] = SUIT_DISPLAY_NAME
    out, seen = [], set()
    for line in lines:
        key = line.split("=", 1)[0] if "=" in line and not line.startswith("#") else None
        if key in wanted:
            if key in seen:
                continue
            out.append(key + "=" + wanted[key])
            seen.add(key)
        else:
            out.append(line)
    for key, val in wanted.items():  # append missing keys in table order
        if key not in seen:
            out.append(key + "=" + val)
    return write_text(path, "\n".join(out) + "\n")


def main():
    # --- BP items
    item_dir = os.path.join(BP, "items")
    template_item = load_json(os.path.join(item_dir, item_file(BASE_ID)))
    for vid in NEW_VARIANTS:
        path = os.path.join(item_dir, item_file(vid))
        report(path, write_json(path, build_item(template_item, vid)))

    reactor_path = os.path.join(item_dir, item_file(REACTOR_ID))
    reactor = load_json(reactor_path)
    reactor["minecraft:item"]["components"]["minecraft:display_name"] = {"value": REACTOR_DISPLAY_NAME}
    report(reactor_path, write_json(reactor_path, reactor))

    # --- RP attachables (the base gets its eyes_boot extra; variants are copies of the base)
    att_dir = os.path.join(RP, "attachables")
    base_path = os.path.join(att_dir, attachable_file(BASE_ID))
    template_att = strip_extras(load_json(base_path))
    for vid in VARIANTS:
        path = os.path.join(att_dir, attachable_file(vid))
        report(path, write_json(path, build_attachable(template_att, vid)))

    # --- .lang
    for lang in ("en_US.lang", "pt_BR.lang"):
        path = os.path.join(RP, "texts", lang)
        report(path, update_lang(path))

    # --- RP manifest: version bump, keep UUIDs
    man_path = os.path.join(RP, "manifest.json")
    man = load_json(man_path)
    man["header"]["version"] = list(RP_VERSION)
    man["header"]["description"] = RP_DESCRIPTION
    for mod in man["modules"]:
        mod["version"] = list(RP_VERSION)
    report(man_path, write_json(man_path, man))


if __name__ == "__main__":
    main()
