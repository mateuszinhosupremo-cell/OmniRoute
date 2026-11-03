// Mark V HUD transport: the visor HUD is drawn by JSON UI (ui/sym_mk5_hud.json) from ONE title
// string encoded per tools/hud_protocol.json. This module owns the HUD life cycle (boot sequence,
// power-failure overlay, alerts queue), sends the title every 2 ticks and hides/restores the
// vanilla crosshair.

import { HudElement, HudVisibility, system } from "@minecraft/server";
import { encodeHud, hiddenHudString, stripFormat, utf8Length } from "./codec.js";
import { SND, TUNING } from "./constants.js";
import { actionbar, playerSound, quiet } from "./fx.js";
import { alertText } from "./texts.js";

export { encodeHud, hiddenHudString, utf8Length };

const TITLE_OPTIONS = Object.freeze({ fadeInDuration: 0, stayDuration: 200, fadeOutDuration: 0 });
const RESEND_TICKS = 40; // re-send an unchanged HUD so it never times out / survives other titles
const PRIORITY = { i: 1, w: 2, c: 3 };
const MAX_ALERTS = 6;

// ---------------------------------------------------------------------------------------------
// alerts
// ---------------------------------------------------------------------------------------------

/**
 * Queue an alert banner. Alerts with a `key` are "sticky": pushing the same key again refreshes
 * it (used every tick for conditions such as an emergency landing).
 * @param {import("./state.js").SuitState} st
 * @param {"i"|"w"|"c"} type
 * @param {string} text
 * @param {number} [duration] ticks on screen
 * @param {string} [key]
 */
export function pushAlert(st, type, text, duration = 60, key = undefined) {
  const q = st.hud.alerts;
  const tick = system.currentTick;
  const same = q.find((a) => (key ? a.key === key : a.text === text && !a.key));
  if (same) {
    same.type = type;
    same.text = text;
    if (same.shownAt !== undefined) same.until = Math.max(same.until ?? 0, tick + duration);
    else same.duration = Math.max(same.duration, duration);
    return;
  }
  q.push({ type, text, duration, key, seq: ++st.hud.seq });
  if (q.length > MAX_ALERTS) {
    // drop the least important, oldest alert
    let worst = 0;
    for (let i = 1; i < q.length; i++) {
      const a = q[i];
      const w = q[worst];
      if (PRIORITY[a.type] < PRIORITY[w.type] || (PRIORITY[a.type] === PRIORITY[w.type] && a.seq < w.seq)) worst = i;
    }
    q.splice(worst, 1);
  }
}

/**
 * The main HUD (mode 1) is on screen right now: no boot / power-failure overlay.
 * @param {import("./state.js").SuitState} st
 */
export function hudShowing(st, tick = system.currentTick) {
  const h = st.hud;
  return !!st.hudActive && h.on && tick >= h.bootUntil && tick >= h.failUntil;
}

/** Alert type of a status message from its colour: §c§l critical, §c / §6 warning, else info. */
export function notifyType(text) {
  const s = String(text ?? "");
  if (s.startsWith("§c§l")) return "c";
  if (s.startsWith("§c") || s.startsWith("§6")) return "w";
  return "i";
}

/**
 * Status / in-flight message: on the HUD alert line while the main HUD is showing (the actionbar
 * text would overlap the flight panel), otherwise the actionbar.
 * @param {import("@minecraft/server").Player} player
 * @param {import("./state.js").SuitState|undefined} st
 * @param {string} text  actionbar text (§ colours allowed)
 * @param {{type?: "i"|"w"|"c", duration?: number, key?: string}} [opts]
 * @returns {"alert"|"actionbar"}
 */
export function notify(player, st, text, opts = {}) {
  if (st && hudShowing(st)) {
    const plain = stripFormat(String(text ?? "")).replace(/\s+/g, " ").trim().toUpperCase();
    pushAlert(st, opts.type ?? notifyType(text), plain, opts.duration ?? 50, opts.key);
    return "alert";
  }
  actionbar(player, text);
  return "actionbar";
}

/** Remove a sticky alert. */
export function clearAlert(st, key) {
  st.hud.alerts = st.hud.alerts.filter((a) => a.key !== key);
}

/**
 * Alert to show now (highest priority; one at a time, each for its own duration).
 * @returns {import("./state.js").AlertEntry|undefined}
 */
export function currentAlert(st, tick) {
  const h = st.hud;
  h.alerts = h.alerts.filter((a) => a.shownAt === undefined || tick < (a.until ?? 0));
  // higher priority first; within a priority the one already on screen stays, then FIFO
  const rank = (a) => PRIORITY[a.type] * 10 + (a.shownAt !== undefined ? 1 : 0);
  let best;
  for (const a of h.alerts) {
    if (!best || rank(a) > rank(best) || (rank(a) === rank(best) && a.seq < best.seq)) best = a;
  }
  if (best && best.shownAt === undefined) {
    best.shownAt = tick;
    best.until = tick + best.duration;
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// life cycle
// ---------------------------------------------------------------------------------------------

/** Start the boot overlay (mode 2). */
export function startBoot(player, st, tick) {
  st.hud.bootStart = tick;
  st.hud.bootUntil = tick + TUNING.BOOT_TICKS;
  st.hud.bootAnnounced = false;
  playerSound(player, SND.HUD_BOOT, 0.9);
}

/** Show the red power-failure overlay (mode 3) for 40 ticks. */
export function showFailure(st, tick) {
  st.hud.failStart = tick;
  st.hud.failUntil = tick + TUNING.FAILURE_TICKS;
  st.hud.bootUntil = 0;
}

/** @param {import("@minecraft/server").Player} player */
export function hideCrosshair(player) {
  quiet(() => player.onScreenDisplay.setHudVisibility(HudVisibility.Hide, [HudElement.Crosshair]));
}

/** @param {import("@minecraft/server").Player} player */
export function restoreCrosshair(player) {
  quiet(() => player.onScreenDisplay.setHudVisibility(HudVisibility.Reset, [HudElement.Crosshair]));
}

/** Send the single "HUD hidden" title. @param {import("@minecraft/server").Player} player */
export function sendHidden(player) {
  quiet(() => player.onScreenDisplay.setTitle(hiddenHudString(), TITLE_OPTIONS));
}

/**
 * Turn the HUD off now (title hidden, crosshair back). Overlays are cancelled.
 * @param {import("@minecraft/server").Player} player
 * @param {import("./state.js").SuitState} st
 * @param {{sound?: boolean}} [opts]
 */
export function forceOff(player, st, opts = {}) {
  const h = st.hud;
  h.bootUntil = 0;
  h.failUntil = 0;
  if (h.on) {
    h.on = false;
    sendHidden(player);
    restoreCrosshair(player);
    if (opts.sound) playerSound(player, SND.HUD_OFF, 0.9);
  }
  h.lastSent = "";
}

/**
 * Per-tick HUD update. `st.hudActive` must be computed before. `build()` returns the data
 * fields (everything but mode / alert / boot_text) and is only called when a title is sent.
 * @param {import("@minecraft/server").Player} player
 * @param {import("./state.js").SuitState} st
 * @param {number} tick
 * @param {(mode: string) => Record<string, unknown>} build
 * @param {(elapsed: number) => string} bootTextFn
 * @param {(elapsed: number) => string} failTextFn
 */
export function updateHud(player, st, tick, build, bootTextFn, failTextFn) {
  const h = st.hud;
  if (st.hudActive && !h.activePrev) startBoot(player, st, tick);
  if (!st.hudActive) h.bootUntil = 0;
  h.activePrev = st.hudActive;

  const failing = tick < h.failUntil;
  if (!st.hudActive && !failing) {
    if (h.alerts.length) h.alerts = []; // nothing piles up while the visor is open / HUD off
    if (h.on) {
      h.on = false;
      sendHidden(player);
      restoreCrosshair(player);
      h.lastSent = "";
    }
    return;
  }
  if (!h.on) {
    h.on = true;
    h.lastSent = "";
    hideCrosshair(player);
  }
  if ((tick + st.phase) % 2 !== 0 && h.lastSent) return;

  const mode = failing ? "3" : tick < h.bootUntil ? "2" : "1";
  const fields = build(mode);
  fields.mode = mode;
  fields.boot_text = mode === "2" ? bootTextFn(tick - h.bootStart) : mode === "3" ? failTextFn(tick - h.failStart) : "";
  const alert = mode === "1" ? currentAlert(st, tick) : undefined;
  fields.alert = alert ? alert.type : "0";
  fields.alert_text = alert ? alertText(alert.text) : "";
  const data = encodeHud(fields);
  if (data === h.lastSent && tick - h.lastSentTick < RESEND_TICKS) return;
  quiet(() => player.onScreenDisplay.setTitle(data, TITLE_OPTIONS));
  h.lastSent = data;
  h.lastSentTick = tick;
}
