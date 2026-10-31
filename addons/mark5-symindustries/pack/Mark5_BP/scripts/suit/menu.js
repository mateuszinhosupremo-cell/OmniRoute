// Mark V control panel (SPEC 5.8): ActionFormData opened by using the Arc Reactor item.
// Actions are injected by index.js (visor, flight, scan, suit-off) so this module has no cycles.

import { system } from "@minecraft/server";
import { ActionFormData, FormCancelationReason } from "@minecraft/server-ui";
import { ICON, SND, TUNING as T } from "./constants.js";
import { FLIGHT_NAMES, costPct, energyPct, formatDuration, formatRate } from "./calc.js";
import { actionbar, playerSound, quiet } from "./fx.js";
import { getState } from "./state.js";

const MAX_BUSY_RETRIES = 10;
const RETRY_TICKS = 5;

/**
 * @typedef {Object} MenuActions
 * @property {(player: import("@minecraft/server").Player) => void} toggleVisor
 * @property {(player: import("@minecraft/server").Player, on: boolean) => void} setHud
 * @property {(player: import("@minecraft/server").Player) => void} toggleFlight
 * @property {(player: import("@minecraft/server").Player) => void} scan
 * @property {(player: import("@minecraft/server").Player, armed: boolean) => void} setLock
 * @property {(player: import("@minecraft/server").Player) => void} suitOff
 */

/**
 * Show a form, retrying while the player is busy (chat / another screen open).
 * @template T
 * @param {import("@minecraft/server").Player} player
 * @param {() => { show(p: import("@minecraft/server").Player): Promise<T> }} build
 * @param {(res: T) => void} onResult
 * @param {() => void} [onAbort] the form could not be shown / answered at all
 */
function showWithRetry(player, build, onResult, onAbort = () => {}, attempt = 0) {
  if (!quiet(() => player.isValid)) return onAbort();
  let promise;
  try {
    promise = build().show(player);
  } catch (err) {
    console.warn(`[Mark V] menu: ${err}`);
    return onAbort();
  }
  promise
    .then((res) => {
      const r = /** @type {any} */ (res);
      if (r?.canceled && r.cancelationReason === FormCancelationReason.UserBusy && attempt < MAX_BUSY_RETRIES) {
        system.runTimeout(() => showWithRetry(player, build, onResult, onAbort, attempt + 1), RETRY_TICKS);
        return;
      }
      if (!quiet(() => player.isValid)) return onAbort();
      try {
        onResult(res);
      } catch (err) {
        console.warn(`[Mark V] menu action: ${err}`);
      }
    })
    .catch((err) => {
      console.warn(`[Mark V] menu: ${err}`);
      onAbort();
    });
}

const visorName = (v) => (v === "closed" ? "§aFECHADO" : v === "open" ? "§6ABERTO" : "§7EM MOVIMENTO");

/** @param {import("./state.js").SuitState} st */
function powerLine(st) {
  const w = st.worn;
  if (!w) return "§7DESCONECTADA";
  if (w.dying) return "§6DESLIGANDO...";
  if (!w.powered || st.offline) return `§cOFFLINE §7(reinício em ${Math.round((T.REBOOT_AT / T.ENERGY_MAX) * 100)}%)`;
  return "§aONLINE";
}

/** @param {import("./state.js").SuitState} st */
function bodyText(st) {
  const pct = energyPct(st.energy);
  const color = pct <= 10 ? "§c" : pct < 25 ? "§6" : "§b";
  const flight = st.flight ? `§b${FLIGHT_NAMES[st.flight.mode] ?? "?"}` : "§7em solo";
  const lock = st.lock.armed ? (st.lock.targetId ? `§cTRAVADA §7(${st.lock.targetName ?? "alvo"})` : "§cARMADA") : "§7DESARMADA";
  return [
    `§7Energia: ${color}${pct}% §7(${Math.round(st.energy)}/${T.ENERGY_MAX})  ${st.rate >= 0 ? "§a" : "§c"}${formatRate(st.rate)}`,
    `§7Estado: ${powerLine(st)}`,
    `§7Visor: ${st.worn ? visorName(st.worn.visor) : "§7—"}`,
    `§7Voo: ${flight}`,
    `§7Mira teleguiada: ${lock}`,
    `§7Integridade da armadura: §f${st.integrity.pct}%`,
  ].join("\n");
}

/**
 * Open the control panel.
 * @param {import("@minecraft/server").Player} player
 * @param {MenuActions} actions
 */
export function openMenu(player, actions) {
  const st = getState(player);
  if (st.menuOpen) return;
  st.menuOpen = true;
  playerSound(player, SND.MENU, 0.8);
  const noPower = !st.worn?.powered;
  const tag = noPower ? "\n§c(sem energia)" : "";
  const visorOpen = st.worn?.visor === "open" || st.worn?.visor === "opening";
  const buttons = [
    { id: "visor", label: visorOpen ? "Fechar visor" : "Abrir visor", icon: ICON.VISOR },
    { id: "hud", label: (st.hudEnabled ? "HUD: §aLIGADO" : "HUD: §cDESLIGADO") + tag, icon: ICON.HUD },
    { id: "flight", label: (st.flight ? "Pousar" : "Decolar") + tag, icon: ICON.FLIGHT },
    { id: "scan", label: "Scanner de área" + tag, icon: ICON.SCAN },
    { id: "lock", label: (st.lock.armed ? "Mira teleguiada: §cARMADA" : "Mira teleguiada: §7DESARMADA") + tag, icon: ICON.LOCK },
    { id: "diag", label: "Diagnóstico de energia", icon: ICON.DIAG },
    { id: "off", label: "Desmontar armadura", icon: ICON.SUITOFF },
  ];
  const build = () => {
    const form = new ActionFormData().title("§l§cMARK V§r §7— Painel de Controle").body(bodyText(getState(player)));
    for (const b of buttons) form.button(b.label, b.icon);
    return form;
  };
  showWithRetry(
    player,
    build,
    (res) => {
      st.menuOpen = false;
      if (res.canceled || res.selection === undefined) return;
      const b = buttons[res.selection];
      if (!b) return;
      const cur = getState(player);
      const powered = !!cur.worn?.powered;
      switch (b.id) {
        case "visor":
          actions.toggleVisor(player);
          break;
        case "hud":
          actions.setHud(player, !cur.hudEnabled);
          if (!powered) actionbar(player, "§7Preferência salva §8— §csem energia§7, o HUD liga no reinício");
          break;
        case "flight":
          if (!powered && !cur.flight) actionbar(player, "§cSem energia §7— propulsores offline");
          else actions.toggleFlight(player);
          break;
        case "scan":
          if (!powered) actionbar(player, "§cSem energia §7— scanner offline");
          else actions.scan(player);
          break;
        case "lock":
          actions.setLock(player, !cur.lock.armed);
          if (!powered) actionbar(player, "§7Mira salva §8— §csem energia§7, ativa no reinício");
          break;
        case "diag":
          openDiagnostics(player, actions);
          break;
        case "off":
          actions.suitOff(player);
          break;
      }
    },
    () => {
      st.menuOpen = false;
    }
  );
  // the promise may never resolve if the player leaves: unlock the menu after a while
  system.runTimeout(() => {
    if (st.menuOpen) st.menuOpen = false;
  }, 20 * 60);
}

/**
 * One-shot costs of the diagnostics screen (SPEC 10: the visor servos count here).
 * @param {import("./state.js").SuitState} st
 * @returns {string[]}
 */
export function oneShotLines(st, tick) {
  const lines = [
    `§7Custos pontuais: §fservos do visor §c-${T.VISOR_COST} §8(${costPct(T.VISOR_COST)}% por abertura/fechamento)`,
    `§7Decolagem §c-${T.TAKEOFF_COST} §7· Scanner §c-${T.SCAN_COST} §7· Trava da mira §c-${T.LOCK_ACQUIRE_COST}`,
  ];
  const o = st.oneShot;
  if (o) {
    const ago = Math.max(0, (tick - o.tick) / 20);
    lines.push(`§7Último: §f${o.name} §c-${o.cost} §8(-${costPct(o.cost)}%, há ${formatDuration(ago)})`);
  }
  return lines;
}

/**
 * Consumption breakdown screen.
 * @param {import("@minecraft/server").Player} player
 * @param {MenuActions} actions
 */
export function openDiagnostics(player, actions) {
  const build = () => {
    const st = getState(player);
    const d = st.drain;
    const line = (label, v) => `§7${label} ${v > 0 ? "§c" : "§8"}${formatRate(-v)}`;
    const eta =
      st.rate > 0.01
        ? `§7Carga completa em §f${formatDuration((T.ENERGY_MAX - st.energy) / st.rate)}`
        : st.rate < -0.01
          ? `§7Autonomia: §c${formatDuration(st.energy / -st.rate)}`
          : "§7Consumo equilibrado";
    const body = [
      `§bEnergia: §f${Math.round(st.energy)}/${T.ENERGY_MAX} (${energyPct(st.energy)}%)`,
      "",
      `§7Reator Arc §a${formatRate(T.REGEN)}`,
      line("LEDs do reator", d.reactor),
      line("LEDs dos braços", d.arms),
      line("LEDs das pernas", d.legs),
      line("LEDs dos olhos", d.eyes),
      line("HUD", d.hud),
      line("Voo", d.flight),
      line("Mira teleguiada", d.lock),
      "",
      `§fSaldo ${st.rate >= 0 ? "§a" : "§c"}${formatRate(st.rate)}`,
      eta,
      "",
      ...oneShotLines(st, system.currentTick),
      "",
      `§7Escudo de energia: absorve §f${Math.round(T.SHIELD_FRACTION * 100)}%§7 do dano (§f${T.SHIELD_COST_PER_HP}§7 de energia por ponto)`,
      `§7Proteção da armadura: §f${st.worn ? st.worn.protection : 0}`,
      `§7Integridade: §f${st.integrity.pct}%  §7Calor dos propulsores: §f${Math.round(st.heat)}%`,
    ].join("\n");
    return new ActionFormData().title("§l§bDIAGNÓSTICO DE ENERGIA").body(body).button("Voltar");
  };
  showWithRetry(player, build, (res) => {
    if (!res.canceled && res.selection === 0) system.run(() => openMenu(player, actions));
  });
}
