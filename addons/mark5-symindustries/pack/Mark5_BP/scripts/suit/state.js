// Mark V per-player runtime state (memory only; persistent bits live in dynamic properties).
// Pure module: no "@minecraft/server" import.

import { TUNING } from "./constants.js";

/**
 * @typedef {Object} AlertEntry
 * @property {"i"|"w"|"c"} type
 * @property {string} text
 * @property {number} duration
 * @property {string} [key]
 * @property {number} seq
 * @property {number} [shownAt]
 * @property {number} [until]
 *
 * @typedef {Object} HudRuntime
 * @property {boolean} on            title HUD currently being sent
 * @property {boolean} activePrev    hudActive on the previous tick (boot on rising edge)
 * @property {number} bootStart
 * @property {number} bootUntil
 * @property {boolean} bootAnnounced
 * @property {number} failStart
 * @property {number} failUntil
 * @property {string} lastSent
 * @property {number} lastSentTick
 * @property {AlertEntry[]} alerts
 * @property {number} seq
 *
 * @typedef {Object} LookInfo
 * @property {any} entity
 * @property {string} id
 * @property {string} typeId
 * @property {"h"|"n"|"p"|"j"} cls
 * @property {boolean} provoked
 * @property {string} name
 * @property {number} dist
 * @property {number} hp
 * @property {number} maxHp
 *
 * @typedef {Object} LockRuntime
 * @property {boolean} armed
 * @property {any} [target]
 * @property {string} [targetId]
 * @property {string} [targetName]
 * @property {string} [candId]
 * @property {number} progress
 * @property {number} nextStep
 * @property {number} missTicks
 * @property {number} outOfCone
 * @property {number} lockedAt
 * @property {number} [targetHeight]
 *
 * @typedef {Object} SuitState
 * @property {string} id
 * @property {number} phase           0/1: spreads every-2-tick work across players
 * @property {boolean} loaded
 * @property {number} energy
 * @property {boolean} offline        latched power failure
 * @property {boolean} dirty          energy changed since the last save
 * @property {number} lastPersist
 * @property {number} alarmLevel
 * @property {{reactor:number, arms:number, legs:number, eyes:number, hud:number, lock:number, flight:number, nv:number, total:number}} drain
 * @property {number} rate            net energy per second (regen - drain)
 * @property {boolean} hudEnabled
 * @property {boolean} busy
 * @property {any} worn               getWornSuit() result of this tick
 * @property {boolean} wasWorn
 * @property {boolean} caseHeld   the Maleta Mark V is in the main hand (SPEC 13 readout)
 * @property {boolean} hudActive
 * @property {{from:string, to:string, at:number, kind:string}|undefined} transition
 * @property {boolean} slowApplied
 * @property {number} heat
 * @property {boolean} overheated
 * @property {any} flight             flight runtime (flight.js) or undefined
 * @property {LookInfo|undefined} look        entity under the reticle right now
 * @property {LookInfo|undefined} lookShown   target panel contents (lingers LOOK_KEEP ticks)
 * @property {number} lookUntil
 * @property {{pct:number, frame:number, state:"n"|"w"|"c"}} integrity  worn suit durability
 * @property {{pct:number, critical:boolean, pendingCritical?:boolean}|undefined} integWatch  damage alert watcher
 * @property {boolean} menuOpen
 * @property {string|undefined} lastTargetSoundId
 * @property {number} lastTargetSoundTick
 * @property {boolean} threat
 * @property {Map<string, number>} aggressors  entity id -> tick it last hurt the player
 * @property {any} scan               area scan runtime (scanner.js) or undefined
 * @property {number} scanCooldownUntil
 * @property {LockRuntime} lock
 * @property {HudRuntime} hud
 * @property {{index:number, next:number}|undefined} tips
 * @property {OneShotCost|undefined} oneShot   last one-shot energy cost (visor servos, SPEC 10)
 * @property {NightVision} nv               auto night vision (SPEC 12.1)
 * @property {boolean} visualLatch    creative: do not start the visual flight again until vanilla flight ends
 * @property {number} suitUpRefusedAt tick of the last "not enough energy to suit up" message
 */

/**
 * @typedef {Object} NightVision
 * @property {boolean} loaded   preference read from PROP.NV
 * @property {boolean} auto     feature enabled (menu, default AUTO)
 * @property {boolean} on       our night vision is on (drains NV_DRAIN)
 * @property {boolean} applied  WE added the night_vision effect (only then do we remove it)
 * @property {number} low       consecutive dark samples
 */

/**
 * @typedef {Object} OneShotCost
 * @property {string} key      short HUD label ("visor" -> alert "-1% visor")
 * @property {string} name     diagnostics label ("servos do visor")
 * @property {number} cost     energy spent
 * @property {number} tick
 * @property {boolean} shown   HUD alert already pushed (or expired)
 */

/** @type {Map<string, SuitState>} */
const states = new Map();
let counter = 0;

/** @returns {SuitState} */
export function newState(id) {
  return {
    id,
    phase: counter++ & 1,
    loaded: false,
    energy: TUNING.ENERGY_MAX,
    offline: false,
    dirty: false,
    lastPersist: -1000,
    alarmLevel: 0,
    drain: { reactor: 0, arms: 0, legs: 0, eyes: 0, hud: 0, lock: 0, flight: 0, nv: 0, total: 0 },
    rate: TUNING.REGEN,
    hudEnabled: true,
    busy: false,
    worn: undefined,
    wasWorn: false,
    caseHeld: false,
    hudActive: false,
    transition: undefined,
    slowApplied: false,
    heat: 0,
    overheated: false,
    flight: undefined,
    look: undefined,
    lookShown: undefined,
    lookUntil: 0,
    integrity: { pct: 100, frame: 10, state: "n" },
    integWatch: undefined,
    menuOpen: false,
    lastTargetSoundId: undefined,
    lastTargetSoundTick: -1000,
    threat: false,
    aggressors: new Map(),
    scan: undefined,
    scanCooldownUntil: 0,
    lock: { armed: false, progress: 0, nextStep: 0, missTicks: 0, outOfCone: 0, lockedAt: 0 },
    hud: {
      on: false,
      activePrev: false,
      bootStart: 0,
      bootUntil: 0,
      bootAnnounced: true,
      failStart: 0,
      failUntil: 0,
      lastSent: "",
      lastSentTick: -1000,
      alerts: [],
      seq: 0,
    },
    tips: undefined,
    oneShot: undefined,
    nv: { loaded: false, auto: true, on: false, applied: false, low: 0 },
    visualLatch: false,
    suitUpRefusedAt: -1000,
  };
}

/** State of a player (created on first use). @param {{id: string}} player */
export function getState(player) {
  let st = states.get(player.id);
  if (!st) {
    st = newState(player.id);
    states.set(player.id, st);
  }
  return st;
}

/** State if it exists. @param {string} id */
export function peekState(id) {
  return states.get(id);
}

/** @param {string} id */
export function dropState(id) {
  states.delete(id);
}

export function allStates() {
  return [...states.values()];
}

/** Spend energy if available. @returns {boolean} */
export function spendEnergy(st, amount) {
  if (!(amount > 0)) return true;
  if (st.energy < amount) return false;
  st.energy -= amount;
  st.dirty = true;
  return true;
}

/**
 * Spend a one-shot cost and remember it for the HUD alert / diagnostics.
 * @param {SuitState} st
 * @returns {boolean} false (nothing spent) when the energy is below `cost`
 */
export function spendOneShot(st, key, name, cost, tick) {
  if (!spendEnergy(st, cost)) return false;
  st.oneShot = { key, name, cost, tick, shown: false };
  return true;
}

/** Remove energy (clamped at 0). */
export function drainEnergy(st, amount) {
  if (!(amount > 0)) return;
  st.energy = Math.max(0, st.energy - amount);
  st.dirty = true;
}
