// Mark V HUD data codec — pure functions (no "@minecraft/server"), unit-tested with node.
//
// The HUD travels as ONE title string: "MK5H" + fixed-width fields (tools/hud_protocol.json).
// Widths are UTF-8 BYTES because JSON UI cuts the string with '%.<n>s' (byte based), so every
// field is padded with ASCII spaces to its exact byte width and never split inside a character.

import { HUD_FIELDS, HUD_HEADER, HUD_TOTAL_BYTES } from "./hud_protocol.js";

// ---------------------------------------------------------------------------------------------
// UTF-8 helpers (QuickJS has no TextEncoder)
// ---------------------------------------------------------------------------------------------

/** UTF-8 byte length of one code point. */
function cpBytes(cp) {
  if (cp < 0x80) return 1;
  if (cp < 0x800) return 2;
  if (cp < 0x10000) return 3;
  return 4;
}

/** Number of UTF-8 bytes of `str`. */
export function utf8Length(str) {
  let n = 0;
  for (const ch of String(str)) n += cpBytes(ch.codePointAt(0) ?? 0);
  return n;
}

/**
 * Longest prefix of `str` that fits in `maxBytes` UTF-8 bytes, cut on a character boundary.
 * A dangling "§" (format code without its letter) is dropped.
 */
export function utf8Truncate(str, maxBytes) {
  let out = "";
  let used = 0;
  for (const ch of String(str)) {
    const b = cpBytes(ch.codePointAt(0) ?? 0);
    if (used + b > maxBytes) break;
    out += ch;
    used += b;
  }
  if (out.endsWith("§")) out = out.slice(0, -1);
  return out;
}

/** `str` truncated and padded with ASCII spaces to exactly `width` bytes. */
export function utf8Pad(str, width) {
  const cut = utf8Truncate(str, width);
  return cut + " ".repeat(width - utf8Length(cut));
}

/** Text fields: keep "\n", drop other control characters and lone surrogates. */
export function sanitizeText(value) {
  const s = (value === undefined || value === null ? "" : String(value)).replace(/\r\n?/g, "\n");
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0xd800 && cp <= 0xdfff) continue; // lone surrogate (pairs iterate as one char)
    if ((cp < 0x20 && cp !== 0x0a) || cp === 0x7f) continue;
    out += ch;
  }
  return out;
}

/** Remove Minecraft "§x" format codes (for names coming from name tags). */
export function stripFormat(str) {
  return String(str ?? "").replace(/§./g, "").replace(/§$/, "");
}

/**
 * Join lines with "\n", keeping only whole lines that fit in `maxBytes` (later lines are
 * dropped instead of being cut in the middle).
 */
export function joinLines(lines, maxBytes) {
  let out = "";
  for (const line of lines) {
    if (line === undefined || line === null) continue;
    const next = out ? `${out}\n${line}` : String(line);
    if (utf8Length(next) > maxBytes) {
      if (!out) out = utf8Truncate(String(line), maxBytes);
      break;
    }
    out = next;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// HUD encoding
// ---------------------------------------------------------------------------------------------

/** Default value of every field (HUD idle). */
export const HUD_DEFAULTS = Object.freeze({
  mode: "1",
  energy_pct: 0,
  energy_frame: 0,
  energy_state: "n",
  integrity_frame: 10,
  reticle: "i",
  lock_frame: "0",
  target_class: "0",
  target_hp_frame: 0,
  flight: "0",
  thrust_frame: 0,
  scan: "0",
  alert: "0",
  led_head: "0",
  led_chest: "0",
  led_arms: "0",
  led_legs: "0",
  lock_mode: "0",
  threat: "0",
  integrity_pct: 100,
  integrity_state: "n",
});

function encodeChar(value, fallback) {
  const s = value === undefined || value === null ? "" : String(value);
  const c = s.charAt(0);
  return /^[\x21-\x7e]$/.test(c) ? c : fallback;
}

/**
 * Digits fields printed as text by the UI ("RESISTÊNCIA 72%"): right-aligned with SPACES ("100",
 * " 72", "  5") because JSON UI cannot strip leading zeros reliably (SPEC 11 item 2). Every
 * other digits field stays zero-padded (texture frame names).
 */
export const SPACE_PADDED_FIELDS = Object.freeze(new Set(["integrity_pct"]));

function encodeDigits(value, width, pad = "0") {
  let n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 0) n = 0;
  const max = Math.pow(10, width) - 1;
  if (n > max) n = max;
  return String(n).padStart(width, pad);
}

/**
 * Build the HUD title string from a `{fieldName: value}` object.
 * The result is always exactly HUD_TOTAL_BYTES UTF-8 bytes.
 * @param {Record<string, unknown>} fields
 */
export function encodeHud(fields) {
  let out = HUD_HEADER;
  for (const f of HUD_FIELDS) {
    const raw = fields[f.name] ?? HUD_DEFAULTS[f.name];
    if (f.type === "char") out += encodeChar(raw, String(HUD_DEFAULTS[f.name] ?? "0").charAt(0) || "0");
    else if (f.type === "digits") out += encodeDigits(raw, f.width, SPACE_PADDED_FIELDS.has(f.name) ? " " : "0");
    else out += utf8Pad(sanitizeText(raw), f.width);
  }
  return out;
}

/** The single "HUD hidden" title (mode 0) sent when the HUD turns off. */
export function hiddenHudString() {
  return (HUD_HEADER + "0").padEnd(HUD_TOTAL_BYTES, " ");
}

export { HUD_FIELDS, HUD_HEADER, HUD_TOTAL_BYTES };

// ---------------------------------------------------------------------------------------------
// compass / bearings (Minecraft yaw: 0 = south +Z, 90 = west, -90 = east, 180 = north)
// ---------------------------------------------------------------------------------------------

export const BEARINGS = Object.freeze(["N", "NE", "L", "SE", "S", "SO", "O", "NO"]);

const norm360 = (deg) => ((deg % 360) + 360) % 360;
const wrap180 = (deg) => {
  const d = norm360(deg);
  return d > 180 ? d - 360 : d;
};

/** Compass heading (0 = north, 90 = east) from an entity yaw. */
export function headingFromYaw(yaw) {
  return norm360(Number(yaw) + 180);
}

/** 8-wind PT-BR name of a heading. */
export function bearingName(heading) {
  return BEARINGS[Math.round(norm360(heading) / 45) % 8];
}

/** Compass heading from `from` to `to` (only x/z matter). */
export function bearingTo(from, to) {
  return norm360((Math.atan2(to.x - from.x, -(to.z - from.z)) * 180) / Math.PI);
}

export const COMPASS_SLOTS = 25; // glyphs on the tape (all 6 px wide in the default font)
export const COMPASS_STEP = 4; // degrees per glyph -> +-48 degrees visible

const COMPASS_LABELS = [0, 45, 90, 135, 180, 225, 270, 315].map((deg, i) => ({ deg, text: BEARINGS[i] }));

/** Compass tape colours (drawn on the HUD's black notch). */
export const COMPASS_COLORS = Object.freeze({ filler: "§3", label: "§b", center: "§f", north: "§c" });

/**
 * One-line compass tape centered on `heading`: "-" filler and "+" every 15 degrees in dark
 * aqua, wind names in aqua (white near the center, N always red). Only "-", "+" and capital
 * letters are used so every glyph has the same width and the tape does not wobble as it scrolls.
 */
export function compassTape(heading, slots = COMPASS_SLOTS, step = COMPASS_STEP) {
  const h = norm360(Number(heading) || 0);
  const center = (slots - 1) / 2;
  const chars = new Array(slots).fill("-");
  const color = new Array(slots).fill(COMPASS_COLORS.filler);
  for (let i = 0; i < slots; i++) {
    const a = h + (i - center) * step;
    const m15 = Math.ceil((a - step / 2) / 15) * 15;
    if (m15 < a + step / 2) chars[i] = "+";
  }
  for (const label of COMPASS_LABELS) {
    const pos = center + wrap180(label.deg - h) / step;
    const first = Math.round(pos - (label.text.length - 1) / 2);
    const near = Math.abs(pos - center) <= 1.5;
    const tint = label.deg === 0 ? COMPASS_COLORS.north : near ? COMPASS_COLORS.center : COMPASS_COLORS.label;
    for (let k = 0; k < label.text.length; k++) {
      const i = first + k;
      if (i < 0 || i >= slots) continue;
      chars[i] = label.text[k];
      color[i] = tint;
    }
  }
  let out = "";
  let last = "";
  for (let i = 0; i < slots; i++) {
    if (color[i] !== last) {
      out += color[i];
      last = color[i];
    }
    out += chars[i];
  }
  return out;
}
