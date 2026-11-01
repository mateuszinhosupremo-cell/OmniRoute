// Mark V energy + flight math — pure functions (no "@minecraft/server"), unit-tested with node.

import { TUNING } from "./constants.js";

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ---------------------------------------------------------------------------------------------
// vectors (plain {x, y, z})
// ---------------------------------------------------------------------------------------------

export const vec = (x = 0, y = 0, z = 0) => ({ x, y, z });
export const vadd = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const vsub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const vscale = (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const vlen = (a) => Math.hypot(a.x, a.y, a.z);
export const vdot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
export function vnorm(a, fallback = { x: 0, y: -1, z: 0 }) {
  const l = vlen(a);
  return l < 1e-6 ? { ...fallback } : vscale(a, 1 / l);
}
export const vdist = (a, b) => vlen(vsub(a, b));

/** Horizontal forward unit vector from a yaw (Minecraft: yaw 0 looks to +Z). */
export function flatForward(yawDeg) {
  const r = (yawDeg * Math.PI) / 180;
  return { x: -Math.sin(r), y: 0, z: Math.cos(r) };
}

/** Horizontal LEFT vector of a forward vector (InputInfo movement x = +1 is left). */
export function leftOf(f) {
  return { x: f.z, y: 0, z: -f.x };
}

/** Angle in degrees between two directions. */
export function angleBetween(a, b) {
  const la = vlen(a);
  const lb = vlen(b);
  if (la < 1e-6 || lb < 1e-6) return 180;
  return (Math.acos(clamp(vdot(a, b) / (la * lb), -1, 1)) * 180) / Math.PI;
}

// ---------------------------------------------------------------------------------------------
// energy
// ---------------------------------------------------------------------------------------------

/**
 * Per-second consumption breakdown (SPEC 5.1).
 * @param {{worn?: boolean, powered?: boolean, busy?: boolean, visor?: string, hudOn?: boolean,
 *   lockArmed?: boolean, flightMode?: string, nvOn?: boolean}} s  nvOn: our night vision is on (SPEC 12.1)
 */
export function computeDrain(s, T = TUNING) {
  const b = { reactor: 0, arms: 0, legs: 0, eyes: 0, hud: 0, lock: 0, flight: 0, nv: 0, total: 0 };
  if (s.worn && s.powered && !s.busy) {
    b.reactor = T.LED_REACTOR;
    b.arms = T.LED_ARMS;
    b.legs = T.LED_LEGS;
    if (s.visor === "closed") b.eyes = T.LED_EYES;
    if (s.hudOn && s.visor === "closed") b.hud = T.HUD_DRAIN;
    if (s.lockArmed) b.lock = T.LOCK_DRAIN;
    b.flight = flightDrain(s.flightMode, T);
    if (s.nvOn) b.nv = T.NV_DRAIN;
  }
  b.total = b.reactor + b.arms + b.legs + b.eyes + b.hud + b.lock + b.flight + b.nv;
  return b;
}

/** Flight consumption per second for a flight mode (undefined = not flying). */
export function flightDrain(mode, T = TUNING) {
  switch (mode) {
    case "hover":
      return T.FLIGHT_HOVER;
    case "cruise":
      return T.FLIGHT_CRUISE;
    case "boost":
      return T.FLIGHT_BOOST;
    case "emergency":
      return T.FLIGHT_EMERGENCY;
    default:
      return 0;
  }
}

// ---------------------------------------------------------------------------------------------
// auto night vision (SPEC 12.1)
// ---------------------------------------------------------------------------------------------

const smooth = (t) => {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
};

/**
 * Sky brightness factor for a time of day (0..23999, 0 = sunrise): 1 by day, NV_NIGHT_FACTOR at
 * night, smooth through dusk (12000 -> 13800) and dawn (22200 -> 24000).
 */
export function nvDayFactor(timeOfDay, T = TUNING) {
  const t = ((Number(timeOfDay) % 24000) + 24000) % 24000;
  if (!Number.isFinite(t)) return 1;
  const night = T.NV_NIGHT_FACTOR;
  if (t < 12000) return 1;
  if (t < 13800) return 1 - (1 - night) * smooth((t - 12000) / 1800);
  if (t < 22200) return night;
  return night + (1 - night) * smooth((t - 22200) / 1800);
}

/**
 * Light the pilot effectively sees: block light when it beats the sky light, otherwise the sky
 * light dimmed by the time of day. Dimensions without a day cycle use the total light only.
 * @param {{total: number, sky: number, dayFactor: number, hasSky?: boolean}} s
 */
export function nvEffectiveLight(s) {
  const total = Number(s.total) || 0;
  if (s.hasSky === false) return total;
  const sky = Number(s.sky) || 0;
  return Math.max(total > sky ? total : 0, sky * s.dayFactor);
}

/**
 * Hysteresis of the auto night vision: on after NV_ON_SAMPLES dark samples (<= NV_ON_LEVEL),
 * off at NV_OFF_LEVEL or brighter.
 * @param {{on: boolean, low: number}} prev
 * @param {number} effective
 * @returns {{on: boolean, low: number}}
 */
export function nvStep(prev, effective, T = TUNING) {
  const low = effective <= T.NV_ON_LEVEL ? prev.low + 1 : 0;
  if (prev.on) return { on: effective < T.NV_OFF_LEVEL, low };
  return { on: low >= T.NV_ON_SAMPLES, low };
}

/**
 * Flight mode of the creative "visual" flight from the real velocity (blocks/tick, SPEC 12.3).
 * @param {{x:number,y:number,z:number}} v
 * @param {boolean} sprint
 * @param {boolean} [overheated]
 */
export function visualFlightMode(v, sprint, overheated = false) {
  const h = Math.hypot(v?.x ?? 0, v?.z ?? 0);
  if (h < 0.06) return "hover";
  return sprint && !overheated ? "boost" : "cruise";
}

/** One tick of energy integration: energy += (regen - drain) / 20, clamped. */
export function stepEnergy(energy, regen, drain, max) {
  return clamp(energy + (regen - drain) / 20, 0, max);
}

/** Regen owed for `ticks` spent away (negative ignored, capped). */
export function regenForElapsed(ticks, T = TUNING) {
  const t = Number(ticks);
  if (!Number.isFinite(t) || t <= 0) return 0;
  return (T.REGEN * Math.min(t, T.OFFLINE_REGEN_CAP_TICKS)) / 20;
}

/** @param {number} energy @param {number} [max] */
export function energyPct(energy, max = TUNING.ENERGY_MAX) {
  return Math.round(clamp(energy / max, 0, 1) * 100);
}

/** Gauge frame 0..frames; any energy above 0 shows at least frame 1. */
export function energyFrame(energy, max = TUNING.ENERGY_MAX, frames = 20) {
  if (!(energy > 0)) return 0;
  return clamp(Math.round((energy / max) * frames), 1, frames);
}

/** "n" normal, "w" low (< 25 %), "c" critical (<= 10 %). */
export function energyState(pct) {
  if (pct <= 10) return "c";
  if (pct < 25) return "w";
  return "n";
}

export const ALARM_LEVELS = Object.freeze([25, 10, 5]);

/**
 * Low-energy alarm state machine. level 0 = above 25 %, 1 = <= 25 %, 2 = <= 10 %, 3 = <= 5 %.
 * A level fires once when reached going down; it re-arms 2 % above its threshold.
 * @returns {{level: number, fire: number}} fire = level that just fired (0 = none)
 */
export function alarmStep(prevLevel, pct) {
  let level = 0;
  ALARM_LEVELS.forEach((thr, i) => {
    if (pct <= thr) level = i + 1;
  });
  if (level > prevLevel) return { level, fire: level };
  // hysteresis: only climb back up once clearly above the threshold
  let keep = prevLevel;
  while (keep > level && pct >= ALARM_LEVELS[keep - 1] + 2) keep--;
  return { level: keep, fire: 0 };
}

/** Initial alarm level for a percentage (no alarm fired). */
export function alarmLevelFor(pct) {
  return alarmStep(0, pct).level;
}

/** "2m05s" / "45s" / "1h12m" */
export function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s >= 3600) return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
  return `${s}s`;
}

/** "+2.0/s" / "-14.6/s" */
export function formatRate(perSecond) {
  const v = Math.round(perSecond * 10) / 10;
  return `${v >= 0 ? "+" : "-"}${Math.abs(v).toFixed(1)}/s`;
}

/** HP absorbed by the energy shield for one hit and its energy cost. */
export function shieldAbsorb(damage, energy, T = TUNING) {
  const dmg = Math.max(0, Number(damage) || 0);
  const absorbed = Math.max(0, Math.min(dmg * T.SHIELD_FRACTION, energy / T.SHIELD_COST_PER_HP));
  return { absorbed, cost: absorbed * T.SHIELD_COST_PER_HP };
}

/**
 * Visor servo charge (SPEC 10): powered = VISOR_COST energy per open / close, refused below it;
 * offline (latched / unpowered set) = manual, free.
 * @returns {{ok: boolean, cost: number, manual: boolean}}
 */
export function visorCharge(powered, energy, T = TUNING) {
  if (!powered) return { ok: true, cost: 0, manual: true };
  return { ok: energy >= T.VISOR_COST, cost: T.VISOR_COST, manual: false };
}

/** A one-shot cost as a whole battery percentage (at least 1): VISOR_COST 10 -> 1. */
/** @param {number} cost @param {number} [max] */
export function costPct(cost, max = TUNING.ENERGY_MAX) {
  return Math.max(1, Math.round((Math.max(0, cost) / max) * 100));
}

// ---------------------------------------------------------------------------------------------
// flight
// ---------------------------------------------------------------------------------------------

export const FLIGHT_NAMES = Object.freeze({
  hover: "PAIRANDO",
  cruise: "CRUZEIRO",
  boost: "TURBO",
  emergency: "EMERGÊNCIA",
});

/** HUD "flight" field per mode. */
export const FLIGHT_CODE = Object.freeze({ hover: "h", cruise: "f", boost: "b", emergency: "e" });

/**
 * Flight mode from the player input.
 * @param {{move: {x:number,y:number}, sprint?: boolean, boostLatch?: boolean,
 *   overheated?: boolean, emergency?: boolean}} p
 */
export function flightMode(p) {
  if (p.emergency) return "emergency";
  const moving = Math.hypot(p.move.x, p.move.y) > 0.2;
  if (p.move.y > 0.5 && (p.sprint || p.boostLatch) && !p.overheated) return "boost";
  return moving ? "cruise" : "hover";
}

/** Acceleration factor (fraction of the gap closed per tick) per mode. */
export function flightAccel(mode, T = TUNING) {
  if (mode === "boost") return T.ACCEL_BOOST;
  if (mode === "cruise") return T.ACCEL_CRUISE;
  if (mode === "emergency") return 1;
  return T.ACCEL_HOVER;
}

/**
 * Target velocity (blocks/tick) for this tick.
 * @param {{mode: string, move: {x:number,y:number}, up?: boolean, down?: boolean,
 *   view: {x:number,y:number,z:number}, yaw: number, icing?: boolean,
 *   v: {x:number,y:number,z:number}, y: number, holdY?: number, tick?: number}} p
 */
export function flightTarget(p, T = TUNING) {
  if (p.mode === "emergency") return { x: p.v.x * 0.9, y: -0.25, z: p.v.z * 0.9 };
  const k = p.icing ? T.ICING_FACTOR : 1;
  const f = flatForward(p.yaw);
  const left = leftOf(f);
  const view = vnorm(p.view, f);
  let t = vec();
  if (p.mode === "boost") {
    t = vadd(vscale(view, T.BOOST_SPEED * k), vscale(left, p.move.x * T.STRAFE_SPEED * 0.5 * k));
  } else if (p.mode === "cruise") {
    // forward follows the 3D view (look up to climb); backwards stays level
    const fwd = p.move.y >= 0 ? vscale(view, p.move.y * T.CRUISE_SPEED * k) : vscale(f, p.move.y * T.CRUISE_SPEED * 0.6 * k);
    t = vadd(fwd, vscale(left, p.move.x * T.STRAFE_SPEED * k));
  }
  if (p.up) t.y += T.VERT_UP * k;
  if (p.down) t.y -= T.VERT_DOWN;
  if (p.mode === "hover" && !p.up && !p.down) {
    // altitude hold + gentle bob
    const hold = p.holdY === undefined ? 0 : clamp((p.holdY - p.y) * 0.15, -0.08, 0.08);
    t.y = hold + Math.sin((p.tick ?? 0) * 0.16) * 0.01;
  }
  t.y = clamp(t.y, -1.6, 1.6);
  return t;
}

/** v += (target - v) * accel */
export function approach(v, target, accel) {
  return {
    x: v.x + (target.x - v.x) * accel,
    y: v.y + (target.y - v.y) * accel,
    z: v.z + (target.z - v.z) * accel,
  };
}

/** Thruster heat after one tick (0..100). */
export function heatStep(heat, s, T = TUNING) {
  let h = heat;
  if (s.flying && s.mode === "boost") h += T.HEAT_UP / 20;
  else if (s.flying) h -= T.HEAT_DOWN / 20;
  else h -= T.HEAT_DOWN_GROUND / 20;
  return clamp(h, 0, 100);
}

/** Overheat latch: on at 100, off again under HEAT_RESUME. */
export function overheatStep(overheated, heat, T = TUNING) {
  if (heat >= 100) return true;
  if (overheated && heat < T.HEAT_RESUME) return false;
  return overheated;
}

/** Thrust level 0..1 shown on the HUD and used for the flame size. */
export function thrustLevel(mode, speed, up, T = TUNING) {
  switch (mode) {
    case "boost":
      return clamp(0.85 + (speed / T.BOOST_SPEED) * 0.15, 0, 1);
    case "cruise":
      return clamp(0.45 + (speed / T.CRUISE_SPEED) * 0.3 + (up ? 0.1 : 0), 0, 1);
    case "emergency":
      return 0.15;
    case "hover":
      return up ? 0.6 : 0.35;
    default:
      return 0;
  }
}

/** Pivot of the flight poses (root rotation of mk5_fly / mk5_boost), above the feet. */
export const POSE_PIVOT_Y = 0.88;

/**
 * Forward lean of the body in degrees, matching the player animations (SPEC 9):
 * hover = upright, cruise (mk5_fly) = clamp(30 + pitch*0.3, 20, 45),
 * boost (mk5_boost) = clamp(90 + pitch, 20, 160) (90 = lying horizontal, like vanilla swim).
 */
export function bodyLean(mode, pitch) {
  const p = Number(pitch) || 0;
  if (mode === "cruise") return clamp(30 + p * 0.3, 20, 45);
  if (mode === "boost") return clamp(90 + p, 20, 160);
  return 0;
}

/** Body long axis (feet -> head, unit) for the flight pose. */
export function bodyAxis(mode, pitch, yaw) {
  const r = (bodyLean(mode, pitch) * Math.PI) / 180;
  const f = flatForward(yaw);
  return { x: f.x * Math.sin(r), y: Math.cos(r), z: f.z * Math.sin(r) };
}

/** Direction the chest faces (unit, perpendicular to the body axis): forward, tilting down. */
export function bodyFront(mode, pitch, yaw) {
  const r = (bodyLean(mode, pitch) * Math.PI) / 180;
  const f = flatForward(yaw);
  return { x: f.x * Math.cos(r), y: -Math.sin(r), z: f.z * Math.cos(r) };
}

const deg2rad = (d) => (d * Math.PI) / 180;
/** Hover: palms hang 24 degrees out to the sides (mk5_hover arms z = +-24). */
export const HOVER_PALM_SPLAY = 24;
/** Cruise: arms point 30 degrees behind the body axis (mk5_fly arms x = 30). */
export const FLY_ARM_BACK = 30;

/**
 * Approximate world positions of the 4 thrusters and the direction of their flames, following the
 * flight pose (SPEC 9): the flames leave the palms / boots along the limbs.
 * - hover: palms at y+0.65, +-0.58 sideways, 0.1 forward, flames down and 24 deg outward;
 *   boots at the feet +-0.11, flames down.
 * - cruise: palms at centre - axis*0.2 +- side*0.37, flames back-down (arm 30 deg behind the axis);
 *   boots at centre - axis*0.88 +- 0.11, flames back along the axis.
 * - boost: palms at centre - axis*0.15 +- side*0.33, boots at centre - axis*0.88 +- 0.11, all
 *   flames straight back along the axis.
 * (centre = pose pivot, loc + y 0.88; emergency / takeoff use the hover pose.)
 * @returns {{bootL: any, bootR: any, palmL: any, palmR: any, axis: any,
 *   bootDir: any, palmDirL: any, palmDirR: any}}
 */
export function nozzles(loc, yaw, pitch, mode) {
  const f = flatForward(yaw);
  const left = leftOf(f);
  const axis = bodyAxis(mode, pitch, yaw);
  const back = vscale(axis, -1);
  if (mode === "cruise" || mode === "boost") {
    const center = vadd(loc, vec(0, POSE_PIVOT_Y, 0));
    const feet = vsub(center, vscale(axis, 0.88));
    const fly = mode === "cruise";
    const hands = vsub(center, vscale(axis, fly ? 0.2 : 0.15));
    const side = fly ? 0.37 : 0.33;
    let palmDir = back;
    if (fly) {
      // arm = -axis turned FLY_ARM_BACK degrees towards the back of the body
      const a = deg2rad(FLY_ARM_BACK);
      const front = bodyFront(mode, pitch, yaw);
      palmDir = vnorm(vsub(vscale(back, Math.cos(a)), vscale(front, Math.sin(a))), back);
    }
    return {
      bootL: vadd(feet, vscale(left, 0.11)),
      bootR: vsub(feet, vscale(left, 0.11)),
      palmL: vadd(hands, vscale(left, side)),
      palmR: vsub(hands, vscale(left, side)),
      axis,
      bootDir: back,
      palmDirL: palmDir,
      palmDirR: palmDir,
    };
  }
  const feet = vadd(loc, vec(0, 0.05, 0));
  const hands = vadd(vadd(loc, vec(0, 0.65, 0)), vscale(f, 0.1));
  const s = Math.sin(deg2rad(HOVER_PALM_SPLAY));
  const c = Math.cos(deg2rad(HOVER_PALM_SPLAY));
  return {
    bootL: vadd(feet, vscale(left, 0.11)),
    bootR: vsub(feet, vscale(left, 0.11)),
    palmL: vadd(hands, vscale(left, 0.58)),
    palmR: vsub(hands, vscale(left, 0.58)),
    axis,
    bootDir: vec(0, -1, 0),
    palmDirL: { x: left.x * s, y: -c, z: left.z * s },
    palmDirR: { x: -left.x * s, y: -c, z: -left.z * s },
  };
}

// ---------------------------------------------------------------------------------------------
// armor integrity (SPEC 8.3) — 100 % = undamaged
// ---------------------------------------------------------------------------------------------

/**
 * Integrity of a suit item from its durability component values.
 * pct is floored so 100 % means "not a scratch"; frame 0..10 shows at least 1 while not broken.
 * @returns {{pct: number, frame: number, state: "n"|"w"|"c"}}
 */
export function integrityInfo(damage, maxDurability) {
  const max = Number(maxDurability);
  const dmg = Number(damage);
  const ratio = max > 0 && Number.isFinite(dmg) ? clamp((max - dmg) / max, 0, 1) : 1;
  const pct = Math.floor(ratio * 100 + 1e-9);
  const frame = ratio <= 0 ? 0 : clamp(Math.round(ratio * 10), 1, 10);
  /** @type {"n"|"w"|"c"} */
  const state = pct >= 60 ? "n" : pct >= 25 ? "w" : "c";
  return { pct, frame, state };
}

/**
 * Integrity watcher: reports a damage alert when the shown percentage drops by >= 1 and the
 * critical warning once when it crosses below 25 % (re-armed after a repair to >= 25 %).
 * `prev` undefined = first sample (no alerts).
 * @param {{pct: number, critical: boolean}|undefined} prev
 * @param {number} pct
 * @returns {{next: {pct: number, critical: boolean}, drop: number, critical: boolean}}
 */
export function integrityStep(prev, pct) {
  if (!prev) return { next: { pct, critical: pct < 25 }, drop: 0, critical: false };
  const drop = pct < prev.pct ? prev.pct - pct : 0;
  const nowCritical = pct < 25;
  const fireCritical = nowCritical && !prev.critical;
  return { next: { pct, critical: nowCritical }, drop, critical: fireCritical };
}

// ---------------------------------------------------------------------------------------------
// scanner / targeting geometry
// ---------------------------------------------------------------------------------------------

/** Ticks until the scan wave front (SCAN_WAVE_SPEED blocks/s) reaches `dist` blocks. */
export function revealDelay(dist, T = TUNING) {
  const d = Math.max(0, Number(dist) || 0);
  return Math.round((d / T.SCAN_WAVE_SPEED) * 20);
}

/** True when `to` lies within `deg` degrees of the direction `dir` seen from `from`. */
export function inCone(from, dir, to, deg) {
  return angleBetween(dir, vsub(to, from)) <= deg;
}

/**
 * Lock-on acquisition, one tick (pure state machine, SPEC 5.7).
 * `cand` = id under the reticle (undefined = nothing). While locked on `lockedId`, looking at
 * the same entity does nothing; another entity must stay under the reticle for the full lock
 * time to switch. A candidate survives up to `grace` ticks without being seen.
 * @param {{candId?: string, progress: number, nextStep: number, missTicks: number}} s
 * @param {string|undefined} cand
 * @param {string|undefined} lockedId
 * @param {number} tick
 * @returns {{candId?: string, progress: number, nextStep: number, missTicks: number,
 *   stepped: boolean, locked: boolean}}
 */
export function lockStep(s, cand, lockedId, tick, T = TUNING, grace = 6) {
  const out = { candId: s.candId, progress: s.progress, nextStep: s.nextStep, missTicks: s.missTicks, stepped: false, locked: false };
  const onLocked = !!cand && cand === lockedId;
  if (!cand || onLocked) {
    out.missTicks++;
    if (out.missTicks > grace || onLocked) {
      out.candId = undefined;
      out.progress = 0;
    }
    return out;
  }
  out.missTicks = 0;
  if (out.candId !== cand) {
    out.candId = cand;
    out.progress = 0;
    out.nextStep = tick + T.LOCK_STEP_TICKS;
    return out;
  }
  if (tick >= out.nextStep && out.progress < T.LOCK_STEPS) {
    out.progress++;
    out.nextStep = tick + T.LOCK_STEP_TICKS;
    out.stepped = true;
    if (out.progress >= T.LOCK_STEPS) out.locked = true;
  }
  return out;
}

/** Reticle code: lock state wins, then the class of the target under it, else idle (SPEC 5.6). */
export function reticleCode(locked, acquiring, cls) {
  if (acquiring) return "l";
  if (locked) return "k";
  return cls ?? "i";
}

/**
 * Live readout shown on the actionbar while the Maleta Mark V is held (SPEC 13).
 * Pure: no engine access, so the exact text is unit-tested.
 * @param {number} energy current reactor charge
 * @param {number} [max] ENERGY_MAX
 * @param {number} [cost] SUITUP_COST
 * @param {number} [regen] REGEN per second
 */
export function caseLine(energy, max = Number(TUNING.ENERGY_MAX), cost = Number(TUNING.SUITUP_COST), regen = Number(TUNING.REGEN)) {
  const e = Number.isFinite(energy) ? clamp(energy, 0, max) : 0;
  const pct = energyPct(e, max);
  if (e >= cost) return `§bMALETA MARK V §7• §fENERGIA §b${pct}% §7• §aPRONTA PARA VESTIR`;
  const need = costPct(cost, max);
  const secs = regen > 0 ? Math.max(1, Math.ceil((cost - e) / regen)) : 0;
  const wait = secs > 0 ? ` §7• §f~${secs}s` : "";
  return `§bMALETA MARK V §7• §fENERGIA §c${pct}% §7• §cPRECISA DE ${need}%${wait}`;
}
