// Mark V auto-adaptive night vision (SPEC 12.1). While the suit is worn, powered, the visor closed,
// the HUD up and the feature on (menu, default AUTO), the light at the head is sampled every
// NV_SAMPLE_TICKS: dark for NV_ON_SAMPLES samples -> night vision on, bright -> off (hysteresis).
// Only an effect WE applied is ever removed; it is refreshed long before the < 10 s flicker.
import { world } from "@minecraft/server";
import { PROP, SND, TUNING as T } from "./constants.js";
import { nvDayFactor, nvEffectiveLight, nvStep } from "./calc.js";
import { playerSound, quiet } from "./fx.js";
import { notify, pushAlert } from "./hud.js";

const EFFECT = "night_vision";
const ALERT_TICKS = 40;

/** Read the menu preference once (PROP.NV: undefined = AUTO, false = off). */
export function loadNvPref(player, st) {
  if (st.nv.loaded) return;
  st.nv.loaded = true;
  st.nv.auto = quiet(() => player.getDynamicProperty(PROP.NV)) !== false;
}

/**
 * Effective light level at the pilot's head, or undefined (unloaded chunk / API failure).
 * @param {import("@minecraft/server").Player} player
 */
export function sampleLight(player) {
  const dim = player.dimension;
  const head = quiet(() => player.getHeadLocation()) ?? { x: player.location.x, y: player.location.y + 1.62, z: player.location.z };
  const loc = { x: Math.floor(head.x), y: Math.floor(head.y), z: Math.floor(head.z) };
  let total;
  let sky;
  try {
    // both throw in unloaded chunks / outside the world height
    total = dim.getLightLevel(loc);
    sky = dim.getSkyLightLevel(loc);
  } catch {
    return undefined;
  }
  if (!Number.isFinite(total)) return undefined;
  const hasSky = dim.id === "minecraft:overworld"; // Nether / End: total light only
  const time = quiet(() => world.getTimeOfDay());
  const dayFactor = hasSky ? nvDayFactor(Number.isFinite(time) ? time : 6000) : 1;
  return nvEffectiveLight({ total, sky: Number.isFinite(sky) ? sky : 0, dayFactor, hasSky });
}

/** (Re)apply our night vision. */
function apply(player) {
  quiet(() => player.addEffect(EFFECT, T.NV_DURATION, { amplifier: 0, showParticles: false }));
}

/** Keep our effect above NV_REFRESH_BELOW ticks (a longer foreign potion is left alone). */
function keepApplied(player, st) {
  const e = quiet(() => player.getEffect(EFFECT));
  const left = Number(quiet(() => e?.duration) ?? 0);
  if (!e || left < T.NV_REFRESH_BELOW) {
    apply(player);
    st.nv.applied = true;
  }
}

/**
 * Turn our night vision off; removes the effect only if we applied it and it is still ours
 * (not longer than one of our applications: a potion drunk meanwhile survives).
 * @param {import("@minecraft/server").Player} player
 * @param {import("./state.js").SuitState} st
 * @param {boolean} [announce] sound + HUD alert (automatic switch-off)
 */
export function nvOff(player, st, announce = false) {
  const nv = st.nv;
  const was = nv.on;
  if (nv.applied && player) {
    const e = quiet(() => player.getEffect(EFFECT));
    const left = Number(quiet(() => e?.duration) ?? 0);
    if (e && left <= T.NV_DURATION + 1) quiet(() => player.removeEffect(EFFECT));
  }
  nv.on = false;
  nv.applied = false;
  nv.low = 0;
  if (announce && was && player) {
    playerSound(player, SND.NIGHT_VISION, 0.7);
    pushAlert(st, "i", "VISÃO NOTURNA DESATIVADA", ALERT_TICKS, "nv");
  }
}

/** @param {import("@minecraft/server").Player} player @param {import("./state.js").SuitState} st */
function nvOn(player, st) {
  apply(player);
  st.nv.on = true;
  st.nv.applied = true;
  playerSound(player, SND.NIGHT_VISION, 0.8);
  pushAlert(st, "i", "VISÃO NOTURNA ATIVADA", ALERT_TICKS, "nv");
}

/**
 * Every tick, after st.hudActive is known (it already means: worn, powered, visor closed, not
 * busy / moving, HUD enabled).
 * @param {import("@minecraft/server").Player} player
 * @param {import("./state.js").SuitState} st
 */
export function tickNightVision(player, st, tick) {
  loadNvPref(player, st);
  const nv = st.nv;
  if (!st.hudActive || !nv.auto) {
    // visor opening, power loss, suit removal, HUD or feature disabled
    if (nv.on || nv.applied) nvOff(player, st, false);
    nv.low = 0;
    return;
  }
  if ((tick + st.phase) % T.NV_SAMPLE_TICKS !== 0) return;
  if (nv.on) keepApplied(player, st);
  const eff = sampleLight(player);
  if (eff === undefined) return;
  const next = nvStep(nv, eff);
  nv.low = next.low;
  if (next.on && !nv.on) nvOn(player, st);
  else if (!next.on && nv.on) nvOff(player, st, true);
}

/**
 * Menu: AUTO (true) / off (false), persisted in PROP.NV.
 * @param {import("@minecraft/server").Player} player
 * @param {import("./state.js").SuitState} st
 * @param {boolean} auto
 */
export function setNightVisionAuto(player, st, auto) {
  loadNvPref(player, st);
  st.nv.auto = auto;
  quiet(() => player.setDynamicProperty(PROP.NV, auto ? undefined : false));
  if (!auto) {
    const was = st.nv.on;
    nvOff(player, st, false);
    if (was) playerSound(player, SND.NIGHT_VISION, 0.7);
    notify(player, st, "§7Visão noturna: §cDESLIGADA", { type: "i" });
  } else {
    notify(player, st, "§bVisão noturna: AUTO", { type: "i" });
  }
}

/** Night vision state for texts: "on" (auto, active), "auto" (waiting for the dark), "off". */
export function nvState(st) {
  if (!st.nv.auto) return "off";
  return st.nv.on ? "on" : "auto";
}
