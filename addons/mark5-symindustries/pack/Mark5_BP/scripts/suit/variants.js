// Mark V suit variants — the worn chest item encodes power (powered / offline / dying) and visor
// (closed / open / opening / closing). Swapping copies everything that makes the suit "yours".

import { EnchantmentTypes, EquipmentSlot, ItemLockMode, ItemStack } from "@minecraft/server";
import { ITEM_SUIT, PROP, VARIANTS, finalOf, isSuitId, isTempVariant, variantFor, variantInfo } from "./constants.js";
import { quiet } from "./fx.js";

export { finalOf, isSuitId, isTempVariant, variantFor, variantInfo };

/**
 * @typedef {import("./constants.js").VariantInfo & {item: import("@minecraft/server").ItemStack}} WornSuit
 */

/** @param {import("@minecraft/server").Entity} player */
function equippable(player) {
  return quiet(() => player.getComponent("minecraft:equippable"));
}

/**
 * The suit variant worn in the chest slot, or undefined.
 * @param {import("@minecraft/server").Player} player
 * @returns {WornSuit|undefined}
 */
export function getWornSuit(player) {
  const item = quiet(() => equippable(player)?.getEquipment(EquipmentSlot.Chest));
  if (!item) return undefined;
  const info = VARIANTS[item.typeId];
  if (!info || !isSuitId(item.typeId)) return undefined;
  return { ...info, item };
}

/** Durability left 0..1 of a suit item. @param {import("@minecraft/server").ItemStack} item */
export function integrityOf(item) {
  const d = quiet(() => item?.getComponent("minecraft:durability"));
  if (!d || !(d.maxDurability > 0)) return 1;
  return Math.max(0, Math.min(1, (d.maxDurability - d.damage) / d.maxDurability));
}

/**
 * New suit item `newId` carrying over durability damage, enchantments, name tag, lore, dynamic
 * properties and keep-on-death of `src`. Temp items are locked in their slot and kept on death
 * (the item they replace remembers its own keep-on-death flag in PROP.ITEM_KEEP).
 * @param {import("@minecraft/server").ItemStack|undefined} src
 * @param {string} newId
 * @param {boolean} temp
 */
export function makeSuitItem(src, newId, temp) {
  const item = new ItemStack(newId, 1);
  if (src) {
    quiet(() => {
      const a = src.getComponent("minecraft:durability");
      const b = item.getComponent("minecraft:durability");
      if (a && b && a.damage > 0) b.damage = Math.max(0, Math.min(b.maxDurability - 1, a.damage));
    });
    quiet(() => {
      const list = src.getComponent("minecraft:enchantable")?.getEnchantments() ?? [];
      const ench = item.getComponent("minecraft:enchantable");
      if (!ench) return;
      for (const e of list) quiet(() => ench.addEnchantment(e));
    });
    quiet(() => {
      if (src.nameTag) item.nameTag = src.nameTag;
    });
    quiet(() => {
      const lore = src.getLore();
      if (lore.length) item.setLore(lore);
    });
    quiet(() => {
      for (const id of src.getDynamicPropertyIds()) {
        if (id !== PROP.ITEM_KEEP) item.setDynamicProperty(id, src.getDynamicProperty(id));
      }
    });
  }
  const keep = keepOf(src);
  quiet(() => {
    if (temp) {
      item.lockMode = ItemLockMode.slot;
      item.keepOnDeath = true;
      item.setDynamicProperty(PROP.ITEM_KEEP, keep);
    } else {
      item.lockMode = ItemLockMode.none;
      item.keepOnDeath = keep;
    }
  });
  return item;
}

/**
 * Real keep-on-death of a suit stack: temp items are always kept, the flag of the item they
 * replaced travels in PROP.ITEM_KEEP. @param {import("@minecraft/server").ItemStack|undefined} src
 */
function keepOf(src) {
  const stashed = quiet(() => src?.getDynamicProperty(PROP.ITEM_KEEP));
  return typeof stashed === "boolean" ? stashed : !!quiet(() => src?.keepOnDeath);
}

/**
 * JSON snapshot of what makes a suit "yours" besides its wear — enchantments, name tag, lore,
 * keep-on-death — so it survives the trip into the case (suit-off -> suit-up). "" = nothing to keep.
 * @param {import("@minecraft/server").ItemStack|undefined} src
 * @returns {string}
 */
export function suitMetaOf(src) {
  if (!src) return "";
  /** @type {{e?: Array<[string, number]>, n?: string, l?: string[], k?: boolean}} */
  const meta = {};
  const ench = quiet(() => src.getComponent("minecraft:enchantable")?.getEnchantments()) ?? [];
  /** @type {Array<[string, number]>} */
  const list = [];
  for (const e of ench) {
    const id = quiet(() => e.type.id);
    if (typeof id === "string" && id) list.push([id, e.level]);
  }
  if (list.length) meta.e = list;
  const name = quiet(() => src.nameTag);
  if (name) meta.n = name;
  const lore = quiet(() => src.getLore()) ?? [];
  if (lore.length) meta.l = lore;
  if (keepOf(src)) meta.k = true;
  return Object.keys(meta).length ? JSON.stringify(meta) : "";
}

/**
 * Re-apply a suitMetaOf() snapshot to a freshly built (non-temp) suit item. Each enchantment is
 * added on its own: one that no longer exists or no longer fits is skipped, not the whole list.
 * @param {import("@minecraft/server").ItemStack} item
 * @param {string|undefined} json
 */
export function applySuitMeta(item, json) {
  if (!item || typeof json !== "string" || !json) return;
  const meta = quiet(() => JSON.parse(json));
  if (!meta || typeof meta !== "object") return;
  const ench = quiet(() => item.getComponent("minecraft:enchantable"));
  if (ench && Array.isArray(meta.e)) {
    for (const entry of meta.e) {
      if (!Array.isArray(entry)) continue;
      const [id, level] = entry;
      quiet(() => {
        const type = typeof id === "string" ? EnchantmentTypes.get(id) : undefined;
        if (type && Number.isInteger(level) && level > 0) ench.addEnchantment({ type, level });
      });
    }
  }
  if (typeof meta.n === "string" && meta.n) quiet(() => (item.nameTag = meta.n));
  if (Array.isArray(meta.l) && meta.l.length) quiet(() => item.setLore(meta.l.map(String)));
  if (meta.k === true) quiet(() => (item.keepOnDeath = true));
}

/** Plain `sym:mark_5` item made from any suit variant stack (drops, inventory leftovers). */
export function baseSuitFrom(stack) {
  return makeSuitItem(stack, ITEM_SUIT, false);
}

/**
 * Replace the worn chest item by variant `newId` (one setEquipment: never duplicates or loses
 * the suit). Temp ids are always locked; `temp` may force it for clarity.
 * @param {import("@minecraft/server").Player} player
 * @param {string} newId
 * @param {{temp?: boolean}} [opts]
 * @returns {boolean}
 */
export function swapChest(player, newId, opts = {}) {
  const eq = equippable(player);
  if (!eq) return false;
  const old = quiet(() => eq.getEquipment(EquipmentSlot.Chest));
  // only ever replace a suit by a suit: never overwrite (and lose) some other chest item
  if (!old || !isSuitId(old.typeId) || !isSuitId(newId)) return false;
  if (old.typeId === newId) return true;
  const item = makeSuitItem(old, newId, !!opts.temp || isTempVariant(newId));
  try {
    eq.setEquipment(EquipmentSlot.Chest, item);
    return true;
  } catch {
    return false;
  }
}
