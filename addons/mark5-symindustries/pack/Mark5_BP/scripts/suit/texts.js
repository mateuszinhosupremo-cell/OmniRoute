// Mark V HUD texts — pure builders (no "@minecraft/server"), unit-tested with node.
// Every builder returns a string that fits its protocol field (whole lines are dropped rather than
// cut). All player-facing text is Brazilian Portuguese.

import { HUD_FIELDS, bearingName, joinLines, utf8Truncate } from "./codec.js";
import { FLIGHT_NAMES, costPct, formatRate } from "./calc.js";
import { CLASS_COLOR, CLASS_LABEL, THREAT_COLOR, shortName } from "./mobs.js";

/** Byte width of a protocol field. */
export function fieldWidth(name) {
  const f = HUD_FIELDS.find((x) => x.name === name);
  if (!f) throw new Error(`unknown HUD field ${name}`);
  return f.width;
}

const W = Object.freeze({
  compass: fieldWidth("compass"),
  coords: fieldWidth("coords_text"),
  energy: fieldWidth("energy_text"),
  suit: fieldWidth("suit_text"),
  systems: fieldWidth("systems_text"),
  target: fieldWidth("target_text"),
  flight: fieldWidth("flight_text"),
  scan: fieldWidth("scan_text"),
  alert: fieldWidth("alert_text"),
  boot: fieldWidth("boot_text"),
});
export const TEXT_WIDTHS = W;

const pad3 = (n) => String(Math.max(0, Math.min(999, Math.round(n)))).padStart(3, "0");
const fmtDist = (d) => (d < 10 ? d.toFixed(1) : String(Math.round(d)));

/** Energy line next to the gauge: "§b087% §7+2.0/s" */
export function energyText(pct, state, rate) {
  const c = state === "c" ? "§c" : state === "w" ? "§6" : "§b";
  return utf8Truncate(`${c}${pad3(pct)}% §7${formatRate(rate)}`, W.energy);
}

/** Position line: "§7123 64 -45 §b012° NE" */
export function coordsText(loc, heading) {
  const h = Math.round(heading) % 360;
  const p = `§7${Math.floor(loc.x)} ${Math.floor(loc.y)} ${Math.floor(loc.z)}`;
  return utf8Truncate(`${p} §b${pad3(h)}° ${bearingName(h)}`, W.coords);
}

/**
 * Energy-shield status line: ATIVO, FRACO (energy critical) or OFF (no power / offline).
 * @param {boolean} ready  the shield can absorb a hit right now (energy.shieldReady)
 * @param {string} [eState] energy state "n" | "w" | "c"
 */
export function shieldStatus(ready, eState = "n") {
  if (!ready) return "§7ESCUDO §cOFF";
  return eState === "c" ? "§7ESCUDO §6FRACO" : "§7ESCUDO §bATIVO";
}

/**
 * Under the 3D armor view (3 lines). The integrity percentage is drawn big by the HUD itself, so
 * the third line is the energy-shield status.
 * @param {{powered: boolean, dying?: boolean, visor: string, protection: number, shield: boolean,
 *   energyState?: string}} s
 */
export function suitText(s) {
  const state = s.powered ? "§aONLINE" : s.dying ? "§6FALHA" : "§cOFFLINE";
  const visor = s.visor === "closed" ? "FECHADO" : s.visor === "open" ? "ABERTO" : "MOVENDO";
  return joinLines(
    [`§bMARK V ${state}`, `§7PROT §f${s.protection} §7VISOR §f${visor}`, shieldStatus(s.shield, s.energyState)],
    W.suit
  );
}

/** HUD alert of a one-shot energy cost: "-1% visor" (SPEC 10). */
export function oneShotAlert(key, cost) {
  return utf8Truncate(`-${costPct(cost)}% ${key}`, W.alert);
}

/**
 * Systems list (left, lower): up to 6 lines.
 * @param {{regen: number, drain: {reactor:number, arms:number, legs:number, eyes:number, hud:number,
 *   lock:number, flight:number}, flightMode?: string, lockArmed: boolean, locked?: boolean,
 *   heat: number, overheated?: boolean, shieldPct: number}} s
 */
export function systemsText(s) {
  const d = s.drain;
  const leds = d.reactor + d.arms + d.legs + d.eyes;
  const flight = s.flightMode
    ? `§7VOO §f${FLIGHT_NAMES[s.flightMode] ?? "?"} §c${formatRate(-d.flight)}`
    : "§7VOO §8EM ESPERA";
  const lock = s.lockArmed
    ? `§7MIRA ${s.locked ? "§cTRAVADA" : "§cARMADA"} §f${formatRate(-d.lock)}`
    : "§7MIRA §8DESARMADA";
  const heat = s.overheated ? `§cSUPERAQUECIDO ${pad3(s.heat)}%` : `§7CALOR §f${pad3(s.heat)}%`;
  return joinLines(
    [
      `§7REATOR ARC §a${formatRate(s.regen)}`,
      `§7LEDs §f${formatRate(-leds)} §7HUD §f${formatRate(-d.hud)}`,
      flight,
      lock,
      `§7ESCUDO §a${s.shieldPct}%`,
      heat,
    ],
    W.systems
  );
}

/**
 * Target analysis (right panel): up to 4 lines.
 * @param {{name: string, cls: string, threat: string, dist: number, hp: number, maxHp: number,
 *   locked?: boolean, provoked?: boolean}} t
 */
export function targetText(t) {
  const tag = t.locked ? " §c[TRAVADO]" : "";
  const label = t.provoked && t.cls === "h" ? "§cHOSTIL §7(provocado)" : CLASS_LABEL[t.cls] ?? "§7?";
  return joinLines(
    [
      `§f${shortName(t.name, 20)}${tag}`,
      `${label} §7AMEAÇA ${THREAT_COLOR[t.threat] ?? "§f"}${t.threat}`,
      `§7DIST §f${t.dist.toFixed(1)}m`,
      `§7VIDA §f${Math.ceil(t.hp)}/${Math.round(t.maxHp)}`,
    ],
    W.target
  );
}

/**
 * Flight telemetry (bottom center): 3 lines.
 * @param {{mode: string, alt: number, agl?: number, speed: number, thrust: number, heat: number,
 *   overheated?: boolean, icing?: boolean}} f
 */
export function flightText(f) {
  const name = FLIGHT_NAMES[f.mode] ?? "?";
  const c = f.mode === "emergency" ? "§c" : f.mode === "boost" ? "§6" : "§b";
  const agl = f.agl === undefined ? ">64" : String(Math.round(f.agl));
  const heat = f.overheated ? `§cSUPERAQUECIDO ${pad3(f.heat)}%` : `§7CALOR §f${pad3(f.heat)}%`;
  return joinLines(
    [
      `${c}${name} §7ALT §f${Math.round(f.alt)} §7SOLO §f${agl}m`,
      `§7VEL §f${f.speed.toFixed(1)}m/s §7EMPUXO §f${pad3(f.thrust)}%`,
      `${heat}${f.icing ? " §bGELO" : ""}`,
    ],
    W.flight
  );
}

/**
 * Area scan results (right top): header + up to 6 entries.
 * @param {{radius: number, counts: {h:number, n:number, p:number, j:number}, sweeping: boolean,
 *   entries: Array<{cls: string, name: string, dist: number, bearing: number, hp: number}>}} s
 */
export function scanText(s) {
  const c = s.counts;
  const head =
    `§bSCAN ${s.radius}m §c• ${c.h} hostis §f• ${c.n} neutros §a• ${c.p} pacíficos` +
    (c.j ? ` §b• ${c.j} jog.` : "");
  const lines = [s.sweeping ? `${head} §7...` : head];
  for (const e of s.entries.slice(0, 6)) {
    lines.push(
      `${CLASS_COLOR[e.cls] ?? "§f"}■ ${shortName(e.name, 12)} §7${fmtDist(e.dist)}m ${bearingName(e.bearing)} ${Math.ceil(e.hp)}hp`
    );
  }
  if (!s.entries.length && !s.sweeping) lines.push("§7Nenhuma entidade detectada");
  return joinLines(lines, W.scan);
}

/**
 * Boot overlay (mode 2): lines appear one by one.
 * @param {number} elapsed ticks since the boot started
 * @param {{pct: number, flightReady: boolean, name?: string}} s
 */
export function bootText(elapsed, s) {
  const lines = [
    "§b§lSYM INDUSTRIES§r §7MARK V",
    `§7Reator Arc ....... §a${pad3(s.pct)}%`,
    "§7Blindagem ........ §aOK",
    "§7Sensores/scanner . §aOK",
    `§7Propulsores ...... ${s.flightReady ? "§aOK" : "§6BAIXA"}`,
    "§b§lHUD ONLINE",
  ];
  const shown = Math.max(1, Math.min(lines.length, Math.floor(elapsed / 7) + 1));
  return joinLines(lines.slice(0, shown), W.boot);
}

/** Power-failure overlay (mode 3). */
export function failureText(elapsed) {
  const lines = [
    "§c§lSISTEMAS OFFLINE",
    "§cENERGIA ESGOTADA",
    "§7LEDs desligados",
    "§7Escudo e propulsores inativos",
    "§7Reinício automático em 15%",
  ];
  const shown = Math.max(1, Math.min(lines.length, Math.floor(elapsed / 5) + 1));
  return joinLines(lines.slice(0, shown), W.boot);
}

/** Alert banner text (one line). */
export function alertText(text) {
  return utf8Truncate(String(text ?? "").replace(/\n/g, " "), W.alert);
}
