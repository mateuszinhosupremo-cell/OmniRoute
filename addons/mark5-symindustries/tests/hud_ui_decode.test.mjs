// Mark V visor HUD — JSON UI decoder test (hud agent).
//
// Evaluates EVERY view binding of EVERY generated control (pack/Mark5_RP/ui/sym_mk5_hud.json and
// the hud_screen.json modifications) against HUD title strings built from the protocol
// (tools/hud_protocol.resolved.json) and checks: fields extract exactly (accented PT-BR text,
// § codes, \n, multi-byte characters at field boundaries), visibility follows the protocol
// semantics, every computed #texture path exists, and the files on disk are exactly what the
// generator produces (offsets cannot drift from the protocol).
// String subtraction is evaluated with BOTH plausible engine semantics ("remove every
// occurrence" and "remove the first occurrence"), and numeric-looking strings with BOTH engine
// behaviours (kept as strings / coerced to numbers, e.g. '09' -> 9: SPEC 11 item 1); every
// expression must give the same visible result and every computed texture path must exist under
// all four combinations.
//
// Run: node --test tests/hud_ui_decode.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse, evalExpr, resolveTree, encodeHud, offString, utf8Len, NUMERIC_MODES, looksNumeric, coerceValue, SPACE_PADDED } from "../tools/hud/jsonui_eval.mjs";
import { STATES, EXTRA_STATES } from "../tools/hud/sample_states.mjs";
import { buildNamespace, buildHudScreen, buildUiDefs, fld, INTEGRITY_TEXT, NS, ROOT_CONTROL, EXPR, FLIGHT_PANEL_BOTTOM, RIGHT_H } from "../tools/hud/build_ui.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RP = join(ROOT, "pack", "Mark5_RP");
const UI = join(RP, "ui");
const PROTO = JSON.parse(readFileSync(join(ROOT, "tools", "hud_protocol.resolved.json"), "utf8"));
// value documentation lives in the source protocol
const DOC = Object.fromEntries(JSON.parse(readFileSync(join(ROOT, "tools", "hud_protocol.json"), "utf8")).fields.map((f) => [f.name, f]));
const F = Object.fromEntries(PROTO.fields.map((f) => [f.name, f]));
const T = "#hud_title_text_string";
const SEMANTICS = ["all", "first"];
/** Every engine-behaviour combination: string subtraction x numeric-string coercion. */
const ENGINES = SEMANTICS.flatMap((minus) => NUMERIC_MODES.map((numeric) => ({ minus, numeric })));
const eng = (o) => `${o.minus}/${o.numeric}`;
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const NSJ = readJson(join(UI, "sym_mk5_hud.json"));
const HUDJ = readJson(join(UI, "hud_screen.json"));
const ALL_STATES = { ...STATES, ...EXTRA_STATES };

const texExists = (p) => existsSync(join(RP, `${p}.png`));

/** Every control of the namespace: { path, def }. */
function controls(def, path = ROOT_CONTROL, out = []) {
  out.push({ path, def });
  for (const c of def.controls || []) for (const [n, d] of Object.entries(c)) controls(d, `${path}/${n}`, out);
  return out;
}
const CONTROLS = controls(NSJ[ROOT_CONTROL]);
const byPath = (nodes) => Object.fromEntries(nodes.map((n) => [n.path, n]));

/** Enumerate every legal value of a char/digits field from the protocol "values" doc
 *  (integrity_pct: right-aligned with spaces, "  0".."100"). */
function legalValues(f) {
  const values = DOC[f.name].values;
  if (values && typeof values === "object") return Object.keys(values);
  const m = /(\d+)\D{0,3}\.\.\D{0,3}(\d+)/.exec(String(values || ""));
  if (!m) throw new Error(`cannot enumerate ${f.name}`);
  const out = [];
  const pad = SPACE_PADDED.has(f.name) ? " " : "0";
  for (let i = Number(m[1]); i <= Number(m[2]); i++) out.push(String(i).padStart(f.width, pad));
  return out;
}

/** Fields read by a binding expression, by exact extraction sub-expression. */
const FIELD_EXPR = Object.fromEntries(PROTO.fields.map((f) => [fld(f.name), f.name]));

// ---------------------------------------------------------------------------------------------
test("generated UI files are exactly what the generator produces from the protocol", () => {
  assert.deepEqual(NSJ, buildNamespace(), "sym_mk5_hud.json is stale: run node tools/hud/build_ui.mjs");
  assert.deepEqual(HUDJ, buildHudScreen(), "hud_screen.json is stale");
  assert.deepEqual(readJson(join(UI, "_ui_defs.json")), buildUiDefs(), "_ui_defs.json is stale");
  assert.equal(NSJ.namespace, NS);
});

test("all UI files are strict JSON", () => {
  for (const fn of readdirSync(UI)) {
    if (!fn.endsWith(".json")) continue;
    const src = readFileSync(join(UI, fn), "utf8");
    assert.doesNotThrow(() => JSON.parse(src), `${fn} is not strict JSON`);
    assert.ok(!/^\s*\/\//m.test(src), `${fn} has a comment line`);
  }
});

test("registration: ui_defs, root inserted into root_panel, vanilla title hidden, field offsets", () => {
  assert.ok(readJson(join(UI, "_ui_defs.json")).ui_defs.includes("ui/sym_mk5_hud.json"));
  const mods = HUDJ.root_panel.modifications;
  assert.equal(mods.length, 1);
  assert.equal(mods[0].array_name, "controls");
  assert.equal(mods[0].operation, "insert_front");
  assert.deepEqual(Object.keys(mods[0].value[0]), [`sym_mk5_hud_root@${NS}.${ROOT_CONTROL}`]);
  assert.equal(HUDJ.namespace, "hud");
  // extraction expressions are exactly the SPEC 3.1 form with the resolved offsets
  for (const f of PROTO.fields) {
    assert.equal(fld(f.name), `(('%.${f.end}s' * ${T}) - ('%.${f.start}s' * ${T}))`);
  }
  assert.equal(PROTO.fields.at(-2).name, "integrity_pct");
  assert.equal(PROTO.fields.at(-1).name, "integrity_state");
});

test("every binding: title binding first, strictly parenthesised expressions, known targets", () => {
  const all = [...CONTROLS.map((c) => [c.path, c.def]), ["hud.hud_title_text", HUDJ.hud_title_text], ["hud.hud_player_renderer", HUDJ.hud_player_renderer]];
  let views = 0;
  for (const [path, def] of all) {
    const b = def.bindings || [];
    if (!b.length) continue;
    assert.deepEqual(b[0], { binding_name: T, binding_type: "global" }, `${path}: title binding must come first`);
    for (const v of b.slice(1)) {
      assert.equal(v.binding_type, "view", path);
      assert.ok(["#visible", "#text", "#texture"].includes(v.target_property_name), `${path}: ${v.target_property_name}`);
      assert.doesNotThrow(() => parse(v.source_property_name), `${path}: ${v.source_property_name}`);
      views++;
    }
  }
  assert.ok(views > 50, `only ${views} view bindings`);
});

// fields the UI does not need to read on their own (reason)
const NOT_DISPLAYED = {
  energy_pct: "the script already prints the percentage inside energy_text; the gauge uses energy_frame",
};

test("every protocol field is consumed by the UI", () => {
  const src = JSON.stringify(NSJ);
  for (const f of PROTO.fields) {
    if (NOT_DISPLAYED[f.name]) continue;
    const used = src.includes(JSON.stringify(fld(f.name)).slice(1, -1)) || (f.name === "mode" && src.includes(`'%.${f.end}s'`));
    assert.ok(used, `field ${f.name} is never read`);
  }
  // every text field has exactly one label whose #text is exactly that field (target_text: two
  // copies, top / below the scan panel, never visible together — checked per state)
  for (const f of PROTO.fields.filter((x) => x.type === "text")) {
    const labels = CONTROLS.filter(({ def }) => (def.bindings || []).some((b) => b.target_property_name === "#text" && b.source_property_name === fld(f.name)));
    assert.equal(labels.length, f.name === "target_text" ? 2 : 1, `text field ${f.name} bound by ${labels.length} labels`);
    for (const { def: d } of labels) {
    assert.equal(d.type, "label");
    assert.equal(d.localize, false, `${f.name} must not be localized`);
    assert.equal(d.shadow, true, `${f.name} needs a shadow`);
    // fields are space padded: centre/right alignment would shift the visible text
    assert.ok(!d.text_alignment || d.text_alignment === "left", `${f.name} label must be left aligned`);
    }
  }
});

test("sample states are realistic and never rely on truncation", () => {
  let accents = 0;
  for (const [key, st] of Object.entries(ALL_STATES)) {
    for (const [name, v] of Object.entries(st.fields)) {
      const f = F[name];
      assert.ok(f, `${key}: unknown field ${name}`);
      if (f.type === "text") {
        assert.ok(utf8Len(v) <= f.width, `${key}.${name}: ${utf8Len(v)} > ${f.width} bytes`);
        if (/[À-ÿ]/.test(v)) accents++;
      } else {
        assert.ok(legalValues(f).includes(v), `${key}.${name}: illegal value ${v}`);
      }
    }
  }
  assert.ok(accents >= 8, "samples need accented PT-BR text");
});

// ---------------------------------------------------------------------------------------------
/** Expected OWN visibility of the controls whose visibility carries protocol meaning. */
function expectedVisibility(v, headerOk) {
  const m = v.mode;
  return {
    [ROOT_CONTROL]: headerOk && m !== "0",
    "root/visor/visor_base": m === "1" || m === "2",
    "root/visor/visor_base_fail": m === "3",
    "root/danger": m === "1" && (v.threat === "1" || v.energy_state === "c"),
    "root/main": m === "1",
    "root/boot": m === "2" || m === "3",
    "root/boot/boot_frame/header_boot": m === "2",
    "root/boot/boot_frame/header_fail": m === "3",
    "root/boot/boot_frame/frame_boot": m === "2",
    "root/boot/boot_frame/frame_fail": m === "3",
    "root/main/right_column/scan_panel": v.scan !== "0",
    "root/main/right_column/scan_panel/radar_idle": v.scan === "1",
    "root/main/right_column/scan_panel/radar_sweep": v.scan === "2",
    "root/main/right_column/scan_panel/sweep": v.scan === "2",
    "root/main/right_column/target_panel": v.target_class !== "0" && v.scan === "0",
    "root/main/right_column/target_panel_low": v.target_class !== "0" && v.scan !== "0",
    "root/main/right_column/systems_panel": v.scan === "0" && v.target_class === "0",
    ...Object.fromEntries(["target_panel", "target_panel_low"].flatMap((p) => ["h", "n", "p", "j"].map((c) => [`root/main/right_column/${p}/frame_${c}`, v.target_class === c && (p === "target_panel" ? v.scan === "0" : v.scan !== "0") && v.target_class !== "0"]))),
    "root/main/top_center/alert_box": v.alert !== "0",
    "root/main/top_center/alert_box/alert_flash": v.alert === "c",
    "root/main/center/lock_ring": v.lock_frame !== "0",
    "root/main/center/lock_tag": v.lock_mode === "1",
    "root/main/flight_panel": v.flight !== "0",
    "root/main/left_column/energy_panel/pulse": v.energy_state === "c",
    "root/main/left_column/suit_panel/integrity_pct_n": v.integrity_state !== "w" && v.integrity_state !== "c",
    "root/main/left_column/suit_panel/integrity_pct_w": v.integrity_state === "w",
    "root/main/left_column/suit_panel/integrity_pct_c": v.integrity_state === "c",
    "root/main/left_column/suit_panel/integrity_crit": v.integrity_state === "c",
  };
}

/** A field value as an engine behaviour delivers it (coerce: numeric-looking -> number). */
const asEngine = (v, numeric) => (numeric === "coerce" ? coerceValue(v) : v);

/** Text fields: path -> field for every label bound to exactly one text field. */
const TEXT_LABELS = CONTROLS.flatMap(({ path, def }) =>
  (def.bindings || []).filter((b) => b.target_property_name === "#text" && FIELD_EXPR[b.source_property_name]).map((b) => [path, FIELD_EXPR[b.source_property_name]]));

/** Checks one title string against its field values under every engine behaviour. */
function checkTitle(label, title, values) {
  const headerOk = title.startsWith(PROTO.header);
  const exp = expectedVisibility(values, headerOk);
  for (const opts of ENGINES) {
    const tag = `${label} [${eng(opts)}]`;
    const nodes = resolveTree(NSJ, ROOT_CONTROL, title, opts);
    const P = byPath(nodes);
    for (const p of Object.keys(exp)) assert.ok(P[p], `${label}: missing control ${p}`);
    for (const [p, want] of Object.entries(exp)) {
      assert.equal(P[p].own.visible, want, `${tag}: ${p} visible=${P[p].own.visible}, expected ${want}`);
    }
    for (const n of nodes) {
      // exact field extraction for every text binding
      for (const b of n.def.bindings || []) {
        if (b.binding_type !== "view") continue;
        const field = FIELD_EXPR[b.source_property_name];
        if (field) {
          const got = evalExpr(b.source_property_name, { [T]: title }, opts);
          assert.equal(got, asEngine(values[field], opts.numeric), `${tag}: ${n.path} reads ${field} as ${JSON.stringify(got)}`);
        }
        if (b.target_property_name === "#visible") assert.equal(typeof n.bound.visible, "boolean", `${tag}: ${n.path} #visible is not a boolean`);
      }
      // every computed texture exists (also for hidden controls: the engine still binds them)
      if (n.def.texture === "#texture") {
        assert.equal(typeof n.own.texture, "string", `${tag}: ${n.path} has no texture`);
        assert.ok(texExists(n.own.texture), `${tag}: ${n.path} -> missing ${n.own.texture}.png`);
      }
    }
    // a text field is never shown twice at once (target_text has two mutually exclusive copies)
    const shown = {};
    for (const [p, field] of TEXT_LABELS) if (P[p].visible) shown[field] = (shown[field] || 0) + 1;
    for (const [field, k] of Object.entries(shown)) assert.equal(k, 1, `${tag}: ${field} shown by ${k} labels`);
    if (values.mode === "1" && headerOk) assert.equal(shown.target_text || 0, values.target_class !== "0" ? 1 : 0, `${tag}: target_text`);
    // big resistance readout: (field + '%'), field right-aligned with spaces by the script
    const pct = P["root/main/left_column/suit_panel/integrity_pct_n"].own.text;
    assert.equal(typeof pct, "string", `${tag}: integrity readout is not a string`);
    assert.equal(pct.trim(), `${Number(values.integrity_pct)}%`, `${tag}: integrity readout ${JSON.stringify(pct)}`);
  }
}

for (const [key, st] of Object.entries(ALL_STATES)) {
  test(`state "${key}": every binding decodes per protocol`, () => {
    const { title, values } = encodeHud(PROTO, st.fields);
    assert.equal(utf8Len(title), PROTO.totalBytes);
    checkTitle(key, title, values);
  });
}

test("every legal value of every char/digits field (textures exist, visibility per protocol)", () => {
  const base = STATES.idle.fields;
  let n = 0;
  for (const f of PROTO.fields.filter((x) => x.type !== "text")) {
    for (const v of legalValues(f)) {
      const fields = { ...base, [f.name]: v };
      const { title, values } = encodeHud(PROTO, fields);
      checkTitle(`${f.name}=${v}`, title, values);
      n++;
    }
  }
  // all class x hp combinations
  for (const c of legalValues(F.target_class)) {
    for (const hp of legalValues(F.target_hp_frame)) {
      const { title, values } = encodeHud(PROTO, { ...base, target_class: c, target_hp_frame: hp });
      checkTitle(`hp ${c}/${hp}`, title, values);
      n++;
    }
  }
  assert.ok(n > 150);
});

test("resistance readout: (field + '%') with the space-padded field, 0..100, every engine", () => {
  assert.equal(INTEGRITY_TEXT, `(${fld("integrity_pct")} + '%')`);
  for (let i = 0; i <= 100; i++) {
    const { title, values } = encodeHud(PROTO, { ...STATES.idle.fields, integrity_pct: String(i) });
    assert.equal(values.integrity_pct, String(i).padStart(3, " "), "script sends it right-aligned with spaces");
    for (const opts of ENGINES) {
      const got = evalExpr(INTEGRITY_TEXT, { [T]: title }, opts);
      const want = opts.numeric === "coerce" ? `${i}%` : `${String(i).padStart(3, " ")}%`;
      assert.equal(got, want, `${i} [${eng(opts)}]`);
    }
  }
});

// ---------------------------------------------------------------------------------------------
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const ALPHABET = [..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,:;!?-+/%()[]<>=#*'\""
  + "áàâãéêíóôõúçÁÀÂÃÉÊÍÓÔÕÚÇ•●■—·°", "§a", "§c", "§l", "§r", "§7", "§b", "\n"];

test("fuzz: random PT-BR text with § codes, \\n and multi-byte chars at every boundary", () => {
  const r = rng(20261031);
  const textFields = PROTO.fields.filter((f) => f.type === "text");
  for (let iter = 0; iter < 160; iter++) {
    const fields = { ...STATES.combat.fields };
    for (const f of textFields) {
      const target = Math.floor(r() * (f.width + 12)); // sometimes longer than the field
      let s = "";
      while (utf8Len(s) < target) s += ALPHABET[Math.floor(r() * ALPHABET.length)];
      fields[f.name] = s;
    }
    if (iter % 4 === 0) {
      // fill fields exactly up to / one byte short of their width with 2-byte characters
      for (const f of textFields) fields[f.name] = "ã".repeat(Math.floor(f.width / 2)) + (iter % 8 === 0 ? "" : "a");
    }
    const { title, values } = encodeHud(PROTO, fields);
    assert.equal(utf8Len(title), PROTO.totalBytes);
    checkTitle(`fuzz#${iter}`, title, values);
  }
});

test("HUD off string and foreign titles: our root hidden, vanilla title restored", () => {
  const titleVisible = HUDJ.hud_title_text.bindings[1].source_property_name;
  const dollVisible = HUDJ.hud_player_renderer.bindings[1].source_property_name;
  const cases = [
    [offString(PROTO), false, false],
    ["", true, false],
    ["Olá, aventureiro!", true, false],
    ["§6Vitória Épica", true, false],
    ["MK5", true, false],
    ["MK5h1abc", true, false],
    ["12345", true, false],
    ["007", true, false],
    [encodeHud(PROTO, STATES.idle.fields).title, false, true],
    [encodeHud(PROTO, STATES.boot.fields).title, false, true],
    [encodeHud(PROTO, STATES.failure.fields).title, false, true],
  ];
  for (const [title, vanillaVisible, ours] of cases) {
    for (const opts of ENGINES) {
      const sc = { [T]: title };
      assert.equal(!!evalExpr(titleVisible, sc, opts), vanillaVisible, `vanilla title for ${JSON.stringify(title.slice(0, 12))} [${eng(opts)}]`);
      assert.equal(!!evalExpr(EXPR.rootVisible, sc, opts), ours, `our root for ${JSON.stringify(title.slice(0, 12))} [${eng(opts)}]`);
      assert.equal(!!evalExpr(dollVisible, sc, opts), !ours, "vanilla paper doll hidden only while our HUD is shown");
      const root = resolveTree(NSJ, ROOT_CONTROL, title, opts)[0];
      assert.equal(root.visible, ours);
    }
  }
});

test("flight panel sits low, just above hearts/hunger, clear of the reticle on phones", () => {
  // vanilla HUD rows above the hotbar: hearts / hunger H-39..H-32, armour H-49..H-42. The script
  // does not use the actionbar during flight, so overlapping its box (H-76..H-61) is fine.
  const ARMOUR_ROW_TOP = 49;
  const RETICLE_CORE = 14; // reticle artwork spans 13.5..15.3 px from the screen centre
  const fp = byPath(CONTROLS)["root/main/flight_panel"].def;
  assert.equal(fp.anchor_from, "bottom_middle");
  assert.equal(fp.anchor_to, "bottom_middle");
  assert.deepEqual(fp.offset, [0, -FLIGHT_PANEL_BOTTOM]);
  assert.ok(FLIGHT_PANEL_BOTTOM >= 52 && FLIGHT_PANEL_BOTTOM <= 60, `about [0,-56], got ${FLIGHT_PANEL_BOTTOM}`);
  assert.ok(FLIGHT_PANEL_BOTTOM >= ARMOUR_ROW_TOP + 3, "flight panel overlaps the armour / hearts rows");
  const top = FLIGHT_PANEL_BOTTOM + fp.size[1];
  for (const H of [200, 208, 216, 240, 270]) {
    assert.ok(H - top >= H / 2 + RETICLE_CORE, `GUI height ${H}: flight panel top ${H - top} overlaps the reticle (${H / 2 + RETICLE_CORE})`);
  }
  // the lock tag sits above the reticle, so it never collides with the flight panel
  const tag = byPath(CONTROLS)["root/main/center/lock_tag"].def;
  assert.ok(tag.offset[1] < 0, "lock tag must be above the reticle");
});

test("right column: absolute panels in the upper part of the screen, below the top visor line", () => {
  const rc = byPath(CONTROLS)["root/main/right_column"].def;
  assert.equal(rc.type, "panel");
  assert.equal(rc.anchor_from, "top_right");
  assert.deepEqual(rc.size, [150, RIGHT_H]);
  const kids = Object.fromEntries((rc.controls || []).map((c) => Object.entries(c)[0]));
  assert.deepEqual(Object.keys(kids).sort(), ["scan_panel", "systems_panel", "target_panel", "target_panel_low"]);
  for (const [k, d] of Object.entries(kids)) {
    assert.equal(d.type, "panel", k);
    assert.equal(d.anchor_from, "top_left", k);
    assert.ok(Array.isArray(d.offset) && d.offset.every((v) => typeof v === "number"), `${k}: absolute offset`);
    assert.ok(d.offset[1] + d.size[1] <= RIGHT_H, `${k} outside the column`);
  }
  // the common states (systems / target / scan alone) stay in the upper ~55 % of a 200 px phone
  // screen (column top "15% + 4px"), above the jump / sneak buttons
  for (const k of ["systems_panel", "target_panel", "scan_panel"]) {
    const d = kids[k];
    assert.equal(d.offset[1], 0, k);
    assert.ok(200 * 0.15 + 4 + d.size[1] <= 200 * 0.55, `${k} reaches below 55% of a 200 px screen`);
  }
});

test("only basic JSON UI constructs: no stack_panel, no flip_book uv, no dynamic image with children", () => {
  for (const { path, def } of CONTROLS) {
    assert.notEqual(def.type, "stack_panel", `${path}: stack_panel`);
    assert.ok(!("uv" in def) && !("uv_size" in def), `${path}: uv animation`);
    if (def.texture === "#texture") assert.ok(!(def.controls || []).length, `${path}: dynamic #texture image with children`);
  }
  for (const [k, a] of Object.entries(NSJ)) if (a && a.anim_type) assert.ok(["alpha", "offset"].includes(a.anim_type), `${k}: ${a.anim_type}`);
});

test("no numeric-looking literal in any binding expression (number/string comparisons)", () => {
  const all = [...CONTROLS.map((c) => [c.path, c.def]), ["hud.hud_title_text", HUDJ.hud_title_text], ["hud.hud_player_renderer", HUDJ.hud_player_renderer]];
  let n = 0;
  for (const [path, def] of all) {
    for (const b of (def.bindings || []).filter((x) => x.binding_type === "view")) {
      for (const m of b.source_property_name.matchAll(/'([^']*)'/g)) {
        assert.ok(!looksNumeric(m[1]), `${path}: literal '${m[1]}' looks numeric`);
        n++;
      }
      assert.ok(!/(^|[\s(])\d/.test(b.source_property_name.replace(/'[^']*'/g, "''")), `${path}: bare number in ${b.source_property_name}`);
    }
  }
  assert.ok(n > 100);
});

test("every zero-padded frame texture has its leading-zero-free twin (identical bytes)", () => {
  const dir = join(RP, "textures", "sym", "hud");
  const files = new Set(readdirSync(dir));
  let twins = 0;
  for (const fn of files) {
    const m = /^(.*_)(0\d+)\.png$/.exec(fn);
    if (!m) continue;
    const twin = `${m[1]}${Number(m[2])}.png`;
    assert.ok(files.has(twin), `${fn} has no twin ${twin}`);
    assert.ok(readFileSync(join(dir, fn)).equals(readFileSync(join(dir, twin))), `${twin} differs from ${fn}`);
    twins++;
  }
  // energy 00..09, integrity 00..09, thrust 00..09, hp_<0|h|n|p|j>_00..09
  assert.equal(twins, 10 * 8);
  for (const p of ["energy_0", "energy_9", "integrity_0", "thrust_5", "hp_h_0", "hp_j_9", "hp_0_0"]) assert.ok(texExists(`textures/sym/hud/${p}`), p);
});

test("static references: textures, animations, renderer", () => {
  const anims = new Set(Object.entries(NSJ).filter(([, v]) => v && typeof v === "object" && v.anim_type).map(([k]) => k));
  const refs = [];
  const walk = (v) => {
    if (typeof v === "string" && v.startsWith(`@${NS}.`)) refs.push(v.slice(NS.length + 2));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(NSJ);
  assert.ok(refs.length > 5);
  for (const r of refs) assert.ok(anims.has(r), `unknown animation @${NS}.${r}`);
  for (const [k, a] of Object.entries(NSJ)) {
    if (!a || !a.anim_type) continue;
    assert.ok(["alpha", "offset"].includes(a.anim_type), `${k}: ${a.anim_type}`);
  }
  let customs = 0;
  for (const { path, def } of CONTROLS) {
    if (typeof def.texture === "string" && def.texture !== "#texture") assert.ok(texExists(def.texture), `${path}: ${def.texture}`);
    if (def.property_bag && def.property_bag["#texture"]) assert.ok(texExists(def.property_bag["#texture"]), `${path}: fallback`);
    if (def.type === "custom") {
      customs++;
      assert.ok(["live_player_renderer", "hud_player_renderer"].includes(def.renderer), def.renderer);
    }
  }
  assert.equal(customs, 1, "exactly one 3D armor view");
});

test("SPEC 2.6 texture set (protocol note textures + menu icons) exists", () => {
  const need = [];
  for (let i = 0; i <= 20; i++) need.push(`energy_${String(i).padStart(2, "0")}`);
  for (let i = 0; i <= 10; i++) {
    const nn = String(i).padStart(2, "0");
    need.push(`integrity_${nn}`, `hp_h_${nn}`, `hp_n_${nn}`, `hp_p_${nn}`, `hp_j_${nn}`, `thrust_${nn}`);
  }
  for (const c of "ihnpjlk") need.push(`reticle_${c}`);
  for (let i = 1; i <= 5; i++) need.push(`lock_${i}`);
  need.push("visor_base", "visor_base_fail", "danger_edge", "compass_notch", "armor_crit_tag");
  for (const n of need) assert.ok(texExists(`textures/sym/hud/${n}`), n);
  for (const n of ["icon_visor", "icon_hud", "icon_flight", "icon_scan", "icon_lock", "icon_diag", "icon_suitoff"]) {
    const p = join(RP, "textures", "sym", "ui", `${n}.png`);
    assert.ok(existsSync(p), n);
    const img = readFileSync(p);
    const w = img.readUInt32BE(16);
    assert.ok(w === 32 || w === 64, `${n} is ${w}px`);
  }
  // the visor base is the user's artwork downscaled to 1280x720
  const vb = readFileSync(join(RP, "textures", "sym", "hud", "visor_base.png"));
  assert.deepEqual([vb.readUInt32BE(16), vb.readUInt32BE(20)], [1280, 720]);
});

test("cross-check: the script's encoder produces the same titles (if present)", async (t) => {
  const codec = join(ROOT, "pack", "Mark5_BP", "scripts", "suit", "codec.js");
  if (!existsSync(codec)) return t.skip("script codec.js not present");
  const mod = await import(pathToFileURL(codec).href);
  if (typeof mod.encodeHud !== "function") return t.skip("codec.js has no encodeHud");
  for (const [key, st] of Object.entries(ALL_STATES)) {
    const { title, values } = encodeHud(PROTO, st.fields);
    assert.equal(mod.encodeHud(values), title, `script encodeHud differs for state ${key}`);
  }
  if (typeof mod.hiddenHudString === "function") assert.equal(mod.hiddenHudString(), offString(PROTO));
  if (typeof mod.compassTape === "function") {
    // the compass label offset assumes 25 glyphs of 6 px ('-', '+', capitals except I)
    for (let h = 0; h < 360; h += 7) {
      const tape = mod.compassTape(h).replace(/§./g, "");
      assert.equal(tape.length, 25, `compass tape at ${h}`);
      assert.ok(/^[-+A-HJ-Z]+$/.test(tape), tape);
    }
  }
});
