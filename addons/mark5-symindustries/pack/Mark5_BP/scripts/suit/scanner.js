// Mark V sensors: look-at target analysis (SPEC 5.4), area scanner with a travelling wave and
// AR marks only the pilot sees (SPEC 5.5) and the "hostile nearby" threat flag.
// Mob knowledge (classes, PT-BR names, sizes) lives in the pure module ./mobs.js.

import { FX, SND, TUNING as T } from "./constants.js";
import { bearingTo } from "./codec.js";
import { clamp, revealDelay, vdist } from "./calc.js";
import {
  HOSTILE,
  MARK_COLOR,
  NEUTRAL,
  PASSIVE,
  classifyId,
  displayName,
  isExcludedType,
  markSize,
  scanOrder,
  threatLevel,
} from "./mobs.js";
import { molang, playerParticle, playerSound, quiet, worldParticle, worldSound } from "./fx.js";
import { notify, pushAlert } from "./hud.js";
import { spendEnergy } from "./state.js";
import { scanText, targetText } from "./texts.js";

const LOOK_KEEP_TICKS = 12; // target panel lingers a little after the reticle leaves the mob
const MARK_EVERY = 5;
const MAX_SCAN_ENTRIES = 80;
const OUT_OF_RANGE = T.SCAN_RADIUS + 16;

/**
 * @typedef {Object} ScanEntry
 * @property {import("@minecraft/server").Entity} entity
 * @property {string} id
 * @property {string} typeId
 * @property {"h"|"n"|"p"|"j"} cls
 * @property {string} name
 * @property {number} height
 * @property {number} width
 * @property {number} revealAt
 * @property {boolean} revealed
 * @property {boolean} alive
 * @property {number} dist
 * @property {number} bearing
 * @property {number} hp
 *
 * @typedef {Object} ScanRuntime
 * @property {number} start
 * @property {number} sweepUntil
 * @property {number} until
 * @property {number} lastPing
 * @property {ScanEntry[]} entries
 */

// ---------------------------------------------------------------------------------------------
// entity helpers
// ---------------------------------------------------------------------------------------------

/** Health of a living entity, or undefined for things that are not alive. */
function healthOf(entity) {
  const h = quiet(() => entity.getComponent("minecraft:health"));
  if (!h) return undefined;
  const cur = Number(quiet(() => h.currentValue));
  const max = Number(quiet(() => h.effectiveMax));
  if (!Number.isFinite(cur)) return undefined;
  return { hp: cur, maxHp: Number.isFinite(max) && max > 0 ? max : Math.max(1, cur) };
}

/**
 * Scannable = alive mob/player: has health > 0, not an item/projectile/vehicle/our case, not
 * family "inanimate", not the scanning player itself.
 * @param {import("@minecraft/server").Entity} entity
 * @param {string} selfId
 */
export function scannable(entity, selfId) {
  if (!entity || entity.id === selfId || !quiet(() => entity.isValid)) return undefined;
  const typeId = entity.typeId;
  if (isExcludedType(typeId)) return undefined;
  const hp = healthOf(entity);
  if (!hp || hp.hp <= 0) return undefined;
  if (quiet(() => entity.matches({ families: ["inanimate"] }))) return undefined;
  return hp;
}

/**
 * Class of an entity for this player ("h"|"n"|"p"|"j"). Neutral mobs that hurt the player in
 * the last 30 s count as hostile.
 * @param {import("@minecraft/server").Entity} entity
 * @param {import("./state.js").SuitState} st
 */
export function classify(entity, st, tick) {
  const hurtAt = st.aggressors.get(entity.id);
  const provoked = hurtAt !== undefined && tick - hurtAt <= T.PROVOKED_TICKS;
  const typeId = entity.typeId;
  const listed = typeId === "minecraft:player" || HOSTILE.has(typeId) || NEUTRAL.has(typeId) || PASSIVE.has(typeId);
  // ids missing from the tables (new vanilla mobs, add-ons): family "monster" = hostile
  const isMonster = listed ? false : !!quiet(() => entity.matches({ families: ["monster"] }));
  return { cls: classifyId(typeId, { isMonster, provoked }), provoked };
}

/** Bracket size of an entity (type table x scale component, babies half size). */
export function sizeOf(entity) {
  const scale = Number(quiet(() => entity.getComponent("minecraft:scale")?.value) ?? 1);
  const baby = !!quiet(() => entity.getComponent("minecraft:is_baby"));
  return markSize(entity.typeId, scale, baby);
}

const nameOf = (entity) => displayName(entity.typeId, quiet(() => entity.nameTag));

// ---------------------------------------------------------------------------------------------
// look-at analysis
// ---------------------------------------------------------------------------------------------

/**
 * Raycast from the eyes (every 2 ticks while the HUD is on) and remember the living entity
 * under the reticle in st.look (st.lookShown keeps the panel for a few ticks after).
 * @param {import("@minecraft/server").Player} player
 * @param {import("./state.js").SuitState} st
 */
export function tickLook(player, st, tick) {
  if ((tick + st.phase) % 2 !== 0) return;
  const hits = quiet(() => player.getEntitiesFromViewDirection({ maxDistance: T.TARGET_RANGE })) ?? [];
  /** @type {import("./state.js").LookInfo|undefined} */
  let look;
  for (const hit of hits) {
    const ent = hit.entity;
    const hp = scannable(ent, player.id);
    if (!hp) continue;
    const { cls, provoked } = classify(ent, st, tick);
    look = {
      entity: ent,
      id: ent.id,
      typeId: ent.typeId,
      cls,
      provoked,
      name: nameOf(ent),
      dist: Number.isFinite(hit.distance) ? hit.distance : vdist(player.location, ent.location),
      hp: hp.hp,
      maxHp: hp.maxHp,
    };
    break;
  }
  st.look = look;
  if (look) {
    st.lookShown = look;
    st.lookUntil = tick + LOOK_KEEP_TICKS;
    if (look.id !== st.lastTargetSoundId || tick - st.lastTargetSoundTick > 100) {
      if (look.id !== st.lastTargetSoundId) playerSound(player, SND.TARGET, 0.6, 1.2);
      st.lastTargetSoundId = look.id;
    }
    st.lastTargetSoundTick = tick;
  } else if (st.lookShown && (tick > st.lookUntil || !quiet(() => st.lookShown.entity.isValid))) {
    st.lookShown = undefined;
  }
}

/** Forget the look-at target (HUD off). @param {import("./state.js").SuitState} st */
export function clearLook(st) {
  st.look = undefined;
  st.lookShown = undefined;
}

/**
 * Target panel fields.
 * @param {import("./state.js").SuitState} st
 * @param {string|undefined} lockedId
 */
export function targetHudFields(st, lockedId) {
  const t = st.lookShown;
  if (!t) return { target_class: "0", target_hp_frame: 0, target_text: "" };
  const frame = t.hp <= 0 ? 0 : clamp(Math.round((t.hp / t.maxHp) * 10), 1, 10);
  return {
    target_class: t.cls,
    target_hp_frame: frame,
    target_text: targetText({
      name: t.name,
      cls: t.cls,
      threat: threatLevel(t.cls, t.maxHp, t.typeId),
      dist: t.dist,
      hp: t.hp,
      maxHp: t.maxHp,
      locked: !!lockedId && lockedId === t.id,
      provoked: t.provoked,
    }),
  };
}

// ---------------------------------------------------------------------------------------------
// threat flag (red visor edge)
// ---------------------------------------------------------------------------------------------

/**
 * Every 10 ticks while the HUD is on: any monster within THREAT_RADIUS blocks?
 * @param {import("@minecraft/server").Player} player
 * @param {import("./state.js").SuitState} st
 */
export function tickThreat(player, st, tick) {
  if ((tick + st.phase) % 10 !== 0) return;
  const list =
    quiet(() =>
      player.dimension.getEntities({ location: player.location, maxDistance: T.THREAT_RADIUS, families: ["monster"] })
    ) ?? [];
  st.threat = list.some((e) => e.id !== player.id && !!scannable(e, player.id));
}

// ---------------------------------------------------------------------------------------------
// area scan
// ---------------------------------------------------------------------------------------------

/**
 * Why the scanner cannot run now ("" = it can).
 * @param {import("./state.js").SuitState} st
 */
export function scanBlocker(st, tick) {
  const worn = st.worn;
  if (!worn || st.busy) return "§cVista a Mark V para usar o scanner";
  if (!worn.powered) return "§cScanner indisponível §7— sem energia";
  if (worn.visor !== "closed") return "§cFeche o visor para usar o scanner";
  if (!st.hudEnabled) return "§cLigue o HUD no painel para usar o scanner";
  if (!st.hudActive) return "§cHUD indisponível no momento";
  if (tick < st.scanCooldownUntil) return "§7Scanner recarregando...";
  if (st.energy < T.SCAN_COST) return `§cEnergia insuficiente para o scanner §7(${T.SCAN_COST})`;
  return "";
}

/**
 * Fire a scanner pulse: query entities in SCAN_RADIUS, the wave reveals them as it passes.
 * @param {import("@minecraft/server").Player} player
 * @param {import("./state.js").SuitState} st
 * @returns {boolean}
 */
export function startScan(player, st, tick) {
  const why = scanBlocker(st, tick);
  if (why) {
    notify(player, st, why);
    return false;
  }
  if (!spendEnergy(st, T.SCAN_COST)) return false;
  st.scanCooldownUntil = tick + T.SCAN_COOLDOWN;
  const loc = player.location;
  const dim = player.dimension;
  const found = quiet(() => dim.getEntities({ location: loc, maxDistance: T.SCAN_RADIUS })) ?? [];
  /** @type {ScanEntry[]} */
  let entries = [];
  for (const ent of found) {
    const hp = scannable(ent, player.id);
    if (!hp) continue;
    const eloc = quiet(() => ent.location);
    if (!eloc) continue;
    const { cls } = classify(ent, st, tick);
    const size = sizeOf(ent);
    const dist = vdist(loc, eloc);
    entries.push({
      entity: ent,
      id: ent.id,
      typeId: ent.typeId,
      cls,
      name: nameOf(ent),
      height: size.height,
      width: size.width,
      revealAt: tick + revealDelay(dist),
      revealed: false,
      alive: true,
      dist,
      bearing: bearingTo(loc, eloc),
      hp: hp.hp,
    });
  }
  entries.sort(scanOrder);
  if (entries.length > MAX_SCAN_ENTRIES) entries = entries.slice(0, MAX_SCAN_ENTRIES);
  const lastReveal = entries.reduce((m, e) => Math.max(m, e.revealAt), tick);
  /** @type {ScanRuntime} */
  const scan = {
    start: tick,
    sweepUntil: tick + T.SCAN_SWEEP_TICKS,
    until: lastReveal + T.SCAN_MARK_TICKS,
    lastPing: -1,
    entries,
  };
  st.scan = scan;
  const center = { x: loc.x, y: loc.y + 0.15, z: loc.z };
  const vars = molang({ radius: T.SCAN_RADIUS });
  worldParticle(dim, FX.SCAN_WAVE, center, vars);
  worldParticle(dim, FX.SCAN_DOME, { x: loc.x, y: loc.y + 1, z: loc.z }, vars);
  worldSound(dim, SND.SCAN, loc, 1);
  const hostiles = entries.filter((e) => e.cls === "h").length;
  pushAlert(st, hostiles ? "w" : "i", hostiles ? `SCAN: ${hostiles} HOSTIS NO RAIO` : "SCAN: ÁREA LIMPA", 50);
  return true;
}

/** @param {import("./state.js").SuitState} st */
export function clearScan(st) {
  st.scan = undefined;
}

/**
 * Wave reveal + AR marks (only the scanning player sees them).
 * @param {import("@minecraft/server").Player} player
 * @param {import("./state.js").SuitState} st
 */
export function tickScan(player, st, tick) {
  /** @type {ScanRuntime|undefined} */
  const scan = st.scan;
  if (!scan) return;
  if (tick >= scan.until) {
    st.scan = undefined;
    return;
  }
  const loc = player.location;
  for (const e of scan.entries) {
    if (e.revealed || tick < e.revealAt) continue;
    e.revealed = true;
    if (e.cls === "h" && scan.lastPing !== tick) {
      scan.lastPing = tick;
      playerSound(player, SND.SCAN_PING, 0.7, 1 + Math.min(0.4, e.dist / 80));
    }
  }
  if ((tick - scan.start) % MARK_EVERY !== 0) return;
  for (const e of scan.entries) {
    if (!e.revealed || !e.alive) continue;
    if (tick > e.revealAt + T.SCAN_MARK_TICKS) {
      e.alive = false;
      continue;
    }
    const hp = scannable(e.entity, player.id);
    const eloc = hp ? quiet(() => e.entity.location) : undefined;
    if (!hp || !eloc) {
      e.alive = false;
      continue;
    }
    e.dist = vdist(loc, eloc);
    if (e.dist > OUT_OF_RANGE || quiet(() => e.entity.dimension.id) !== quiet(() => player.dimension.id)) {
      e.alive = false;
      continue;
    }
    e.hp = hp.hp;
    e.bearing = bearingTo(loc, eloc);
    if (!st.hudActive) continue; // AR marks are drawn by the visor
    const center = { x: eloc.x, y: eloc.y + Math.max(0.2, (e.height - 0.2) / 2), z: eloc.z };
    playerParticle(player, FX.MARK, center, molang({ size: e.height, width: e.width, color: MARK_COLOR[e.cls] }));
  }
}

/**
 * Scan panel fields.
 * @param {import("./state.js").SuitState} st
 */
export function scanHudFields(st, tick) {
  /** @type {ScanRuntime|undefined} */
  const scan = st.scan;
  if (!scan) return { scan: "0", scan_text: "" };
  const shown = scan.entries.filter((e) => e.revealed && e.alive);
  const counts = { h: 0, n: 0, p: 0, j: 0 };
  for (const e of shown) counts[e.cls]++;
  shown.sort(scanOrder);
  const sweeping = tick < scan.sweepUntil;
  return {
    scan: sweeping ? "2" : "1",
    scan_text: scanText({ radius: T.SCAN_RADIUS, counts, sweeping, entries: shown }),
  };
}
