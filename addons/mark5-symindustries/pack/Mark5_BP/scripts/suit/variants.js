// Mark V suit variants — the worn chest item encodes power (powered / offline / dying) and visor
// (closed / open / opening / closing). Swapping copies everything that makes the suit "yours".

import { EquipmentSlot, ItemLockMode, ItemStack } from "@minecraft/server";
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
  let keep = false;
  quiet(() => {
    const stashed = src?.getDynamicProperty(PROP.ITEM_KEEP);
    keep = typeof stashed === "boolean" ? stashed : !!src?.keepOnDeath;
  });
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
