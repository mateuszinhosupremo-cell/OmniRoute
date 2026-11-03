// Unit tests for the engine-free Mark V script modules (node:test).
// Run: node --test tests/script_pure.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SUIT = join(ROOT, "pack/Mark5_BP/scripts/suit");
const mod = (name) => import(join(SUIT, name));

const C = await mod("constants.js");
const codec = await mod("codec.js");
const calc = await mod("calc.js");
const mobs = await mod("mobs.js");
const texts = await mod("texts.js");
const state = await mod("state.js");
const proto = await mod("hud_protocol.js");

const utf8 = (s) => Buffer.byteLength(s, "utf8");
/** JSON UI style extraction: ('%.<end>s' * s) - ('%.<start>s' * s), byte based */
const field = (s, name) => {
  const f = proto.HUD_FIELDS.find((x) => x.name === name);
  return Buffer.from(s, "utf8").subarray(f.start, f.end).toString("utf8");
};

// ---------------------------------------------------------------------------------------------
test("pure modules never import @minecraft/server", () => {
  for (const f of ["constants.js", "codec.js", "calc.js", "mobs.js", "texts.js", "state.js", "hud_protocol.js"]) {
    const src = readFileSync(join(SUIT, f), "utf8");
    assert.ok(!/^\s*(import|export)[^\n]*from\s+"@minecraft\//m.test(src) && !/^\}\s*from\s+"@minecraft\//m.test(src), `${f} imports an engine module`);
  }
});

test("every script file only imports existing relative modules / allowed engine modules", () => {
  const dirs = [join(ROOT, "pack/Mark5_BP/scripts"), SUIT];
  for (const dir of dirs) {
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".js"))) {
      const src = readFileSync(join(dir, f), "utf8");
      for (const m of src.matchAll(/^(?:import|export|\})[^\n]*from\s+"([^"]+)"/gm)) {
        const spec = m[1];
        if (spec.startsWith(".")) {
          assert.ok(readdirSync(dirname(join(dir, spec))).includes(spec.split("/").pop()), `${f}: ${spec}`);
        } else {
          assert.ok(["@minecraft/server", "@minecraft/server-ui"].includes(spec), `${f}: ${spec}`);
        }
      }
    }
  }
});

test("manifest declares server 2.3.0 (SPEC 12.1) + server-ui 2.0.0 and version 2.0.0", () => {
  const m = JSON.parse(readFileSync(join(ROOT, "pack/Mark5_BP/manifest.json"), "utf8"));
  assert.deepEqual(m.header.version, [2, 0, 0]);
  assert.deepEqual(m.header.min_engine_version, [1, 26, 0]);
  for (const x of m.modules) assert.deepEqual(x.version, [2, 0, 0]);
  const deps = Object.fromEntries(m.dependencies.filter((d) => d.module_name).map((d) => [d.module_name, d.version]));
  assert.equal(deps["@minecraft/server"], "2.3.0");
  const ts = JSON.parse(readFileSync(join(ROOT, "tests/typecheck/tsconfig.json"), "utf8"));
  assert.match(ts.compilerOptions.paths["@minecraft/server"][0], /minecraft-server-2\.3\.0\/package\/index\.d\.ts$/);
  assert.equal(deps["@minecraft/server-ui"], "2.0.0");
  const rp = m.dependencies.find((d) => d.uuid);
  assert.deepEqual(rp.version, [2, 0, 0]);
  assert.equal(m.header.uuid, "c7e2f915-2b84-4d3c-a6f7-1e5d8b9c0a43");
});

// ---------------------------------------------------------------------------------------------
test("generated protocol matches the resolved json and ends with integrity fields", () => {
  const resolved = JSON.parse(readFileSync(join(ROOT, "tools/hud_protocol.resolved.json"), "utf8"));
  assert.equal(proto.HUD_TOTAL_BYTES, resolved.totalBytes);
  assert.deepEqual(proto.HUD_FIELDS.map((f) => [f.name, f.start, f.end]), resolved.fields.map((f) => [f.name, f.start, f.end]));
  const names = proto.HUD_FIELDS.map((f) => f.name);
  assert.deepEqual(names.slice(-2), ["integrity_pct", "integrity_state"]);
});

test("encodeHud: constant byte length, every field decodes back", () => {
  const fields = {
    mode: "1",
    energy_pct: 87,
    energy_frame: 17,
    energy_state: "n",
    integrity_frame: 9,
    integrity_pct: 93,
    integrity_state: "n",
    reticle: "h",
    lock_frame: "3",
    target_class: "h",
    target_hp_frame: 6,
    flight: "b",
    thrust_frame: 10,
    scan: "2",
    alert: "c",
    led_head: "1",
    led_chest: "1",
    led_arms: "1",
    led_legs: "1",
    lock_mode: "1",
    threat: "1",
    compass: codec.compassTape(10),
    coords_text: "§7123 64 -45 §b012° NE",
    energy_text: "§b087% §7+2.0/s",
    suit_text: "ÁÉÍÓÚ çãõ ".repeat(20), // too long: must be cut on a character boundary
    target_text: "§fZumbi\n§cHOSTIL",
    alert_text: "POUSO DE EMERGÊNCIA",
  };
  const s = codec.encodeHud(fields);
  assert.equal(utf8(s), proto.HUD_TOTAL_BYTES);
  assert.ok(s.startsWith("MK5H1"));
  assert.equal(field(s, "energy_pct"), "087");
  assert.equal(field(s, "energy_frame"), "17");
  assert.equal(field(s, "integrity_pct"), " 93", "SPEC 11 item 2: right-aligned with spaces");
  assert.equal(field(s, "integrity_state"), "n");
  assert.equal(field(s, "reticle"), "h");
  assert.equal(field(s, "lock_frame"), "3");
  assert.equal(field(s, "flight"), "b");
  assert.equal(field(s, "alert_text").trimEnd(), "POUSO DE EMERGÊNCIA");
  assert.equal(field(s, "target_text").trimEnd(), "§fZumbi\n§cHOSTIL");
  assert.ok(!field(s, "suit_text").includes("�"), "multi-byte character split");
  // defaults: empty object still has the full length and sane values
  const d = codec.encodeHud({});
  assert.equal(utf8(d), proto.HUD_TOTAL_BYTES);
  assert.equal(field(d, "integrity_pct"), "100");
  assert.equal(field(d, "integrity_state"), "n");
  assert.equal(field(d, "target_class"), "0");
  // out of range digits are clamped, junk chars fall back
  const j = codec.encodeHud({ energy_pct: 4000, energy_frame: -3, reticle: "", integrity_pct: 250 });
  assert.equal(field(j, "energy_pct"), "999");
  assert.equal(field(j, "energy_frame"), "00");
  assert.equal(field(j, "integrity_pct"), "250");
  // SPEC 11 item 2: integrity_pct is right-aligned with SPACES, every other digits field keeps zeros
  for (const [v, want] of [[100, "100"], [72, " 72"], [5, "  5"], [0, "  0"], [-4, "  0"], ["x", "  0"], [59.6, " 60"]]) {
    assert.equal(field(codec.encodeHud({ integrity_pct: v }), "integrity_pct"), want, `integrity_pct ${v}`);
  }
  assert.equal(field(codec.encodeHud({ energy_pct: 5, energy_frame: 9 }), "energy_pct"), "005");
  assert.equal(field(codec.encodeHud({ energy_frame: 9 }), "energy_frame"), "09");
  assert.deepEqual([...codec.SPACE_PADDED_FIELDS], ["integrity_pct"]);
  assert.equal(field(j, "reticle"), "i");
});

test("hidden HUD string", () => {
  const h = codec.hiddenHudString();
  assert.equal(utf8(h), proto.HUD_TOTAL_BYTES);
  assert.ok(h.startsWith("MK5H0"));
  assert.equal(h.trimEnd(), "MK5H0");
});

test("utf8 helpers", () => {
  assert.equal(codec.utf8Length("aé€😀"), 1 + 2 + 3 + 4);
  assert.equal(codec.utf8Truncate("ééé", 5), "éé");
  assert.equal(codec.utf8Truncate("ab§c", 3), "ab"); // dangling § dropped
  assert.equal(utf8(codec.utf8Pad("ção", 8)), 8);
  assert.equal(codec.sanitizeText("a\r\nb\tc\u0007"), "a\nbc");
  assert.equal(codec.stripFormat("§cBob§r"), "Bob");
  assert.equal(codec.joinLines(["aaaa", "bbbb", "cccc"], 9), "aaaa\nbbbb");
});

test("compass tape fits its field for every heading and is centred", () => {
  const w = texts.TEXT_WIDTHS.compass;
  for (let h = 0; h < 360; h += 1) {
    const t = codec.compassTape(h);
    assert.ok(utf8(t) <= w, `heading ${h}: ${utf8(t)} bytes`);
    assert.equal(codec.stripFormat(t).length, codec.COMPASS_SLOTS);
  }
  assert.equal(codec.stripFormat(codec.compassTape(0))[(codec.COMPASS_SLOTS - 1) / 2], "N");
  assert.equal(codec.stripFormat(codec.compassTape(90))[(codec.COMPASS_SLOTS - 1) / 2], "L");
  assert.equal(codec.headingFromYaw(180), 0); // yaw 180 looks north (-Z)
  assert.equal(codec.headingFromYaw(-90), 90); // east
  assert.equal(codec.bearingName(225), "SO");
  assert.equal(Math.round(codec.bearingTo({ x: 0, z: 0 }, { x: 0, z: -5 })), 0);
  assert.equal(Math.round(codec.bearingTo({ x: 0, z: 0 }, { x: 5, z: 0 })), 90);
});

// ---------------------------------------------------------------------------------------------
test("variant table matches SPEC 2.1 + 11.1 (flying twins, power-up item)", () => {
  assert.equal(C.SUIT_IDS.length, 12);
  const row = (id) => C.VARIANTS[id];
  assert.equal(row("sym:mark_5").visor, "closed");
  assert.equal(row("sym:mark_5_offline").protection, 8);
  assert.equal(row("sym:mark_5_powerdown").protection, 20);
  for (const id of C.SUIT_IDS) {
    const v = row(id);
    assert.ok(C.isSuitId(v.final) && !C.isTempVariant(v.final), `${id} final ${v.final}`);
    assert.equal(v.temp, ["opening", "closing"].includes(v.visor) || id === C.POWERDOWN_ID || id === C.POWERUP_ID, id);
    assert.equal(v.flying, id.endsWith("_flying"), id);
    // variantFor never yields a flying twin or the power-up item (both are worn by the script only)
    if (!v.flying && id !== C.POWERUP_ID) assert.equal(C.variantFor({ powered: v.powered, visor: v.visor, dying: v.dying }), id);
    assert.equal(C.groundTwin(id), v.flying ? v.ground : id);
  }
  // SPEC 11.1 flying twins: powered finals only, protection 20, same visor as their ground twin
  assert.equal(C.flyingTwin("sym:mark_5"), "sym:mark_5_flying");
  assert.equal(C.flyingTwin("sym:mark_5_open"), "sym:mark_5_open_flying");
  for (const id of ["sym:mark_5_opening", "sym:mark_5_offline", "sym:mark_5_powerup", "sym:mark_5_flying", undefined]) {
    assert.equal(C.flyingTwin(id), undefined, String(id));
  }
  assert.equal(C.groundTwin("sym:mark_5_flying"), "sym:mark_5");
  assert.equal(C.groundTwin("sym:mark_5_open_flying"), "sym:mark_5_open");
  for (const id of ["sym:mark_5_flying", "sym:mark_5_open_flying"]) {
    const v = row(id);
    assert.ok(v.powered && !v.temp && v.final === id && v.protection === 20, id);
    assert.equal(v.visor, row(v.ground).visor);
  }
  const up = row(C.POWERUP_ID);
  assert.ok(up.powered && up.temp && up.visor === "closed" && up.final === "sym:mark_5" && up.protection === 20);
  assert.equal(C.finalOf("sym:mark_5_opening"), "sym:mark_5_open");
  assert.equal(C.finalOf("sym:mark_5_offline_closing"), "sym:mark_5_offline");
  assert.equal(C.finalOf("sym:mark_5_powerdown"), "sym:mark_5_offline");
  assert.equal(C.isSuitId("sym:mark_5_assembling_4"), false);
  assert.equal(C.isSuitId(undefined), false);
  assert.deepEqual(C.TRANSITION_TICKS, { visor: 16, powerdown: 24, powerup: 24 });
});

test("tuning numbers match SPEC 6", () => {
  const T = C.TUNING;
  const expect = {
    ENERGY_MAX: 1000, REGEN: 4, LED_REACTOR: 0.3, LED_ARMS: 0.3, LED_LEGS: 0.3, LED_EYES: 0.1,
    HUD_DRAIN: 1, LOCK_DRAIN: 0.6, FLIGHT_HOVER: 4, FLIGHT_CRUISE: 7, FLIGHT_BOOST: 16,
    FLIGHT_EMERGENCY: 0, TAKEOFF_COST: 15, SCAN_COST: 50, LOCK_ACQUIRE_COST: 5,
    FLIGHT_MIN_ENERGY: 60, EMERGENCY_AT: 30, REBOOT_AT: 150, SHIELD_FRACTION: 0.4,
    SHIELD_COST_PER_HP: 12, CRUISE_SPEED: 0.75, BOOST_SPEED: 1.6, STRAFE_SPEED: 0.45,
    VERT_UP: 0.45, VERT_DOWN: 0.5, ACCEL_HOVER: 0.25, ACCEL_CRUISE: 0.18, ACCEL_BOOST: 0.1,
    TARGET_RANGE: 48, SCAN_RADIUS: 32, SCAN_MARK_TICKS: 240, LOCK_RANGE: 64,
    NV_DRAIN: 0.5, NV_SAMPLE_TICKS: 10, NV_ON_LEVEL: 6, NV_ON_SAMPLES: 2, NV_OFF_LEVEL: 9,
    NV_DURATION: 400, NV_REFRESH_BELOW: 300, SUITUP_COST: 80, SUITOFF_COST: 40,
  };
  for (const [k, v] of Object.entries(expect)) assert.equal(T[k], v, k);
});

// ---------------------------------------------------------------------------------------------
test("energy drain breakdown (SPEC 5.1)", () => {
  const base = { worn: true, powered: true, busy: false, visor: "closed", hudOn: true, lockArmed: false };
  const d = calc.computeDrain(base);
  assert.equal(+d.total.toFixed(3), 0.3 * 3 + 0.1 + 1.0);
  const open = calc.computeDrain({ ...base, visor: "open" });
  assert.equal(open.eyes, 0);
  assert.equal(open.hud, 0);
  assert.equal(calc.computeDrain({ ...base, lockArmed: true, flightMode: "boost" }).flight, 16);
  assert.equal(calc.computeDrain({ ...base, flightMode: "emergency" }).flight, 0);
  assert.equal(calc.computeDrain({ ...base, busy: true }).total, 0);
  assert.equal(calc.computeDrain({ ...base, powered: false }).total, 0);
  assert.equal(calc.computeDrain({ worn: false }).total, 0);
  // SPEC 12.1: our night vision drains 0.5/s, only while powered
  const nv = calc.computeDrain({ ...base, nvOn: true });
  assert.equal(nv.nv, 0.5);
  assert.equal(+nv.total.toFixed(3), +(d.total + 0.5).toFixed(3));
  assert.equal(calc.computeDrain({ ...base, nvOn: true, powered: false }).nv, 0);
  assert.equal(d.nv, 0);
});

test("auto night vision: day factor, effective light, hysteresis (SPEC 12.1)", () => {
  assert.equal(calc.nvDayFactor(6000), 1);
  assert.equal(calc.nvDayFactor(0), 1);
  assert.equal(calc.nvDayFactor(18000), 0.27);
  const dusk = calc.nvDayFactor(12900);
  assert.ok(dusk < 1 && dusk > 0.27, `smooth dusk ${dusk}`);
  const dawn = calc.nvDayFactor(23100);
  assert.ok(dawn < 1 && dawn > 0.27, `smooth dawn ${dawn}`);
  for (let t = 11000; t < 25000; t += 100) {
    const a = calc.nvDayFactor(t);
    const b = calc.nvDayFactor(t + 100);
    assert.ok(Math.abs(a - b) < 0.07, `no jump at ${t}`);
  }
  // outdoors: sky light dimmed by the night; torches (total > sky) count fully; Nether/End: total
  assert.equal(calc.nvEffectiveLight({ total: 15, sky: 15, dayFactor: 1 }), 15);
  assert.ok(calc.nvEffectiveLight({ total: 15, sky: 15, dayFactor: 0.27 }) <= 6, "open sky at night is dark");
  assert.equal(calc.nvEffectiveLight({ total: 12, sky: 0, dayFactor: 1 }), 12, "torch-lit cave");
  assert.equal(calc.nvEffectiveLight({ total: 3, sky: 0, dayFactor: 1 }), 3, "dark cave");
  assert.equal(calc.nvEffectiveLight({ total: 7, sky: 0, dayFactor: 1, hasSky: false }), 7, "nether");
  // ON after 2 dark samples, OFF at >= 9, nothing in between
  let s = { on: false, low: 0 };
  s = calc.nvStep(s, 4);
  assert.deepEqual(s, { on: false, low: 1 });
  s = calc.nvStep(s, 6);
  assert.equal(s.on, true);
  s = calc.nvStep(s, 8);
  assert.equal(s.on, true, "hysteresis keeps it on at 7..8");
  s = calc.nvStep(s, 9);
  assert.equal(s.on, false);
  s = calc.nvStep(s, 3);
  s = calc.nvStep(s, 7);
  assert.equal(s.on, false, "a bright sample resets the dark count");
  assert.equal(s.low, 0);
});

test("creative visual flight mode from the real velocity (SPEC 12.3)", () => {
  assert.equal(calc.visualFlightMode({ x: 0, y: 0, z: 0 }, false), "hover");
  assert.equal(calc.visualFlightMode({ x: 0.01, y: -0.4, z: 0 }, true), "hover", "vertical only = hover");
  assert.equal(calc.visualFlightMode({ x: 0.3, y: 0, z: 0.2 }, false), "cruise");
  assert.equal(calc.visualFlightMode({ x: 0.3, y: 0, z: 0.4 }, true), "boost");
  assert.equal(calc.visualFlightMode({ x: 0.3, y: 0, z: 0.4 }, true, true), "cruise", "overheated: no boost");
});

test("scripts: no in-flight flame sprites; suit-up is paid before both cinematics (SPEC 11.1 / 12.2)", () => {
  const dir = join(ROOT, "pack/Mark5_BP/scripts");
  const all = [join(dir, "main.js"), ...readdirSync(join(dir, "suit")).map((f) => join(dir, "suit", f))];
  for (const f of all) {
    const src = readFileSync(f, "utf8");
    for (const id of ["sym:mk5_thrust", "sym:mk5_thrust_glow", "sym:mk5_smoke"]) assert.ok(!src.includes(`"${id}"`), `${f} spawns ${id}`);
  }
  assert.equal(C.FX.TRAIL, "sym:mk5_trail");
  assert.equal(C.SND.NIGHT_VISION, "sym.mk5.night_vision");
  assert.equal(C.PROP.NV, "sym:mk5_nv");
  const main = readFileSync(join(dir, "main.js"), "utf8");
  assert.match(main, /chargeSuitUp\(player\)\) !== false\) beginThrowSequence\(player\)/, "throw case pays first");
  const placed = main.slice(main.indexOf("// walking onto a placed case"));
  assert.ok(placed.indexOf("chargeSuitUp(player)") > 0 && placed.indexOf("chargeSuitUp(player)") < placed.indexOf("beginFromPlacedCase(player, ent)"), "placed case pays first");
});

test("energy integration, regen and gauges", () => {
  assert.equal(calc.stepEnergy(500, 4, 0, 1000), 500.2);
  assert.equal(calc.stepEnergy(0.1, 4, 20, 1000), 0);
  assert.equal(calc.stepEnergy(999.9, 4, 0, 1000), 1000);
  assert.equal(calc.regenForElapsed(200), 40);
  assert.equal(calc.regenForElapsed(-5), 0);
  assert.equal(calc.regenForElapsed(1e9), (4 * C.TUNING.OFFLINE_REGEN_CAP_TICKS) / 20);
  assert.equal(calc.energyFrame(0), 0);
  assert.equal(calc.energyFrame(1), 1);
  assert.equal(calc.energyFrame(1000), 20);
  assert.equal(calc.energyState(10), "c");
  assert.equal(calc.energyState(24), "w");
  assert.equal(calc.energyState(25), "n");
  assert.equal(calc.formatRate(-14.62), "-14.6/s");
  assert.equal(calc.formatRate(2), "+2.0/s");
  assert.equal(calc.formatDuration(125), "2m05s");
});

test("low-energy alarms fire once per threshold going down", () => {
  let lvl = 0;
  const fired = [];
  for (const pct of [40, 30, 25, 24, 20, 12, 10, 9, 6, 5, 4, 3, 6, 4]) {
    const r = calc.alarmStep(lvl, pct);
    lvl = r.level;
    if (r.fire) fired.push([pct, r.fire]);
  }
  assert.deepEqual(fired, [[25, 1], [10, 2], [5, 3]]);
  // re-arm after recharging clearly above the threshold
  let r = calc.alarmStep(3, 8);
  assert.equal(r.level, 2);
  r = calc.alarmStep(r.level, 4);
  assert.equal(r.fire, 3);
});

test("energy shield absorption is capped by stored energy", () => {
  assert.deepEqual(calc.shieldAbsorb(10, 1000), { absorbed: 4, cost: 48 });
  const low = calc.shieldAbsorb(10, 24);
  assert.equal(low.absorbed, 2);
  assert.equal(low.cost, 24);
  assert.equal(calc.shieldAbsorb(-3, 100).absorbed, 0);
});

// ---------------------------------------------------------------------------------------------
test("movement vector convention: x = +1 is LEFT", () => {
  const f = calc.flatForward(0); // yaw 0 looks +Z
  assert.deepEqual([Math.round(f.x) + 0, Math.round(f.z) + 0], [0, 1]);
  const left = calc.leftOf(f); // facing +Z, left is +X
  assert.deepEqual([Math.round(left.x) + 0, Math.round(left.z) + 0], [1, 0]);
  const t = calc.flightTarget({ mode: "cruise", move: { x: 1, y: 0 }, view: f, yaw: 0, v: calc.vec(), y: 64 });
  assert.ok(t.x > 0.4 && Math.abs(t.z) < 1e-9);
});

test("flight modes, target velocity and smoothing", () => {
  assert.equal(calc.flightMode({ move: { x: 0, y: 0 } }), "hover");
  assert.equal(calc.flightMode({ move: { x: 0, y: 1 } }), "cruise");
  assert.equal(calc.flightMode({ move: { x: 0, y: 1 }, sprint: true }), "boost");
  assert.equal(calc.flightMode({ move: { x: 0, y: 1 }, sprint: true, overheated: true }), "cruise");
  assert.equal(calc.flightMode({ move: { x: 0, y: 1 }, emergency: true }), "emergency");
  const up = calc.vnorm({ x: 0, y: 1, z: 1 });
  const boost = calc.flightTarget({ mode: "boost", move: { x: 0, y: 1 }, view: up, yaw: 0, v: calc.vec(), y: 64 });
  assert.ok(Math.abs(calc.vlen(boost) - 1.6) < 1e-6);
  const iced = calc.flightTarget({ mode: "boost", move: { x: 0, y: 1 }, view: up, yaw: 0, v: calc.vec(), y: 320, icing: true });
  assert.ok(Math.abs(calc.vlen(iced) - 1.6 * 0.6) < 1e-6);
  const em = calc.flightTarget({ mode: "emergency", move: { x: 0, y: 0 }, view: up, yaw: 0, v: { x: 1, y: 0, z: 0 }, y: 64 });
  assert.equal(em.y, -0.25);
  assert.equal(em.x, 0.9);
  const hover = calc.flightTarget({ mode: "hover", move: { x: 0, y: 0 }, view: up, yaw: 0, v: calc.vec(), y: 64, holdY: 64, tick: 7 });
  assert.ok(Math.abs(hover.y) <= 0.01 + 1e-9);
  const desc = calc.flightTarget({ mode: "hover", move: { x: 0, y: 0 }, down: true, view: up, yaw: 0, v: calc.vec(), y: 64 });
  assert.equal(desc.y, -0.5);
  const a = calc.approach({ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }, 0.25);
  assert.deepEqual(a, { x: 0.25, y: 0.25, z: 0.25 });
});

test("thruster heat and overheat latch", () => {
  let heat = 0;
  let over = false;
  for (let i = 0; i < 20 * 10; i++) {
    heat = calc.heatStep(heat, { flying: true, mode: "boost" });
    over = calc.overheatStep(over, heat);
  }
  assert.equal(heat, 100);
  assert.equal(over, true);
  for (let i = 0; i < 20 * 2; i++) {
    heat = calc.heatStep(heat, { flying: true, mode: "cruise" });
    over = calc.overheatStep(over, heat);
  }
  assert.equal(over, true); // 64 % still > 60
  for (let i = 0; i < 20; i++) {
    heat = calc.heatStep(heat, { flying: false });
    over = calc.overheatStep(over, heat);
  }
  assert.equal(over, false);
});

test("nozzles sit near the body", () => {
  const loc = { x: 10, y: 64, z: 10 };
  for (const mode of ["hover", "cruise", "boost"]) {
    const n = calc.nozzles(loc, 37, -10, mode);
    for (const k of ["bootL", "bootR", "palmL", "palmR"]) assert.ok(calc.vdist(n[k], loc) < 2.2, `${mode} ${k}`);
  }
});

// ---------------------------------------------------------------------------------------------
test("integrity info + watcher (SPEC 8.3)", () => {
  assert.deepEqual(calc.integrityInfo(0, 1815), { pct: 100, frame: 10, state: "n" });
  assert.equal(calc.integrityInfo(1, 1815).pct, 99);
  assert.equal(calc.integrityInfo(1815 * 0.5, 1815).state, "w");
  assert.equal(calc.integrityInfo(1815 * 0.41, 1815).state, "w"); // 59 %
  assert.equal(calc.integrityInfo(1815 * 0.4, 1815).state, "n"); // 60 %
  assert.equal(calc.integrityInfo(1815 * 0.8, 1815).state, "c");
  assert.equal(calc.integrityInfo(1814, 1815).frame, 1);
  assert.equal(calc.integrityInfo(1815, 1815).frame, 0);
  assert.deepEqual(calc.integrityInfo(5, 0), { pct: 100, frame: 10, state: "n" });
  let w = calc.integrityStep(undefined, 80);
  assert.equal(w.drop, 0);
  w = calc.integrityStep(w.next, 77);
  assert.equal(w.drop, 3);
  assert.equal(w.critical, false);
  w = calc.integrityStep(w.next, 24);
  assert.equal(w.critical, true);
  w = calc.integrityStep(w.next, 20);
  assert.equal(w.critical, false); // only once
  w = calc.integrityStep(w.next, 90); // repaired
  assert.equal(w.drop, 0);
  w = calc.integrityStep(w.next, 10);
  assert.equal(w.critical, true); // re-armed
});

test("lock-on state machine (SPEC 5.7)", () => {
  let s = { candId: undefined, progress: 0, nextStep: 0, missTicks: 0 };
  let locked = false;
  let steps = 0;
  for (let t = 0; t < 40 && !locked; t++) {
    const r = calc.lockStep(s, "zombie", undefined, t);
    s = r;
    if (r.stepped) steps++;
    locked = r.locked;
  }
  assert.ok(locked);
  assert.equal(steps, 5);
  // looking at the locked entity does not restart anything
  let r = calc.lockStep({ candId: undefined, progress: 0, nextStep: 0, missTicks: 0 }, "zombie", "zombie", 50);
  assert.equal(r.progress, 0);
  assert.equal(r.locked, false);
  // brief glance away keeps progress, long one resets
  s = { candId: "a", progress: 3, nextStep: 10, missTicks: 0 };
  r = calc.lockStep(s, undefined, undefined, 10);
  assert.equal(r.progress, 3);
  for (let i = 0; i < 7; i++) r = calc.lockStep(r, undefined, undefined, 11 + i);
  assert.equal(r.progress, 0);
  // new candidate restarts
  r = calc.lockStep({ candId: "a", progress: 4, nextStep: 0, missTicks: 0 }, "b", "x", 5);
  assert.equal(r.candId, "b");
  assert.equal(r.progress, 0);
  assert.equal(calc.reticleCode(true, false, "h"), "k");
  assert.equal(calc.reticleCode(false, true, "h"), "l");
  assert.equal(calc.reticleCode(false, false, "p"), "p");
  assert.equal(calc.reticleCode(false, false, undefined), "i");
});

test("scan wave timing and cone", () => {
  assert.equal(calc.revealDelay(24), 20);
  assert.equal(calc.revealDelay(0), 0);
  assert.equal(calc.revealDelay(32), 27);
  const eye = { x: 0, y: 0, z: 0 };
  assert.ok(calc.inCone(eye, { x: 0, y: 0, z: 1 }, { x: 0.3, y: 0, z: 2 }, 30));
  assert.ok(!calc.inCone(eye, { x: 0, y: 0, z: 1 }, { x: 2, y: 0, z: 1 }, 30));
});

// ---------------------------------------------------------------------------------------------
test("mob classification and names", () => {
  assert.equal(mobs.classifyId("minecraft:zombie"), "h");
  assert.equal(mobs.classifyId("minecraft:enderman"), "n");
  assert.equal(mobs.classifyId("minecraft:enderman", { provoked: true }), "h");
  assert.equal(mobs.classifyId("minecraft:cow"), "p");
  assert.equal(mobs.classifyId("minecraft:player"), "j");
  assert.equal(mobs.classifyId("addon:robot", { isMonster: true }), "h");
  assert.equal(mobs.classifyId("addon:robot"), "p");
  for (const id of ["breeze", "bogged", "creaking", "parched", "zombie_nautilus"]) assert.equal(mobs.classifyId(`minecraft:${id}`), "h", id);
  for (const id of ["armadillo", "happy_ghast", "copper_golem"]) assert.equal(mobs.classifyId(`minecraft:${id}`), "p", id);
  for (const id of ["camel_husk", "nautilus"]) assert.ok(["n", "p"].includes(mobs.classifyId(`minecraft:${id}`)), id);
  assert.equal(mobs.displayName("minecraft:zombie"), "Zumbi");
  assert.equal(mobs.displayName("minecraft:villager_v2"), "Aldeão");
  assert.equal(mobs.displayName("minecraft:iron_golem"), "Golem de Ferro");
  assert.equal(mobs.displayName("minecraft:zombie", "§cRex"), "Rex");
  assert.equal(mobs.displayName("foo:iron_golem_mk2"), "Iron Golem Mk2");
  assert.equal(mobs.threatLevel("h", 20, "minecraft:creeper"), "ALTA");
  assert.equal(mobs.threatLevel("p", 10, "minecraft:cow"), "BAIXA");
  const z = mobs.markSize("minecraft:zombie");
  assert.ok(z.height >= 1.8 && z.width >= 0.9);
  assert.ok(mobs.markSize("minecraft:zombie", 1, true).height < z.height);
  // the four scan colours of SPEC 5.5
  assert.deepEqual(mobs.MARK_COLOR.h, { red: 1, green: 0.2, blue: 0.2, alpha: 1 });
  assert.deepEqual(mobs.MARK_COLOR.p, { red: 0.3, green: 1, blue: 0.45, alpha: 0.9 });
  for (const id of C.SUIT_IDS) assert.ok(!mobs.isExcludedType(id));
  assert.ok(mobs.isExcludedType("sym:mk5_case"));
  assert.ok(mobs.isExcludedType("minecraft:item"));
});

// ---------------------------------------------------------------------------------------------
test("HUD text builders always fit their fields (worst cases)", () => {
  const W = texts.TEXT_WIDTHS;
  const long = "Ááéíóúãõç".repeat(10);
  const fits = (s, w, label) => assert.ok(utf8(s) <= w, `${label}: ${utf8(s)} > ${w}`);
  fits(texts.energyText(100, "c", -999.9), W.energy, "energy");
  fits(texts.coordsText({ x: -29999999.5, y: -64, z: -29999999.5 }, 359.6), W.coords, "coords");
  fits(texts.suitText({ powered: false, dying: true, visor: "opening", protection: 20, integrity: 100 }), W.suit, "suit");
  assert.equal(texts.suitText({ powered: true, visor: "closed", protection: 20, integrity: 100 }).split("\n").length, 3);
  const drain = { reactor: 0.3, arms: 0.3, legs: 0.3, eyes: 0.1, hud: 1, lock: 0.6, flight: 16 };
  for (const nv of [undefined, "on", "auto", "off"]) {
    const sys = texts.systemsText({ regen: 4, drain: { ...drain, nv: 0.5 }, flightMode: "emergency", lockArmed: true, locked: true, heat: 100, overheated: true, shieldPct: 100, nv });
    fits(sys, W.systems, "systems");
    assert.equal(sys.split("\n").length, 6, `systems shows all 6 lines (nv ${nv})`);
  }
  // SPEC 12.1: the NV AUTO state shows next to the shield in normal conditions
  const sysOf = (nv) => texts.systemsText({ regen: 4, drain, lockArmed: false, heat: 10, shieldPct: 72, nv }).split("\n")[4];
  assert.equal(sysOf("on"), "§7ESCUDO §a72% §bNV AUTO");
  assert.equal(sysOf("auto"), "§7ESCUDO §a72% §8NV AUTO");
  assert.equal(sysOf("off"), "§7ESCUDO §a72% §8NV DESL.");
  const tgt = texts.targetText({ name: long, cls: "n", threat: "MÉDIA", dist: 47.9, hp: 300, maxHp: 300, locked: true, provoked: true });
  fits(tgt, W.target, "target");
  assert.equal(tgt.split("\n").length, 4, "target shows all 4 lines");
  const fl = texts.flightText({ mode: "emergency", alt: -64, agl: undefined, speed: 32, thrust: 100, heat: 100, overheated: true, icing: true });
  fits(fl, W.flight, "flight");
  assert.equal(fl.split("\n").length, 3);
  const entries = Array.from({ length: 9 }, (_, i) => ({ cls: "h", name: long, dist: 31.9, bearing: i * 40, hp: 300 }));
  const sc = texts.scanText({ radius: 32, counts: { h: 99, n: 99, p: 99, j: 9 }, sweeping: true, entries });
  fits(sc, W.scan, "scan");
  assert.ok(sc.split("\n").length >= 4, `scan shows ${sc.split("\n").length} lines`);
  const typical = ["Esqueleto Murcho", "Zumbi", "Creeper", "Aranha", "Vaca", "Porco", "Ovelha"].map((name, i) => ({
    cls: i < 4 ? "h" : "p", name, dist: 5 + i * 3.3, bearing: i * 50, hp: 20,
  }));
  const sct = texts.scanText({ radius: 32, counts: { h: 4, n: 0, p: 3, j: 0 }, sweeping: false, entries: typical });
  fits(sct, W.scan, "scan typical");
  assert.equal(sct.split("\n").length, 7, "typical scan: header + 6 entries");
  for (let e = 0; e < 60; e += 3) {
    fits(texts.bootText(e, { pct: 100, flightReady: false }), W.boot, "boot");
    fits(texts.failureText(e), W.boot, "failure");
  }
  assert.equal(texts.bootText(999, { pct: 87, flightReady: true }).split("\n").length, 6);
  fits(texts.alertText(long), W.alert, "alert");
});

test("per-player state helpers", () => {
  const st = state.getState({ id: "p1" });
  assert.equal(state.getState({ id: "p1" }), st);
  assert.equal(st.energy, C.TUNING.ENERGY_MAX);
  assert.equal(st.integrity.pct, 100);
  assert.ok(state.spendEnergy(st, 100));
  assert.equal(st.energy, 900);
  assert.ok(!state.spendEnergy(st, 5000));
  state.drainEnergy(st, 5000);
  assert.equal(st.energy, 0);
  state.dropState("p1");
  assert.equal(state.peekState("p1"), undefined);
});

test("caseLine: suitcase energy readout (SPEC 13)", () => {
  const { caseLine } = calc;
  const T = C.TUNING;
  const max = T.ENERGY_MAX;
  const ready = caseLine(max, max, T.SUITUP_COST, T.REGEN);
  assert.match(ready, /MALETA MARK V/);
  assert.match(ready, /ENERGIA .*100%/);
  assert.match(ready, /PRONTA PARA VESTIR/);
  // exactly at the cost: still ready
  assert.match(caseLine(T.SUITUP_COST, max, T.SUITUP_COST, T.REGEN), /PRONTA PARA VESTIR/);
  // below the cost: shows the needed % and the wait in seconds
  const low = caseLine(0, max, T.SUITUP_COST, T.REGEN);
  assert.match(low, /PRECISA DE 8%/);
  assert.match(low, /~20s/); // 80 energy / 4.0 per second
  assert.ok(!low.includes("PRONTA"));
  // the wait shrinks as it charges, and never shows 0s
  const half = caseLine(T.SUITUP_COST - 1, max, T.SUITUP_COST, T.REGEN);
  assert.match(half, /~1s/);
  // junk input never throws or prints NaN
  for (const v of [undefined, NaN, -50, max * 10]) {
    const s = caseLine(/** @type {number} */ (v), max, T.SUITUP_COST, T.REGEN);
    assert.ok(!s.includes("NaN"), `NaN in ${s}`);
    assert.ok(!s.includes("undefined"));
  }
});
