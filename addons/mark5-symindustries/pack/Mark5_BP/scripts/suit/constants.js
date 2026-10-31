// Mark V suit systems — identifiers, suit variant table and tuning (SPEC sections 2 and 6).
// Pure module: it does NOT import "@minecraft/server", so node unit tests can load it.

export const ITEM_SUIT = "sym:mark_5";
export const ITEM_REACTOR = "sym:mark_5_reactor";
export const ENTITY_CASE = "sym:mk5_case";

/** Dynamic property ids (player properties unless noted). */
export const PROP = Object.freeze({
  STATE: "sym:mk5_state", // "suitup" | "suitoff" while main.js runs a cinematic
  ENERGY: "sym:mk5_energy", // 0..ENERGY_MAX
  ENERGY_T: "sym:mk5_energy_t", // world.getAbsoluteTime() of the last energy save
  OFFLINE: "sym:mk5_offline", // latched "power ran out" flag
  HUD: "sym:mk5_hud", // HUD preference (default on)
  LOCK_MODE: "sym:mk5_lock_mode", // homing reticle armed
  LOCK_TARGET: "sym:mk5_lock_target", // id of the locked entity (for other add-ons)
  TIPS: "sym:mk5_tips", // gesture tips already shown
  ITEM_KEEP: "sym:mk5_kod", // item property: keepOnDeath of the final item a temp item replaced
});

// ---------------------------------------------------------------------------------------------
// suit variants (SPEC 2.1) — the visor state and the power state ARE the worn chest item
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {"closed"|"open"|"opening"|"closing"} VisorState
 * @typedef {Object} VariantInfo
 * @property {string} id
 * @property {boolean} powered   LEDs on, HUD/flight/scanner available
 * @property {boolean} dying     power-down animation playing (not powered)
 * @property {VisorState} visor
 * @property {boolean} temp      transition item (locked in the slot, swapped by the script)
 * @property {string} final      id worn when the transition ends (itself for final variants)
 * @property {number} protection
 */

/** @returns {VariantInfo} */
const variant = (id, powered, visor, temp, final, dying = false) =>
  Object.freeze({ id, powered, dying, visor, temp, final: final ?? id, protection: powered || dying ? 20 : 8 });

/** @type {Readonly<Record<string, VariantInfo>>} */
export const VARIANTS = Object.freeze({
  "sym:mark_5": variant("sym:mark_5", true, "closed", false),
  "sym:mark_5_open": variant("sym:mark_5_open", true, "open", false),
  "sym:mark_5_opening": variant("sym:mark_5_opening", true, "opening", true, "sym:mark_5_open"),
  "sym:mark_5_closing": variant("sym:mark_5_closing", true, "closing", true, "sym:mark_5"),
  "sym:mark_5_powerdown": variant("sym:mark_5_powerdown", false, "closed", true, "sym:mark_5_offline", true),
  "sym:mark_5_offline": variant("sym:mark_5_offline", false, "closed", false),
  "sym:mark_5_offline_open": variant("sym:mark_5_offline_open", false, "open", false),
  "sym:mark_5_offline_opening": variant("sym:mark_5_offline_opening", false, "opening", true, "sym:mark_5_offline_open"),
  "sym:mark_5_offline_closing": variant("sym:mark_5_offline_closing", false, "closing", true, "sym:mark_5_offline"),
});

export const SUIT_IDS = Object.freeze(Object.keys(VARIANTS));
export const POWERDOWN_ID = "sym:mark_5_powerdown";

/** @param {string|undefined} id */
export function isSuitId(id) {
  return typeof id === "string" && Object.prototype.hasOwnProperty.call(VARIANTS, id);
}

/** @param {string|undefined} id @returns {VariantInfo|undefined} */
export function variantInfo(id) {
  return isSuitId(id) ? VARIANTS[id] : undefined;
}

/** @param {string|undefined} id */
export function isTempVariant(id) {
  return !!variantInfo(id)?.temp;
}

/** Final variant a (temp) id resolves to; undefined for non-suit ids. */
export function finalOf(id) {
  return variantInfo(id)?.final;
}

/**
 * Variant id for a power/visor combination ("dying" only exists closed: the power-down item).
 * @param {{powered: boolean, visor: VisorState, dying?: boolean}} q
 */
export function variantFor(q) {
  if (q.dying) return POWERDOWN_ID;
  const base = q.powered ? "sym:mark_5" : "sym:mark_5_offline";
  return q.visor === "closed" ? base : `${base}_${q.visor}`;
}

/** Ticks a transition item is worn before the final variant replaces it (SPEC 2.1). */
export const TRANSITION_TICKS = Object.freeze({ visor: 16, powerdown: 24 });

// ---------------------------------------------------------------------------------------------
// tuning (SPEC 6) — energy is in "units", rates are per second, speeds in blocks per tick
// ---------------------------------------------------------------------------------------------

export const TUNING = Object.freeze({
  ENERGY_MAX: 1000,
  REGEN: 4.0,
  LED_REACTOR: 0.3,
  LED_ARMS: 0.3,
  LED_LEGS: 0.3,
  LED_EYES: 0.1,
  HUD_DRAIN: 1.0,
  LOCK_DRAIN: 0.6,
  FLIGHT_HOVER: 4,
  FLIGHT_CRUISE: 7,
  FLIGHT_BOOST: 16,
  FLIGHT_EMERGENCY: 0,
  TAKEOFF_COST: 15,
  SCAN_COST: 50,
  LOCK_ACQUIRE_COST: 5,
  VISOR_COST: 10, // SPEC 10: visor servos, per open / close while powered
  FLIGHT_MIN_ENERGY: 60,
  EMERGENCY_AT: 30,
  REBOOT_AT: 150,
  SHIELD_FRACTION: 0.4,
  SHIELD_COST_PER_HP: 12,
  CRUISE_SPEED: 0.75,
  BOOST_SPEED: 1.6,
  STRAFE_SPEED: 0.45,
  VERT_UP: 0.45,
  VERT_DOWN: 0.5,
  ACCEL_HOVER: 0.25,
  ACCEL_CRUISE: 0.18,
  ACCEL_BOOST: 0.1,
  TARGET_RANGE: 48,
  SCAN_RADIUS: 32,
  SCAN_MARK_TICKS: 240,
  LOCK_RANGE: 64,
  // derived / secondary numbers used by the script
  OFFLINE_REGEN_CAP_TICKS: 24000, // regen applied for time spent offline is capped at 20 min
  SCAN_WAVE_SPEED: 24, // blocks per second
  SCAN_SWEEP_TICKS: 28, // ~1.4 s
  SCAN_COOLDOWN: 60,
  THREAT_RADIUS: 16,
  PROVOKED_TICKS: 600, // a neutral mob that hurt you in the last 30 s counts as hostile
  LOCK_STEP_TICKS: 3,
  LOCK_STEPS: 5,
  LOCK_CONE_DEG: 30,
  LOCK_CONE_GRACE: 40,
  SONIC_BOOM_SPEED: 1.3,
  SONIC_BOOM_COOLDOWN: 100,
  HEAT_UP: 12, // per second while boosting
  HEAT_DOWN: 18, // per second while flying without boost
  HEAT_DOWN_GROUND: 30, // per second when not flying
  HEAT_RESUME: 60,
  ICING_Y: 300,
  ICING_FACTOR: 0.6,
  SUPERHERO_SPEED: 0.6,
  TAKEOFF_IMPULSE: 0.9,
  DOUBLE_TAP_TICKS: 8,
  SNEAK_DOUBLE_TAP_TICKS: 10,
  BOOT_TICKS: 50,
  FAILURE_TICKS: 40,
});

// ---------------------------------------------------------------------------------------------
// resource identifiers (SPEC 2.3–2.6)
// ---------------------------------------------------------------------------------------------

export const SND = Object.freeze({
  POWER_DOWN: "sym.mk5.power_down",
  POWER_UP: "sym.mk5.power_up",
  HUD_BOOT: "sym.mk5.hud_boot",
  HUD_OFF: "sym.mk5.hud_off",
  ALARM: "sym.mk5.alarm",
  SCAN: "sym.mk5.scan",
  SCAN_PING: "sym.mk5.scan_ping",
  LOCK_TICK: "sym.mk5.lock_tick",
  LOCK_ON: "sym.mk5.lock_on",
  LOCK_LOST: "sym.mk5.lock_lost",
  TARGET: "sym.mk5.target",
  THRUSTER_START: "sym.mk5.thruster_start",
  THRUSTER_LOOP: "sym.mk5.thruster_loop",
  THRUSTER_BOOST: "sym.mk5.thruster_boost",
  THRUSTER_STOP: "sym.mk5.thruster_stop",
  SONIC_BOOM: "sym.mk5.sonic_boom",
  LANDING: "sym.mk5.landing",
  SHIELD: "sym.mk5.shield",
  MENU: "sym.mk5.menu",
  HELMET_OPEN: "sym.mk5.helmet_open",
  HELMET_CLOSE: "sym.mk5.helmet_close",
});

export const FX = Object.freeze({
  THRUST: "sym:mk5_thrust",
  THRUST_GLOW: "sym:mk5_thrust_glow",
  SMOKE: "sym:mk5_smoke",
  BOOM: "sym:mk5_boom",
  TAKEOFF: "sym:mk5_takeoff",
  LANDING: "sym:mk5_landing",
  SCAN_WAVE: "sym:mk5_scan_wave",
  SCAN_DOME: "sym:mk5_scan_dome",
  MARK: "sym:mk5_mark",
  LOCK: "sym:mk5_lock",
  POWER_DOWN: "sym:mk5_power_down",
  POWER_UP: "sym:mk5_power_up",
  SHIELD_HIT: "sym:mk5_shield_hit",
});

export const ANIM = Object.freeze({
  CONTROLLER: "sym_mk5_flight",
  HOVER: "animation.sym.player.mk5_hover",
  FLY: "animation.sym.player.mk5_fly",
  BOOST: "animation.sym.player.mk5_boost",
  TAKEOFF: "animation.sym.player.mk5_takeoff",
  LAND: "animation.sym.player.mk5_land",
  RESET: "animation.sym.player.mk5_flight_reset",
});

export const ICON = Object.freeze({
  VISOR: "textures/sym/ui/icon_visor",
  HUD: "textures/sym/ui/icon_hud",
  FLIGHT: "textures/sym/ui/icon_flight",
  SCAN: "textures/sym/ui/icon_scan",
  LOCK: "textures/sym/ui/icon_lock",
  DIAG: "textures/sym/ui/icon_diag",
  SUITOFF: "textures/sym/ui/icon_suitoff",
});

/** Script events of the homing lock-on API (see targeting.js). */
export const SCRIPT_EVENT = Object.freeze({
  LOCKED: "sym:mk5_target_locked",
  LOST: "sym:mk5_target_lost",
  QUERY: "sym:mk5_lock_query",
  INFO: "sym:mk5_lock_info",
});
