# Mark V — Sym Industries v2.0 — Master Spec

Workspace root: `/home/user/OmniRoute/_artifacts/mark5_build` (call it `$B`).
The addon lives in `$B/pack/Mark5_BP` (behavior) and `$B/pack/Mark5_RP` (resources).
Reference material (read-only): `$B/ref/` — `mcapi/minecraft-server-2.0.0/package/index.d.ts`
and `mcapi/minecraft-server-ui-2.0.0/package/index.d.ts` (THE API contract), vanilla
`hud_screen.json`, `player.entity.json`, `player.animation.json`, `player.render_controllers.json`,
and Bedrock-Wiki JSON-UI pages (`wiki_*.md`).

## 0. What the user asked (Portuguese, translated)

The user plays Minecraft Bedrock with this Iron Man Mark V addon (suitcase suit-up cinematic).
They asked for:

1. The suit must not need the invisibility effect — the body is hidden by the suit/render
   controllers. NEVER apply `invisibility` anywhere.
2. A high-tech HUD (visor) that shows the armor in 3D (paper-doll renderer of the player), a
   crosshair/reticle and "other things to make it top".
3. ENERGY system. Energy also gives armor (protection depends on power). If energy runs out, the
   suit's LED lights — helmet eyes, arms (palm repulsors), legs (boot thrusters) and chest
   (arc reactor) — turn OFF with a little power-down sound.
4. The HUD consumes energy while active; the suit LEDs (chest reactor, arms, legs) consume energy;
   the eyes consume a little. The armor recovers energy normally whether equipped or unequipped.
5. Target scanner: when you look at a mob, show if it is hostile, distance, health, etc.
6. Area scanner: scan all entities in a radius; dangerous ones get marked RED, natural / non-hostile
   ones GREEN and WHITE (inspired by the "Legends" mod scanner).
7. Flight system that spends energy; no energy = cannot fly. HUD shuts down without energy.
   Very cool, realistic, with custom effects (fire, etc.).
8. A button to take off / put on the mask (open/close the visor). Opening hides the HUD.
9. A homing lock-on targeting system for future missiles.

All in-game text is Brazilian Portuguese.

## 1. Hard constraints

- Script API: `@minecraft/server` **2.0.0** and `@minecraft/server-ui` **2.0.0** ONLY. Every API you
  call must exist in `ref/mcapi/*/package/index.d.ts` (grep it!). No beta APIs. `min_engine_version`
  stays `[1, 26, 0]`.
- JavaScript ES modules (QuickJS). No Node APIs, no `Buffer`, no `TextEncoder` (compute UTF-8 byte
  length manually). `Date.now()` is allowed but prefer `system.currentTick` /
  `world.getAbsoluteTime()`.
- Every engine call that may throw (runCommand, playAnimation, setTitle, component access on an
  entity that may have died, teleport, applyKnockback, spawnParticle in unloaded chunks, …) goes
  through the existing `safeRun()` pattern or a try/catch. One player's error must never stop the
  loop for others.
- Performance: per-tick work only for players wearing the suit; entity queries for the area scan
  only on demand; look-at raycast at most every 2 ticks; HUD title at most every 2 ticks.
- No `invisibility`. No custom player.json behavior override (no BP `entities/player.json`).
- JSON files must be valid JSON (no comments) — except UI files may NOT contain comments either
  (keep them strict JSON so our validators can parse them).
- Keep existing identifiers working (`sym:mark_5`, `sym:mark_5_suitcase`, `sym:mark_5_reactor`,
  assembling/disassembling items, the case entity, all existing animations and sounds).

## 2. Identifier registry (everyone must use EXACTLY these)

### 2.1 Suit chest items (BP `items/`, RP `attachables/`) — "suit variants"

| id | powered | visor | kind | protection | attachable texture | attachable extra animation (third person, worn) |
|---|---|---|---|---|---|---|
| `sym:mark_5` (exists) | yes | closed | final | 20 | `textures/sym/mk5` | `animation.sym.mk5.eyes_boot` (one-shot, hold) |
| `sym:mark_5_open` | yes | open | final | 20 | `textures/sym/mk5` | `animation.sym.mk5.visor_opened` (static loop) |
| `sym:mark_5_opening` | yes | opening | temp (locked) | 20 | `textures/sym/mk5` | `animation.sym.mk5.visor_opening` (0.8 s, hold) |
| `sym:mark_5_closing` | yes | closing | temp (locked) | 20 | `textures/sym/mk5` | `animation.sym.mk5.visor_closing` (0.8 s, hold) |
| `sym:mark_5_powerdown` | dying | closed | temp (locked) | 20 | `textures/sym/mk5` | `animation.sym.mk5.eyes_shutdown` (1.2 s, hold) |
| `sym:mark_5_offline` | no | closed | final | 8 | `textures/sym/mk5_off` | none (eyes cube stays visible but its pixels are dark in mk5_off) |
| `sym:mark_5_offline_open` | no | open | final | 8 | `textures/sym/mk5_off` | `animation.sym.mk5.visor_opened` |
| `sym:mark_5_offline_opening` | no | opening | temp (locked) | 8 | `textures/sym/mk5_off` | `animation.sym.mk5.visor_opening` |
| `sym:mark_5_offline_closing` | no | closing | temp (locked) | 8 | `textures/sym/mk5_off` | `animation.sym.mk5.visor_closing` |

- All variants: `max_stack_size` 1, `minecraft:wearable` slot `slot.armor.chest`, durability 1815,
  enchantable `armor_torso` value 10, repairable with diamond 454, tag `minecraft:is_armor`, icon
  `sym_mk5_armor`, display name "Armadura Mark V". Only `sym:mark_5` is visible in the creative
  menu (`equipment` / chestplate group); all others `"menu_category": {"category": "none",
  "is_hidden_in_commands": true}`.
- Transition timings used by the script: opening/closing temp worn for **16 ticks**, powerdown temp
  worn for **24 ticks**, then swapped to the final variant.
- `textures/sym/mk5_off.png` = copy of `mk5.png` where the 20 emissive LED pixels (alpha 140) become
  opaque dark metal/glass (alpha 255, e.g. RGB ~ (38, 44, 52); eye/reactor glass slightly bluish
  (30, 40, 55)). The LED pixels are: eyes (3,89)(4,89)(7,89)(8,89); chest reactor
  (23..24, 22..23); palms (41..42, 49..50); boots (9..10, 17..18); unused (49..50, 17..18).
- Render-controller "FULL suit" set = all 9 variants + `sym:mark_5_assembling_4` +
  `sym:mark_5_disassembling_1`. "FACE VISIBLE" (visor open-ish: show Tony's head instead of the
  undersuit head) = `sym:mark_5_open`, `sym:mark_5_opening`, `sym:mark_5_closing`,
  `sym:mark_5_offline_open`, `sym:mark_5_offline_opening`, `sym:mark_5_offline_closing`.

### 2.2 Attachable animations (RP `animations/sym_mk5.animation.json`, add — do not break existing)

Bones (geometry `geometry.sym.mk5`): faceplate `mk5_mask` (child of `mk5_mainframe`), eye glow cube
`mk5_eyes` (child of `mk5_mask`), side plates `mk5_Left_mask`, `mk5_Right_mask`.
The original suit-off animation opens the faceplate like this (reuse these numbers):
side plates unlatch: `mk5_Left_mask` rot y −12.5 / pos z −0.5..−1, `mk5_Right_mask` rot y +12.5 /
pos z −0.5..−1; faceplate lifts: `mk5_mask` rotation `[-75,0,0]`, position `[0,5.5,-1.5]` →
`[0,5,3]`; eyes off = `mk5_eyes` scale 0 (flickered).

- `animation.sym.mk5.visor_opened` — loop, static open pose: mask rot `[-75,0,0]` pos `[0,5,3]`,
  eyes scale 0, side plates at rest.
- `animation.sym.mk5.visor_opening` — 0.8 s, `hold_on_last_frame`: eyes flicker off (0–0.2),
  side plates unlatch (0.15–0.35), mask lifts (0.35–0.65) with the same in-between key
  `[0,5.5,-1.5]`, side plates return (0.65–0.8). Ends exactly in the `visor_opened` pose.
- `animation.sym.mk5.visor_closing` — 0.8 s, hold: reverse of opening (mask comes down with a tiny
  overshoot `[0,-0.5,0]` like suitup_3, plates latch), eyes stay scale 0 until the end then the
  eyes are scale 1 at 0.8 (eyes then flicker on through `eyes_boot` when the final item is worn).
- `animation.sym.mk5.eyes_boot` — 0.9 s, hold: `mk5_eyes` scale flicker 0→1→0→1… ending at 1
  (like suitup_3 1.8–2.675 s).
- `animation.sym.mk5.eyes_shutdown` — 1.2 s, hold: `mk5_eyes` flicker 1→0→1→0… ending at 0
  (like suitoff_1 0.625–1.5 s).
In the attachables, these extra animations are added to `scripts.animate` with the same condition
used for the worn pose: `"!(c.item_slot == 'main_hand' || c.item_slot == 'off_hand')"`.
Variant attachables are otherwise copies of `attachables/sym_mark_5.json` (same geometry, material,
first-person animations).

### 2.3 Player animations (RP `animations/sym_mk5_player.animation.json`, add)

Played by the script with `player.playAnimation(id, { controller: "sym_mk5_flight", blendOutTime,
stopExpression: "0" })` (the `sym_mk5_flight` controller is separate from the cinematic `sym_mk5`).
Vanilla proves that rotating `root` in a player animation also moves armor attachables (vanilla
swim rotates `root`). Player geometry bones: `root` > `waist` > `body` > (`head`, `rightArm`,
`leftArm`); `rightLeg`, `leftLeg` are children of `root`. Every value must be multiplied by
`(1 - variable.is_first_person)` (or otherwise disabled in first person) so first-person arms are
not thrown around.

- `animation.sym.player.mk5_hover` — loop 2 s: arms slightly out and forward-down with palms facing
  the ground (stabilizer pose), legs straight slightly apart, gentle bob of `root` position y
  (±0.4 px).
- `animation.sym.player.mk5_fly` — loop: Iron-Man cruise. `root` pitched forward like vanilla swim
  but less: rotation x = `math.clamp(60 + query.target_x_rotation * 0.6, 15, 110)` with matching
  root position offset (see vanilla `animation.player.swim`: position y `sin(rot)*~13+4`, z
  `cos(rot)*~13`… tune so the body stays centered on the hitbox); arms straight back along the
  body (palms back), legs together slightly bent; head compensates so it looks along the view.
- `animation.sym.player.mk5_boost` — loop: like fly but flatter (≈ 80 + pitch*0.5, clamp 20..120),
  arms tight to the body, small shaking (`math.sin(query.life_time*90)*0.6` deg).
- `animation.sym.player.mk5_takeoff` — 0.5 s one-shot: quick crouch then arms snap down (palms
  down).
- `animation.sym.player.mk5_land` — 1.0 s one-shot "superhero landing": `root` drops ~6 px, right
  knee down, left leg forward bent, right fist to the ground, left arm out back; returns to stand at
  the end.
- `animation.sym.player.mk5_flight_reset` — 0.05 s one-shot with no bones (used to stop the flight
  loops on the `sym_mk5_flight` controller).

### 2.4 Particles (RP `particles/`) — identifiers and Molang inputs

Script passes values with `MolangVariableMap`: `setVector3("variable.dir", v)` → `variable.dir.x/y/z`;
`setFloat("variable.power", n)`; `setFloat("variable.size", n)`; `setFloat("variable.width", n)`;
`setFloat("variable.radius", n)`; `setColorRGBA("variable.color", {red,green,blue,alpha})` →
`variable.color.r/g/b/a`. Particles MUST work (with sane defaults) even if a variable is missing:
guard with e.g. `(variable.power ?? 1)` — Molang supports `??`.

| id | look | inputs |
|---|---|---|
| `sym:mk5_thrust` | repulsor / boot jet: short stream (0.12–0.25 s) of additive flame sprites shooting along `dir`, white-blue core → cyan → orange → dark, shrinking; 6–14 particles per spawn scaled by power | `dir`, `power` 0..1 |
| `sym:mk5_thrust_glow` | single bright blue-white glow disc at the nozzle, 0.1 s | `power` |
| `sym:mk5_smoke` | 2–4 grey smoke puffs drifting up/back, 0.8–1.4 s, `particles_blend` | `dir` |
| `sym:mk5_boom` | sonic boom: white translucent ring perpendicular to `dir` that expands 0→6 blocks in 0.45 s and fades; plus a few streaks | `dir` |
| `sym:mk5_takeoff` | ground blast: flat expanding ring of dust/fire on the XZ plane + upward sparks | — |
| `sym:mk5_landing` | superhero landing: flat dust shockwave ring on XZ plane (radius 0→3), debris chunks | — |
| `sym:mk5_scan_wave` | scanner pulse: thin cyan glowing ring lying on the XZ plane, radius grows 0→`radius` (default 32) over 1.4 s, fades | `radius` |
| `sym:mk5_scan_dome` | camera-facing cyan circle outline growing 0→`radius` over 1.4 s (sphere impression), faint | `radius` |
| `sym:mk5_mark` | target bracket box (four corner brackets) billboard (`lookat_xyz`), size `width` x `size` blocks, tinted by `color`, lifetime 0.35 s, slight pulse | `size`, `width`, `color` |
| `sym:mk5_lock` | red rotating diamond / reticle around a locked target, lifetime 0.3 s, size from `size` | `size` |
| `sym:mk5_power_down` | electrical sparks + dark smoke puff from the chest when power dies | — |
| `sym:mk5_power_up` | cyan ring pulse expanding from the chest reactor on reboot | — |
| `sym:mk5_shield_hit` | hexagonal cyan shield flash (billboard) + sparks when energy absorbs damage | — |

Existing (keep): `sym:mk5_spark`, `sym:mk5_power_burst`.
Particle textures live under `textures/sym/particle/` (an atlas `mk5_fx.png` is fine).

### 2.5 Sounds (RP `sounds/sound_definitions.json` + `sounds/sym/*.ogg`)

All new sounds are original, synthesized (numpy) and encoded OGG Vorbis (ffmpeg libvorbis, mono,
44.1 kHz). Category `player`. Existing ones stay.

| id | file | description |
|---|---|---|
| `sym.mk5.power_down` | `sounds/sym/power_down.ogg` | LEDs dying: electric crackle + descending whine 1.2 kHz→80 Hz + final relay click, 1.3 s |
| `sym.mk5.power_up` | `sounds/sym/power_up.ogg` | reboot: rising whine + 3 ascending chimes, 1.2 s |
| `sym.mk5.hud_boot` | `sounds/sym/hud_boot.ogg` | HUD boot: quick digital chirps + soft swell, 1.0 s |
| `sym.mk5.hud_off` | `sounds/sym/hud_off.ogg` | short descending blip, 0.3 s |
| `sym.mk5.alarm` | `sounds/sym/alarm.ogg` | low-energy two-tone warning beep-beep, 0.5 s |
| `sym.mk5.scan` | `sounds/sym/scan.ogg` | sonar ping with long shimmering tail + sweep, 1.6 s |
| `sym.mk5.scan_ping` | `sounds/sym/scan_ping.ogg` | small high blip when a hostile is detected, 0.15 s |
| `sym.mk5.lock_tick` | `sounds/sym/lock_tick.ogg` | short targeting beep, 0.08 s |
| `sym.mk5.lock_on` | `sounds/sym/lock_on.ogg` | lock confirmed: steady high tone with tremolo, 0.6 s |
| `sym.mk5.lock_lost` | `sounds/sym/lock_lost.ogg` | descending two-note blip, 0.3 s |
| `sym.mk5.target` | `sounds/sym/target.ogg` | soft UI blip when a new target is analyzed, 0.1 s |
| `sym.mk5.thruster_start` | `sounds/sym/thruster_start.ogg` | ignition: whoosh + low boom + rising roar, 1.0 s |
| `sym.mk5.thruster_loop` | `sounds/sym/thruster_loop.ogg` | jet/repulsor roar (filtered noise + hum), 1.0 s, loop-friendly fades |
| `sym.mk5.thruster_boost` | `sounds/sym/thruster_boost.ogg` | brighter, more aggressive roar, 1.0 s, loop-friendly |
| `sym.mk5.thruster_stop` | `sounds/sym/thruster_stop.ogg` | spool-down, 0.8 s |
| `sym.mk5.sonic_boom` | `sounds/sym/sonic_boom.ogg` | double-crack boom with rumble tail, 1.5 s |
| `sym.mk5.landing` | `sounds/sym/landing.ogg` | heavy metal impact + ground thud, 0.8 s |
| `sym.mk5.shield` | `sounds/sym/shield.ogg` | energy shield absorb zap, 0.4 s |
| `sym.mk5.menu` | `sounds/sym/menu.ogg` | panel open chirp, 0.2 s |

Existing: `sym.mk5.suitup`, `sym.mk5.suitoff`, `sym.mk5.helmet_close`, `sym.mk5.helmet_open`
(used for visor open/close), `sym.mk5.power_on`.

### 2.6 UI textures (owned by the HUD agent)

- HUD textures: `textures/sym/hud/*` — at least every name referenced by the protocol notes:
  `energy_00..20`, `integrity_00..10`, `reticle_i,h,n,p,j,l,k`, `lock_1..5`,
  `hp_h_00..10`, `hp_n_00..10`, `hp_p_00..10`, `hp_j_00..10`, `thrust_00..10`, plus whatever frames
  and panels the HUD design needs.
- Menu button icons (used by the script's ActionFormData): `textures/sym/ui/icon_visor`,
  `icon_hud`, `icon_flight`, `icon_scan`, `icon_lock`, `icon_diag`, `icon_suitoff` (PNG, 32x32 or
  64x64, transparent background).

## 3. HUD

### 3.1 Transport

The script sends the HUD as a TITLE: `player.onScreenDisplay.setTitle(data, { fadeInDuration: 0,
stayDuration: 200, fadeOutDuration: 0 })` every 2 ticks while the HUD is on. `data` is built by
`encodeHud(fields)` per `tools/hud_protocol.json` (offsets in `tools/hud_protocol.resolved.json` and
generated module `pack/Mark5_BP/scripts/suit/hud_protocol.js`). Total length is constant
(`HUD_TOTAL_BYTES`). When the HUD goes off the script sends ONE string `"MK5H0"` padded to full
length with spaces (mode `0`) — then stops sending (so other titles work again).

JSON UI side (`ui/hud_screen.json` + `ui/sym_mk5_hud.json` registered in `ui/_ui_defs.json`):
- The vanilla title element `hud_title_text` must be hidden whenever the current title string starts
  with `MK5H` (add a `#visible` view binding on it).
- Our root panel is inserted into `root_panel` (see `ref/wiki_add-hud-elements.md`). It is visible
  only when `('%.4s' * #hud_title_text_string) = 'MK5H'` and mode ≠ `0`.
- Field extraction: `((('%.<end>s' * #hud_title_text_string) - ('%.<start>s' * #hud_title_text_string)))`.
- Dynamic images use `"texture": "#texture"` with a view binding producing
  `('textures/sym/hud/energy_' + <field>)` (pattern from `ref/wiki_best-practices.md`).
- Each control that reads the title needs `{ "binding_name": "#hud_title_text_string" }` before its
  view bindings (`binding_type` global is the default).

### 3.2 Layout (UI pixels; anchor to edges so it works on phone and PC)

- Visor frame overlay: full screen, behind everything else of ours, transparent center, cyan
  tech borders/corner brackets/scan lines; red edge glow image visible when `threat = 1` or
  `energy_state = c`.
- Center: reticle image (`reticle_<c>`, ~32x32) + lock progress ring (`lock_<c>`, hidden at `0`).
  The script hides the vanilla crosshair while the HUD is on.
- Top center: compass tape label (`compass`) in a thin frame; alert banner below it (`alert`,
  `alert_text`), color by alert type, `c` blinks (alpha anim).
- Top-left: "3D armor" panel — `hud_player_renderer` (vanilla custom renderer, see
  `ref/hud_screen.json` top) inside a frame ~48x72, the 4 LED state dots/labels (head, chest, arms,
  legs from `led_*`), `suit_text` under it, integrity bar.
- Left, under the armor panel: energy gauge image (`energy_<NN>`) + `energy_text`, color/glow by
  `energy_state`.
- Left, lower: `systems_text`.
- Right-middle: target panel (visible when `target_class` ≠ `0`): frame colored by class,
  `target_text`, HP bar `hp_<class>_<NN>`.
- Right-top (below where phone pause/chat buttons are, ~y 40): scan panel (visible when `scan` ≠
  `0`), `scan_text`; when `scan = 2` show an animated "SCANNING" sweep.
- Bottom center above the hotbar (≈ 58 px from bottom): flight panel (visible when `flight` ≠ `0`):
  `flight_text` + thrust bar `thrust_<NN>`.
- Bottom-left above hotbar or top-right corner: `coords_text`, small.
- `lock_mode = 1`: small "MIRA TELEGUIADA" tag near the reticle.
- mode `2` (boot): main panels hidden, centered boot overlay with `boot_text` and a scan-line
  sweep animation. mode `3` (power failure): red version of that overlay.

## 4. Script architecture (BP `scripts/`)

`main.js` stays the entry point and keeps the cinematic suit-up/off. New modules in
`scripts/suit/`:

- `hud_protocol.js` — GENERATED (do not edit by hand).
- `constants.js` — ids, variant table, tuning numbers (section 6).
- `variants.js` — `isSuitId(id)`, `isTempVariant(id)`, `variantFor({powered, visor})`,
  `getWornSuit(player)` → `{item, id, powered, visor}` or undefined, `swapChest(player, newId,
  {temp})` copying durability damage, enchantments (`minecraft:enchantable`
  getEnchantments/addEnchantments), nameTag, lore, keepOnDeath, dynamic properties; temp variants
  get `lockMode = ItemLockMode.slot` and `keepOnDeath = true`, final variants unlocked.
- `energy.js` — energy model + power state machine + energy shield.
- `hud.js` — `encodeHud()`, utf8 byte helpers, HUD state per player (boot, alerts queue), builds all
  fields, sends titles, hides/restores vanilla crosshair (`HudElement.Crosshair`).
- `flight.js` — flight controller.
- `scanner.js` — look-at analysis + area scan + marks; PT-BR mob names + classification table.
- `targeting.js` — lock-on (public API, see 5.7).
- `menu.js` — control panel (`ActionFormData`).
- `input.js` — gestures (double-tap jump etc.).
- `fx.js` — particle/sound helpers (`MolangVariableMap`).
- `index.js` — `initSuitSystems({ beginSuitOff })`: subscribes everything, runs the main loop
  (`system.runInterval(..., 1)`), exports hooks used by `main.js`: `onSuitUpComplete(player)`,
  `beforeSuitOff(player)`, `isSuitWorn(player)`, `finalSuitIdForPlayer(player)`.

Cinematic detection: a player is "busy" while `player.getDynamicProperty("sym:mk5_state")` is
`"suitup"`/`"suitoff"` (main.js sets it) — suit systems do nothing for busy players (HUD hidden,
no flight, no energy drain except regen, no variant swaps).

### main.js changes

- Every `wearing(player, ITEM_SUIT)` check → "wearing any suit variant".
- End of suit-up (tick 278): equip `finalSuitIdForPlayer(player)` (powered closed `sym:mark_5`, or
  `sym:mark_5_offline` when energy is latched offline) with the stored damage; at tick 318 (after
  camera clear) call `onSuitUpComplete(player)` → HUD boot sequence.
- `beginSuitOff`: call `beforeSuitOff(player)` first (stop flight, HUD off, drop lock, restore
  crosshair, reset flight anim); durability is read from whatever variant is worn.
- Arc Reactor item: use → open the control panel menu; sneak + use → toggle visor (quick button).
  Rename item to "Reator Arc (Painel Mark V)" and its lore to explain both actions.
  The old direct suit-off on use moves into the menu ("Desmontar armadura").
- `recover()`: temp variants (opening/closing/powerdown) worn after a reload → swap to their final
  variant; suit variants found in the inventory (not worn) → replace with a base `sym:mark_5` item
  (keep damage + enchantments). Dropped variant items (entitySpawn) → base `sym:mark_5`.
- Keep: look down + double-tap sneak on the ground = take the suit off.
- Bump nothing else; keep the cinematic exactly as is.

## 5. Behaviour

### 5.1 Energy (`energy.js`)

- Stored per player: dynamic property `sym:mk5_energy` (0..`ENERGY_MAX`, default full),
  `sym:mk5_energy_t` (last `world.getAbsoluteTime()` at update), `sym:mk5_offline` (latched
  offline flag). On join, apply regen for elapsed absolute time (capped) — "recovers equipped or
  unequipped". Persist at most once per second.
- Every tick for every online player: `energy += (REGEN - drain) / 20`, clamp 0..MAX.
- `drain` (per second) only when the suit is worn, powered and the player is not busy:
  LED reactor + LED arms + LED legs always; LED eyes only when visor closed; HUD when HUD enabled
  and visor closed; lock mode when armed; flight per mode (hover/cruise/boost/emergency).
  Keep a breakdown object for the diagnostics screen and the HUD rate text.
- Power down: powered and energy hits 0 → latch offline; if visor closed wear
  `sym:mark_5_powerdown` for 24 ticks then `sym:mark_5_offline`; if open → `sym:mark_5_offline_open`
  directly. Sound `sym.mk5.power_down` at the player, particles `sym:mk5_power_down` at the chest,
  HUD mode `3` for 40 ticks with "SISTEMAS OFFLINE / ENERGIA ESGOTADA / LEDs desligados" then
  hidden. Flight is cut (see 5.3). Actionbar message.
- While offline (worn): slowness amplifier 0 (heavy suit), refreshed (duration 50 ticks, no
  particles); removed when powered again or suit removed. Protection is 8 (variant item).
- Reboot: offline and energy ≥ `REBOOT_AT` → unlatch, wear powered variant of the same visor state
  (closed → `sym:mark_5`, whose attachable flickers the eyes on), sound `sym.mk5.power_up`,
  particles `sym:mk5_power_up`, HUD boot sequence (if visor closed & HUD enabled).
- Low energy alarms when crossing 25 %, 10 %, 5 % downward: `sym.mk5.alarm` (pitch higher for
  lower levels) + HUD alert. At ≤ 10 % the HUD energy state is critical.
- Energy shield: `world.afterEvents.entityHurt` (players only, suit powered, cause in
  {entityAttack, projectile, entityExplosion, blockExplosion, fireworks, lightning, thorns, contact,
  flyIntoWall, anvil, fallingBlock, fall, maceSmash, ramAttack, sonicBoom, magic}) → absorb
  `min(damage * SHIELD_FRACTION, energy / SHIELD_COST_PER_HP)` HP: heal it back
  (`minecraft:health` `setCurrentValue(min(effectiveMax, current + absorbed))` only if the player is
  still alive), drain energy, particle `sym:mk5_shield_hit`, sound `sym.mk5.shield`, HUD info alert
  "ESCUDO: -X.X ABSORVIDO".

### 5.2 Visor (in `index.js` or `variants.js` + `hud.js`)

- `toggleVisor(player)`: only when a FINAL variant is worn and not busy and no transition running.
  Open: wear `*_opening` (powered or offline set) for 16 ticks then `*_open`; sound
  `sym.mk5.helmet_open`; HUD turns off immediately (`sym.mk5.hud_off`), crosshair restored.
  Close: wear `*_closing` 16 ticks then the closed final; sound `sym.mk5.helmet_close`; when powered
  and HUD enabled → HUD boot sequence after the swap.
- Persist nothing extra: the visor state is the worn variant.

### 5.3 Flight (`flight.js`)

- Engage: double-tap Jump (two `Pressed` events within 8 ticks; use
  `world.afterEvents.playerButtonInput`) while wearing a powered final/temp variant, not busy, not in
  water/lava, not riding, not gliding, not vanilla-flying (`player.isFlying`), not spectator, energy
  ≥ `FLIGHT_MIN_ENERGY`. Also from the menu ("Decolar"). From the ground: takeoff impulse
  `applyKnockback({x:0,z:0}, 0.9)`, particles `sym:mk5_takeoff` at feet, sound
  `sym.mk5.thruster_start`, anim `mk5_takeoff` then `mk5_hover`, `camerashake add @s 0.15 0.3
  positional`.
- Every tick while flying: read `player.inputInfo.getMovementVector()` (x = +1 LEFT, −1 right;
  y = +1 forward), up = Jump held (`inputInfo.getButtonState(InputButton.Jump) ===
  ButtonState.Pressed` or `player.isJumping`), down = `player.isSneaking` (touch sneak is a 1-tick
  press, the sneak toggle state is what matters). Boost = `player.isSprinting` while moving
  forward. Mode: no input → `hover`; movement → `cruise`; boost → `boost`.
  Target velocity (blocks/tick): forward component along the 3D view direction
  (`getViewDirection()`), strafe along the horizontal left vector, vertical from up/down; hover = 0
  with a ±0.01 bob. Smooth: `v += (target - v) * accel` (accel per mode). Apply with
  `player.applyKnockback({ x: v.x, z: v.z }, v.y)` every tick (this sets player motion).
  While flying keep `slow_falling` (amplifier 0, 40 ticks, no particles) refreshed every 10 ticks —
  this also prevents fall damage — and keep it 60 ticks after flight ends normally.
- Effects every tick: `sym:mk5_thrust` at both boots (dir = exhaust direction: mostly down when
  hovering, opposite to velocity when moving) and both palms (hover: down; cruise/boost: backwards),
  `sym:mk5_thrust_glow` at the 4 nozzles every 2 ticks, `sym:mk5_smoke` every 3 ticks while boosting.
  Spawn with `player.dimension.spawnParticle` (everyone sees the flight). Nozzle positions:
  approximate from location, yaw and pose (hover: boots at feet ±0.15 sideways; palms at y+0.75,
  ±0.45 sideways; fly/boost: body is horizontal → boots ≈ center − dir*0.9, palms ≈ center ±
  side*0.35 − dir*0.2).
- Sound: `sym.mk5.thruster_loop` (or `thruster_boost` when boosting) every 18 ticks at the player,
  volume by mode; `sym.mk5.thruster_stop` when flight ends.
- Sonic boom: entering boost with speed ≥ 1.3 b/t, cooldown 100 ticks → `sym:mk5_boom` (dir =
  velocity), `sym.mk5.sonic_boom`, `camerashake add @s 0.3 0.4 positional`.
- Thruster heat: `heat` 0..100 rises while boosting (+12/s), falls otherwise (−18/s, −30/s
  grounded). ≥ 100 → boost disabled until heat < 60, alert "SUPERAQUECIMENTO DOS PROPULSORES".
  Shown in flight_text.
- Altitude icing (Mark II easter egg): above y = 300 thrust −40 % and warning "FORMAÇÃO DE GELO —
  ALTITUDE CRÍTICA".
- Player anims (controller `sym_mk5_flight`): mode change → play `mk5_hover`/`mk5_fly`/`mk5_boost`
  (stopExpression "0", blendOutTime 0.25); end → `mk5_flight_reset`.
- Disengage: double-tap Jump again; landing (on ground while descending or with no input for 6
  ticks while on ground) → if horizontal+vertical speed at touchdown ≥ 0.6 b/t do a superhero
  landing (anim `mk5_land`, particles `sym:mk5_landing`, sound `sym.mk5.landing`, camerashake),
  else normal; suit removed/visor irrelevant; entering water → disengage with message
  "PROPULSORES INOPERANTES SUBMERSO".
- Energy ≤ `EMERGENCY_AT` while flying → `emergency` mode: no player control, gentle descent
  (v.y = −0.25, horizontal decays), slow falling kept, no drain, HUD alert critical
  "POUSO DE EMERGÊNCIA" until grounded, then flight off.
- Power loss (energy 0) while flying (e.g. huge shield drain) → flight off immediately,
  slow_falling REMOVED (realism: you fall).
- Telemetry for the HUD: altitude y, height above ground (downward block raycast up to 64), speed
  m/s (|v|*20), thrust %, mode name (PAIRANDO / CRUZEIRO / TURBO / EMERGÊNCIA), heat %.

### 5.4 Look-at target analysis (`scanner.js`)

- Every 2 ticks while the HUD is on: `player.getEntitiesFromViewDirection({ maxDistance:
  TARGET_RANGE (48) })` → first valid living entity (has `minecraft:health`, not item/xp/projectile/
  `sym:mk5_case`, not family `inanimate`).
- Classification (`classify(entity)` → `h|n|p|j`): players `j`; explicit tables for vanilla ids
  (hostile / neutral / passive, include 1.21–1.26 mobs: breeze, bogged, creaking, armadillo,
  happy_ghast, copper_golem, parched, camel_husk, nautilus, zombie_nautilus …); unknown ids:
  `matches({families:["monster"]})` → `h`, else `p`. A neutral mob that hurt the player in the last
  30 s (track via entityHurt `damagingEntity`) counts as hostile (`h`).
- Names: PT-BR table for vanilla ids (Zumbi, Esqueleto, Creeper, Aranha, Enderman, Vaca, Porco,
  Ovelha, Galinha, Aldeão, Lobo, Golem de Ferro, …); nameTag wins if present; unknown →
  prettified id ("Iron Golem").
- target_text lines: name; class label with color (§cHOSTIL / §fNEUTRO / §aPACÍFICO / §bJOGADOR)
  + threat level (ALTA / MÉDIA / BAIXA by class and max HP); `DIST 12.4m`; `VIDA 18/20`.
- New target → sound `sym.mk5.target` (only to that player: `player.playSound`).

### 5.5 Area scan (`scanner.js`)

- Trigger: menu "Scanner de área" or look up (pitch ≤ −50) + double-tap Sneak. Cost
  `SCAN_COST` energy (refuse with message if not enough or HUD/power unavailable). Cooldown 60 ticks.
- `dimension.getEntities({ location, maxDistance: SCAN_RADIUS (32) })` filtered like 5.4, excluding
  the player. Spawn `sym:mk5_scan_wave` + `sym:mk5_scan_dome` at the player (dimension-wide so others
  see the pulse), sound `sym.mk5.scan`.
- Wave front speed 24 blocks/s: each entity becomes "revealed" when the front reaches it
  (`delay = dist / 24 * 20` ticks); on reveal of a hostile play `sym.mk5.scan_ping` (player only).
- Revealed entities are marked for `SCAN_MARK_TICKS` (240): every 5 ticks
  `player.spawnParticle("sym:mk5_mark", center, vars)` (only the scanning player sees it) with size
  = entity height estimate (use a per-type height table, default 1.8; width default 0.9) and color:
  hostile red (1, 0.2, 0.2, 1), neutral white (1, 1, 1, 0.9), passive green (0.3, 1, 0.45, 0.9),
  player white-blue (0.75, 0.9, 1, 0.9). Stop marking dead/removed/out-of-range entities.
- HUD: `scan = 2` during the sweep (~1.4 s), then `1` for the mark duration. scan_text: header
  `SCAN 32m • 3 hostis • 2 neutros • 5 pacíficos`, then up to 6 lines sorted (hostile first, then
  distance): colored square + name + distance + bearing (N, NE, …) + HP.
- `threat` field = 1 when any hostile is within 16 blocks (cheap check every 10 ticks only while
  HUD on: `getEntities({location, maxDistance:16, families:["monster"]})`).

### 5.6 Visual mark of the reticle

`reticle` field: lock state wins (`l`/`k`), else target class, else `i`.

### 5.7 Homing lock-on (`targeting.js`)

- Armed/disarmed from the menu ("Mira teleguiada"), persisted in `sym:mk5_lock_mode`. Drains
  `LOCK_DRAIN` while armed.
- While armed and HUD on: the entity under the reticle (5.4 result) accumulates lock progress
  (+1 per 3 ticks, 0..5 → `lock_frame`), `sym.mk5.lock_tick` each step; at 5 → LOCKED:
  `sym.mk5.lock_on`, HUD alert info "ALVO TRAVADO: <nome>", `system.sendScriptEvent(
  "sym:mk5_target_locked", JSON.stringify({ player: player.id, target: target.id }))`, dynamic
  property `sym:mk5_lock_target` = target id.
- Locked target keeps being tracked while valid, within 64 blocks and within a 30° cone of the view
  direction; outside the cone for > 40 ticks, dead, or out of range → lost: `sym.mk5.lock_lost`,
  `sym:mk5_target_lost` script event, property cleared. Looking at another entity while locked does
  not switch the lock unless it stays under the reticle for the full lock time.
- Every 4 ticks while locked: `player.spawnParticle("sym:mk5_lock", center, {size})`.
- Public API (exported from `targeting.js` and re-exported from `index.js`):
  `getLockedTarget(player) → Entity | undefined`, `onTargetLocked(cb)`, `onTargetLost(cb)`,
  `isLockArmed(player)`. Also `system.afterEvents.scriptEventReceive` for id
  `sym:mk5_lock_query` (sourceEntity player) → replies with `sym:mk5_lock_info` script event.
  Document this at the top of the file for the future missiles.

### 5.8 Control panel (`menu.js`)

`ActionFormData` titled `§l§cMARK V§r §7— Painel de Controle`, body with energy %, rate, power state,
visor state, flight, lock. Buttons (with icons from 2.6), labels toggling by state:
1. `Abrir visor` / `Fechar visor` (icon_visor)
2. `HUD: LIGADO` / `HUD: DESLIGADO` (icon_hud) — persisted `sym:mk5_hud` (default on)
3. `Decolar` / `Pousar` (icon_flight)
4. `Scanner de área` (icon_scan)
5. `Mira teleguiada: ARMADA` / `DESARMADA` (icon_lock)
6. `Diagnóstico de energia` (icon_diag) → second ActionFormData listing the consumption breakdown
   (Reator Arc +x/s, LEDs reator/braços/pernas/olhos, HUD, voo, mira) and a "Voltar" button.
7. `Desmontar armadura` (icon_suitoff) → calls the injected `beginSuitOff(player)` (only on ground).
Play `sym.mk5.menu` on open. Handle `FormCancelationReason.UserBusy` by retrying up to 10× every 5
ticks. Menu works while offline (shows OFFLINE; HUD/flight/scan/lock buttons explain "sem energia").

### 5.9 Gestures (`input.js`)

- Double-tap Jump → toggle flight (5.3).
- Look up (pitch ≤ −50) + double-tap Sneak → area scan.
- (main.js keeps) look down + double-tap Sneak on ground → suit off.
- Reactor item: use → menu, sneak+use → toggle visor.
Tell the player these on first power-on (actionbar, once per world via a dynamic property).

## 6. Tuning (constants.js)

```
ENERGY_MAX = 1000          REGEN = 4.0 /s (always, worn or not)
LED_REACTOR = 0.3 /s       LED_ARMS = 0.3 /s      LED_LEGS = 0.3 /s     LED_EYES = 0.1 /s
HUD_DRAIN = 1.0 /s         LOCK_DRAIN = 0.6 /s
FLIGHT_HOVER = 4 /s        FLIGHT_CRUISE = 7 /s   FLIGHT_BOOST = 16 /s  FLIGHT_EMERGENCY = 0
TAKEOFF_COST = 15          SCAN_COST = 50         LOCK_ACQUIRE_COST = 5
FLIGHT_MIN_ENERGY = 60     EMERGENCY_AT = 30      REBOOT_AT = 150
SHIELD_FRACTION = 0.4      SHIELD_COST_PER_HP = 12
CRUISE_SPEED = 0.75 b/t    BOOST_SPEED = 1.6 b/t  STRAFE_SPEED = 0.45   VERT_UP = 0.45  VERT_DOWN = 0.5
ACCEL: hover 0.25, cruise 0.18, boost 0.10
TARGET_RANGE = 48          SCAN_RADIUS = 32       SCAN_MARK_TICKS = 240   LOCK_RANGE = 64
```

## 7. Ownership (who writes what)

- script agent: `pack/Mark5_BP/scripts/**` (except generated `hud_protocol.js`),
  `pack/Mark5_BP/manifest.json` (add `@minecraft/server-ui` 2.0.0 dependency; bump header/modules
  version to `[2,0,0]`; keep UUIDs; RP dependency version `[2,0,0]`).
- suit agent: BP `items/` (new variant items; reactor item rename), RP `attachables/`,
  `animations/` (attachable + player anims), `render_controllers/`, `textures/sym/mk5_off.png`,
  `texts/*.lang`, `entity/player.entity.json` (only if needed), RP `manifest.json` (bump to
  `[2,0,0]`, keep UUIDs), `textures/item_texture.json` (only if needed).
- fx agent: RP `particles/` (new), `textures/sym/particle/` (new), `sounds/sym/*.ogg` (new),
  `sounds/sound_definitions.json` (merge), generators in `tools/fx/`.
- hud agent: RP `ui/**`, `textures/sym/hud/**`, `textures/sym/ui/**`, generators in `tools/hud/`,
  a decoder test `tests/hud_ui_decode.test.mjs`.
Nobody edits another agent's files. If you need something from another area, write it in your
final report.

## 8. Change request #1 from the user (after the first build)

"The invisibility part is not needed (I was confused)" — nothing to do, we never use invisibility.

"Make the 3D armor in the HUD spin 360 degrees, show the armor resistance percentage from 100 % to
0 %, and make it turn red: when it takes damage it starts getting red to show it is breaking."

### 8.1 Spin (suit area: `entity/player.entity.json` + player animations)
- New player animation `animation.sym.player.paperdoll_spin` (loop): `root` rotation y =
  `math.mod(query.time_stamp * 2 + query.life_time * 40, 360)` (≈ one turn every 9 s; either source
  keeps it turning if the other is 0 in the UI render).
- `player.entity.json`: register it (`"sym_paperdoll_spin": "animation.sym.player.paperdoll_spin"`)
  and add to `scripts.animate`: `{ "sym_paperdoll_spin": "variable.is_paperdoll && <wearing any
  FULL suit variant>" }`. `variable.is_paperdoll` is the vanilla flag for UI renders of the player
  (vanilla root controller uses it); the HUD `hud_player_renderer` sets it.

### 8.2 Turning red with damage — CANCELLED by the user
The user decided: no red tint on the armor model (it would also show in the world). Do NOT add any
overlay_color / damage tint to the suit. Only the percentage is shown in the HUD.

### 8.3 HUD (hud area + protocol + script)
- Protocol: two fields APPENDED at the end (offsets of existing fields do not change):
  `integrity_pct` (digits, 3, "000".."100") and `integrity_state` (char: `n` ≥ 60 %, `w` 25–59 %,
  `c` < 25 %). Re-run `node tools/gen_protocol.mjs`.
- HUD: under/next to the spinning 3D armor show a large integrity percentage ("RESISTÊNCIA 100%")
  whose text color goes cyan → amber → red by `integrity_state`, plus the existing integrity bar and
  a blinking "ARMADURA CRÍTICA" tag at `c`. No red glow/tint on or behind the armor model.
- Script: fill both fields from the worn suit's durability (100 % = undamaged); play a short HUD
  alert "DANO NA ARMADURA -X%" when the integrity drops by ≥ 1 % from a hit, and the critical
  warning once when crossing below 25 %.

## 9. Change request #2 — flight look (user reference: `ref/user/flight_reference.jpg`)

The user sent a screenshot of how the flight should look "more or less": Iron Man rising, body
upright, arms down and slightly out to the sides with palms facing the ground, legs straight down
together. At each palm and each boot there is a compact, VERY bright yellow-white repulsor flame:
a short glowing cone/cylinder about the size of the hand/foot (≈ 0.3–0.45 block long), saturated
yellow (#FFF27A → #FFD23A) with a white-hot core, flickering flame tongues at its lower edge — not a
long blue jet. It looks emissive (glows even in shade).

- Pose: hovering and climbing use this upright pose (`mk5_hover`). Forward flight (`mk5_fly`) may
  tilt the body forward but keep it moderate (lean ≈ 20–45° with pitch), arms down/back with palms
  back-down, legs together; boost leans more. The repulsor flames must stay attached to the
  palms/boots in every pose.
- Flames (`sym:mk5_thrust`): dense, short-lived (0.06–0.14 s) additive sprites spawned every tick at
  each nozzle so they read as a continuous glowing cone; yellow-white palette (not cyan); a small
  bright glow disc at the nozzle (`sym:mk5_thrust_glow`, yellow-white); flame length/brightness
  scale with `variable.power`; at boost add a faint orange outer flame and smoke.
- Direction: palms/boots point their flames along the limb (down in hover, back-down in forward
  flight), so nozzle positions/directions in `flight.js` must follow the pose.
- UPDATE from the user: when accelerating forward (boost / sprint) the suit LIES DOWN — fully
  horizontal "Superman/Iron Man" flight. `mk5_boost`: body aligned with the flight direction like
  vanilla swim (`root` rotation x ≈ `90 + query.target_x_rotation`, clamped ≈ 20..160, with the
  matching root position offset so the model stays on the hitbox), head lifted to look forward,
  arms straight back along the body (palms back), legs straight together. The transition
  cruise → boost should blend smoothly (blendOutTime ~0.3 s). In boost the boot flames point
  straight back (behind the feet) and the palm flames back along the hips.

## 10. Change request #3 — visor servos cost energy

- Opening or closing the visor spends `VISOR_COST = 10` energy (1 %) when powered (servo motors).
  If the energy is below the cost, refuse with "ENERGIA INSUFICIENTE PARA OS SERVOS DO VISOR".
- While OFFLINE (latched), the visor can still be opened/closed manually at no cost; actionbar
  "Abertura manual do visor (sem energia)".
- The diagnostics screen and the HUD rate text count it as a one-shot cost (show "-1% visor" in the
  alert line for ~1 s).
- Confirmed with the user: the 3D armor in the HUD is the player's real model (hud_player_renderer),
  identical to the world one (same LEDs/visor state), spinning around the vertical axis.

## 11. Fixes from the user's first in-game test (video) + "clean flames"

Observed in game (phone, Bedrock 1.26): flight, HUD frame, compass, coords, LEDs, suit_text,
energy_text, the spinning 3D armor all WORK. Broken:

1. **Magenta square instead of the energy gauge when energy < ~50 %.** Root cause: JSON UI
   coerces numeric-looking strings, so `'textures/sym/hud/energy_' + '09'` becomes `energy_9`
   (leading zero dropped) → missing texture. Frames ≥ 10 work. Same bug for every digits frame
   field used in a texture path (energy, integrity, thrust, hp_<c>_NN, lock, boot frames …).
   FIX (hud): the texture generator must ALSO write every frame without leading zeros
   (`energy_0..energy_9`, `integrity_0..9`, `thrust_0..9`, `hp_<c>_0..9`, …) next to the padded
   names, so both engine behaviours resolve. Tests must assert both names exist.
2. **"RESISTÊNCIA" number is blank.** The leading-zero-stripping expression does not work in the
   engine. FIX: script encodes `integrity_pct` RIGHT-ALIGNED WITH SPACES ("100", " 72", "  5");
   UI label text = `(field + '%')` only (works whether or not the engine coerces it). Update the
   protocol doc + tests.
3. **The whole right column never renders** (no systems / target / scan panel at all, even
   though `systems_text` should be visible most of the time) → "mob info not showing". Rebuild it
   with only the most basic, vanilla-proven constructs: NO stack_panel (absolute offsets for each
   panel), NO flip_book `uv` animation (static radar image, alpha blink allowed), NO dynamic
   `#texture` image that has children (use one static frame image per target class toggled by
   `#visible`, and put the dynamic hp bar as a sibling). Same simplification anywhere else these
   constructs are used. Keep phone-safe placement (right side, below the top visor line, above the
   jump/sneak buttons ~ lower 45 % of the screen on the right).

### 11.1 Clean geometry flames (user reference `ref/user/flight_reference_clean.jpg`)
Replace particle flames with GEOMETRY attached to the suit: compact, solid, very bright
yellow-white cones under each palm and each boot (like the reference: ~4x5x4 px outer cone,
tapered with stacked boxes, white-hot core, slightly lighter top), flickering.
- suit: new geometry `geometry.sym.mk5_flames` (own file) whose top-level bones are `rightArm`,
  `leftArm`, `rightLeg`, `leftLeg` (same names/pivots as `geometry.sym.mk5`, so they follow the
  player's limbs and flight poses exactly like the armor), with child bones `mk5_flame_rh`,
  `mk5_flame_lh` (just below the glove bottom, y ≈ 12) and `mk5_flame_rf`, `mk5_flame_lf` (just
  below the boot soles, y ≈ 0), pivots at the nozzle so a y-scale flicker grows away from it.
  Texture `textures/sym/mk5_flames.png` (clean gradient, emissive: use alpha ≈ 140–200 so
  `entity_emissive_alpha` makes it glow). New render controller `controller.render.sym_mk5_flames`
  (Geometry.flames / Texture.flames / Material.default). Animation
  `animation.sym.mk5.flames_flicker` (loop, fast subtle y-scale/xz-scale flicker per flame with
  different phases).
- suit: two new FINAL variants worn only while flying (powered):
  `sym:mark_5_flying` (visor closed) and `sym:mark_5_open_flying` (visor open pose) — protection
  20, texture mk5, render_controllers `["controller.render.sym_mk5", "controller.render.sym_mk5_flames"]`,
  geometry `{default: geometry.sym.mk5, flames: geometry.sym.mk5_flames}`, plus the flicker
  animation (worn condition). Add them to the FULL set (and open_flying to FACE VISIBLE).
- suit: new TEMP variant `sym:mark_5_powerup` (24 ticks, texture mk5, `eyes_boot`), and REMOVE
  `eyes_boot` from `sym:mark_5` (so swapping back after a flight does not flicker the eyes);
  `visor_closing` ends with a short eyes flicker-on instead.
- script: engage flight → swap the worn powered final variant to its `_flying` twin; flight end
  (any reason) → swap back. Visor toggle is refused while flying ("Pouse para mexer no visor").
  Power loss in flight: end flight (swap back) first, then the normal power-down. Reboot uses
  `sym:mark_5_powerup` for 24 ticks then `sym:mark_5` (open visor → straight to `sym:mark_5_open`).
  recover(): a `_flying` variant worn while not flying (reload) → its non-flying twin;
  `sym:mark_5_powerup` → `sym:mark_5`.
- script: stop spawning `sym:mk5_thrust`, `sym:mk5_thrust_glow` and `sym:mk5_smoke` during
  flight (clean look). Keep takeoff blast, sonic boom, landing dust.

## 12. Change request #4 — auto night vision, suit-up/off energy, effects renewal, creative

### 12.1 Auto-adaptive night vision (script)
- Requires `@minecraft/server` **2.3.0** (stable since 1.21.120; the user's game is ≥ 1.26.0):
  bump the BP manifest dependency and the typecheck harness (`tests/typecheck/tsconfig.json` paths →
  `ref/mcapi/minecraft-server-2.3.0/package/index.d.ts`; copy it there from
  `/home/user/OmniRoute/_artifacts/mcapi/s2.3.0/package/`). Uses `Dimension.getLightLevel(loc)` and
  `Dimension.getSkyLightLevel(loc)` (both throw in unloaded chunks → guard) + `world.getTimeOfDay()`.
- Every 10 ticks while the suit is worn, powered, visor CLOSED and the feature enabled: sample the
  light at the head. `dayFactor` from time of day (day 1.0, night ≈ 0.27, smooth at dusk/dawn;
  Nether/End: use the total light only). `effective = max(total > sky ? total : 0, sky * dayFactor)`.
  Turn ON when `effective ≤ 6` for 2 consecutive samples, OFF when `≥ 9` (hysteresis).
- ON: `addEffect("night_vision", 400, { amplifier: 0, showParticles: false })`, refreshed when
  < 300 ticks remain (never let it reach the < 10 s flicker); remember that WE applied it and only
  remove an effect we applied (`removeEffect`) when turning off, visor opening, power loss, suit
  removal or HUD/feature disabled. Drain `NV_DRAIN = 0.5 /s` while on (in the breakdown +
  diagnostics as "Visão noturna"). Sound `sym.mk5.night_vision` + HUD info alert
  "VISÃO NOTURNA ATIVADA" / "VISÃO NOTURNA DESATIVADA"; systems_text shows `NV AUTO` state.
- Menu button "Visão noturna: AUTO / DESLIGADA" (persisted `sym:mk5_nv`, default AUTO).

### 12.2 Transformation costs energy (script, main.js)
- Suit-up costs `SUITUP_COST = 80` (8 %) at the start of the cinematic (throw or placed case).
  If energy < cost: refuse with "ENERGIA INSUFICIENTE PARA MONTAR A MARK V (precisa 8%)" + the
  current % (the case stays in hand / on the ground).
- Suit-off costs `SUITOFF_COST = 40` (4 %) when available; if not, the suit-off still happens
  ("Desmontagem manual (sem energia)") — never trap the player in the suit.
- Show both in the diagnostics screen as one-shot costs.

### 12.3 Creative mode flight (script)
In creative, the vanilla double-tap already toggles creative flight. Do not fight it: while the
suit is powered and `player.isFlying` is true, run our flight in VISUAL mode — poses, geometry
flames (`_flying` variant swap), sounds, HUD telemetry, energy drain — but NO applyKnockback (vanilla
creative physics move the player); mode from the real velocity (`getVelocity`): ~0 → hover,
moving → cruise, sprinting → boost. When `isFlying` turns false → end flight. If energy is too low
in creative, show the warning but cannot stop vanilla flight (fine).

### 12.4 Effects renewal — "clean" look (fx)
The user finds the effects "meio paia". Redesign the remaining flight FX in a clean, crisp style
(solid shapes, fewer but sharper sprites, no muddy random smoke): `sym:mk5_takeoff` (bright flash +
crisp shockwave ring + a few sparks), `sym:mk5_landing` (clean dust ring + short debris),
`sym:mk5_boom` (sharp white vapor ring/cone), NEW `sym:mk5_trail` (thin bright short contrail
segment, spawned by the script from each boot every tick only while boosting; inputs `dir`, `vel`).
Also NEW sound `sym.mk5.night_vision` (soft rising optical "whirr" + click, 0.4 s).

## 13. Change request #5 — suitcase energy readout (script, applied by the lead after round 3)

While a player HOLDS the Maleta Mark V in the main hand (and is not in a cinematic / not wearing a
suit), show a live actionbar readout, refreshed every 10 ticks (only while the item is held; stop
as soon as it leaves the hand so other actionbar text is not clobbered):
- Enough energy (>= SUITUP_COST): `§bMALETA MARK V §7• §fENERGIA §b<pct>% §7• §aPRONTA PARA VESTIR`
- Not enough: `§bMALETA MARK V §7• §fENERGIA §c<pct>% §7• §cPRECISA DE 8% §7• §f~<s>s`
  where `<s>` = ceil((SUITUP_COST - energy) / REGEN) seconds to reach the cost.
Energy is the player's own reactor charge (the same pool the suit uses), so it reads the same value
before and after suiting up. Also append the same information to the Arc Reactor hint and show the
percentage in the suit-up refusal message (SPEC 12.2).

## 14. Change request #6 — helmet tilt bug (from the user's video) + helmet pose pinning

### 14.1 The "helmet opens / tilts way back" bug — CONFIRMED ROOT CAUSE
`animation.sym.player.mk5_fly` and `mk5_boost` compensate the root tilt on the `head` bone
(`math.clamp(this - <root tilt>, -75, 75) ...`). That is WRONG: vanilla's
`animation.humanoid.look_at_target.default` already has `"relative_to": {"rotation": "entity"}`,
so the head is oriented relative to the ENTITY, not to the rotated `root` bone — no compensation is
needed. Ours double-corrects, pitching the head (and with it the whole helmet, which is parented to
`head`) up to 75° backwards, which reads in game as "the helmet opened / tilts way back".
FIX (suit): REMOVE the `head` channel from `mk5_fly` and `mk5_boost` entirely (vanilla look-at
handles it). Vanilla's swimming look-at only lerps the pitch toward -45° for style; if a stylistic
lift is wanted in boost, it must be a SMALL additive value (<= 15°), never a compensation of the
root tilt. Add a regression check in tests/suit_validate.py: no flight animation may reference
`this` on the `head` bone, and no head-bone value may exceed 15° in magnitude.

### 14.2 Pin the helmet pose on every worn variant (robustness)
No animation currently pins the faceplate bones, so after each chest-item swap (v2 swaps often:
power-up, power-down, visor, flight) the mask falls back to the model's rest pose and can be seen
mid-transition. Add two looping attachable animations that hold the faceplate explicitly and give
every worn variant the right one (in `scripts.animate`, same condition as `worn`):
- `animation.sym.mk5.visor_shut` (loop): `mk5_mask`, `mk5_Left_mask`, `mk5_Right_mask`,
  `mk5_mainframe`, `mk5_upper_face`, `mk5_lower_face` (+ the two lower-face halves) at the closed
  rest pose (rotation [0,0,0], position [0,0,0], scale 1); eyes NOT touched (the eye flicker clips
  own that bone).
- `animation.sym.mk5.visor_up` (loop): the open pose (mask rotation [-75,0,0], position [0,5,3];
  side plates at rest), used by `*_open*` variants instead of `visor_shut`.
Closed variants: `sym:mark_5`, `sym:mark_5_flying`, `sym:mark_5_powerup`, `sym:mark_5_powerdown`,
`sym:mark_5_offline` → `visor_shut`. Open variants: `sym:mark_5_open`, `sym:mark_5_open_flying`,
`sym:mark_5_offline_open` → `visor_up`. The transition variants (`*_opening` / `*_closing`) keep
only their own transition clip. Validator: every worn final variant declares exactly one of the two.
