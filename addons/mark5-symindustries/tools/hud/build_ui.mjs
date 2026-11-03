// Mark V visor HUD — JSON UI generator (hud agent).
//
// Reads tools/hud_protocol.resolved.json (exact byte offsets of every HUD field) and writes:
//   pack/Mark5_RP/ui/_ui_defs.json      registers ui/sym_mk5_hud.json
//   pack/Mark5_RP/ui/hud_screen.json    ONLY: inserts our root into "root_panel" (modifications)
//                                       and hides the vanilla title while the title starts "MK5H"
//   pack/Mark5_RP/ui/sym_mk5_hud.json   namespace "sym_mk5_hud": every HUD control
//
// Offsets are never typed by hand: every field read is generated from the resolved protocol, so
// they cannot drift when the protocol changes (re-run `node tools/gen_protocol.mjs` then this).
// Every binary operation in a binding expression is wrapped in its own parentheses, so JSON UI
// operator precedence never matters.
//
// Usage: node tools/hud/build_ui.mjs
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const RP = join(ROOT, "pack", "Mark5_RP");
const PROTO = JSON.parse(readFileSync(join(ROOT, "tools", "hud_protocol.resolved.json"), "utf8"));

export const NS = "sym_mk5_hud";
export const ROOT_CONTROL = "root";
const T = "#hud_title_text_string";
const HUD_TEX = "textures/sym/hud/";

// The 3D armor view. `hud_player_renderer` (vanilla top-left paper doll) only draws the player
// while sprinting/sneaking/flying/etc. and fades out otherwise; `live_player_renderer` (vanilla
// inventory doll) draws the local player permanently and is what community HUD packs use for an
// always-on HUD model (see tools/hud/vanilla_ref/community). Both are "paper doll" renders, so
// `variable.is_paperdoll` is set (the vanilla controller's paperdoll state plays
// look_at_target_ui, which only exists for the inventory doll) and the suit area's
// `animation.sym.player.paperdoll_spin` turns the model 360 degrees. Sized like the vanilla
// inventory doll (30x30 panel inside a 52x70 box, offset -14) scaled to our 46x70 viewport.
const PLAYER_RENDERER = "live_player_renderer";

const F = Object.fromEntries(PROTO.fields.map((f) => [f.name, f]));
const H = PROTO.header;

// ------------------------------------------------------------------ expressions --
const trunc = (n) => `('%.${n}s' * ${T})`;
/** Field bytes [start,end) as a string. */
export const fld = (name) => {
  const f = F[name];
  if (!f) throw new Error(`unknown HUD field ${name}`);
  return `(${trunc(f.end)} - ${trunc(f.start)})`;
};
const eq = (a, b) => `(${a} = ${b})`;
const not = (a) => `(not ${a})`;
const and = (a, b) => `(${a} and ${b})`;
const or = (a, b) => `(${a} or ${b})`;
const cat = (a, b) => `(${a} + ${b})`;
const lit = (s) => {
  if (s.includes("'")) throw new Error("quote in literal");
  return `'${s}'`;
};
/** Field equals a one-char value. JSON UI coerces numeric-looking strings (SPEC 11 item 1): a field
 *  holding '0' may arrive as the NUMBER 0, and a number/string comparison is not reliable. For
 *  digit values both sides are therefore prefixed with '_' ('_' + 0 and '_' + '0' are both the
 *  non-numeric string '_0'), so the comparison is string = string under both engine behaviours. */
const is = (name, ch) => (/^[0-9]+$/.test(ch) ? eq(cat(lit("_"), fld(name)), lit(`_${ch}`)) : eq(fld(name), lit(ch)));
const isnt = (name, ch) => not(is(name, ch));
const modeIs = (m) => eq(trunc(F.mode.end), lit(H + m));
const headerOk = eq(trunc(H.length), lit(H));
const texOf = (prefix, ...parts) => {
  let e = lit(HUD_TEX + prefix);
  parts.forEach((p) => {
    e = cat(e, p);
  });
  return e;
};

export const EXPR = {
  rootVisible: and(headerOk, not(modeIs("0"))),
  vanillaTitleVisible: not(headerOk),
};

// --------------------------------------------------------------------- builders --
const titleBinding = () => ({ binding_name: T, binding_type: "global" });
const view = (expr, target) => ({ binding_type: "view", source_property_name: expr, target_property_name: target });

function withBindings(def, views) {
  if (!views.length) return def;
  return { ...def, bindings: [titleBinding(), ...views] };
}

const C = (name, def) => ({ [name]: def });

function panel(props, controls = [], visible) {
  const def = { type: "panel", ...props };
  if (controls.length) def.controls = controls;
  return withBindings(def, visible ? [view(visible, "#visible")] : []);
}

function image(texture, props = {}, controls = [], visible) {
  const def = { type: "image", texture: HUD_TEX + texture, bilinear: true, ...props };
  if (controls.length) def.controls = controls;
  return withBindings(def, visible ? [view(visible, "#visible")] : []);
}

/** Image whose texture path is computed from the title. Never has children (SPEC 11 item 3: a
 *  dynamic-#texture image with children did not render in game); put siblings next to it. */
function dynImage(texExpr, fallback, props = {}, controls = [], visible) {
  if (controls.length) throw new Error("dynImage must not have children");
  const def = {
    type: "image",
    texture: "#texture",
    allow_debug_missing_texture: false,
    bilinear: true,
    property_bag: { "#texture": HUD_TEX + fallback },
    ...props,
  };
  if (controls.length) def.controls = controls;
  const views = [view(texExpr, "#texture")];
  if (visible) views.push(view(visible, "#visible"));
  return withBindings(def, views);
}

const TXT = {
  ice: [0.78, 0.95, 1.0],
  cyan: [0.25, 0.85, 1.0],
  dim: [0.42, 0.7, 0.82],
  amber: [1.0, 0.72, 0.25],
  red: [1.0, 0.32, 0.3],
  white: [0.95, 0.98, 1.0],
};

/** Label bound to a HUD text field. */
function fieldLabel(field, props, visible) {
  const def = {
    type: "label",
    text: "#text",
    localize: false,
    shadow: true,
    font_type: "default",
    anchor_from: "top_left",
    anchor_to: "top_left",
    ...props,
  };
  const views = [view(fld(field), "#text")];
  if (visible) views.push(view(visible, "#visible"));
  return withBindings(def, views);
}

function staticLabel(text, props, visible) {
  const def = {
    type: "label",
    text,
    localize: false,
    shadow: true,
    font_type: "default",
    anchor_from: "top_left",
    anchor_to: "top_left",
    ...props,
  };
  return withBindings(def, visible ? [view(visible, "#visible")] : []);
}

const TL = { anchor_from: "top_left", anchor_to: "top_left" };
const at = (x, y) => ({ ...TL, offset: [x, y] });
const ref = (name) => `@${NS}.${name}`;

// ------------------------------------------------------------------- animations --
const ANIMS = {
  anim_blink_out: { anim_type: "alpha", easing: "in_out_sine", duration: 0.32, from: 1.0, to: 0.12, next: ref("anim_blink_in") },
  anim_blink_in: { anim_type: "alpha", easing: "in_out_sine", duration: 0.32, from: 0.12, to: 1.0, next: ref("anim_blink_out") },
  anim_pulse_out: { anim_type: "alpha", easing: "in_out_sine", duration: 0.75, from: 1.0, to: 0.35, next: ref("anim_pulse_in") },
  anim_pulse_in: { anim_type: "alpha", easing: "in_out_sine", duration: 0.75, from: 0.35, to: 1.0, next: ref("anim_pulse_out") },
  anim_armor_scan: { anim_type: "offset", easing: "linear", duration: 2.6, from: [0, 2], to: [0, 62], next: ref("anim_armor_scan") },
  anim_scan_sweep: { anim_type: "offset", easing: "linear", duration: 1.1, from: [2, 12], to: [2, 58], next: ref("anim_scan_sweep") },
  anim_boot_scan: { anim_type: "offset", easing: "in_out_sine", duration: 1.8, from: [2, 3], to: [2, 95], next: ref("anim_boot_scan") },
  anim_ring_out: { anim_type: "alpha", easing: "in_out_sine", duration: 1.4, from: 0.55, to: 0.25, next: ref("anim_ring_in") },
  anim_ring_in: { anim_type: "alpha", easing: "in_out_sine", duration: 1.4, from: 0.25, to: 0.55, next: ref("anim_ring_out") },
};

// ----------------------------------------------------------------------- layout --
// GUI pixels. The user's visor artwork (textures/sym/hud/visor_base, stretched full screen) is the
// frame everything is arranged around. Its geometry, as fractions of the screen (measured on the
// 2560x1440 source):
//   top polyline     y = 8.9% at the edges, 16.25% at its deepest points (x = 35% / 65%),
//                    10.5% on the raised centre segment (x = 39%..61%)
//   bottom polyline  y = 72% at the edges, 87% (x = 17% / 83%), 94% (x = 38% / 62%),
//                    87% on the raised centre segment (x = 44%..56%)
//   black helmet notches: top centre (x = 28%..72%, 2.4% deep at the sides, 1% in the middle),
//                    bottom centre (hotbar area) and both bottom corners.
// Panels therefore start just below the top polyline ("15% + 4px" clears it for every panel x
// range on 16:9..20:9 screens), the compass lives in a black tab that extends the top notch, the
// alert banner sits below the deepest point of the top line, and the flight panel stays above the
// raised centre of the bottom line, just above the vanilla hearts / hunger / armour rows (hearts
// H-39..H-32, armour H-49..H-42). Its bottom edge sits FLIGHT_PANEL_BOTTOM px above the screen
// bottom: low enough that on phones (GUI height ~200-216) its top edge (H-86) stays below the
// reticle (H/2 + ~14). It overlaps vanilla's actionbar box (H-76..H-61): the script does not use the
// actionbar during flight (SPEC 11 follow-up), so nothing prints over flight_text.
// Phone-safe: nothing interactive; the bottom-left (move pad) and bottom-right (jump / sneak) are
// kept clear, the right column starts below the top-right ~100x36 touch buttons and stays in the
// upper ~55 % of the screen, and the screen centre only has the reticle.
// Only basic, vanilla-proven constructs (SPEC 11 item 3): plain panels with ABSOLUTE offsets (no
// stack_panel), static images (no flip_book uv animation; alpha/offset animations only), and a
// dynamic "#texture" image never has children.
const BELOW_TOP_LINE = "15% + 4px";
const BELOW_TOP_LINE_DEEPEST = "16.5% + 3px";
export const FLIGHT_PANEL_BOTTOM = 55;

function visorFrame() {
  const full = { size: ["100%", "100%"], keep_ratio: false, fill: true };
  return panel({ size: ["100%", "100%"], layer: 0 }, [
    C("visor_base", image("visor_base", { ...full, layer: 0 }, [], or(modeIs("1"), modeIs("2")))),
    C("visor_base_fail", image("visor_base_fail", { ...full, layer: 0, anims: [ref("anim_pulse_out")] }, [], modeIs("3"))),
  ]);
}

function dangerEdge() {
  return image("danger_edge", {
    size: ["100%", "100%"], keep_ratio: false, fill: true, layer: 0,
    anims: [ref("anim_pulse_out")],
  }, [], and(modeIs("1"), or(is("threat", "1"), is("energy_state", "c"))));
}

/** Resistance readout. The script sends integrity_pct RIGHT-ALIGNED WITH SPACES ("100", " 72",
 *  "  5"), so (field + '%') is right whether the engine keeps the field as a string (" 72%") or
 *  coerces it to a number ("72%") — SPEC 11 item 2. */
export const INTEGRITY_TEXT = cat(fld("integrity_pct"), lit("%"));

function suitPanel() {
  const ledCell = (name, field, label, x, y) => [
    C(`led_${name}`, dynImage(texOf("led_", fld(field)), "led_1", { size: [7, 7], ...at(x, y), layer: 2 })),
    C(`led_${name}_label`, staticLabel(label, { ...at(x + 9, y + 1.5), font_scale_factor: 0.55, color: TXT.dim, layer: 2 })),
  ];
  const pct = (state, color, visible, extra = {}) =>
    C(`integrity_pct_${state}`, {
      type: "label",
      text: "#text",
      localize: false,
      shadow: true,
      font_type: "default",
      font_scale_factor: 1.5,
      color,
      layer: 3,
      ...at(53, 19.5),
      ...extra,
      bindings: [titleBinding(), view(INTEGRITY_TEXT, "#text"), view(visible, "#visible")],
    });
  return image("panel_suit", { size: [152, 86], ...TL, layer: 1 }, [
    C("title", staticLabel("§lMARK V", { ...at(6, 2), font_scale_factor: 0.75, color: TXT.cyan, layer: 2 })),
    C("os", staticLabel("SYM OS 2.3", { anchor_from: "top_right", anchor_to: "top_right", offset: [-17, 2.5], font_scale_factor: 0.5, color: TXT.dim, layer: 2 })),
    C("viewport", image("armor_viewport", { size: [46, 70], ...at(3, 12), layer: 1 }, [
      // the player animation sym_paperdoll_spin turns the model 360 degrees (variable.is_paperdoll)
      C("doll", panel({ size: [27, 27], anchor_from: "center", anchor_to: "center", offset: [0, -12], layer: 2 }, [
        C("armor_model", {
          type: "custom",
          renderer: PLAYER_RENDERER,
          layer: 2,
          anchor_from: "center",
          anchor_to: "center",
          property_bag: { "#look_at_cursor": false },
        }),
      ])),
      C("scanbar", image("armor_scanbar", { size: [46, 6], ...at(0, 2), alpha: 0.6, layer: 4, anims: [ref("anim_armor_scan")] })),
    ])),
    // large resistance readout: colour by integrity_state (n cyan / w amber / c red + blinking)
    C("integrity_caption", staticLabel("RESISTÊNCIA", { ...at(53, 13), font_scale_factor: 0.5, color: TXT.dim, layer: 2 })),
    pct("n", TXT.cyan, and(isnt("integrity_state", "w"), isnt("integrity_state", "c"))),
    pct("w", TXT.amber, is("integrity_state", "w")),
    pct("c", TXT.red, is("integrity_state", "c"), { anims: [ref("anim_blink_out")] }),
    C("integrity_crit", panel({ size: [54, 10], ...at(94, 21), layer: 3 }, [
      C("plate", image("armor_crit_tag", { size: [54, 10], layer: 1, anims: [ref("anim_blink_out")] })),
      C("label", staticLabel("ARMADURA CRÍTICA", { anchor_from: "center", anchor_to: "center", offset: [0, 0.5], text_alignment: "center", font_scale_factor: 0.5, color: TXT.white, layer: 2, anims: [ref("anim_blink_out")] })),
    ], is("integrity_state", "c"))),
    C("integrity", dynImage(texOf("integrity_", fld("integrity_frame")), "integrity_10", { size: [92, 5], ...at(53, 35), layer: 2 })),
    ...ledCell("head", "led_head", "OLHOS", 53, 44),
    ...ledCell("chest", "led_chest", "REATOR", 100, 44),
    ...ledCell("arms", "led_arms", "BRAÇOS", 53, 53),
    ...ledCell("legs", "led_legs", "PERNAS", 100, 53),
    C("suit_text", fieldLabel("suit_text", { ...at(53, 63), size: [96, "default"], font_scale_factor: 0.6, color: TXT.ice, layer: 2 })),
  ]);
}

function energyPanel(y) {
  return image("panel_energy", { size: [152, 38], ...at(0, y), layer: 1 }, [
    C("ring", dynImage(texOf("energy_ring_", fld("energy_state")), "energy_ring_n", { size: [36, 36], ...at(2, 1), layer: 2 })),
    C("gauge", dynImage(texOf("energy_", fld("energy_frame")), "energy_20", { size: [36, 36], ...at(2, 1), layer: 3 })),
    C("pulse", image("energy_pulse", { size: [46, 46], ...at(-3, -4), layer: 4, anims: [ref("anim_blink_out")] }, [], is("energy_state", "c"))),
    C("caption", staticLabel("ENERGIA • REATOR ARC", { ...at(42, 5), font_scale_factor: 0.5, color: TXT.dim, layer: 2 })),
    C("energy_text", fieldLabel("energy_text", { ...at(42, 14), font_scale_factor: 1.0, color: TXT.ice, layer: 2 })),
  ]);
}

// Right column (SPEC 11 item 3): plain panels at ABSOLUTE offsets inside a fixed-size panel, each
// with its background image as a SIBLING of its content (no stack_panel, no image with children).
//   no scan, no target  -> systems panel at the top
//   target, no scan     -> target panel at the top
//   scan                -> scan panel at the top (+ the "low" target copy right below it)
export const RIGHT_W = 150;
const SCAN_H = 66;
const TARGET_H = 54;
const SYSTEMS_H = 50;
const RIGHT_GAP = 2;
const TARGET_LOW_Y = SCAN_H + RIGHT_GAP;
export const RIGHT_H = TARGET_LOW_Y + TARGET_H;

// IN-GAME FIX (v2.3): the three right-column panels STILL bled through on real devices with
// just #visible on captions. The reliable Bedrock JSON-UI pattern is: wrap every element in its
// OWN panel sized 0x0 when hidden. We do this by making each sub-panel's top-level `size`
// bindable: when the condition is false, we don't add any binding -> uses the declared size;
// when true, we still use declared size. To actually HIDE children we rely on size=[0,0] on
// the WRAPPER panel, controlled by a bindable size binding.
//
// Since size-bindings on panels are not well supported either, the simplest + most reliable
// trick: wrap each caption/text in a DEDICATED panel whose only purpose is to carry #visible.
// Panels DO respect #visible on themselves (tested) and the children render inside.
// This reduces each label to a "panel>label" pair that the engine treats correctly.

const visWrap = (inner, vis, props = {}) => panel({ size: inner.size || ["100%cm", "100%cm"], ...props, layer: props.layer ?? 2 }, [C("x", inner)], vis);

/** Systems list: shown only while there is no scan / target to show. */
function systemsPanel() {
  const W = RIGHT_W;
  const vis = and(is("scan", "0"), is("target_class", "0"));
  return panel({ size: [W, SYSTEMS_H], ...at(0, 0), layer: 1 }, [
    C("bg", image("panel_systems", { size: [W, SYSTEMS_H], ...at(0, 0), layer: 1 }, [], vis)),
    C("caption_box", panel({ ...at(6, 1.5), size: [100, 8] }, [
      C("caption", staticLabel("SISTEMAS", { ...at(0, 0), font_scale_factor: 0.5, color: TXT.dim, layer: 2 })),
    ], vis)),
    C("systems_text_box", panel({ ...at(5, 10), size: [W - 8, SYSTEMS_H - 12] }, [
      C("systems_text", fieldLabel("systems_text", { ...at(0, 0), size: [W - 8, "default"], font_scale_factor: 0.6, color: TXT.ice, layer: 2 })),
    ], vis)),
  ], vis);
}

function scanPanel() {
  const W = RIGHT_W;
  const vis = isnt("scan", "0");
  return panel({ size: [W, SCAN_H], ...at(0, 0), layer: 1 }, [
    C("bg", image("panel_scan", { size: [W, SCAN_H], ...at(0, 0), layer: 1 }, [], vis)),
    C("radar_idle", image("radar_idle", { size: [11, 11], ...at(4, 0.5), layer: 2 }, [], is("scan", "1"))),
    C("radar_sweep", image("radar_sweep", { size: [11, 11], ...at(4, 0.5), layer: 2, anims: [ref("anim_blink_out")] }, [], is("scan", "2"))),
    C("caption_box", panel({ ...at(18, 3), size: [120, 8] }, [
      C("caption", staticLabel("SCANNER DE ÁREA", { ...at(0, 0), font_scale_factor: 0.55, color: TXT.cyan, layer: 2 })),
    ], vis)),
    C("scan_text_box", panel({ ...at(5, 14), size: [141, SCAN_H - 16] }, [
      C("scan_text", fieldLabel("scan_text", { ...at(0, 0), size: [141, "default"], font_scale_factor: 0.6, color: TXT.ice, layer: 2 })),
    ], vis)),
    C("sweep", image("scan_sweep", { size: [146, 6], ...at(2, 12), alpha: 0.9, layer: 3, anims: [ref("anim_scan_sweep")] }, [], is("scan", "2"))),
  ], vis);
}

export const TARGET_CLASSES = ["h", "n", "p", "j"];

/** Target analysis panel at height y: wrap labels in their own visibility panels. */
function targetPanel(y, visible) {
  const W = RIGHT_W;
  return panel({ size: [W, TARGET_H], ...at(0, y), layer: 1 }, [
    ...TARGET_CLASSES.map((c) => C(`frame_${c}`, image(`target_frame_${c}`, { size: [W, TARGET_H], ...at(0, 0), layer: 1 }, [], and(visible, is("target_class", c))))),
    C("caption_box", panel({ ...at(7, 3), size: [120, 8] }, [
      C("caption", staticLabel("ANÁLISE DE ALVO", { ...at(0, 0), font_scale_factor: 0.55, color: TXT.white, layer: 2 })),
    ], visible)),
    C("target_text_box", panel({ ...at(6, 14), size: [138, TARGET_H - 20] }, [
      C("target_text", fieldLabel("target_text", { ...at(0, 0), size: [138, "default"], font_scale_factor: 0.65, color: TXT.white, layer: 2 })),
    ], visible)),
    C("hp_bar", dynImage(texOf("hp_", cat(cat(fld("target_class"), lit("_")), fld("target_hp_frame"))), "hp_0_00", { size: [138, 5], ...at(6, 45), layer: 2 }, [], visible)),
  ], visible);
}

const COMPASS_W = 150;
const COMPASS_SLOTS = 25;
const COMPASS_SCALE = 0.75;
const COMPASS_X = (COMPASS_W - (COMPASS_SLOTS * 6 - 1) * COMPASS_SCALE) / 2;

function topCenter() {
  const W = COMPASS_W;
  return panel({ size: ["100%", "100%"], layer: 2 }, [
    // compass tape inside a black tab that extends the user's top-centre helmet notch
    C("compass_box", panel({ size: [W, 12], anchor_from: "top_middle", anchor_to: "top_middle", offset: [0, 0] }, [
      C("compass_notch", image("compass_notch", { size: [W, 12], layer: 1 })),
      // Text fields arrive padded with trailing spaces, so they are never centre-aligned (the
      // padding would shift them). The tape is COMPASS_SLOTS glyphs of 6 font px (script codec.js),
      // so a left-aligned label at a fixed offset is exactly centred in the tab.
      C("compass", fieldLabel("compass", { ...at(COMPASS_X, 2.5), font_scale_factor: COMPASS_SCALE, color: TXT.cyan, layer: 2 })),
    ])),
    C("alert_box", panel({ size: [204, 15], anchor_from: "top_middle", anchor_to: "top_middle", offset: [0, BELOW_TOP_LINE_DEEPEST] }, [
      C("alert_banner", dynImage(texOf("alert_", fld("alert")), "alert_i", { size: [204, 15], layer: 1 })),
      C("alert_flash", image("alert_flash", { size: [204, 15], layer: 2, anims: [ref("anim_blink_out")] }, [], is("alert", "c"))),
      C("alert_text", fieldLabel("alert_text", { anchor_from: "left_middle", anchor_to: "left_middle", offset: [21, 0.5], font_scale_factor: 0.75, color: TXT.white, layer: 3 })),
    ], isnt("alert", "0"))),
  ]);
}

function centerCluster() {
  return panel({ size: ["100%", "100%"], layer: 3 }, [
    C("reticle_ring", image("reticle_ring", { size: [60, 60], layer: 1, anims: [ref("anim_ring_out")] })),
    C("reticle", dynImage(texOf("reticle_", fld("reticle")), "reticle_i", { size: [32, 32], layer: 3 })),
    C("lock_ring", dynImage(texOf("lock_", fld("lock_frame")), "lock_0", { size: [50, 50], layer: 4 }, [], isnt("lock_frame", "0"))),
    // above the reticle: below it the tag would collide with the low flight panel on phones
    C("lock_tag", image("lock_tag", { size: [86, 10], anchor_from: "center", anchor_to: "center", offset: [0, -36], layer: 2 }, [
      C("lock_tag_label", staticLabel("MIRA TELEGUIADA", { anchor_from: "center", anchor_to: "center", offset: [0, 0.5], text_alignment: "center", font_scale_factor: 0.55, color: TXT.amber, layer: 1 })),
    ], is("lock_mode", "1"))),
  ]);
}

function rightColumn() {
  const noScan = is("scan", "0");
  const hasTarget = isnt("target_class", "0");
  return panel({ size: [RIGHT_W, RIGHT_H], anchor_from: "top_right", anchor_to: "top_right", offset: [-4, BELOW_TOP_LINE], layer: 2 }, [
    C("systems_panel", systemsPanel()),
    C("scan_panel", scanPanel()),
    C("target_panel", targetPanel(0, and(hasTarget, noScan))),
    C("target_panel_low", targetPanel(TARGET_LOW_Y, and(hasTarget, not(noScan)))),
  ]);
}

function flightPanel() {
  return image("panel_flight", { size: [166, 31], anchor_from: "bottom_middle", anchor_to: "bottom_middle", offset: [0, -FLIGHT_PANEL_BOTTOM], layer: 2 }, [
    C("badge", dynImage(texOf("flight_", fld("flight")), "flight_0", { size: [24, 24], ...at(4, 3.5), layer: 2 })),
    C("caption", staticLabel("VOO • PROPULSORES", { ...at(32, 2.5), font_scale_factor: 0.5, color: TXT.dim, layer: 2 })),
    C("flight_text", fieldLabel("flight_text", { ...at(32, 9), size: [118, "default"], font_scale_factor: 0.6, color: TXT.ice, layer: 2 })),
    C("thrust", dynImage(texOf("thrust_", fld("thrust_frame")), "thrust_00", { size: [8, 26], ...at(154, 2.5), layer: 2 })),
  ], isnt("flight", "0"));
}

function mainHud() {
  return panel({ size: ["100%", "100%"], layer: 5 }, [
    C("left_column", panel({ size: [152, 126], ...at(4, BELOW_TOP_LINE), layer: 2 }, [
      C("suit_panel", suitPanel()),
      C("energy_panel", energyPanel(88)),
    ])),
    C("top_center", topCenter()),
    // coordinates: small, in the top-left band of the visor (above its top-left polyline)
    C("coords_text", fieldLabel("coords_text", { ...at(7, 5), font_scale_factor: 0.55, color: TXT.dim, layer: 2 })),
    C("center", centerCluster()),
    C("right_column", rightColumn()),
    C("flight_panel", flightPanel()),
  ], modeIs("1"));
}

function bootOverlay() {
  const m = fld("mode");
  const frame = (mode) => image(`boot_frame_${mode}`, { size: [230, 106], ...at(0, 0), layer: 1 }, [], modeIs(mode));
  return panel({ size: ["100%", "100%"], layer: 20 }, [
    // frame images are static per mode and SIBLINGS of the content (SPEC 11 item 3)
    C("boot_frame", panel({ size: [230, 106], anchor_from: "center", anchor_to: "center", offset: [0, -14], layer: 1 }, [
      C("frame_boot", frame("2")),
      C("frame_fail", frame("3")),
      C("header_boot", staticLabel("SYM INDUSTRIES  //  MARK V  //  SYM OS 2.3", { ...at(9, 3.5), font_scale_factor: 0.6, color: TXT.cyan, layer: 2 }, modeIs("2"))),
      C("header_fail", staticLabel("§lALERTA  //  FALHA CRÍTICA DE ENERGIA", { ...at(9, 3.5), font_scale_factor: 0.6, color: TXT.red, layer: 2 }, modeIs("3"))),
      C("ring", dynImage(texOf("boot_ring_", m), "boot_ring_2", { size: [26, 26], anchor_from: "top_right", anchor_to: "top_right", offset: [-7, 19], layer: 2 })),
      C("boot_text", fieldLabel("boot_text", { ...at(9, 19), size: [180, "default"], font_scale_factor: 0.75, color: TXT.ice, layer: 2 })),
      C("loader", dynImage(texOf("boot_load_", m), "boot_load_2", { size: [64, 5], anchor_from: "bottom_left", anchor_to: "bottom_left", offset: [9, -7], layer: 2, anims: [ref("anim_pulse_out")] })),
      C("scanline", dynImage(texOf("boot_scan_", m), "boot_scan_2", { size: [226, 8], ...at(2, 3), alpha: 0.8, layer: 5, anims: [ref("anim_boot_scan")] })),
    ])),
  ], or(modeIs("2"), modeIs("3")));
}

export function buildNamespace() {
  // layer 0 + inserted at the FRONT of root_panel: the visor artwork draws below every vanilla HUD
  // element (hotbar, hearts, chat...), our panels draw above the artwork.
  const root = panel({ size: ["100%", "100%"], layer: 0 }, [
    C("visor", visorFrame()),
    // threat glow over the artwork (its texture is cut out around the user's lines and notches)
    C("danger", dangerEdge()),
    C("main", mainHud()),
    C("boot", bootOverlay()),
  ], EXPR.rootVisible);
  return { namespace: NS, ...ANIMS, [ROOT_CONTROL]: root };
}

export function buildHudScreen() {
  return {
    namespace: "hud",
    // vanilla title text hidden while the title is a Mark V HUD string
    hud_title_text: {
      bindings: [titleBinding(), view(EXPR.vanillaTitleVisible, "#visible")],
    },
    // vanilla top-left paper doll hidden while our HUD (which has its own 3D armor view) is shown
    hud_player_renderer: {
      bindings: [titleBinding(), view(not(EXPR.rootVisible), "#visible")],
    },
    root_panel: {
      modifications: [
        {
          array_name: "controls",
          operation: "insert_front",
          value: [{ [`sym_mk5_hud_root@${NS}.${ROOT_CONTROL}`]: {} }],
        },
      ],
    },
  };
}

export function buildUiDefs() {
  return { ui_defs: ["ui/sym_mk5_hud.json"] };
}

function writeJson(rel, obj) {
  const p = join(RP, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
  return p;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  if (!existsSync(join(RP, "manifest.json"))) throw new Error(`RP not found at ${RP}`);
  const ns = buildNamespace();
  writeJson("ui/_ui_defs.json", buildUiDefs());
  writeJson("ui/hud_screen.json", buildHudScreen());
  writeJson("ui/sym_mk5_hud.json", ns);
  let controls = 0;
  let bindings = 0;
  const walk = (def) => {
    controls++;
    bindings += (def.bindings || []).length;
    for (const c of def.controls || []) for (const k of Object.keys(c)) walk(c[k]);
  };
  walk(ns[ROOT_CONTROL]);
  console.log(`sym_mk5_hud.json: ${controls} controls, ${bindings} bindings, total title bytes ${PROTO.totalBytes}`);
}
