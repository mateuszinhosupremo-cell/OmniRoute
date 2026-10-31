// Mark V flight controller (SPEC 5.3).
//
// Physics: every tick the script computes a target velocity from the player's input and the view
// direction, eases the current velocity towards it and applies it with applyKnockback() (which
// sets the player's motion). slow_falling keeps gravity soft and cancels fall damage.
// Input: movement stick/WASD (x = +1 LEFT, y = +1 forward), Jump held = up, sneaking = down,
// sprinting while moving forward = boost. Double-tap Jump toggles the thrusters (input.js).

import { ButtonState, GameMode, InputButton, system } from "@minecraft/server";
import { ANIM, FX, SND, TUNING as T } from "./constants.js";
import {
  FLIGHT_CODE,
  approach,
  clamp,
  flatForward,
  flightAccel,
  flightMode,
  flightTarget,
  heatStep,
  nozzles,
  overheatStep,
  thrustLevel,
  vadd,
  vlen,
  vnorm,
  vscale,
} from "./calc.js";
import { actionbar, flightAnim, molang, quiet, resetFlightAnim, shake, worldParticle, worldSound } from "./fx.js";
import { clearAlert, pushAlert } from "./hud.js";
import { spendEnergy } from "./state.js";
import { flightText } from "./texts.js";

/**
 * @typedef {Object} FlightRuntime
 * @property {"hover"|"cruise"|"boost"|"emergency"} mode
 * @property {{x:number,y:number,z:number}} v   commanded velocity (blocks/tick)
 * @property {number} start
 * @property {string} anim                       loop currently playing
 * @property {number} animLockUntil              takeoff clip plays until this tick
 * @property {number} nextSound
 * @property {number|undefined} holdY            altitude hold while hovering
 * @property {number} groundIdle
 * @property {boolean} boostLatch
 * @property {boolean} boomDone
 * @property {number} lastBoom
 * @property {number} thrust                     0..1
 * @property {number|undefined} agl              height above ground (undefined = > 64)
 * @property {number} aglTick
 * @property {number} speed
 * @property {number} alt
 * @property {boolean} icing
 */

const DOWN = Object.freeze({ x: 0, y: -1, z: 0 });
const SOUND_VOLUME = { hover: 0.7, cruise: 0.9, boost: 1.2, emergency: 0.5 };

/** Blend-out time (s) of the flight loops: cruise <-> boost <-> hover changes blend smoothly. */
export const FLIGHT_BLEND_OUT = 0.3;

/**
 * Pose the thruster flames follow: the loop on screen (hover while the takeoff clip plays and in
 * emergency descent) at the current pitch / yaw.
 * @param {{x:number,y:number,z:number}} loc
 * @param {{x:number,y:number}} rot
 * @param {FlightRuntime} f
 */
export function flamePose(loc, rot, f) {
  const pose = f.anim === ANIM.BOOST ? "boost" : f.anim === ANIM.FLY ? "cruise" : "hover";
  return nozzles(loc, rot.y, rot.x, pose);
}

/** @param {import("@minecraft/server").Player} player */
function inLava(player) {
  return !!quiet(() => {
    const id = player.dimension.getBlock(player.location)?.typeId ?? "";
    return id.includes("lava");
  });
}

/** Distance from the feet down to the first solid block or liquid (undefined if > max). */
export function groundDistance(player, max = 64) {
  const hit = quiet(() =>
    player.dimension.getBlockFromRay(player.location, DOWN, {
      maxDistance: max,
      includeLiquidBlocks: true,
      includePassableBlocks: false,
    })
  );
  if (!hit) return undefined;
  return Math.max(0, player.location.y - (hit.block.location.y + hit.faceLocation.y));
}

/** @param {import("@minecraft/server").Player} player */
function refreshSlowFall(player, ticks) {
  quiet(() => player.addEffect("slow_falling", ticks, { amplifier: 0, showParticles: false }));
}

/** @param {import("./state.js").SuitState} st */
export function isFlying(st) {
  return !!st.flight;
}

/**
 * Why the thrusters cannot start now ("" = they can).
 * @param {import("@minecraft/server").Player} player
 * @param {import("./state.js").SuitState} st
 */
export function flightBlocker(player, st) {
  const worn = st.worn;
  if (!worn || st.busy) return "§cVista a Mark V para voar";
  if (!worn.powered) return "§cSem energia §7— propulsores offline";
  if (st.energy < T.FLIGHT_MIN_ENERGY) return `§cEnergia insuficiente para voar §7(mínimo ${Math.round((T.FLIGHT_MIN_ENERGY / T.ENERGY_MAX) * 100)}%)`;
  const gm = quiet(() => player.getGameMode());
  if (gm === GameMode.Spectator) return "§cIndisponível no modo espectador";
  if (player.isInWater || player.isSwimming || inLava(player)) return "§cPROPULSORES INOPERANTES SUBMERSO";
  if (quiet(() => player.getComponent("minecraft:riding"))) return "§cDesmonte antes de decolar";
  if (player.isGliding) return "§cNão é possível decolar planando";
  // vanilla flight (creative / mayfly) must be off first; in creative the double-tap is left to
  // vanilla (gestureToggle) and the menu "Decolar" works once the player is not vanilla-flying
  if (player.isFlying) return "§cDesative o voo atual primeiro";
  return "";
}

/**
 * Start the thrusters (from the ground: takeoff blast).
 * @param {import("@minecraft/server").Player} player
 * @param {import("./state.js").SuitState} st
 * @returns {boolean}
 */
export function engage(player, st, tick) {
  if (st.flight) return true;
  const why = flightBlocker(player, st);
  if (why) {
    actionbar(player, why);
    return false;
  }
  if (!spendEnergy(st, T.TAKEOFF_COST)) {
    actionbar(player, "§cEnergia insuficiente para decolar");
    return false;
  }
  const loc = player.location;
  const dim = player.dimension;
  const agl = groundDistance(player, 4);
  const grounded = player.isOnGround || (agl !== undefined && agl < 1.6);
  let v = { x: 0, y: T.TAKEOFF_IMPULSE, z: 0 };
  if (!grounded) {
    const cur = quiet(() => player.getVelocity()) ?? { x: 0, y: 0, z: 0 };
    v = { x: clamp(cur.x, -1.5, 1.5), y: clamp(cur.y, -1, 1), z: clamp(cur.z, -1.5, 1.5) };
  }
  /** @type {FlightRuntime} */
  const f = {
    mode: "hover",
    v,
    start: tick,
    anim: "",
    animLockUntil: grounded ? tick + 10 : tick,
    nextSound: tick + 16,
    holdY: undefined,
    groundIdle: 0,
    boostLatch: false,
    boomDone: false,
    lastBoom: -1000,
    thrust: 0.6,
    agl,
    aglTick: tick,
    speed: vlen(v),
    alt: loc.y,
    icing: false,
  };
  st.flight = f;
  quiet(() => player.applyKnockback({ x: v.x, z: v.z }, v.y));
  refreshSlowFall(player, 40);
  worldSound(dim, SND.THRUSTER_START, loc, 1);
  if (grounded) {
    worldParticle(dim, FX.TAKEOFF, { x: loc.x, y: loc.y + 0.05, z: loc.z });
    shake(player, 0.15, 0.3);
    flightAnim(player, ANIM.TAKEOFF, false, 0.15);
  } else {
    flightAnim(player, ANIM.HOVER, true, FLIGHT_BLEND_OUT);
    f.anim = ANIM.HOVER;
  }
  pushAlert(st, "i", "PROPULSORES ONLINE", 40);
  return true;
}

/**
 * Stop flying.
 * @param {import("@minecraft/server").Player} player
 * @param {import("./state.js").SuitState} st
 * @param {{fall?: boolean, hero?: boolean, silent?: boolean, message?: string}} [opts]
 *   fall: power loss -> slow_falling removed; hero: superhero landing
 */
export function stop(player, st, opts = {}) {
  const f = st.flight;
  if (!f) return;
  st.flight = undefined;
  clearAlert(st, "emerg");
  clearAlert(st, "icing");
  if (!player || !quiet(() => player.isValid)) return;
  const loc = player.location;
  const dim = player.dimension;
  if (opts.hero) {
    flightAnim(player, ANIM.LAND, false, 0.2);
    worldParticle(dim, FX.LANDING, { x: loc.x, y: loc.y + 0.05, z: loc.z });
    worldSound(dim, SND.LANDING, loc, 1);
    shake(player, 0.3, 0.4);
    quiet(() => player.addEffect("slowness", 16, { amplifier: 3, showParticles: false }));
  } else {
    resetFlightAnim(player);
  }
  if (!opts.silent) worldSound(dim, SND.THRUSTER_STOP, loc, 0.9);
  if (opts.fall) quiet(() => player.removeEffect("slow_falling"));
  else refreshSlowFall(player, 60);
  if (opts.message) actionbar(player, opts.message);
}

/** Forget the flight without touching the (dead / leaving) player. */
export function abort(st) {
  st.flight = undefined;
  clearAlert(st, "emerg");
  clearAlert(st, "icing");
}

/** Double-tap Jump / menu. @returns {boolean} flying afterwards */
export function toggle(player, st, tick) {
  if (st.flight) {
    stop(player, st, { message: "§7Propulsores desligados" });
    return false;
  }
  return engage(player, st, tick);
}

/** Ticks a creative double-tap waits for vanilla to toggle its own flight before deciding. */
export const CREATIVE_SETTLE_TICKS = 2;

/**
 * Double-tap Jump gesture. Survival (and landing from our flight): plain toggle. Creative: the
 * same double-tap toggles vanilla creative flight, so ours is NOT engaged while the player is
 * vanilla-flying (vanilla is turning it off) nor when vanilla switches it on with this double-tap
 * (checked again CREATIVE_SETTLE_TICKS later). The menu "Decolar" still engages normally.
 * @param {import("@minecraft/server").Player} player
 * @param {import("./state.js").SuitState} st
 * @returns {boolean} flying (ours) afterwards
 */
export function gestureToggle(player, st, tick) {
  if (st.flight || quiet(() => player.getGameMode()) !== GameMode.Creative) return toggle(player, st, tick);
  if (player.isFlying) return false;
  system.runTimeout(() => {
    if (st.flight || !quiet(() => player.isValid) || player.isFlying) return;
    if (quiet(() => player.getGameMode()) !== GameMode.Creative) return;
    engage(player, st, system.currentTick);
  }, CREATIVE_SETTLE_TICKS);
  return false;
}

/**
 * Thruster heat (every tick, flying or not).
 * @param {import("./state.js").SuitState} st
 */
export function tickHeat(st) {
  const f = st.flight;
  st.heat = heatStep(st.heat, { flying: !!f, mode: f?.mode });
  const was = st.overheated;
  st.overheated = overheatStep(st.overheated, st.heat);
  if (st.overheated) pushAlert(st, "w", "SUPERAQUECIMENTO DOS PROPULSORES", 10, "heat");
  else if (was) clearAlert(st, "heat");
}

/**
 * One flight tick.
 * @param {import("@minecraft/server").Player} player
 * @param {import("./state.js").SuitState} st
 */
export function tickFlight(player, st, tick) {
  const f = st.flight;
  if (!f) return;
  const worn = st.worn;
  if (!worn || st.busy) return stop(player, st);
  if (!worn.powered || st.energy <= 0) {
    return stop(player, st, { fall: true, message: "§c§lSEM ENERGIA§r §7— propulsores desligados" });
  }
  if (player.isInWater || player.isSwimming) {
    pushAlert(st, "w", "PROPULSORES INOPERANTES SUBMERSO", 60);
    return stop(player, st, { message: "§cPROPULSORES INOPERANTES SUBMERSO" });
  }
  const gm = quiet(() => player.getGameMode());
  if (gm === GameMode.Spectator || player.isGliding || quiet(() => player.getComponent("minecraft:riding"))) {
    return stop(player, st);
  }

  const loc = player.location;
  const rot = player.getRotation();
  const dim = player.dimension;

  // emergency landing once energy is almost gone (no control, no flight drain)
  if (f.mode !== "emergency" && st.energy <= T.EMERGENCY_AT) {
    f.mode = "emergency";
    f.holdY = undefined;
    actionbar(player, "§c§lPOUSO DE EMERGÊNCIA§r §7— energia crítica");
  }
  const emergency = f.mode === "emergency";
  if (emergency) pushAlert(st, "c", "POUSO DE EMERGÊNCIA", 8, "emerg");

  // input
  const move = quiet(() => player.inputInfo.getMovementVector()) ?? { x: 0, y: 0 };
  const jumpHeld = quiet(() => player.inputInfo.getButtonState(InputButton.Jump) === ButtonState.Pressed);
  const up = !emergency && (!!jumpHeld || player.isJumping);
  const down = !emergency && player.isSneaking;
  const sprint = player.isSprinting;
  if (move.y <= 0.5 || st.overheated) f.boostLatch = false;
  else if (sprint) f.boostLatch = true;

  // landing (uses the velocity of the previous tick = touchdown speed)
  const impact = vlen(f.v);
  if (tick - f.start > 10 && player.isOnGround) {
    const idle = Math.hypot(move.x, move.y) < 0.2 && !up;
    f.groundIdle = idle ? f.groundIdle + 1 : 0;
    if (emergency || f.v.y < -0.05 || down || f.groundIdle >= 6) {
      if (emergency) actionbar(player, "§6Pouso de emergência concluído");
      return stop(player, st, { hero: !emergency && impact >= T.SUPERHERO_SPEED });
    }
  } else {
    f.groundIdle = 0;
  }

  const mode = emergency ? "emergency" : flightMode({ move, sprint, boostLatch: f.boostLatch, overheated: st.overheated });
  if (mode !== "boost") f.boomDone = false;
  f.mode = mode;
  if (mode === "hover" && !up && !down) {
    if (f.holdY === undefined && Math.abs(f.v.y) < 0.06) f.holdY = loc.y;
  } else {
    f.holdY = undefined;
  }

  f.alt = loc.y;
  f.icing = loc.y > T.ICING_Y;
  if (f.icing && !emergency) pushAlert(st, "w", "FORMAÇÃO DE GELO — ALTITUDE CRÍTICA", 10, "icing");
  else clearAlert(st, "icing");

  const view = quiet(() => player.getViewDirection()) ?? flatForward(rot.y);
  const target = flightTarget({ mode, move, up, down, view, yaw: rot.y, icing: f.icing, v: f.v, y: loc.y, holdY: f.holdY, tick });
  f.v = mode === "emergency" ? target : approach(f.v, target, flightAccel(mode));
  quiet(() => player.applyKnockback({ x: f.v.x, z: f.v.z }, f.v.y));
  f.speed = vlen(f.v);
  f.thrust = thrustLevel(mode, f.speed, up);

  if ((tick - f.start) % 10 === 0) refreshSlowFall(player, 40);
  if (tick - f.aglTick >= 4) {
    f.agl = groundDistance(player, 64);
    f.aglTick = tick;
  }

  // body pose (every loop blends out over FLIGHT_BLEND_OUT so cruise <-> boost is smooth)
  const want = mode === "boost" ? ANIM.BOOST : mode === "cruise" ? ANIM.FLY : ANIM.HOVER;
  if (tick >= f.animLockUntil && want !== f.anim) {
    flightAnim(player, want, true, FLIGHT_BLEND_OUT);
    f.anim = want;
  }

  // thrusters: flames at boots and palms (everyone sees them). Positions and flame directions
  // follow the body pose (the flames leave along the limbs); `vel` (the commanded velocity,
  // blocks/tick) makes the sprites travel with the suit instead of trailing behind at speed.
  const nz = flamePose(loc, rot, f);
  const vel = { x: f.v.x, y: f.v.y, z: f.v.z };
  const power = clamp(f.thrust, 0.1, 1);
  if (!emergency || tick % 3 !== 0) {
    const vb = molang({ dir: nz.bootDir, power, vel });
    worldParticle(dim, FX.THRUST, nz.bootL, vb);
    worldParticle(dim, FX.THRUST, nz.bootR, vb);
    worldParticle(dim, FX.THRUST, nz.palmL, molang({ dir: nz.palmDirL, power: power * 0.75, vel }));
    worldParticle(dim, FX.THRUST, nz.palmR, molang({ dir: nz.palmDirR, power: power * 0.75, vel }));
  }
  if (tick % 2 === 0) {
    const g = molang({ power, vel });
    for (const p of [nz.bootL, nz.bootR, nz.palmL, nz.palmR]) worldParticle(dim, FX.THRUST_GLOW, p, g);
  }
  if (mode === "boost" && tick % 3 === 0) {
    const vs = molang({ dir: nz.bootDir });
    worldParticle(dim, FX.SMOKE, nz.bootL, vs);
    worldParticle(dim, FX.SMOKE, nz.bootR, vs);
  }

  // engine sound: replayed every 18 ticks a little ahead on the flight path so the pilot does
  // not leave it behind at high speed
  if (tick >= f.nextSound) {
    f.nextSound = tick + 18;
    const id = mode === "boost" ? SND.THRUSTER_BOOST : SND.THRUSTER_LOOP;
    worldSound(dim, id, vadd(loc, vscale(f.v, 9)), SOUND_VOLUME[mode] ?? 0.8, emergency ? 0.75 : 1);
  }

  // sonic boom when the boost breaks through
  if (mode === "boost" && !f.boomDone && f.speed >= T.SONIC_BOOM_SPEED && tick - f.lastBoom >= T.SONIC_BOOM_COOLDOWN) {
    f.boomDone = true;
    f.lastBoom = tick;
    const c = { x: loc.x, y: loc.y + 0.9, z: loc.z };
    worldParticle(dim, FX.BOOM, c, molang({ dir: vnorm(f.v, flatForward(rot.y)) }));
    worldSound(dim, SND.SONIC_BOOM, c, 2);
    shake(player, 0.3, 0.4);
  }
}

/** HUD fields of the flight panel. @param {import("./state.js").SuitState} st */
export function flightHudFields(st) {
  const f = st.flight;
  if (!f) return { flight: "0", thrust_frame: 0, flight_text: "" };
  return {
    flight: FLIGHT_CODE[f.mode] ?? "h",
    thrust_frame: Math.round(f.thrust * 10),
    flight_text: flightText({
      mode: f.mode,
      alt: f.alt,
      agl: f.agl,
      speed: f.speed * 20,
      thrust: f.thrust * 100,
      heat: st.heat,
      overheated: st.overheated,
      icing: f.icing,
    }),
  };
}
