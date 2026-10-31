// Mark V particle / sound / animation helpers. Every engine call is guarded: a particle in an
// unloaded chunk or a sound for a player who just left must never break the main loop.

import { MolangVariableMap } from "@minecraft/server";
import { ANIM } from "./constants.js";

/** Run `fn`, log and swallow errors. */
export function safeRun(fn, label = "Mark V") {
  try {
    return fn();
  } catch (err) {
    console.warn(`[${label}] ${err}`);
    return undefined;
  }
}

/** Run `fn` and ignore errors silently (expected failures: unloaded chunks, dead entities). */
export function quiet(fn) {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/**
 * Molang inputs for our particles (SPEC 2.4).
 * `vel` = emitter velocity in blocks/tick (flames move with the flying suit).
 * @param {{dir?: {x:number,y:number,z:number}, vel?: {x:number,y:number,z:number}, power?: number,
 *   size?: number, width?: number, radius?: number,
 *   color?: {red:number, green:number, blue:number, alpha:number}}} [v]
 */
export function molang(v = {}) {
  const m = new MolangVariableMap();
  if (v.dir) m.setVector3("variable.dir", v.dir);
  if (v.vel) m.setVector3("variable.vel", v.vel);
  if (v.power !== undefined) m.setFloat("variable.power", v.power);
  if (v.size !== undefined) m.setFloat("variable.size", v.size);
  if (v.width !== undefined) m.setFloat("variable.width", v.width);
  if (v.radius !== undefined) m.setFloat("variable.radius", v.radius);
  if (v.color) m.setColorRGBA("variable.color", v.color);
  return m;
}

/** Particle everyone can see. @param {import("@minecraft/server").Dimension} dimension */
export function worldParticle(dimension, id, location, vars) {
  quiet(() => dimension.spawnParticle(id, location, vars));
}

/** Particle only `player` can see. @param {import("@minecraft/server").Player} player */
export function playerParticle(player, id, location, vars) {
  quiet(() => player.spawnParticle(id, location, vars));
}

/** Positional sound heard by everyone nearby. @param {import("@minecraft/server").Dimension} dimension */
export function worldSound(dimension, id, location, volume = 1, pitch = 1) {
  quiet(() => dimension.playSound(id, location, { volume, pitch }));
}

/** Sound only `player` hears. @param {import("@minecraft/server").Player} player */
export function playerSound(player, id, volume = 1, pitch = 1) {
  quiet(() => player.playSound(id, { volume, pitch }));
}

/** @param {import("@minecraft/server").Player} player */
export function shake(player, intensity, seconds) {
  quiet(() => player.runCommand(`camerashake add @s ${intensity} ${seconds} positional`));
}

/** @param {import("@minecraft/server").Player} player */
export function actionbar(player, text) {
  quiet(() => player.onScreenDisplay.setActionBar(text));
}

/**
 * Flight body animation on the separate "sym_mk5_flight" controller (never touches the
 * cinematic "sym_mk5" one). Loops run until the next clip on the controller replaces them.
 * @param {import("@minecraft/server").Player} player
 */
export function flightAnim(player, animation, loop, blendOutTime = 0.25) {
  /** @type {import("@minecraft/server").PlayAnimationOptions} */
  const options = { controller: ANIM.CONTROLLER, blendOutTime };
  if (loop) options.stopExpression = "0";
  quiet(() => player.playAnimation(animation, options));
}

/** Stop any flight loop (empty 0.05 s clip). */
export function resetFlightAnim(player) {
  flightAnim(player, ANIM.RESET, false, 0.25);
}

/** Point at chest height (arc reactor). @param {{x:number,y:number,z:number}} loc */
export const chestOf = (loc) => ({ x: loc.x, y: loc.y + 1.25, z: loc.z });
