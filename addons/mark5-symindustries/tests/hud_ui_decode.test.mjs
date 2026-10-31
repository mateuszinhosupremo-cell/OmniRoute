// Mark V visor HUD — JSON UI decoder test (hud agent).
//
// Evaluates EVERY view binding of EVERY generated control (pack/Mark5_RP/ui/sym_mk5_hud.json and
// the hud_screen.json modifications) against HUD title strings built from the protocol
// (tools/hud_protocol.resolved.json) and checks: fields extract exactly (accented PT-BR text,
// § codes, \n, multi-byte characters at field boundaries), visibility follows the protocol
// semantics, every computed #texture path exists, and the files on disk are exactly what the
// generator produces (offsets cannot drift from the protocol).
// String subtraction is evaluated with BOTH plausible engine semantics ("remove every
// occurrence" and "remove the first occurrence"); every expression must give the same result.
//
// Run: node --test tests/hud_ui_decode.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse, evalExpr, resolveTree, encodeHud, offString, utf8Len } from "../tools/hud/jsonui_eval.mjs";
import { STATES, EXTRA_STATES } from "../tools/hud/sample_states.mjs";
import { buildNamespace, buildHudScreen, buildUiDefs, fld, INTEGRITY_TEXT, NS, ROOT_CONTROL, EXPR } from "../tools/hud/build_ui.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RP = join(ROOT, "pack", "Mark5_RP");
const UI = join(RP, "ui");
const PROTO = JSON.parse(readFileSync(join(ROOT, "tools", "hud_protocol.resolved.json"), "utf8"));
// value documentation lives in the source protocol
const DOC = Object.fromEntries(JSON.parse(readFileSync(join(ROOT, "tools", "hud_protocol.json"), "utf8")).fields.map((f) => [f.name, f]));
const F = Object.fromEntries(PROTO.fields.map((f) => [f.name, f]));
const T = "#hud_title_text_string";
const SEMANTICS = ["all", "first"];
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

/** Enumerate every legal value of a char/digits field from the protocol "values" doc. */
function legalValues(f) {
  const values = DOC[f.name].values;
  if (values && typeof values === "object") return Object.keys(values);
  const m = /^(\d+)\.\.(\d+)/.exec(String(values || ""));
  if (!m) throw new Error(`cannot enumerate ${f.name}`);
  const out = [];
  for (let i = Number(m[1]); i <= Number(m[2]); i++) out.push(String(i).padStart(f.width, "0"));
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
  // every text field has exactly one label whose #text is exactly that field
  for (const f of PROTO.fields.filter((x) => x.type === "text")) {
    const labels = CONTROLS.filter(({ def }) => (def.bindings || []).some((b) => b.target_property_name === "#text" && b.source_property_name === fld(f.name)));
    assert.equal(labels.length, 1, `text field ${f.name} bound by ${labels.length} labels`);
    const d = labels[0].def;
    assert.equal(d.type, "label");
    assert.equal(d.localize, false, `${f.name} must not be localized`);
    assert.equal(d.shadow, true, `${f.name} needs a shadow`);
    // fields are space padded: centre/right alignment would shift the visible text
    assert.ok(!d.text_alignment || d.text_alignment === "left", `${f.name} label must be left aligned`);
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
    "root/main/right_column/scan_panel": v.scan !== "0",
    "root/main/right_column/scan_panel/radar_idle": v.scan === "1",
    "root/main/right_column/scan_panel/radar_sweep": v.scan === "2",
    "root/main/right_column/scan_panel/sweep": v.scan === "2",
    "root/main/right_column/gap": v.scan !== "0" && v.target_class !== "0",
    "root/main/right_column/target_panel": v.target_class !== "0",
    "root/main/right_column/systems_panel": v.scan === "0" && v.target_class === "0",
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

/** Checks one title string against its field values (both string-subtraction semantics). */
function checkTitle(label, title, values) {
  const headerOk = title.startsWith(PROTO.header);
  const exp = expectedVisibility(values, headerOk);
  for (const minus of SEMANTICS) {
    const nodes = resolveTree(NSJ, ROOT_CONTROL, title, { minus });
    const P = byPath(nodes);
    for (const p of Object.keys(exp)) assert.ok(P[p], `${label}: missing control ${p}`);
    for (const [p, want] of Object.entries(exp)) {
      assert.equal(P[p].own.visible, want, `${label} [${minus}]: ${p} visible=${P[p].own.visible}, expected ${want}`);
    }
    for (const n of nodes) {
      // exact field extraction for every text binding
      for (const b of n.def.bindings || []) {
        if (b.binding_type !== "view") continue;
        const field = FIELD_EXPR[b.source_property_name];
        if (field) {
          const got = evalExpr(b.source_property_name, { [T]: title }, { minus });
          assert.equal(got, values[field], `${label} [${minus}]: ${n.path} reads ${field} as ${JSON.stringify(got)}`);
        }
      }
      // every computed texture exists (also for hidden controls: the engine still binds them)
      if (n.def.texture === "#texture") {
        assert.equal(typeof n.own.texture, "string", `${label}: ${n.path} has no texture`);
        assert.ok(texExists(n.own.texture), `${label} [${minus}]: ${n.path} -> missing ${n.own.texture}.png`);
      }
    }
    // big resistance readout
    const pct = P["root/main/left_column/suit_panel/integrity_pct_n"].own.text;
    assert.equal(pct, `${Number(values.integrity_pct)}%`, `${label} [${minus}]: integrity readout ${pct}`);
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

test("resistance readout strips leading zeros for 000..100", () => {
  for (let i = 0; i <= 100; i++) {
    const { title } = encodeHud(PROTO, { ...STATES.idle.fields, integrity_pct: String(i).padStart(3, "0") });
    for (const minus of SEMANTICS) assert.equal(evalExpr(INTEGRITY_TEXT, { [T]: title }, { minus }), `${i}%`);
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
    [encodeHud(PROTO, STATES.idle.fields).title, false, true],
    [encodeHud(PROTO, STATES.boot.fields).title, false, true],
    [encodeHud(PROTO, STATES.failure.fields).title, false, true],
  ];
  for (const [title, vanillaVisible, ours] of cases) {
    for (const minus of SEMANTICS) {
      const sc = { [T]: title };
      assert.equal(!!evalExpr(titleVisible, sc, { minus }), vanillaVisible, `vanilla title for ${JSON.stringify(title.slice(0, 12))}`);
      assert.equal(!!evalExpr(EXPR.rootVisible, sc, { minus }), ours, `our root for ${JSON.stringify(title.slice(0, 12))}`);
      assert.equal(!!evalExpr(dollVisible, sc, { minus }), !ours, "vanilla paper doll hidden only while our HUD is shown");
      const root = resolveTree(NSJ, ROOT_CONTROL, title, { minus })[0];
      assert.equal(root.visible, ours);
    }
  }
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
    assert.ok(["alpha", "offset", "flip_book"].includes(a.anim_type), `${k}: ${a.anim_type}`);
  }
  let customs = 0;
  for (const { path, def } of CONTROLS) {
    if (typeof def.texture === "string" && def.texture !== "#texture") assert.ok(texExists(def.texture), `${path}: ${def.texture}`);
    if (def.property_bag && def.property_bag["#texture"]) assert.ok(texExists(def.property_bag["#texture"]), `${path}: fallback`);
    if (def.type === "custom") {
      customs++;
      assert.ok(["live_player_renderer", "hud_player_renderer"].includes(def.renderer), def.renderer);
    }
    if (def.type === "image" && def.uv) {
      const a = NSJ[def.uv.slice(NS.length + 2)];
      assert.equal(a.anim_type, "flip_book");
      const tex = def.texture === "#texture" ? def.property_bag["#texture"] : def.texture;
      const img = readFileSync(join(RP, `${tex}.png`));
      const w = img.readUInt32BE(16);
      const h = img.readUInt32BE(20);
      assert.equal(h, def.uv_size[1], `${path}: flip-book strip height`);
      assert.equal(w, def.uv_size[0] * a.frame_count, `${path}: flip-book strip width`);
      assert.equal(a.frame_step, def.uv_size[0]);
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
