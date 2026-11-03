// Mark V homing lock-on ("Mira teleguiada", SPEC 5.7) — the targeting half of future missiles.
//
// PUBLIC API (re-exported by ./index.js)
//   import { getLockedTarget, onTargetLocked, onTargetLost, isLockArmed } from "./suit/index.js";
//   getLockedTarget(player)  -> Entity | undefined   the valid, currently locked entity
//   isLockArmed(player)      -> boolean              homing reticle armed in the control panel
//   onTargetLocked(cb)       -> () => void           cb({ player, target })   (returns unsubscribe)
//   onTargetLost(cb)         -> () => void           cb({ player, targetId, reason })
//        reason: "dead" | "range" | "cone" | "switch" | "disarmed" | "hud" | "pilot" (pilot died)
//                | "left" (pilot left the world)
//
// SCRIPT EVENTS (for other add-ons; messages are JSON strings)
//   sym:mk5_target_locked   {"player": "<player id>", "target": "<entity id>"}
//   sym:mk5_target_lost     {"player": "<player id>", "target": "<entity id>", "reason": "..."}
//   sym:mk5_lock_query      ask for the lock state of a player: run `/scriptevent sym:mk5_lock_query`
//                           as/at the player (sourceEntity = player) or send
//                           system.sendScriptEvent("sym:mk5_lock_query", '{"player":"<id or name>"}')
//   sym:mk5_lock_info       reply: {"player","armed","locked","target","targetType","progress",
//                           "location": {x,y,z} | null}
//   Player dynamic property sym:mk5_lock_target = id of the locked entity while locked.
//
// Rules: while armed and the HUD is on, the entity under the reticle gains one lock step every
// 3 ticks (5 steps = LOCKED, costs LOCK_ACQUIRE_COST energy). A lock is kept while the target is
// alive, within LOCK_RANGE blocks and inside a 30 degree cone of the view (40 ticks of grace
// outside it). Another entity must stay under the reticle for the full lock time to switch.

import { system, world } from "@minecraft/server";
import { FX, PROP, SCRIPT_EVENT, SND, TUNING as T } from "./constants.js";
import { inCone, lockStep, reticleCode, vdist } from "./calc.js";
import { molang, playerParticle, playerSound, quiet } from "./fx.js";
import { notify, pushAlert } from "./hud.js";
import { scannable, sizeOf } from "./scanner.js";
import { peekState, spendEnergy } from "./state.js";
import { shortName } from "./mobs.js";

/** @typedef {{player: import("@minecraft/server").Player, target: import("@minecraft/server").Entity}} LockedEvent */
/** @typedef {{player: import("@minecraft/server").Player|undefined, targetId: string, reason: string}} LostEvent */

/** @type {Set<(ev: LockedEvent) => void>} */
const lockedCallbacks = new Set();
/** @type {Set<(ev: LostEvent) => void>} */
const lostCallbacks = new Set();

/** @param {(ev: LockedEvent) => void} cb @returns {() => void} unsubscribe */
export function onTargetLocked(cb) {
  lockedCallbacks.add(cb);
  return () => lockedCallbacks.delete(cb);
}

/** @param {(ev: LostEvent) => void} cb @returns {() => void} unsubscribe */
export function onTargetLost(cb) {
  lostCallbacks.add(cb);
  return () => lostCallbacks.delete(cb);
}

function emit(set, ev) {
  for (const cb of [...set]) {
    try {
      cb(ev);
    } catch (err) {
      console.warn(`[Mark V] lock callback: ${err}`);
    }
  }
}

function scriptEvent(id, payload) {
  quiet(() => system.sendScriptEvent(id, JSON.stringify(payload)));
}

/** @param {import("@minecraft/server").Player} player */
export function isLockArmed(player) {
  const st = peekState(player.id);
  if (st?.loaded) return st.lock.armed;
  return quiet(() => player.getDynamicProperty(PROP.LOCK_MODE)) === true;
}

/**
 * The entity currently locked by `player`, if it is still valid.
 * @param {import("@minecraft/server").Player} player
 * @returns {import("@minecraft/server").Entity|undefined}
 */
export function getLockedTarget(player) {
  const t = peekState(player.id)?.lock.target;
  return t && quiet(() => t.isValid) ? t : undefined;
}

/** @param {import("./state.js").LockRuntime} l */
function resetCandidate(l) {
  l.candId = undefined;
  l.progress = 0;
  l.missTicks = 0;
}

/**
 * Release the current lock (if any): sound, property cleared, script event + callbacks.
 * @param {import("@minecraft/server").Player|undefined} player
 * @param {import("./state.js").SuitState} st
 * @param {string} reason
 * @param {{silent?: boolean, keepCandidate?: boolean}} [opts]
 */
export function dropLock(player, st, reason, opts = {}) {
  const l = st.lock;
  if (!opts.keepCandidate) resetCandidate(l);
  const targetId = l.targetId;
  if (!targetId) return;
  l.target = undefined;
  l.targetId = undefined;
  l.targetName = undefined;
  l.outOfCone = 0;
  const valid = !!player && !!quiet(() => player.isValid);
  if (valid) {
    quiet(() => player.setDynamicProperty(PROP.LOCK_TARGET, undefined));
    if (!opts.silent) {
      playerSound(player, SND.LOCK_LOST, 0.8);
      if (reason !== "disarmed" && reason !== "hud") pushAlert(st, "w", "ALVO PERDIDO", 30);
    }
  }
  scriptEvent(SCRIPT_EVENT.LOST, { player: st.id, target: targetId, reason });
  emit(lostCallbacks, { player: valid ? player : undefined, targetId, reason });
}

/**
 * Arm / disarm the homing reticle (persisted).
 * @param {import("@minecraft/server").Player} player
 * @param {import("./state.js").SuitState} st
 * @param {boolean} armed
 */
export function setLockArmed(player, st, armed) {
  st.lock.armed = armed;
  quiet(() => player.setDynamicProperty(PROP.LOCK_MODE, armed ? true : undefined));
  if (!armed) dropLock(player, st, "disarmed");
  resetCandidate(st.lock);
  notify(player, st, armed ? "§c§lMIRA TELEGUIADA ARMADA§r §7— mire em um alvo para travar" : "§7Mira teleguiada desarmada", {
    type: armed ? "w" : "i",
  });
}

/**
 * @param {import("@minecraft/server").Player} player
 * @param {import("./state.js").SuitState} st
 * @param {import("./state.js").LookInfo} look
 */
function lockOn(player, st, look, tick) {
  const l = st.lock;
  if (!spendEnergy(st, T.LOCK_ACQUIRE_COST)) {
    resetCandidate(l);
    notify(player, st, "§cEnergia insuficiente para travar o alvo");
    return;
  }
  if (l.targetId) dropLock(player, st, "switch", { silent: true, keepCandidate: true });
  resetCandidate(l);
  l.target = look.entity;
  l.targetId = look.id;
  l.targetName = look.name;
  l.targetHeight = sizeOf(look.entity).height;
  l.outOfCone = 0;
  l.lockedAt = tick;
  quiet(() => player.setDynamicProperty(PROP.LOCK_TARGET, look.id));
  playerSound(player, SND.LOCK_ON, 0.9);
  pushAlert(st, "i", `ALVO TRAVADO: ${shortName(look.name, 18)}`, 50);
  scriptEvent(SCRIPT_EVENT.LOCKED, { player: player.id, target: look.id });
  emit(lockedCallbacks, { player, target: look.entity });
}

/** Center of a locked entity (feet + half its bracket height). */
function centerOf(entity, height) {
  const loc = entity.location;
  return { x: loc.x, y: loc.y + Math.max(0.3, ((height ?? 1.8) - 0.2) / 2), z: loc.z };
}

/**
 * One targeting tick (after the look-at analysis of this tick).
 * @param {import("@minecraft/server").Player} player
 * @param {import("./state.js").SuitState} st
 */
export function tickTargeting(player, st, tick) {
  const l = st.lock;
  if (!l.armed || !st.hudActive) {
    if (l.targetId) dropLock(player, st, l.armed ? "hud" : "disarmed");
    else resetCandidate(l);
    return;
  }

  // keep / lose the current lock
  if (l.targetId) {
    const t = l.target;
    const alive = !!t && !!scannable(t, player.id);
    if (!alive) {
      dropLock(player, st, "dead", { keepCandidate: true });
    } else {
      const eye = player.getHeadLocation();
      const center = centerOf(t, l.targetHeight);
      const sameDim = quiet(() => t.dimension.id) === quiet(() => player.dimension.id);
      if (!sameDim || vdist(eye, center) > T.LOCK_RANGE) {
        dropLock(player, st, "range", { keepCandidate: true });
      } else {
        const view = quiet(() => player.getViewDirection());
        l.outOfCone = view && inCone(eye, view, center, T.LOCK_CONE_DEG) ? 0 : l.outOfCone + 1;
        if (l.outOfCone > T.LOCK_CONE_GRACE) dropLock(player, st, "cone", { keepCandidate: true });
        else if ((tick - l.lockedAt) % 4 === 0) {
          playerParticle(player, FX.LOCK, center, molang({ size: l.targetHeight ?? 1.8 }));
        }
      }
    }
  }

  // acquisition / switching
  const look = st.look;
  const r = lockStep(l, look?.id, l.targetId, tick);
  l.candId = r.candId;
  l.progress = r.progress;
  l.nextStep = r.nextStep;
  l.missTicks = r.missTicks;
  if (r.stepped && !r.locked) playerSound(player, SND.LOCK_TICK, 0.7, 1 + r.progress * 0.1);
  if (r.locked && look && look.id === r.candId) lockOn(player, st, look, tick);
}

/**
 * HUD fields of the reticle / lock ring.
 * @param {import("./state.js").SuitState} st
 */
export function lockHudFields(st) {
  const l = st.lock;
  const acquiring = l.armed && l.progress > 0;
  const locked = l.armed && !!l.targetId;
  const frame = acquiring ? l.progress : locked ? T.LOCK_STEPS : 0;
  return {
    lock_mode: l.armed ? "1" : "0",
    lock_frame: String(Math.max(0, Math.min(T.LOCK_STEPS, frame))),
    reticle: reticleCode(locked, acquiring, st.look?.cls),
  };
}

/**
 * system.afterEvents.scriptEventReceive handler for sym:mk5_lock_query.
 * @param {import("@minecraft/server").ScriptEventCommandMessageAfterEvent} ev
 */
export function handleLockQuery(ev) {
  if (ev.id !== SCRIPT_EVENT.QUERY) return;
  /** @type {import("@minecraft/server").Player|undefined} */
  let player;
  const src = ev.sourceEntity;
  if (src && src.typeId === "minecraft:player") player = /** @type {import("@minecraft/server").Player} */ (src);
  if (!player && ev.message) {
    let key = ev.message.trim();
    try {
      const m = JSON.parse(key);
      if (m && typeof m.player === "string") key = m.player;
    } catch {
      // plain id or name
    }
    player = world.getAllPlayers().find((p) => p.id === key || p.name === key);
  }
  if (!player) return;
  const st = peekState(player.id);
  const target = getLockedTarget(player);
  const loc = target ? quiet(() => target.location) : undefined;
  scriptEvent(SCRIPT_EVENT.INFO, {
    player: player.id,
    armed: isLockArmed(player),
    locked: !!target,
    target: target ? target.id : null,
    targetType: target ? target.typeId : null,
    progress: st ? st.lock.progress : 0,
    location: loc ? { x: Math.round(loc.x * 100) / 100, y: Math.round(loc.y * 100) / 100, z: Math.round(loc.z * 100) / 100 } : null,
  });
}
