// Mark V scanner knowledge base — pure tables (no "@minecraft/server"), unit-tested with node.
// Classes: "h" hostile (red), "n" neutral (white), "p" passive (green), "j" player (white-blue).

import { stripFormat } from "./codec.js";

const ids = (list) => new Set(list.split(/\s+/).filter(Boolean).map((s) => `minecraft:${s}`));

/** Always hostile. */
export const HOSTILE = ids(`
  blaze bogged breeze cave_spider creaking creeper drowned elder_guardian ender_dragon endermite
  evocation_illager ghast guardian hoglin husk illusioner magma_cube parched phantom piglin_brute
  pillager ravager shulker silverfish skeleton slime spider stray vex vindicator warden witch
  wither wither_skeleton zoglin zombie zombie_villager zombie_villager_v2 zombie_nautilus
`);

/** Neutral: only attack when provoked (a provoked one counts as hostile for 30 s). */
export const NEUTRAL = ids(`
  bee camel_husk dolphin enderman goat iron_golem llama nautilus panda piglin polar_bear
  pufferfish trader_llama wolf zombie_pigman
`);

/** Passive / friendly. */
export const PASSIVE = ids(`
  agent allay armadillo axolotl bat camel cat chicken cod copper_golem cow donkey fox frog
  glow_squid happy_ghast horse mooshroom mule npc ocelot parrot pig rabbit salmon sheep
  skeleton_horse sniffer snow_golem squid strider tadpole tropicalfish turtle villager
  villager_v2 wandering_trader zombie_horse
`);

/** Bosses / explosive or very dangerous mobs: always threat "ALTA". */
export const HIGH_THREAT = ids(`
  creeper elder_guardian ender_dragon evocation_illager ghast ravager warden wither
`);

/** Never analysed (not living things, projectiles, our own case...). */
export const EXCLUDED_TYPES = Object.freeze([
  "minecraft:item",
  "minecraft:xp_orb",
  "minecraft:xp_bottle",
  "minecraft:arrow",
  "minecraft:thrown_trident",
  "minecraft:snowball",
  "minecraft:egg",
  "minecraft:ender_pearl",
  "minecraft:eye_of_ender_signal",
  "minecraft:fireball",
  "minecraft:small_fireball",
  "minecraft:dragon_fireball",
  "minecraft:wither_skull",
  "minecraft:wither_skull_dangerous",
  "minecraft:shulker_bullet",
  "minecraft:llama_spit",
  "minecraft:fishing_hook",
  "minecraft:splash_potion",
  "minecraft:lingering_potion",
  "minecraft:fireworks_rocket",
  "minecraft:wind_charge_projectile",
  "minecraft:breeze_wind_charge_projectile",
  "minecraft:area_effect_cloud",
  "minecraft:evocation_fang",
  "minecraft:lightning_bolt",
  "minecraft:falling_block",
  "minecraft:tnt",
  "minecraft:tnt_minecart",
  "minecraft:ender_crystal",
  "minecraft:armor_stand",
  "minecraft:painting",
  "minecraft:leash_knot",
  "minecraft:minecart",
  "minecraft:chest_minecart",
  "minecraft:hopper_minecart",
  "minecraft:command_block_minecart",
  "minecraft:boat",
  "minecraft:chest_boat",
  "sym:mk5_case",
]);
const EXCLUDED_SET = new Set(EXCLUDED_TYPES);

/** @param {string} typeId */
export function isExcludedType(typeId) {
  return EXCLUDED_SET.has(typeId);
}

/** PT-BR names of vanilla mobs. */
export const NAMES = Object.freeze({
  "minecraft:player": "Jogador",
  "minecraft:agent": "Agente",
  "minecraft:allay": "Allay",
  "minecraft:armadillo": "Tatu",
  "minecraft:axolotl": "Axolote",
  "minecraft:bat": "Morcego",
  "minecraft:bee": "Abelha",
  "minecraft:blaze": "Blaze",
  "minecraft:bogged": "Pantanoso",
  "minecraft:breeze": "Brisa",
  "minecraft:camel": "Camelo",
  "minecraft:camel_husk": "Camelo-Múmia",
  "minecraft:cat": "Gato",
  "minecraft:cave_spider": "Aranha da Caverna",
  "minecraft:chicken": "Galinha",
  "minecraft:cod": "Bacalhau",
  "minecraft:copper_golem": "Golem de Cobre",
  "minecraft:cow": "Vaca",
  "minecraft:creaking": "Rangedor",
  "minecraft:creeper": "Creeper",
  "minecraft:dolphin": "Golfinho",
  "minecraft:donkey": "Burro",
  "minecraft:drowned": "Afogado",
  "minecraft:elder_guardian": "Guardião Ancião",
  "minecraft:ender_dragon": "Dragão do Ender",
  "minecraft:enderman": "Enderman",
  "minecraft:endermite": "Endermite",
  "minecraft:evocation_illager": "Invocador",
  "minecraft:fox": "Raposa",
  "minecraft:frog": "Sapo",
  "minecraft:ghast": "Ghast",
  "minecraft:glow_squid": "Lula Brilhante",
  "minecraft:goat": "Cabra",
  "minecraft:guardian": "Guardião",
  "minecraft:happy_ghast": "Ghast Feliz",
  "minecraft:hoglin": "Hoglin",
  "minecraft:horse": "Cavalo",
  "minecraft:husk": "Zumbi-Múmia",
  "minecraft:illusioner": "Ilusionista",
  "minecraft:iron_golem": "Golem de Ferro",
  "minecraft:llama": "Lhama",
  "minecraft:magma_cube": "Cubo de Magma",
  "minecraft:mooshroom": "Coguvaca",
  "minecraft:mule": "Mula",
  "minecraft:nautilus": "Náutilo",
  "minecraft:npc": "NPC",
  "minecraft:ocelot": "Jaguatirica",
  "minecraft:panda": "Panda",
  "minecraft:parched": "Ressecado",
  "minecraft:parrot": "Papagaio",
  "minecraft:phantom": "Phantom",
  "minecraft:pig": "Porco",
  "minecraft:piglin": "Piglin",
  "minecraft:piglin_brute": "Piglin Bruto",
  "minecraft:pillager": "Saqueador",
  "minecraft:polar_bear": "Urso-Polar",
  "minecraft:pufferfish": "Baiacu",
  "minecraft:rabbit": "Coelho",
  "minecraft:ravager": "Devastador",
  "minecraft:salmon": "Salmão",
  "minecraft:sheep": "Ovelha",
  "minecraft:shulker": "Shulker",
  "minecraft:silverfish": "Traça",
  "minecraft:skeleton": "Esqueleto",
  "minecraft:skeleton_horse": "Cavalo-Esqueleto",
  "minecraft:slime": "Slime",
  "minecraft:sniffer": "Farejador",
  "minecraft:snow_golem": "Golem de Neve",
  "minecraft:spider": "Aranha",
  "minecraft:squid": "Lula",
  "minecraft:stray": "Errante",
  "minecraft:strider": "Lavagante",
  "minecraft:tadpole": "Girino",
  "minecraft:trader_llama": "Lhama de Mercador",
  "minecraft:tropicalfish": "Peixe Tropical",
  "minecraft:turtle": "Tartaruga",
  "minecraft:vex": "Vex",
  "minecraft:villager": "Aldeão",
  "minecraft:villager_v2": "Aldeão",
  "minecraft:vindicator": "Vingador",
  "minecraft:wandering_trader": "Mercador Ambulante",
  "minecraft:warden": "Warden",
  "minecraft:witch": "Bruxa",
  "minecraft:wither": "Wither",
  "minecraft:wither_skeleton": "Esqueleto Wither",
  "minecraft:wolf": "Lobo",
  "minecraft:zoglin": "Zoglin",
  "minecraft:zombie": "Zumbi",
  "minecraft:zombie_horse": "Cavalo Zumbi",
  "minecraft:zombie_nautilus": "Náutilo Zumbi",
  "minecraft:zombie_pigman": "Piglin Zumbificado",
  "minecraft:zombie_villager": "Aldeão Zumbi",
  "minecraft:zombie_villager_v2": "Aldeão Zumbi",
});

/** Collision box [height, width] in blocks of vanilla mobs (adults, scale 1). */
export const SIZES = Object.freeze({
  "minecraft:player": [1.8, 0.6],
  "minecraft:allay": [0.6, 0.35],
  "minecraft:armadillo": [0.65, 0.7],
  "minecraft:axolotl": [0.42, 0.75],
  "minecraft:bat": [0.9, 0.5],
  "minecraft:bee": [0.6, 0.6],
  "minecraft:blaze": [1.8, 0.5],
  "minecraft:breeze": [1.77, 0.6],
  "minecraft:camel": [2.375, 1.7],
  "minecraft:camel_husk": [2.375, 1.7],
  "minecraft:cat": [0.7, 0.6],
  "minecraft:cave_spider": [0.5, 0.7],
  "minecraft:chicken": [0.8, 0.6],
  "minecraft:cod": [0.3, 0.5],
  "minecraft:copper_golem": [1.0, 0.6],
  "minecraft:cow": [1.3, 0.9],
  "minecraft:creaking": [2.7, 0.9],
  "minecraft:creeper": [1.7, 0.6],
  "minecraft:dolphin": [0.6, 0.9],
  "minecraft:donkey": [1.6, 1.4],
  "minecraft:elder_guardian": [2.0, 2.0],
  "minecraft:ender_dragon": [4.0, 8.0],
  "minecraft:enderman": [2.9, 0.6],
  "minecraft:endermite": [0.3, 0.4],
  "minecraft:fox": [0.7, 0.6],
  "minecraft:frog": [0.55, 0.5],
  "minecraft:ghast": [4.0, 4.0],
  "minecraft:glow_squid": [0.95, 0.95],
  "minecraft:goat": [1.3, 0.9],
  "minecraft:guardian": [0.85, 0.85],
  "minecraft:happy_ghast": [4.0, 4.0],
  "minecraft:hoglin": [1.4, 1.4],
  "minecraft:horse": [1.6, 1.4],
  "minecraft:iron_golem": [2.9, 1.4],
  "minecraft:llama": [1.87, 0.9],
  "minecraft:magma_cube": [1.04, 1.04],
  "minecraft:mooshroom": [1.3, 0.9],
  "minecraft:mule": [1.6, 1.4],
  "minecraft:nautilus": [0.9, 0.9],
  "minecraft:ocelot": [0.7, 0.6],
  "minecraft:panda": [1.25, 1.3],
  "minecraft:parrot": [0.9, 0.5],
  "minecraft:phantom": [0.5, 0.9],
  "minecraft:pig": [0.9, 0.9],
  "minecraft:polar_bear": [1.4, 1.3],
  "minecraft:pufferfish": [0.7, 0.7],
  "minecraft:rabbit": [0.5, 0.4],
  "minecraft:ravager": [2.2, 1.95],
  "minecraft:salmon": [0.4, 0.7],
  "minecraft:sheep": [1.3, 0.9],
  "minecraft:shulker": [1.0, 1.0],
  "minecraft:silverfish": [0.3, 0.4],
  "minecraft:skeleton_horse": [1.6, 1.4],
  "minecraft:slime": [1.04, 1.04],
  "minecraft:sniffer": [1.75, 1.9],
  "minecraft:snow_golem": [1.8, 0.4],
  "minecraft:spider": [0.9, 1.4],
  "minecraft:squid": [0.95, 0.95],
  "minecraft:strider": [1.7, 0.9],
  "minecraft:tadpole": [0.3, 0.4],
  "minecraft:trader_llama": [1.87, 0.9],
  "minecraft:tropicalfish": [0.52, 0.4],
  "minecraft:turtle": [0.4, 1.2],
  "minecraft:vex": [0.8, 0.4],
  "minecraft:warden": [2.9, 0.9],
  "minecraft:wither": [3.5, 1.0],
  "minecraft:wither_skeleton": [2.4, 0.7],
  "minecraft:wolf": [0.8, 0.6],
  "minecraft:zoglin": [1.4, 1.4],
  "minecraft:zombie_horse": [1.6, 1.4],
  "minecraft:zombie_nautilus": [0.9, 0.9],
});

const DEFAULT_SIZE = [1.8, 0.9];

/**
 * Bracket size for the scanner mark of a mob: `{height, width}` (blocks), scaled by the entity
 * scale component and halved for babies. Width never goes under 0.9 (spec default).
 */
export function markSize(typeId, scale = 1, isBaby = false) {
  const [h, w] = SIZES[typeId] ?? DEFAULT_SIZE;
  const k = (Number.isFinite(scale) && scale > 0 ? scale : 1) * (isBaby ? 0.5 : 1);
  return { height: Math.max(0.4, h * k + 0.2), width: Math.max(0.9, w * k + 0.3) };
}

/**
 * Classify a mob type.
 * @param {string} typeId
 * @param {{isMonster?: boolean, provoked?: boolean}} [hints] isMonster = has family "monster"
 * @returns {"h"|"n"|"p"|"j"}
 */
export function classifyId(typeId, hints = {}) {
  if (typeId === "minecraft:player") return "j";
  /** @type {"h"|"n"|"p"|"j"} */
  let cls;
  if (HOSTILE.has(typeId)) cls = "h";
  else if (NEUTRAL.has(typeId)) cls = "n";
  else if (PASSIVE.has(typeId)) cls = "p";
  else cls = hints.isMonster ? "h" : "p";
  if (cls !== "h" && hints.provoked) cls = "h";
  return cls;
}

/** "minecraft:iron_golem" -> "Iron Golem" (unknown / add-on mobs). */
export function prettifyId(typeId) {
  const short = String(typeId ?? "").split(":").pop() ?? "";
  const words = short.split(/[_\-.\s]+/).filter(Boolean);
  if (!words.length) return "?";
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/** Display name: name tag wins, then the PT-BR table, then the prettified id. */
export function displayName(typeId, nameTag) {
  const tag = stripFormat(nameTag ?? "").trim();
  if (tag) return tag;
  return NAMES[typeId] ?? prettifyId(typeId);
}

/** Shorten a name to `max` characters (adds "."). */
export function shortName(name, max) {
  const s = String(name);
  return s.length <= max ? s : `${s.slice(0, Math.max(1, max - 1)).trimEnd()}.`;
}

/** Threat level text for the target panel. */
export function threatLevel(cls, maxHp, typeId) {
  const hp = Number(maxHp) || 0;
  if (cls === "h") return HIGH_THREAT.has(typeId) || hp >= 30 ? "ALTA" : "MÉDIA";
  if (cls === "n") return hp >= 30 ? "MÉDIA" : "BAIXA";
  if (cls === "j") return "MÉDIA";
  return "BAIXA";
}

export const THREAT_COLOR = Object.freeze({ ALTA: "§c", "MÉDIA": "§6", BAIXA: "§a" });

/** Colored class label (target panel). */
export const CLASS_LABEL = Object.freeze({
  h: "§cHOSTIL",
  n: "§fNEUTRO",
  p: "§aPACÍFICO",
  j: "§bJOGADOR",
});

/** Text color code per class (scan list squares). */
export const CLASS_COLOR = Object.freeze({ h: "§c", n: "§f", p: "§a", j: "§b" });

/** Particle tint per class for sym:mk5_mark (SPEC 5.5). */
export const MARK_COLOR = Object.freeze({
  h: Object.freeze({ red: 1, green: 0.2, blue: 0.2, alpha: 1 }),
  n: Object.freeze({ red: 1, green: 1, blue: 1, alpha: 0.9 }),
  p: Object.freeze({ red: 0.3, green: 1, blue: 0.45, alpha: 0.9 }),
  j: Object.freeze({ red: 0.75, green: 0.9, blue: 1, alpha: 0.9 }),
});

/** Sort key: hostiles first, then by distance. */
export function scanOrder(a, b) {
  const ha = a.cls === "h" ? 0 : 1;
  const hb = b.cls === "h" ? 0 : 1;
  return ha - hb || a.dist - b.dist;
}
