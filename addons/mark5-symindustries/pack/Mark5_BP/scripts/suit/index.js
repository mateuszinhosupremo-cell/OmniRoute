// Mark V suit systems (v2.0): energy, visor HUD, flight, sensors, homing lock-on, control panel.
// main.js keeps the suitcase cinematic and calls initSuitSystems({ beginSuitOff }) once, plus the
// hooks exported here. Players inside a cinematic (dynamic property sym:mk5_state = "suitup" /
// "suitoff") are "busy": nothing runs for them except reactor regen.

import { system, world } from "@minecraft/server";
import { ITEM_SUIT, PROP, SND, TUNING as T, VARIANTS, isSuitId, variantFor, TRANSITION_TICKS } from "./constants.js";
import { compassTape, headingFromYaw } from "./codec.js";
import { costPct, energyFrame, energyPct, energyState, integrityInfo, integrityStep, visorCharge } from "./calc.js";
import { actionbar, quiet, resetFlightAnim, worldSound } from "./fx.js";
import { forceOff, pushAlert, restoreCrosshair, updateHud } from "./hud.js";
import { allStates, dropState, getState, peekState, spendOneShot } from "./state.js";
import { baseSuitFrom, getWornSuit, swapChest } from "./variants.js";
import * as energy from "./energy.js";
import * as flight from "./flight.js";
import * as scanner from "./scanner.js";
import * as targeting from "./targeting.js";
import * as input from "./input.js";
import { openMenu } from "./menu.js";
import { bootText, coordsText, energyText, failureText, oneShotAlert, suitText, systemsText } from "./texts.js";

export { getLockedTarget, isLockArmed, onTargetLocked, onTargetLost } from "./targeting.js";
export { isSuitId };

/** @typedef {import("@minecraft/server").Player} Player */

/** @type {{beginSuitOff: (player: Player) => void}} */
const deps = { beginSuitOff: () => {} };
let initialized = false;
/** @type {Map<string, number>} */
const lastError = new Map();

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

/** Inside the suit-up / suit-off cinematic. @param {Player} player */
export function isBusy(player) {
  const s = quiet(() => player.getDynamicProperty(PROP.STATE));
  return s === "suitup" || s === "suitoff";
}

/** @param {Player} player */
function stateOf(player) {
  const st = getState(player);
  if (!st.loaded) energy.loadPersistent(player, st, system.currentTick);
  return st;
}

/** Final variant a temp item resolves to, honouring the current power latch. */
function resolvedFinal(st, tempId) {
  const info = VARIANTS[tempId];
  const visor = VARIANTS[info?.final ?? ITEM_SUIT]?.visor ?? "closed";
  return variantFor({ powered: !st.offline, visor });
}

/**
 * Transitions and consistency of the worn variant (not for busy players).
 * @param {Player} player
 * @param {import("./state.js").SuitState} st
 */
function syncSuit(player, st, tick) {
  let worn = getWornSuit(player);
  if (!worn) {
    st.transition = undefined;
    return undefined;
  }
  if (st.busy) return worn;
  const tr = st.transition;
  if (tr) {
    if (worn.id !== tr.from) st.transition = undefined; // replaced meanwhile (death, commands...)
    else if (tick >= tr.at) {
      st.transition = undefined;
      swapChest(player, resolvedFinal(st, tr.from));
      worn = getWornSuit(player);
    }
    return worn;
  }
  if (worn.temp) {
    // stray transition item (reload / crash / death): finish it now
    swapChest(player, resolvedFinal(st, worn.id));
    return getWornSuit(player);
  }
  if (worn.powered && st.offline) {
    // a powered item was put on while the reactor is still latched offline
    swapChest(player, variantFor({ powered: false, visor: worn.visor }));
    actionbar(player, `§cMark V sem energia §7— recarregando (${energyPct(st.energy)}%, reinício em 15%)`);
    return getWornSuit(player);
  }
  if (!worn.powered && !worn.dying && !st.offline) {
    st.worn = worn;
    energy.reboot(player, st, tick);
    return getWornSuit(player);
  }
  return worn;
}

/**
 * Integrity watcher (SPEC 8.3): damage alert when the percentage drops, critical once < 25 %.
 * @param {import("./state.js").SuitState} st
 */
function updateIntegrity(st, worn) {
  const dur = quiet(() => worn.item.getComponent("minecraft:durability"));
  st.integrity = dur ? integrityInfo(dur.damage, dur.maxDurability) : integrityInfo(0, 1);
  if (st.busy) {
    st.integWatch = undefined;
    return;
  }
  const r = integrityStep(st.integWatch, st.integrity.pct);
  st.integWatch = r.next;
  if (r.critical) pushAlert(st, "c", `ARMADURA CRÍTICA — RESISTÊNCIA ${st.integrity.pct}%`, 80);
  else if (r.drop >= 1) pushAlert(st, st.integrity.state === "n" ? "i" : "w", `DANO NA ARMADURA -${r.drop}%`, 30, "armor");
}

/** @param {import("./state.js").SuitState} st */
function computeHudActive(st) {
  const w = st.worn;
  return !!w && !st.busy && w.powered && !st.offline && !w.temp && w.visor === "closed" && st.hudEnabled && !st.transition;
}

/**
 * HUD data fields (everything but mode / alert / boot_text).
 * @param {Player} player
 * @param {import("./state.js").SuitState} st
 */
function buildHud(player, st, tick, mode) {
  const pct = energyPct(st.energy);
  const eState = energyState(pct);
  const w = st.worn;
  const loc = player.location;
  const yaw = quiet(() => player.getRotation().y) ?? 0;
  const heading = headingFromYaw(yaw);
  const lit = mode !== "3" && !!w?.powered;
  const led = (on) => (on ? "1" : "0");
  return {
    energy_pct: pct,
    energy_frame: energyFrame(st.energy),
    energy_state: eState,
    energy_text: energyText(pct, eState, st.rate),
    integrity_frame: st.integrity.frame,
    integrity_pct: st.integrity.pct,
    integrity_state: st.integrity.state,
    led_head: led(lit && w?.visor === "closed"),
    led_chest: led(lit),
    led_arms: led(lit),
    led_legs: led(lit),
    threat: st.threat ? "1" : "0",
    compass: compassTape(heading),
    coords_text: coordsText(loc, heading),
    suit_text: suitText({
      powered: !!w?.powered,
      dying: !!w?.dying,
      visor: w?.visor ?? "closed",
      protection: w?.protection ?? 0,
      shield: energy.shieldReady(st),
      energyState: eState,
    }),
    systems_text: systemsText({
      regen: T.REGEN,
      drain: st.drain,
      flightMode: st.flight?.mode,
      lockArmed: st.lock.armed,
      locked: !!st.lock.targetId,
      heat: st.heat,
      overheated: st.overheated,
      shieldPct: w?.powered ? pct : 0,
    }),
    ...flight.flightHudFields(st),
    ...scanner.targetHudFields(st, st.lock.targetId),
    ...scanner.scanHudFields(st, tick),
    ...targeting.lockHudFields(st),
  };
}

/** HUD alert of a one-shot cost shows this long (~1 s). */
const ONE_SHOT_ALERT_TICKS = 20;
/** ...and only if the HUD can show it within this many ticks (visor close + boot ~ 66). */
const ONE_SHOT_KEEP = 100;

/**
 * Push the alert of the last one-shot cost ("-1% visor") once the main HUD is on screen (the
 * visor servos run while the HUD is off: the alert waits for the boot to end).
 * @param {import("./state.js").SuitState} st
 */
function flushOneShot(st, tick) {
  const o = st.oneShot;
  if (!o || o.shown) return;
  if (tick - o.tick > ONE_SHOT_KEEP) {
    o.shown = true;
    return;
  }
  if (!st.hud.on || tick < st.hud.bootUntil || tick < st.hud.failUntil) return;
  o.shown = true;
  pushAlert(st, "i", oneShotAlert(o.key, o.cost), ONE_SHOT_ALERT_TICKS, "oneshot");
}

// ---------------------------------------------------------------------------------------------
// per-player tick
// ---------------------------------------------------------------------------------------------

/** @param {Player} player */
function tickPlayer(player, tick) {
  const st = stateOf(player);
  st.busy = isBusy(player);
  st.worn = syncSuit(player, st, tick);
  const worn = st.worn;
  if (worn) updateIntegrity(st, worn);
  else st.integWatch = undefined;

  energy.integrate(st);
  energy.tickPower(player, st, tick); // may swap the chest item (st.worn refreshed)
  st.hudActive = computeHudActive(st);

  flight.tickHeat(st);
  if (st.flight) flight.tickFlight(player, st, tick);

  if (st.hudActive) {
    scanner.tickLook(player, st, tick);
    scanner.tickThreat(player, st, tick);
  } else if (st.look || st.lookShown || st.threat) {
    scanner.clearLook(st);
    st.threat = false;
  }
  if (st.scan) {
    if (!st.worn || st.busy || !st.worn.powered) scanner.clearScan(st);
    else scanner.tickScan(player, st, tick);
  }
  targeting.tickTargeting(player, st, tick);
  energy.tickSlowness(player, st, tick);

  if (st.worn || st.hud.on || tick < st.hud.failUntil) {
    updateHud(
      player,
      st,
      tick,
      (mode) => buildHud(player, st, tick, mode),
      (elapsed) => bootText(elapsed, { pct: energyPct(st.energy), flightReady: st.energy >= T.FLIGHT_MIN_ENERGY }),
      failureText
    );
    flushOneShot(st, tick); // before the boot announcement: "-1% visor" first, for ~1 s
    if (st.hud.on && !st.hud.bootAnnounced && tick >= st.hud.bootUntil) {
      st.hud.bootAnnounced = true;
      pushAlert(st, "i", `MARK V ONLINE — ENERGIA ${energyPct(st.energy)}%`, 50);
    }
  } else {
    st.hud.activePrev = false;
  }
  input.tickTips(player, st, tick);
  energy.persist(player, st, tick);
  st.wasWorn = !!st.worn;
}

function mainLoop() {
  const tick = system.currentTick;
  for (const player of world.getAllPlayers()) {
    try {
      tickPlayer(player, tick);
    } catch (err) {
      const last = lastError.get(player.id) ?? -1000;
      if (tick - last > 200) {
        lastError.set(player.id, tick);
        console.warn(`[Mark V] ${player.name}: ${err}`);
      }
    }
  }
  if (tick % 200 === 0) {
    for (const st of allStates()) {
      for (const [id, at] of st.aggressors) if (tick - at > T.PROVOKED_TICKS) st.aggressors.delete(id);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// actions (menu, reactor item, gestures)
// ---------------------------------------------------------------------------------------------

/**
 * Open / close the faceplate (SPEC 5.2).
 * @param {Player} player
 */
export function toggleVisor(player) {
  const st = stateOf(player);
  const tick = system.currentTick;
  if (isBusy(player)) return;
  const worn = getWornSuit(player);
  if (!worn) {
    actionbar(player, "§cVista a Mark V primeiro");
    return;
  }
  if (worn.temp || st.transition) {
    actionbar(player, "§7Aguarde o visor terminar o movimento...");
    return;
  }
  const powered = worn.powered && !st.offline;
  // SPEC 10: the servos cost VISOR_COST energy when powered; offline the faceplate moves by hand
  const charge = visorCharge(powered, st.energy);
  if (!charge.ok) {
    actionbar(player, "§cENERGIA INSUFICIENTE PARA OS SERVOS DO VISOR");
    return;
  }
  const opening = worn.visor === "closed";
  if (opening) {
    const temp = variantFor({ powered, visor: "opening" });
    if (!swapChest(player, temp, { temp: true })) return;
    st.transition = { from: temp, to: variantFor({ powered, visor: "open" }), at: tick + TRANSITION_TICKS.visor, kind: "visor" };
    worldSound(player.dimension, SND.HELMET_OPEN, player.location, 1);
    forceOff(player, st, { sound: true });
    restoreCrosshair(player);
    scanner.clearLook(st);
  } else {
    const temp = variantFor({ powered, visor: "closing" });
    if (!swapChest(player, temp, { temp: true })) return;
    st.transition = { from: temp, to: variantFor({ powered, visor: "closed" }), at: tick + TRANSITION_TICKS.visor, kind: "visor" };
    worldSound(player.dimension, SND.HELMET_CLOSE, player.location, 1);
    if (powered && st.hudEnabled) st.hud.activePrev = false; // boot sequence once the visor is shut
  }
  if (charge.manual) {
    actionbar(player, opening ? "§7Abertura manual do visor (sem energia)" : "§7Fechamento manual do visor (sem energia)");
  } else if (spendOneShot(st, "visor", "servos do visor", charge.cost, tick)) {
    actionbar(player, `§7Servos do visor §c-${costPct(charge.cost)}%§7 de energia`);
  }
  st.worn = getWornSuit(player);
}

/** @param {Player} player @param {boolean} on */
function setHud(player, on) {
  const st = stateOf(player);
  st.hudEnabled = on;
  quiet(() => player.setDynamicProperty(PROP.HUD, on ? undefined : false));
  if (!on) {
    forceOff(player, st, { sound: true });
    restoreCrosshair(player);
    actionbar(player, "§7HUD desligado");
  } else {
    st.hud.activePrev = false;
    actionbar(player, "§bHUD ligado");
  }
}

/** @param {Player} player */
function toggleFlight(player) {
  if (isBusy(player)) return;
  const st = stateOf(player);
  st.worn = getWornSuit(player);
  flight.toggle(player, st, system.currentTick);
}

/**
 * Double-tap Jump. In creative the same double-tap toggles vanilla flight, so ours only starts
 * when vanilla did not take it (flight.gestureToggle); survival = plain toggle.
 * @param {Player} player
 */
function gestureFlight(player) {
  if (isBusy(player)) return;
  const st = stateOf(player);
  st.worn = getWornSuit(player);
  flight.gestureToggle(player, st, system.currentTick);
}

/** @param {Player} player */
function areaScan(player) {
  if (isBusy(player)) return;
  scanner.startScan(player, stateOf(player), system.currentTick);
}

/** @param {Player} player */
function suitOffFromMenu(player) {
  const st = stateOf(player);
  const worn = getWornSuit(player);
  if (!worn || isBusy(player)) return;
  if (worn.temp || st.transition) return actionbar(player, "§7Aguarde o visor terminar o movimento...");
  if (st.flight) return actionbar(player, "§cPouse antes de desmontar a armadura");
  if (!player.isOnGround || player.isInWater || player.isFlying || player.isGliding) {
    return actionbar(player, "§cFique parado no chão para desmontar");
  }
  deps.beginSuitOff(player);
}

const menuActions = {
  toggleVisor,
  setHud,
  toggleFlight,
  scan: areaScan,
  setLock: (player, armed) => targeting.setLockArmed(player, stateOf(player), armed),
  suitOff: suitOffFromMenu,
};

/**
 * Arc Reactor item used (main.js): control panel.
 * @param {Player} player
 */
export function openControlPanel(player) {
  if (isBusy(player)) return;
  stateOf(player).worn = getWornSuit(player);
  openMenu(player, menuActions);
}

const gestureActions = {
  canUse: (player) => !isBusy(player) && !!getWornSuit(player),
  toggleFlight: gestureFlight,
  scan: areaScan,
};

// ---------------------------------------------------------------------------------------------
// hooks used by main.js
// ---------------------------------------------------------------------------------------------

/** Any suit variant worn in the chest slot. @param {Player} player */
export function isSuitWorn(player) {
  return !!getWornSuit(player);
}

/**
 * Chest item id to equip at the end of the suit-up: powered closed suit, or the offline one
 * while the reactor is still latched offline.
 * @param {Player} player
 */
export function finalSuitIdForPlayer(player) {
  const st = stateOf(player);
  energy.unlatchIfCharged(player, st);
  return st.offline ? variantFor({ powered: false, visor: "closed" }) : ITEM_SUIT;
}

/**
 * Cinematic finished (camera back): HUD boot + first-time tips.
 * @param {Player} player
 */
export function onSuitUpComplete(player) {
  const st = stateOf(player);
  const tick = system.currentTick;
  st.hud.activePrev = false;
  st.integWatch = undefined;
  if (st.offline) {
    actionbar(player, `§cMark V sem energia §7— recarregando (${energyPct(st.energy)}%, reinício em 15%)`);
    return;
  }
  input.maybeStartTips(player, st, tick);
  if (!st.tips) actionbar(player, "§bReator Arc§7: usar = §fpainel§7 · agachar + usar = §fvisor");
}

/**
 * Called first thing by main.js beginSuitOff: everything off, nothing left behind.
 * @param {Player} player
 */
export function beforeSuitOff(player) {
  const st = stateOf(player);
  if (st.flight) flight.stop(player, st);
  else resetFlightAnim(player); // leave the sym_mk5_flight controller idle for the cinematic
  forceOff(player, st);
  restoreCrosshair(player);
  targeting.dropLock(player, st, "hud", { silent: true });
  scanner.clearScan(st);
  scanner.clearLook(st);
  st.transition = undefined;
  st.tips = undefined;
  st.hud.alerts = [];
  st.hud.activePrev = false;
  if (st.slowApplied) energy.clearSlowness(player, st);
  energy.persist(player, st, system.currentTick, true);
}

/**
 * Safety net for main.js recover(): a transition item worn without a running transition
 * (world reload) becomes its final variant.
 * @param {Player} player
 */
export function recoverWornSuit(player) {
  if (isBusy(player)) return;
  const worn = getWornSuit(player);
  if (!worn?.temp) return;
  const st = stateOf(player);
  if (st.transition && st.transition.from === worn.id) return; // still animating
  st.transition = undefined;
  swapChest(player, resolvedFinal(st, worn.id));
}

/**
 * Plain `sym:mark_5` replacement for a suit variant stack that is not worn (inventory leftovers,
 * dropped items). undefined when no replacement is needed.
 * @param {import("@minecraft/server").ItemStack|undefined} stack
 */
export function baseSuitItemFor(stack) {
  if (!stack || !isSuitId(stack.typeId) || stack.typeId === ITEM_SUIT) return undefined;
  return baseSuitFrom(stack);
}

// ---------------------------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------------------------

/**
 * Subscribe everything and start the main loop (call once from main.js).
 * @param {{beginSuitOff: (player: Player) => void}} options
 */
export function initSuitSystems(options) {
  if (initialized) return;
  initialized = true;
  if (options?.beginSuitOff) deps.beginSuitOff = options.beginSuitOff;

  world.afterEvents.playerButtonInput.subscribe((ev) => {
    try {
      input.handleButton(ev, system.currentTick, gestureActions);
    } catch (err) {
      console.warn(`[Mark V] input: ${err}`);
    }
  });

  world.afterEvents.entityHurt.subscribe(
    (ev) => {
      try {
        const hurt = ev.hurtEntity;
        if (hurt?.typeId !== "minecraft:player") return;
        const player = /** @type {Player} */ (hurt);
        const st = peekState(player.id);
        if (!st?.loaded) return;
        const src = ev.damageSource;
        const attacker = src?.damagingEntity;
        if (attacker && attacker.id !== player.id) st.aggressors.set(attacker.id, system.currentTick);
        energy.shieldHit(player, st, ev.damage, src?.cause);
      } catch (err) {
        console.warn(`[Mark V] shield: ${err}`);
      }
    },
    { entityTypes: ["minecraft:player"] }
  );

  world.afterEvents.entityDie.subscribe(
    (ev) => {
      try {
        const dead = ev.deadEntity;
        if (dead?.typeId !== "minecraft:player") return;
        const player = /** @type {Player} */ (dead);
        const st = peekState(player.id);
        if (!st) return;
        flight.abort(st);
        targeting.dropLock(player, st, "pilot", { silent: true });
        scanner.clearScan(st);
        scanner.clearLook(st);
        st.transition = undefined;
        forceOff(player, st);
        st.hud.alerts = [];
        st.hud.activePrev = false;
        st.slowApplied = false;
        st.heat = 0;
        st.overheated = false;
        st.threat = false;
        st.integWatch = undefined;
        st.aggressors.clear();
        energy.persist(player, st, system.currentTick, true);
      } catch (err) {
        console.warn(`[Mark V] death: ${err}`);
      }
    },
    { entityTypes: ["minecraft:player"] }
  );

  // save while the player object is still valid
  world.beforeEvents.playerLeave.subscribe((ev) => {
    try {
      const st = peekState(ev.player.id);
      if (st) energy.persist(ev.player, st, system.currentTick, true);
    } catch {
      // the 1 s periodic save already has (almost) everything
    }
  });

  world.afterEvents.playerLeave.subscribe((ev) => {
    try {
      const st = peekState(ev.playerId);
      if (st) targeting.dropLock(undefined, st, "left", { silent: true });
    } catch (err) {
      console.warn(`[Mark V] leave: ${err}`);
    }
    dropState(ev.playerId);
    input.forgetInput(ev.playerId);
    lastError.delete(ev.playerId);
  });

  system.afterEvents.scriptEventReceive.subscribe(
    (ev) => {
      try {
        targeting.handleLockQuery(ev);
      } catch (err) {
        console.warn(`[Mark V] lock query: ${err}`);
      }
    },
    { namespaces: ["sym"] }
  );

  system.runInterval(mainLoop, 1);
}
