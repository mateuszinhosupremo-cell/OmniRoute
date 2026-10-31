// Dumps, for every sample HUD state, the resolved dynamic properties (visible / text / texture)
// of every control of the generated namespace, keyed by control path. Consumed by preview.py.
// Usage: node tools/hud/dump_resolved.mjs > out.json
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTree, encodeHud } from "./jsonui_eval.mjs";
import { STATES, EXTRA_STATES } from "./sample_states.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const proto = JSON.parse(readFileSync(join(ROOT, "tools", "hud_protocol.resolved.json"), "utf8"));
const ns = JSON.parse(readFileSync(join(ROOT, "pack", "Mark5_RP", "ui", "sym_mk5_hud.json"), "utf8"));

/** Extra state whose texts come from the REAL script text builders (if the BP scripts exist). */
async function scriptState() {
  try {
    const t = await import(join(ROOT, "pack", "Mark5_BP", "scripts", "suit", "texts.js"));
    const c = await import(join(ROOT, "pack", "Mark5_BP", "scripts", "suit", "codec.js"));
    const drain = { reactor: 0.3, arms: 0.3, legs: 0.3, eyes: 0.1, hud: 1, lock: 0.6, flight: 7 };
    return {
      title: "real script texts (cruise + target + scan)",
      fields: {
        ...STATES.flight.fields,
        energy_pct: "058", energy_frame: "12", energy_state: "n", alert: "i", flight: "f", integrity_pct: "081", integrity_state: "n", integrity_frame: "08",
        compass: c.compassTape(212),
        coords_text: t.coordsText({ x: -1204.6, y: 141.2, z: 388.9 }, 212),
        energy_text: t.energyText(58, "n", -5.6),
        suit_text: t.suitText({ powered: true, visor: "closed", protection: 20, integrity: 81 }),
        systems_text: t.systemsText({ regen: 4, drain, flightMode: "cruise", lockArmed: true, heat: 22, shieldPct: 40 }),
        target_text: t.targetText({ name: "Esqueleto Wither", cls: "h", threat: "ALTA", dist: 23.4, hp: 17, maxHp: 20, provoked: false }),
        flight_text: t.flightText({ mode: "cruise", alt: 141, agl: 72, speed: 15, thrust: 62, heat: 22 }),
        scan_text: t.scanText({ radius: 32, counts: { h: 3, n: 1, p: 4, j: 0 }, sweeping: false, entries: [
          { cls: "h", name: "Creeper", dist: 8.2, bearing: 40, hp: 20 },
          { cls: "h", name: "Esqueleto", dist: 14.9, bearing: 95, hp: 18 },
          { cls: "h", name: "Aranha das Cavernas", dist: 27.0, bearing: 300, hp: 12 },
          { cls: "n", name: "Enderman", dist: 21.4, bearing: 180, hp: 40 },
          { cls: "p", name: "Ovelha", dist: 9.1, bearing: 10, hp: 8 },
          { cls: "p", name: "Galinha", dist: 25.5, bearing: 260, hp: 4 },
        ] }),
        alert_text: t.alertText("§bALVO TRAVADO: Esqueleto Wither"),
      },
    };
  } catch (e) {
    process.stderr.write(`script texts unavailable: ${e.message}\n`);
    return null;
  }
}

const out = {};
const extra = await scriptState();
const all = { ...STATES, ...EXTRA_STATES };
if (extra) all.script_texts = extra;
for (const [key, st] of Object.entries(all)) {
  const { title } = encodeHud(proto, st.fields);
  const nodes = {};
  for (const n of resolveTree(ns, "root", title)) {
    nodes[n.path] = { visible: n.visible, text: n.own.text ?? null, texture: n.own.texture ?? null };
  }
  out[key] = { title: st.title || key, nodes };
}
process.stdout.write(JSON.stringify(out));
