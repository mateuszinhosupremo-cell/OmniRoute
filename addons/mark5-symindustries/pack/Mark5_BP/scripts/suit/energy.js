// Mark V energy (SPEC 5.1): arc-reactor regen, LED / HUD / lock / flight consumption, the latched
// power-failure state machine (power down -> offline -> reboot), the offline "heavy suit" slowness
// and the energy shield that turns stored energy into absorbed damage.
//
// Persistence (player dynamic properties): sym:mk5_energy (0..ENERGY_MAX), sym:mk5_energy_t
// (world.getAbsoluteTime() of the last save, used to credit regen while the player was away) and
// sym:mk5_offline (latched failure flag). Saved at most once per second.

import { EntityDamageCause, world } from "@minecraft/server";
import { PROP, SND, FX, TUNING as T, POWERDOWN_ID, TRANSITION_TICKS, variantFor } from "./constants.js";
import { alarmLevelFor, alarmStep, computeDrain, energyPct, regenForElapsed, shieldAbsorb, stepEnergy } from "./calc.js";
import { actionbar, chestOf, quiet, worldParticle, worldSound } from "./fx.js";
import { pushAlert, showFailure } from "./hud.js";
import { drainEnergy } from "./state.js";
import { getWornSuit, swapChest } from "./variants.js";
import * as flight from "./flight.js";

const PERSIST_TICKS = 20;
const SLOW_REFRESH = 40;
const SLOW_DURATION = 50;

/** Damage causes the energy shield can absorb (SPEC 5.1). @type {ReadonlySet<string>} */
export const SHIELD_CAUSES = Object.freeze(
  new Set([
    EntityDamageCause.entityAttack,
    EntityDamageCause.projectile,
    EntityDamageCause.entityExplosion,
    EntityDamageCause.blockExplosion,
    EntityDamageCause.fireworks,
    EntityDamageCause.lightning,
    EntityDamageCause.thorns,
    EntityDamageCause.contact,
    EntityDamageCause.flyIntoWall,
    EntityDamageCause.anvil,
    EntityDamageCause.fallingBlock,
    EntityDamageCause.fall,
    EntityDamageCause.maceSmash,
    EntityDamageCause.ramAttack,
    EntityDamageCause.sonicBoom,
    EntityDamageCause.magic,
  ])
);

const absTime = () => Number(quiet(() => world.getAbsoluteTime()) ?? 0);

// ---------------------------------------------------------------------------------------------
// persistence
// ---------------------------------------------------------------------------------------------

/**
 * Load the persistent suit data of a player into its runtime state (once per session) and
 * credit the regen owed for the time spent away (capped).
 * @param {import("@minecraft/server").Player} player
 * @param {import("./state.js").SuitState} st
 */
export function loadPersistent(player, st, tick) {
  st.loaded = true;
  const raw = quiet(() => player.getDynamicProperty(PROP.ENERGY));
  const saved = typeof raw === "number" && Number.isFinite(raw) ? raw : T.ENERGY_MAX;
  const last = quiet(() => player.getDynamicProperty(PROP.ENERGY_T));
  const owed = typeof last === "number" ? regenForElapsed(absTime() - last) : 0;
  st.energy = Math.max(0, Math.min(T.ENERGY_MAX, saved + owed));
  st.offline = quiet(() => player.getDynamicProperty(PROP.OFFLINE)) === true;
  const hud = quiet(() => player.getDynamicProperty(PROP.HUD));
  st.hudEnabled = hud !== false;
  st.lock.armed = quiet(() => player.getDynamicProperty(PROP.LOCK_MODE)) === true;
  st.alarmLevel = alarmLevelFor(energyPct(st.energy));
  st.dirty = true;
  persist(player, st, tick, true);
}

/**
 * Save energy (at most once per second unless forced).
 * @param {import("@minecraft/server").Player} player
 * @param {import("./state.js").SuitState} st
 */
export function persist(player, st, tick, force = false) {
  if (!st.loaded) return;
  if (!force && (!st.dirty || tick - st.lastPersist < PERSIST_TICKS)) return;
  st.lastPersist = tick;
  st.dirty = false;
  quiet(() => {
    player.setDynamicProperty(PROP.ENERGY, Math.round(st.energy * 100) / 100);
    player.setDynamicProperty(PROP.ENERGY_T, absTime());
  });
}

/** @param {import("@minecraft/server").Player} player @param {import("./state.js").SuitState} st */
function saveOffline(player, st) {
  quiet(() => player.setDynamicProperty(PROP.OFFLINE, st.offline ? true : undefined));
}

/**
 * Clear the offline latch if the reactor already recharged past REBOOT_AT (suit not worn).
 * @param {import("@minecraft/server").Player} player
 * @param {import("./state.js").SuitState} st
 */
export function unlatchIfCharged(player, st) {
  if (st.offline && st.energy >= T.REBOOT_AT) {
    st.offline = false;
    saveOffline(player, st);
  }
  return !st.offline;
}

// ---------------------------------------------------------------------------------------------
// per tick
// ---------------------------------------------------------------------------------------------

/**
 * Integrate one tick of energy (every online player, suit worn or not).
 * Requires st.worn / st.busy / st.flight of this tick.
 * @param {import("./state.js").SuitState} st
 */
export function integrate(st) {
  const worn = st.worn;
  st.drain = computeDrain({
    worn: !!worn,
    powered: !!worn?.powered,
    busy: st.busy,
    visor: worn?.visor,
    hudOn: st.hudEnabled,
    lockArmed: st.lock.armed,
    flightMode: st.flight?.mode,
  });
  st.rate = T.REGEN - st.drain.total;
  const before = st.energy;
  st.energy = stepEnergy(st.energy, T.REGEN, st.drain.total, T.ENERGY_MAX);
  if (st.energy !== before) st.dirty = true;
}

/**
 * Power state machine + alarms (after integrate()).
 * @param {import("@minecraft/server").Player} player
 * @param {import("./state.js").SuitState} st
 */
export function tickPower(player, st, tick) {
  const worn = st.worn;
  const pct = energyPct(st.energy);

  // low-energy alarms (only meaningful while the powered suit is on)
  const a = alarmStep(st.alarmLevel, pct);
  st.alarmLevel = a.level;
  if (a.fire && worn?.powered && !st.busy) {
    worldSound(player.dimension, SND.ALARM, player.location, 0.8, 1 + (a.fire - 1) * 0.15);
    if (a.fire === 1) pushAlert(st, "w", `ENERGIA BAIXA — ${pct}%`, 60);
    else pushAlert(st, "c", `ENERGIA CRÍTICA — ${pct}%`, 70);
  }

  if (!worn) {
    unlatchIfCharged(player, st); // recharged in the case / inventory: next suit-up is powered
    return;
  }
  if (st.busy) return;

  if (worn.powered && !st.offline && st.energy <= 0) {
    powerDown(player, st, tick);
    return;
  }
  if (st.offline && st.energy >= T.REBOOT_AT) reboot(player, st, tick);
}

/**
 * Energy ran out: latch offline, LEDs die with a sound, HUD shows the red failure overlay.
 * @param {import("@minecraft/server").Player} player
 * @param {import("./state.js").SuitState} st
 */
export function powerDown(player, st, tick) {
  st.offline = true;
  st.energy = 0;
  st.dirty = true;
  saveOffline(player, st);
  if (st.flight) flight.stop(player, st, { fall: true });
  const worn = st.worn;
  if (worn && !worn.temp) {
    if (worn.visor === "closed") {
      if (swapChest(player, POWERDOWN_ID, { temp: true })) {
        st.transition = { from: POWERDOWN_ID, to: variantFor({ powered: false, visor: "closed" }), at: tick + TRANSITION_TICKS.powerdown, kind: "powerdown" };
      }
    } else {
      swapChest(player, variantFor({ powered: false, visor: "open" }));
    }
  }
  // a temp (visor moving) item resolves to its offline final when its transition ends
  st.worn = getWornSuit(player);
  const loc = player.location;
  worldSound(player.dimension, SND.POWER_DOWN, loc, 1);
  worldParticle(player.dimension, FX.POWER_DOWN, chestOf(loc));
  if (st.hud.on) showFailure(st, tick);
  actionbar(player, "§c§lENERGIA ESGOTADA§r §7— Mark V offline · reinício automático em 15%");
}

/**
 * Enough energy again: unlatch and wear the powered variant of the same visor state (the closed
 * suit's attachable flickers the eyes back on). The HUD boots on its own (rising edge).
 * @param {import("@minecraft/server").Player} player
 * @param {import("./state.js").SuitState} st
 */
export function reboot(player, st, tick) {
  st.offline = false;
  saveOffline(player, st);
  const worn = st.worn;
  if (worn && !worn.temp && !worn.powered) {
    swapChest(player, variantFor({ powered: true, visor: worn.visor }));
    st.worn = getWornSuit(player);
  }
  const loc = player.location;
  worldSound(player.dimension, SND.POWER_UP, loc, 1);
  worldParticle(player.dimension, FX.POWER_UP, chestOf(loc));
  actionbar(player, "§b§lENERGIA RESTAURADA§r §7— sistemas da Mark V reiniciando");
}

/**
 * Heavy offline suit: slowness 0 refreshed while an offline variant is worn; removed (only our
 * own weak, short slowness) when powered again or the suit comes off.
 * @param {import("@minecraft/server").Player} player
 * @param {import("./state.js").SuitState} st
 */
export function tickSlowness(player, st, tick) {
  const heavy = !!st.worn && !st.worn.powered && !st.worn.dying && !st.busy;
  if (heavy) {
    if (!st.slowApplied || (tick + st.phase) % SLOW_REFRESH === 0) {
      quiet(() => player.addEffect("slowness", SLOW_DURATION, { amplifier: 0, showParticles: false }));
      st.slowApplied = true;
    }
  } else if (st.slowApplied) {
    clearSlowness(player, st);
  }
}

/** @param {import("@minecraft/server").Player} player @param {import("./state.js").SuitState} st */
export function clearSlowness(player, st) {
  st.slowApplied = false;
  quiet(() => {
    const e = player.getEffect("slowness");
    if (e && e.amplifier === 0 && e.duration <= SLOW_DURATION) player.removeEffect("slowness");
  });
}

// ---------------------------------------------------------------------------------------------
// energy shield
// ---------------------------------------------------------------------------------------------

/**
 * The energy shield can absorb a hit right now: powered suit worn, not latched offline, not in a
 * cinematic, energy left. Also drives the "ESCUDO ATIVO / OFF" line of the HUD.
 * @param {import("./state.js").SuitState} st
 */
export function shieldReady(st) {
  const worn = st.worn;
  return !!worn && !!worn.powered && !st.busy && !st.offline && st.energy > 0;
}

/**
 * entityHurt on a player wearing the powered suit: absorb part of the hit with energy.
 * @param {import("@minecraft/server").Player} player
 * @param {import("./state.js").SuitState} st
 * @param {number} damage
 * @param {string} cause
 * @returns {number} HP absorbed
 */
export function shieldHit(player, st, damage, cause) {
  if (!shieldReady(st) || !SHIELD_CAUSES.has(cause)) return 0;
  const { absorbed, cost } = shieldAbsorb(damage, st.energy);
  if (absorbed < 0.05) return 0;
  const health = quiet(() => player.getComponent("minecraft:health"));
  if (!health) return 0;
  const cur = Number(quiet(() => health.currentValue) ?? 0);
  if (!(cur > 0)) return 0; // already dead: nothing to save
  const max = Number(quiet(() => health.effectiveMax) ?? 20);
  quiet(() => health.setCurrentValue(Math.min(max, cur + absorbed)));
  drainEnergy(st, cost);
  const loc = player.location;
  worldParticle(player.dimension, FX.SHIELD_HIT, chestOf(loc));
  worldSound(player.dimension, SND.SHIELD, loc, 0.8, 1);
  pushAlert(st, "i", `ESCUDO: -${absorbed.toFixed(1)} ABSORVIDO`, 30, "shield");
  return absorbed;
}
