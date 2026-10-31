export const meta = {
  name: 'mark5-verify',
  description: 'Verify Mark V v2: mock-runtime harness, Bedrock content review, script review, adversarial confirmation',
  phases: [
    { title: 'Check', detail: 'harness + reviewers in parallel' },
    { title: 'Confirm', detail: 'adversarially confirm each finding' },
  ],
}

const B = '/home/user/OmniRoute/_artifacts/mark5_build'

const COMMON = `Project: "Mark V — Sym Industries v2.0", a Minecraft Bedrock addon (Iron Man suit) at ${B} ($B). Packs: $B/pack/Mark5_BP and $B/pack/Mark5_RP. The binding contract is $B/SPEC.md (read it). API typings: $B/ref/mcapi/minecraft-server-2.0.0/package/index.d.ts and minecraft-server-ui-2.0.0. Vanilla references and Bedrock-Wiki JSON-UI docs are in $B/ref/.
Rules: do NOT modify anything under $B/pack (you are a verifier, not a fixer) — write only under $B/tests/ (and $B/dist/ for artifacts). Do not run any git commands at all. Never \`git stash\` / \`git stash pop\` — ANYWHERE in this repo, including inside an isolated worktree, and including inside any subagent you dispatch. Never touch /home/user/OmniRoute/_tasks.
Report only REAL defects with a concrete failure scenario (what input/state -> what goes wrong in game). No style nits. For each finding give file, line (best effort), severity (critical: breaks loading/crashes/feature unusable; major: feature misbehaves in a common case; minor: edge case / polish), and a precise suggested fix.`

const FINDINGS = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'short unique slug' },
          area: { type: 'string', enum: ['script', 'hud', 'fx', 'suit', 'cross'] },
          severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
          file: { type: 'string' },
          line: { type: 'integer' },
          title: { type: 'string' },
          scenario: { type: 'string', description: 'concrete failure scenario' },
          fix: { type: 'string', description: 'precise suggested fix' },
        },
        required: ['id', 'area', 'severity', 'file', 'title', 'scenario', 'fix'],
      },
    },
  },
  required: ['summary', 'findings'],
}

const VERDICT = {
  type: 'object',
  properties: {
    real: { type: 'boolean' },
    reasoning: { type: 'string' },
    refined_fix: { type: 'string' },
  },
  required: ['real', 'reasoning', 'refined_fix'],
}

const CHECKERS = [
  {
    key: 'harness',
    prompt: `${COMMON}

TASK: build an executable MOCK RUNTIME for the scripts and run realistic scenarios, independently of the script author.
1. $B/tests/mock/server.mjs — a faithful-enough fake of the parts of "@minecraft/server" 2.0.0 the scripts use (grep the scripts for every import/API call; follow the typings for names and signatures; throw like the engine would for obviously invalid calls, e.g. unknown enum values, spawnParticle with non-MolangVariableMap). Include: world (afterEvents/beforeEvents signals, getAllPlayers, getDimension, getEntity, getAbsoluteTime, dynamic properties), system (runInterval/runTimeout/run/clearRun driven by a manual tick(), currentTick, beforeEvents.startup with itemComponentRegistry, afterEvents.scriptEventReceive, sendScriptEvent), ItemStack (+ durability/enchantable components, lore, nameTag, dynamic properties, lockMode, keepOnDeath, clone), Player/Entity (location, rotation, getViewDirection, getHeadLocation, getVelocity, inputInfo, isSneaking/isJumping/isSprinting/isOnGround/isFlying/isGliding/isInWater, components equippable/inventory/health/riding, onScreenDisplay that RECORDS titles/actionbars/hud visibility, camera, inputPermissions, playAnimation/applyKnockback/addEffect/removeEffect/getEffect/spawnParticle/playSound/runCommand recording, getEntitiesFromViewDirection, matches with families), Dimension (spawnParticle, playSound, getEntities with location/maxDistance/families/type filters, getPlayers, getBlock, getBlockFromRay, spawnEntity, spawnItem), MolangVariableMap, all enums used. Plus $B/tests/mock/server-ui.mjs (ActionFormData/MessageFormData whose show() resolves with responses queued by the test, incl. a UserBusy cancel). And a loader $B/tests/mock/register.mjs using node:module register() resolve hooks so "@minecraft/server" and "@minecraft/server-ui" map to the mocks.
2. $B/tests/scenarios.test.mjs (node:test, run with: node --import $B/tests/mock/register.mjs --test $B/tests/scenarios.test.mjs). Import $B/pack/Mark5_BP/scripts/main.js and drive scenarios through events + ticks: first join (case given) -> full throw suit-up cinematic to the end (sym:mark_5 worn, reactor given, HUD titles start); HUD title strings: exact byte length = HUD_TOTAL_BYTES from scripts/suit/hud_protocol.js, header MK5H, every fixed field within its allowed values (tools/hud_protocol.json), sensible texts; energy drain to 0 -> powerdown temp -> offline variant, slowness, HUD power-failure then hidden, LED fields 0; regen to REBOOT_AT -> powered again + boot; visor toggle (reactor sneak+use) -> opening -> open, HUD hidden, crosshair restored; close -> closing -> sym:mark_5, HUD back; flight via double-tap jump with movement input -> applyKnockback calls with sane magnitudes, energy decreasing, particles, then landing; emergency landing at low energy; area scan with fake mobs (hostile/neutral/passive/player) -> marks only via player.spawnParticle with correct colors, scan_text; lock-on armed via menu -> lock progress -> locked script event -> lost when target dies; energy shield on entityHurt; menu "Desmontar armadura" -> suit-off cinematic -> case back, HUD hidden, flight stopped; recover() after reload with a temp variant worn; player leaving mid-flight; enchantments+durability preserved across every variant swap; the suit is never duplicated or lost (count suit/case items across inventory+equipment+world drops at every step).
3. Also verify HUD integration: take REAL titles captured from the scenarios and evaluate the generated JSON UI ($B/pack/Mark5_RP/ui/*.json) bindings against them (reuse an evaluator from $B/tests/hud_ui_decode.test.mjs if one exists; otherwise write one for the expression subset used) — every computed #texture path must exist and text fields must decode exactly.
Run everything. Then report every failure as a finding (a failing test that is caused by a mock limitation is NOT a finding — fix your mock instead). Keep the tests in place for later re-runs.`,
  },
  {
    key: 'content',
    prompt: `${COMMON}

TASK: Bedrock CONTENT review — find things that would fail to load, log content errors, or render wrong in the real game (you cannot run the game, so reason from the vanilla samples, the wiki docs and the format rules). Review:
- RP ui/_ui_defs.json, ui/hud_screen.json, ui/sym_mk5_hud.json: valid JSON UI (control types, properties, binding syntax, modifications syntax on root_panel and hud_title_text, namespace references "@ns.element", variables, anims), correct use of "#hud_title_text_string", '%.Ns' byte truncation vs field offsets in $B/tools/hud_protocol.resolved.json, "#texture" bindings, hud_player_renderer usage, visibility logic, layering, sizes/anchors that could push elements off-screen on a ~427x240 phone GUI.
- particles/*.json: component names/shapes valid for format 1.10.0, Molang validity, UVs within texture sizes, facing modes, materials.
- attachables/*.json, animations/*.json (bone names exist in the geometries; loop modes valid; Molang valid), render_controllers (expressions balanced, query names valid: query.is_item_name_any arguments), entity/player.entity.json, items (format 1.21.90 components valid; menu_category), sound_definitions.json + ogg files (ffprobe them), texts/*.lang, manifests (UUIDs unique, versions, dependencies).
- Run python3 -I $B/tools/check_refs.py and include any FAIL lines as findings.
Fetch extra vanilla references from https://raw.githubusercontent.com/Mojang/bedrock-samples/main/resource_pack/... when you need ground truth.`,
  },
  {
    key: 'script-review',
    prompt: `${COMMON}

TASK: adversarial CODE REVIEW of $B/pack/Mark5_BP/scripts/** against SPEC.md sections 4-6 and real Bedrock Script API 2.0.0 semantics. Hunt for: APIs that do not exist in 2.0.0 or are used with wrong signatures/units (degrees vs radians, ticks vs seconds, blocks/tick), calls that throw in "read-only mode" (before-events) or on invalid entities, state machine races (visor toggle during power-down, power-down during visor transition, suit-off during flight, double-tap timing, reboot while transition), variant swaps that can duplicate/lose the suit or drop enchantments/durability/nameTag, energy math errors (per-tick vs per-second, persistence frequency, offline catch-up using getAbsoluteTime, NaN), HUD encoder byte-width errors (multi-byte chars, § codes cut in half, newline handling), flight physics (applyKnockback each tick, slow_falling handling, fall damage, emergency landing, landing detection on slabs/water), scanner/targeting (entity validity, families, Player.spawnParticle usage, MolangVariableMap setters), menu (promise handling, UserBusy retry, actions on a player that left), memory leaks in Maps for players/entities, performance per tick. Also check main.js integration (wearing checks for every variant, recover(), entitySpawn replacement, reactor use flow). Run sh $B/tests/typecheck/run.sh and node --check on all files.`,
  },
]

phase('Check')
const results = await pipeline(
  CHECKERS,
  (c) => agent(c.prompt, { label: `check:${c.key}`, phase: 'Check', schema: FINDINGS }).then((r) => ({ key: c.key, r })),
  (res) => {
    if (!res || !res.r) return null
    const items = res.r.findings || []
    log(`${res.key}: ${items.length} finding(s)`)
    return parallel(items.map((f) => () =>
      agent(`${COMMON}

A reviewer reported this possible defect. Try hard to REFUTE it by reading the actual code/files (and the vanilla references / typings). Default to real=false if it cannot actually happen, is already handled elsewhere, relies on a wrong assumption about Bedrock, or is a pure style preference. If it is real, refine the fix to be minimal and precise.

FINDING (${f.severity}, area ${f.area}): ${f.title}
File: ${f.file}${f.line ? ':' + f.line : ''}
Scenario: ${f.scenario}
Suggested fix: ${f.fix}`, { label: `confirm:${f.id}`, phase: 'Confirm', schema: VERDICT })
        .then((v) => ({ ...f, source: res.key, verdict: v }))
    )).then((all) => ({ key: res.key, summary: res.r.summary, findings: all.filter(Boolean) }))
  }
)
const out = results.filter(Boolean)
const confirmed = out.flatMap((r) => r.findings.filter((f) => f.verdict && f.verdict.real))
const rejected = out.flatMap((r) => r.findings.filter((f) => !f.verdict || !f.verdict.real))
log(`confirmed ${confirmed.length}, rejected ${rejected.length}`)
return {
  summaries: out.map((r) => ({ key: r.key, summary: r.summary })),
  confirmed: confirmed.map((f) => ({ id: f.id, area: f.area, severity: f.severity, file: f.file, line: f.line, title: f.title, scenario: f.scenario, fix: f.verdict.refined_fix || f.fix })),
  rejected: rejected.map((f) => ({ id: f.id, title: f.title, why: f.verdict ? f.verdict.reasoning : 'no verdict' })),
}
