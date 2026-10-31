// Mark V gestures (SPEC 5.9) and the one-time tips shown on the first power-on.
//   double-tap Jump                     -> thrusters on / off
//   look up (pitch <= -50) + 2x Sneak   -> area scan
//   look down + 2x Sneak on the ground  -> take the suit off (handled by main.js)
//   Arc Reactor: use -> control panel, sneak + use -> visor (main.js -> index.js)

import { ButtonState, InputButton } from "@minecraft/server";
import { PROP, TUNING as T } from "./constants.js";
import { actionbar, quiet } from "./fx.js";

const LOOK_UP_PITCH = -50;

/** @type {Map<string, number>} */
const lastJump = new Map();
/** @type {Map<string, number>} */
const lastSneak = new Map();

/**
 * @typedef {Object} GestureActions
 * @property {(player: import("@minecraft/server").Player) => boolean} canUse  wearing the suit, not busy
 * @property {(player: import("@minecraft/server").Player) => void} toggleFlight
 * @property {(player: import("@minecraft/server").Player) => void} scan
 */

/**
 * Double-tap detector: true on the second press within `window` ticks.
 * @param {Map<string, number>} map
 */
export function doubleTap(map, id, tick, window) {
  const prev = map.get(id);
  if (prev !== undefined && tick - prev <= window) {
    map.delete(id);
    return true;
  }
  map.set(id, tick);
  return false;
}

/**
 * world.afterEvents.playerButtonInput handler.
 * @param {import("@minecraft/server").PlayerButtonInputAfterEvent} ev
 * @param {number} tick
 * @param {GestureActions} actions
 */
export function handleButton(ev, tick, actions) {
  if (ev.newButtonState !== ButtonState.Pressed) return;
  const player = ev.player;
  if (!quiet(() => player.isValid) || !actions.canUse(player)) return;
  if (ev.button === InputButton.Jump) {
    if (doubleTap(lastJump, player.id, tick, T.DOUBLE_TAP_TICKS)) actions.toggleFlight(player);
  } else if (ev.button === InputButton.Sneak) {
    const pitch = quiet(() => player.getRotation().x) ?? 0;
    if (pitch > LOOK_UP_PITCH) {
      lastSneak.delete(player.id);
      return;
    }
    if (doubleTap(lastSneak, player.id, tick, T.SNEAK_DOUBLE_TAP_TICKS)) actions.scan(player);
  }
}

/** Forget gesture timing of a player (leave). */
export function forgetInput(id) {
  lastJump.delete(id);
  lastSneak.delete(id);
}

// ---------------------------------------------------------------------------------------------
// tips (once per player per world)
// ---------------------------------------------------------------------------------------------

export const TIPS = Object.freeze([
  "§b§lMARK V§r §7— §bReator Arc§7: usar = §fpainel§7 · agachar + usar = §fvisor",
  "§7Pule §fduas vezes§7 = §bpropulsores§7 · corra para frente = §6turbo",
  "§7Voando: §fpular§7 sobe · §fagachar§7 desce · pule 2x de novo para pousar",
  "§7Olhe para §fcima§7 + agache §f2x§7 = §bscanner de área",
  "§7Olhe para §fbaixo§7 + agache §f2x§7 no chão = §cdesmontar a armadura",
]);
const TIP_TICKS = 70;
const TIP_RESEND = 35;

/**
 * Start the tips if this player never saw them.
 * @param {import("@minecraft/server").Player} player
 * @param {import("./state.js").SuitState} st
 */
export function maybeStartTips(player, st, tick) {
  if (st.tips || quiet(() => player.getDynamicProperty(PROP.TIPS)) === true) return;
  quiet(() => player.setDynamicProperty(PROP.TIPS, true));
  st.tips = { index: 0, next: tick + 60 }; // after the boot overlay
}

/**
 * @param {import("@minecraft/server").Player} player
 * @param {import("./state.js").SuitState} st
 */
export function tickTips(player, st, tick) {
  const t = st.tips;
  if (!t || tick < t.next) return;
  if (t.index >= TIPS.length * 2) {
    st.tips = undefined;
    return;
  }
  actionbar(player, TIPS[t.index >> 1]);
  t.index++;
  t.next = tick + TIP_RESEND;
  if (t.index >= TIPS.length * 2) t.next = tick + TIP_TICKS - TIP_RESEND;
}
