// Smoke test of the integrated Mark V suit systems against a tiny engine fake.
// Run: node --import ./tests/script_mock/register.mjs --test tests/script_smoke.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SUIT = join(ROOT, "pack/Mark5_BP/scripts/suit");

const mc = await import("@minecraft/server");
const ui = await import("@minecraft/server-ui");
const suit = await import(join(SUIT, "index.js"));
const { peekState } = await import(join(SUIT, "state.js"));
const { HUD_FIELDS, HUD_TOTAL_BYTES } = await import(join(SUIT, "hud_protocol.js"));
const { system, world, log, Dimension, Entity, Player, ItemStack, InputButton, ButtonState } = mc;

const utf8 = (s) => Buffer.byteLength(s, "utf8");
const field = (s, name) => {
  const f = HUD_FIELDS.find((x) => x.name === name);
  return Buffer.from(s, "utf8").subarray(f.start, f.end).toString("utf8");
};
const flush = () => new Promise((r) => setImmediate(r));

const offCalls = [];
suit.initSuitSystems({ beginSuitOff: (p) => offCalls.push(p.name) });

const dim = new Dimension("minecraft:overworld");
const p = new Player(dim, "Tony", { x: 0, y: 64, z: 0 });
world.players.push(p);
const suitItem = new ItemStack("sym:mark_5");
suitItem._dur.damage = 100;
suitItem._ench.push({ type: { id: "protection" }, level: 4 });
suitItem.nameTag = "Mark V do Tony";
p.equipment.Chest = suitItem;

const chest = () => p.equipment.Chest;
const lastTitle = () => p.titles.at(-1)?.t ?? "";
const st = () => peekState(p.id);
const press = (button) => world.afterEvents.playerButtonInput.fire({ player: p, button, newButtonState: ButtonState.Pressed });

function checkTitles() {
  for (const { t } of p.titles) {
    assert.equal(utf8(t), HUD_TOTAL_BYTES, "HUD title byte length");
    assert.ok(t.startsWith("MK5H"));
  }
}
function checkChest() {
  const c = chest();
  assert.ok(c && suit.isSuitId(c.typeId), `chest holds a suit (${c?.typeId})`);
  assert.equal(c._dur.damage >= 100, true, "durability kept");
  assert.equal(c._ench.length, 1, "enchantment kept exactly once");
  assert.equal(c.nameTag, "Mark V do Tony");
}

test("HUD boots then runs (titles have the protocol length, crosshair hidden)", () => {
  system.tick(5);
  assert.ok(p.titles.length > 0, "titles sent");
  assert.equal(field(lastTitle(), "mode"), "2");
  assert.ok(p.hudCalls.some((c) => c.v === mc.HudVisibility.Hide && c.els.includes(mc.HudElement.Crosshair)));
  system.tick(60);
  const t = lastTitle();
  assert.equal(field(t, "mode"), "1");
  assert.equal(field(t, "integrity_pct"), " 94", "SPEC 11 item 2: right-aligned with spaces");
  assert.ok(field(t, "systems_text").includes("NV AUTO"), "SPEC 12.1: NV AUTO state in the systems list");
  assert.equal(field(t, "integrity_state"), "n");
  assert.equal(field(t, "led_head"), "1");
  assert.equal(field(t, "reticle"), "i");
  assert.ok(field(t, "energy_text").includes("100%"));
  checkTitles();
  assert.ok(suit.isSuitWorn(p));
  assert.equal(suit.finalSuitIdForPlayer(p), "sym:mark_5");
});

test("visor open / close swaps through the temp variants and keeps the item", () => {
  suit.toggleVisor(p);
  assert.equal(chest().typeId, "sym:mark_5_opening");
  assert.equal(chest().lockMode, mc.ItemLockMode.slot);
  assert.equal(lastTitle().trimEnd(), "MK5H0", "HUD hidden");
  suit.toggleVisor(p); // ignored during the transition
  assert.equal(chest().typeId, "sym:mark_5_opening");
  system.tick(17);
  assert.equal(chest().typeId, "sym:mark_5_open");
  assert.equal(chest().lockMode, mc.ItemLockMode.none);
  checkChest();
  const n = p.titles.length;
  system.tick(10);
  assert.equal(p.titles.length, n, "no HUD while the visor is open");
  suit.toggleVisor(p);
  assert.equal(chest().typeId, "sym:mark_5_closing");
  system.tick(17);
  assert.equal(chest().typeId, "sym:mark_5");
  system.tick(3);
  assert.equal(field(lastTitle(), "mode"), "2", "boot after closing");
  system.tick(60);
  checkChest();
});

test("double-tap jump flies, movement cruises, sprint boosts, double-tap lands", () => {
  const e0 = st().energy;
  press(InputButton.Jump);
  system.tick(3);
  p.actionbars.length = 0;
  press(InputButton.Jump);
  assert.ok(st().flight, "flying");
  // SPEC 11.1: geometry flames = the `_flying` twin, worn only while flying (item kept)
  assert.equal(chest().typeId, "sym:mark_5_flying");
  assert.equal(chest().lockMode, mc.ItemLockMode.none);
  checkChest();
  // the visor is refused while flying; the reason goes to the HUD alert line, not the actionbar
  suit.toggleVisor(p);
  assert.equal(chest().typeId, "sym:mark_5_flying", "visor refused while flying");
  assert.ok(st().hud.alerts.some((a) => a.text === "POUSE PARA MEXER NO VISOR"), "refusal on the HUD alert line");
  assert.equal(p.actionbars.length, 0, "no actionbar text over the flight panel while the HUD is up");
  log.particles.length = 0;
  p.isOnGround = false;
  p.move = { x: 0, y: 1 };
  p.knockbacks.length = 0;
  system.tick(20);
  assert.equal(st().flight.mode, "cruise");
  const kb = p.knockbacks.at(-1);
  assert.ok(kb.z > 0.3 && kb.z <= 0.76, `cruise velocity ${JSON.stringify(kb)}`);
  p.isSprinting = true;
  system.tick(40);
  assert.equal(st().flight.mode, "boost");
  assert.ok(Math.hypot(p.knockbacks.at(-1).x, p.knockbacks.at(-1).z) > 1.2);
  assert.ok(st().energy < e0, "flight drains energy");
  // SPEC 11.1: no flame sprites in flight any more; SPEC 12.4: a contrail from each boot every
  // tick while boosting, with dir + vel
  for (const id of ["sym:mk5_thrust", "sym:mk5_thrust_glow", "sym:mk5_smoke"]) {
    assert.ok(!log.particles.some((x) => x.id === id), `${id} not spawned in flight`);
  }
  const trails = log.particles.filter((x) => x.id === "sym:mk5_trail");
  assert.ok(trails.length >= 2 * 20, `trail every boost tick from both boots (${trails.length})`);
  assert.ok(trails.every((x) => x.scope === "world" && x.vars?.["variable.dir"] && x.vars?.["variable.vel"]), "trail has dir + vel");
  assert.ok(log.particles.some((x) => x.id === "sym:mk5_boom"), "sonic boom");
  assert.equal(field(lastTitle(), "flight"), "b");
  // through a portal the looping pose is replayed (other clients re-add the actor) (S2)
  p.anims.length = 0;
  world.afterEvents.playerDimensionChange.fire({ player: p, fromDimension: dim, toDimension: dim, fromLocation: p.location });
  system.tick(2);
  assert.equal(p.anims.filter((a) => a.id === "animation.sym.player.mk5_boost").length, 1, "boost pose replayed once");
  p.isSprinting = false;
  p.move = { x: 0, y: 0 };
  system.tick(10);
  press(InputButton.Jump);
  system.tick(2);
  log.particles.length = 0;
  system.tick(3);
  assert.ok(!log.particles.some((x) => x.id === "sym:mk5_trail"), "no trail out of boost");
  press(InputButton.Jump);
  system.tick(2);
  press(InputButton.Jump);
  assert.equal(st().flight, undefined, "landed");
  assert.equal(chest().typeId, "sym:mark_5", "flight end swaps the non-flying variant back");
  checkChest();
  assert.ok(p.effects.has("slow_falling"));
  p.isOnGround = true;
  system.tick(5);
});

test("area scan reveals and marks mobs for the pilot only", () => {
  const zombie = new Entity(dim, "minecraft:zombie", { x: 10, y: 64, z: 0 }, { families: ["monster", "zombie"] });
  const cow = new Entity(dim, "minecraft:cow", { x: 0, y: 64, z: 5 }, { hp: 10 });
  new Entity(dim, "minecraft:item", { x: 1, y: 64, z: 1 });
  system.tick(60); // scanner cooldown from nothing / energy regen
  p.rotation = { x: -60, y: 0 };
  log.particles.length = 0;
  press(InputButton.Sneak);
  system.tick(2);
  press(InputButton.Sneak);
  assert.ok(st().scan, "scan started");
  assert.ok(log.particles.some((x) => x.id === "sym:mk5_scan_wave" && x.scope === "world"));
  system.tick(30);
  const marks = log.particles.filter((x) => x.id === "sym:mk5_mark");
  assert.ok(marks.length > 0 && marks.every((m) => m.scope === "player"));
  assert.ok(marks.some((m) => m.vars["variable.color"].green === 0.2), "hostile red");
  assert.ok(marks.some((m) => m.vars["variable.color"].green === 1), "passive green");
  system.tick(2);
  const sc = field(lastTitle(), "scan_text");
  assert.ok(sc.includes("Zumbi") && sc.includes("Vaca"), sc);
  assert.ok(sc.indexOf("Zumbi") < sc.indexOf("Vaca"), "hostile first");
  assert.equal(field(lastTitle(), "threat"), "1");
  p.rotation = { x: 0, y: 0 };
  zombie.location = { x: 0, y: 64, z: 8 };
  cow.kill();
});

test("lock-on via the control panel: progress, locked event, lost on death", async () => {
  ui.responses.push({ canceled: true, cancelationReason: ui.FormCancelationReason.UserBusy });
  ui.responses.push({ canceled: false, selection: 5 }); // 0 visor, 1 HUD, 2 night vision, 3 flight, 4 scan, 5 lock
  suit.openControlPanel(p);
  await flush();
  system.tick(6);
  await flush();
  assert.ok(suit.isLockArmed(p), "armed after the busy retry");
  assert.ok(ui.shown.length >= 2 && ui.shown[0].buttons.length === 8);
  const zombie = dim.entities.find((e) => e.typeId === "minecraft:zombie");
  p.lookingAt = [zombie];
  const locked = [];
  const lost = [];
  suit.onTargetLocked((ev) => locked.push(ev.target.id));
  suit.onTargetLost((ev) => lost.push(ev.reason));
  system.tick(4);
  assert.equal(field(lastTitle(), "reticle") === "l" || field(lastTitle(), "reticle") === "h", true);
  system.tick(20);
  assert.deepEqual(locked, [zombie.id]);
  assert.equal(suit.getLockedTarget(p), zombie);
  assert.ok(log.events.some((e) => e.id === "sym:mk5_target_locked" && e.message.target === zombie.id));
  system.tick(2);
  assert.equal(field(lastTitle(), "reticle"), "k");
  system.sendScriptEvent("sym:mk5_lock_query", JSON.stringify({ player: p.id }));
  const info = log.events.filter((e) => e.id === "sym:mk5_lock_info").at(-1);
  assert.equal(info.message.target, zombie.id);
  zombie.kill();
  p.lookingAt = [];
  system.tick(2);
  assert.deepEqual(lost, ["dead"]);
  assert.equal(suit.getLockedTarget(p), undefined);
});

test("energy shield absorbs part of a hit", () => {
  p.hp = 10;
  const e0 = st().energy;
  world.afterEvents.entityHurt.fire({ hurtEntity: p, damage: 10, damageSource: { cause: "entityAttack" } });
  assert.equal(p.hp, 14);
  assert.ok(Math.abs(e0 - st().energy - 48) < 1e-6);
  world.afterEvents.entityHurt.fire({ hurtEntity: p, damage: 10, damageSource: { cause: "fire" } });
  assert.equal(p.hp, 14, "fire is not shielded");
  p.hp = 20;
});

test("power failure: powerdown -> offline (slowness, failure overlay), then reboot", () => {
  st().energy = 500;
  press(InputButton.Jump);
  system.tick(2);
  press(InputButton.Jump);
  assert.ok(st().flight, "flying before the failure");
  p.isOnGround = false;
  system.tick(5);
  assert.equal(chest().typeId, "sym:mark_5_flying");
  st().energy = 0; // e.g. drained by the shield
  system.tick(1);
  // SPEC 11.1 order: flight ends (flying twin swapped back) first, then the normal power-down
  assert.equal(chest().typeId, "sym:mark_5_powerdown");
  assert.equal(st().flight, undefined, "flight cut");
  assert.ok(!p.effects.has("slow_falling"), "you fall");
  p.isOnGround = true;
  assert.ok(log.sounds.some((s) => s.id === "sym.mk5.power_down"));
  system.tick(3);
  assert.equal(field(lastTitle(), "mode"), "3");
  assert.equal(field(lastTitle(), "led_chest"), "0");
  system.tick(25);
  assert.equal(chest().typeId, "sym:mark_5_offline");
  checkChest();
  assert.equal(p.effects.get("slowness")?.amplifier, 0);
  system.tick(30);
  assert.equal(lastTitle().trimEnd(), "MK5H0", "HUD hidden after the failure overlay");
  assert.equal(suit.finalSuitIdForPlayer(p), "sym:mark_5_offline");
  press(InputButton.Jump);
  system.tick(2);
  press(InputButton.Jump);
  assert.equal(st().flight, undefined, "cannot fly offline");
  st().energy = 149.5; // +0.2 regen this tick
  system.tick(1);
  assert.equal(chest().typeId, "sym:mark_5_offline");
  st().energy = 150;
  system.tick(1);
  // SPEC 11.1: reboot through the power-up item (eyes flicker on) for 24 ticks, then sym:mark_5
  assert.equal(chest().typeId, "sym:mark_5_powerup");
  assert.equal(chest().lockMode, mc.ItemLockMode.slot);
  assert.ok(!p.effects.has("slowness"));
  checkChest();
  system.tick(23);
  assert.equal(chest().typeId, "sym:mark_5_powerup");
  system.tick(2);
  assert.equal(chest().typeId, "sym:mark_5");
  assert.equal(chest().lockMode, mc.ItemLockMode.none);
  system.tick(5);
  assert.equal(field(lastTitle(), "mode"), "2");
  checkChest();
  checkTitles();
});

test("reboot with the visor open goes straight to sym:mark_5_open (SPEC 11.1)", () => {
  system.tick(60);
  suit.toggleVisor(p);
  system.tick(17);
  assert.equal(chest().typeId, "sym:mark_5_open");
  st().energy = -1; // clamps to 0 this tick (the open suit's LEDs alone would not drain it)
  system.tick(1);
  assert.equal(chest().typeId, "sym:mark_5_offline_open");
  st().energy = 150;
  system.tick(1);
  assert.equal(chest().typeId, "sym:mark_5_open", "no power-up item with the visor open");
  suit.toggleVisor(p);
  system.tick(17);
  assert.equal(chest().typeId, "sym:mark_5");
  system.tick(60);
  checkChest();
});

test("critical warning waits for the HUD instead of being purged while it is off (S3)", () => {
  const hudAlerts = () => p.titles.filter(({ t }) => field(t, "alert") === "c" && field(t, "alert_text").includes("CRÍTICA"));
  const crossBelow25 = () => {
    st().hudEnabled = false;
    system.tick(4);
    assert.equal(st().hudActive, false);
    chest()._dur.damage = Math.ceil(1815 * 0.78); // 94 % -> 22 %
    system.tick(4);
    assert.equal(st().integWatch.critical, true);
  };
  // crossed with the HUD off, a repair to >= 25 % before it comes back cancels the warning
  crossBelow25();
  assert.equal(st().integWatch.pendingCritical, true, "not used up while hidden");
  chest()._dur.damage = 100;
  system.tick(4);
  assert.equal(st().integWatch.pendingCritical, false);
  const n0 = hudAlerts().length;
  st().hudEnabled = true;
  system.tick(70);
  assert.equal(hudAlerts().length, n0, "no stale critical warning after a repair");
  // crossed with the HUD off, shown once the HUD is back and booted
  crossBelow25();
  st().hudEnabled = true;
  system.tick(30);
  assert.equal(st().integWatch.pendingCritical, true, "still waiting during the boot");
  system.tick(40);
  assert.equal(st().integWatch.pendingCritical, false);
  assert.ok(hudAlerts().length > n0, "ARMADURA CRÍTICA shown after the boot");
  chest()._dur.damage = 100;
  system.tick(4);
  checkChest();
});

test("suit meta snapshot survives the case: enchantments, name, lore, keep-on-death (S1)", () => {
  const worn = new ItemStack("sym:mark_5_closing"); // temp variant: real keep flag in sym:mk5_kod
  worn._ench.push({ type: { id: "minecraft:protection" }, level: 4 }, { type: { id: "minecraft:mending" }, level: 1 });
  worn.nameTag = "Mark V do Tony";
  worn.setLore(["§7Lore do Tony"]);
  worn.keepOnDeath = true;
  worn.setDynamicProperty("sym:mk5_kod", true);
  const meta = suit.suitMetaOf(worn);
  assert.ok(meta.length > 0 && meta.length < 32767);
  const back = new ItemStack("sym:mark_5");
  back.setLore(["default"]);
  suit.applySuitMeta(back, meta);
  assert.deepEqual(back._ench.map((e) => [e.type.id, e.level]), [["minecraft:protection", 4], ["minecraft:mending", 1]]);
  assert.equal(back.nameTag, "Mark V do Tony");
  assert.deepEqual(back.getLore(), ["§7Lore do Tony"]);
  assert.equal(back.keepOnDeath, true);
  // a temp item whose final item was NOT kept on death does not carry its forced flag
  const temp = new ItemStack("sym:mark_5_opening");
  temp.keepOnDeath = true;
  temp.setDynamicProperty("sym:mk5_kod", false);
  assert.equal(suit.suitMetaOf(temp), "");
  // nothing to keep / garbage is a no-op; a vanished enchantment is skipped, the rest applied
  const plain = new ItemStack("sym:mark_5");
  plain.setLore(["default"]);
  assert.equal(suit.suitMetaOf(undefined), "");
  suit.applySuitMeta(plain, "");
  suit.applySuitMeta(plain, "{bad json");
  assert.equal(plain._ench.length, 0);
  suit.applySuitMeta(plain, JSON.stringify({ e: [["gone:x", 1], ["minecraft:unbreaking", 3]], l: [] }));
  assert.deepEqual(plain._ench.map((e) => [e.type.id, e.level]), [["minecraft:unbreaking", 3]]);
  assert.deepEqual(plain.getLore(), ["default"], "empty lore keeps the default");
  assert.equal(plain.keepOnDeath, false);
});

test("stray temp variant is resolved, inventory variant becomes the base item", () => {
  const temp = new ItemStack("sym:mark_5_opening");
  temp._dur.damage = 300;
  const back = suit.baseSuitItemFor(temp);
  assert.equal(back.typeId, "sym:mark_5");
  assert.equal(back._dur.damage, 300);
  assert.equal(suit.baseSuitItemFor(new ItemStack("sym:mark_5")), undefined);
  st().transition = undefined;
  p.equipment.Chest = temp;
  suit.recoverWornSuit(p);
  assert.equal(chest().typeId, "sym:mark_5_open");
  p.equipment.Chest = suitItem;
  system.tick(2);
});

test("recover(): `_flying` worn while not flying -> twin; power-up -> sym:mark_5 (SPEC 11.1)", () => {
  system.tick(60);
  assert.equal(st().flight, undefined);
  const cases = [
    ["sym:mark_5_flying", "sym:mark_5"],
    ["sym:mark_5_open_flying", "sym:mark_5_open"],
    ["sym:mark_5_powerup", "sym:mark_5"],
  ];
  for (const [id, want] of cases) {
    const it = new ItemStack(id);
    it._dur.damage = 200;
    st().transition = undefined;
    p.equipment.Chest = it;
    suit.recoverWornSuit(p);
    assert.equal(chest().typeId, want, id);
    assert.equal(chest()._dur.damage, 200, `${id} keeps its wear`);
  }
  // the per-tick safety net does the same (e.g. respawn with keep-on-death)
  p.equipment.Chest = new ItemStack("sym:mark_5_flying");
  system.tick(1);
  assert.equal(chest().typeId, "sym:mark_5");
  // a flying item in the inventory / on the ground becomes the plain suit
  assert.equal(suit.baseSuitItemFor(new ItemStack("sym:mark_5_open_flying")).typeId, "sym:mark_5");
  p.equipment.Chest = suitItem;
  system.tick(2);
});

test("status messages use the HUD alert line in mode 1, the actionbar otherwise", () => {
  system.tick(60);
  assert.equal(field(lastTitle(), "mode"), "1");
  p.actionbars.length = 0;
  suit.suitNotify(p, "§cTeste de alerta");
  assert.equal(p.actionbars.length, 0);
  assert.equal(st().hud.alerts.find((x) => x.text === "TESTE DE ALERTA")?.type, "w");
  suit.toggleVisor(p); // HUD off while the visor opens
  system.tick(17);
  suit.suitNotify(p, "§7Fora do HUD");
  assert.equal(p.actionbars.at(-1), "§7Fora do HUD");
  suit.toggleVisor(p);
  system.tick(17 + 60);
  assert.equal(field(lastTitle(), "mode"), "1");
});

test("creative: visual flight follows vanilla flight, never applyKnockback (SPEC 12.3)", () => {
  p.gameMode = mc.GameMode.Creative;
  st().energy = 900;
  p.isOnGround = false;
  p.isFlying = true;
  p.knockbacks.length = 0;
  log.particles.length = 0;
  system.tick(1);
  assert.ok(st().flight?.visual, "visual flight started with vanilla flight");
  assert.equal(chest().typeId, "sym:mark_5_flying", "geometry flames");
  p.velocity = { x: 0, y: 0, z: 0 };
  system.tick(5);
  assert.equal(st().flight.mode, "hover");
  p.velocity = { x: 0, y: 0, z: 0.5 };
  system.tick(5);
  assert.equal(st().flight.mode, "cruise");
  assert.equal(field(lastTitle(), "flight"), "f", "HUD telemetry");
  p.isSprinting = true;
  system.tick(5);
  assert.equal(st().flight.mode, "boost");
  assert.ok(log.particles.some((x) => x.id === "sym:mk5_trail"), "contrail while boosting");
  const e = st().energy;
  system.tick(20);
  assert.ok(st().energy < e, "flight drain still runs");
  // the double-tap belongs to vanilla here; the menu cannot land vanilla flight either
  press(InputButton.Jump);
  system.tick(2);
  press(InputButton.Jump);
  assert.ok(st().flight?.visual, "double-tap does not toggle ours");
  // vanilla flight off -> our flight ends and the variant goes back
  p.isFlying = false;
  p.isSprinting = false;
  p.velocity = undefined;
  system.tick(1);
  assert.equal(st().flight, undefined);
  assert.equal(chest().typeId, "sym:mark_5");
  assert.equal(p.knockbacks.length, 0, "vanilla physics move the player");
  // too little energy: one warning, vanilla keeps flying, latched until vanilla flight ends
  st().energy = 40;
  st().hud.alerts = [];
  p.isFlying = true;
  system.tick(3);
  assert.equal(st().flight, undefined);
  assert.equal(st().hud.alerts.filter((a) => a.text.startsWith("ENERGIA INSUFICIENTE PARA VOAR")).length, 1);
  st().energy = 900;
  system.tick(2);
  assert.equal(st().flight, undefined, "latched while vanilla still flies");
  p.isFlying = false;
  system.tick(1);
  p.isFlying = true;
  system.tick(1);
  assert.ok(st().flight?.visual);
  // critical energy: the thrusters go dark, vanilla flight goes on, no restart until it ends
  st().energy = 20;
  system.tick(1);
  assert.equal(st().flight, undefined);
  assert.equal(chest().typeId, "sym:mark_5");
  system.tick(3);
  assert.equal(st().flight, undefined);
  assert.equal(p.knockbacks.length, 0);
  p.isFlying = false;
  p.isOnGround = true;
  p.gameMode = mc.GameMode.Survival;
  st().energy = 900;
  system.tick(2);
});

test("auto night vision: dark -> on, drain, refresh, hysteresis, only our own effect removed (SPEC 12.1)", async () => {
  system.tick(60);
  assert.equal(field(lastTitle(), "mode"), "1");
  log.sounds.length = 0;
  dim.light = { total: 2, sky: 0 }; // cave
  system.tick(10);
  assert.ok(!p.effects.has("night_vision"), "needs 2 dark samples");
  system.tick(10);
  const e = p.getEffect("night_vision");
  assert.ok(e && e.amplifier === 0 && e.showParticles === false && e.duration > 300, JSON.stringify(e));
  assert.ok(st().nv.on);
  assert.ok(log.sounds.some((s) => s.id === "sym.mk5.night_vision"));
  assert.ok(st().hud.alerts.some((a) => a.text === "VISÃO NOTURNA ATIVADA"));
  assert.equal(st().drain.nv, 0.5);
  system.tick(2);
  assert.ok(field(lastTitle(), "systems_text").includes("§bNV AUTO"));
  system.tick(150);
  assert.ok(p.getEffect("night_vision").duration >= 290, "refreshed before the < 10 s flicker");
  dim.light = { total: 8, sky: 0 };
  system.tick(20);
  assert.ok(st().nv.on, "hysteresis");
  dim.light = { total: 12, sky: 0 };
  system.tick(10);
  assert.ok(!st().nv.on && !p.effects.has("night_vision"), "bright -> off");
  assert.ok(st().hud.alerts.some((a) => a.text === "VISÃO NOTURNA DESATIVADA"));
  // open sky: dark at night, bright by day
  dim.light = { total: 15, sky: 15 };
  world.timeOfDay = 18000;
  system.tick(20);
  assert.ok(st().nv.on, "night outdoors");
  world.timeOfDay = 6000;
  system.tick(10);
  assert.ok(!st().nv.on, "day");
  // a potion the player drank is never removed by us
  dim.light = { total: 2, sky: 0 };
  system.tick(20);
  assert.ok(st().nv.on);
  p.addEffect("night_vision", 3600, { amplifier: 0 });
  dim.light = { total: 12, sky: 0 };
  system.tick(10);
  assert.ok(!st().nv.on);
  assert.ok(p.getEffect("night_vision")?.duration > 3000, "foreign potion kept");
  p.removeEffect("night_vision");
  // unloaded chunk: no sample, no crash
  dim.light = { total: 2, sky: 0 };
  dim.unloaded = true;
  system.tick(30);
  assert.ok(!st().nv.on);
  dim.unloaded = false;
  system.tick(20);
  assert.ok(st().nv.on);
  // visor opening removes it, closing brings it back
  suit.toggleVisor(p);
  system.tick(1);
  assert.ok(!p.effects.has("night_vision") && !st().nv.on, "visor open -> off");
  system.tick(17);
  suit.toggleVisor(p);
  system.tick(17 + 30);
  assert.ok(st().nv.on, "visor closed again -> on");
  // menu "Visão noturna: DESLIGADA" (persisted) removes it; AUTO again restores it
  ui.responses.push({ canceled: false, selection: 2 });
  suit.openControlPanel(p);
  await flush();
  assert.ok(ui.shown.at(-1).buttons[2].text.startsWith("Visão noturna: "));
  assert.equal(p.getDynamicProperty("sym:mk5_nv"), false);
  assert.ok(!p.effects.has("night_vision") && !st().nv.on);
  system.tick(30);
  assert.ok(!st().nv.on, "stays off");
  ui.responses.push({ canceled: false, selection: 2 });
  suit.openControlPanel(p);
  await flush();
  assert.equal(p.getDynamicProperty("sym:mk5_nv"), undefined);
  system.tick(20);
  assert.ok(st().nv.on);
  // power loss removes it
  st().energy = -1;
  system.tick(1);
  assert.ok(!p.effects.has("night_vision") && !st().nv.on, "power loss -> off");
  st().energy = 900;
  system.tick(30 + 60);
  dim.light = undefined;
  system.tick(10);
  assert.ok(!st().nv.on);
});

test("suit-up / suit-off costs (SPEC 12.2)", async () => {
  p.actionbars.length = 0;
  st().energy = 79;
  assert.equal(suit.chargeSuitUp(p), false);
  const msg = p.actionbars.at(-1);
  assert.ok(msg.includes("ENERGIA INSUFICIENTE PARA MONTAR A MARK V (precisa 8%)") && msg.includes("energia atual 8%"), msg);
  assert.equal(st().energy, 79);
  const n = p.actionbars.length;
  suit.chargeSuitUp(p);
  assert.equal(p.actionbars.length, n, "refusal message throttled (standing on the case)");
  st().energy = 500;
  assert.equal(suit.chargeSuitUp(p), true);
  assert.equal(st().energy, 420);
  assert.equal(st().oneShot.name, "montagem da armadura");
  // suit-off: 4 % when available...
  st().energy = 300;
  suit.beforeSuitOff(p);
  assert.equal(st().energy, 260);
  assert.ok(p.actionbars.at(-1).includes("-4%"));
  // ...free and manual without it (never trapped in the suit)
  system.tick(70);
  st().energy = 30;
  suit.beforeSuitOff(p);
  assert.equal(st().energy, 30);
  assert.equal(p.actionbars.at(-1), "§7Desmontagem manual (sem energia)");
  // the diagnostics list both one-shot costs and the night vision drain
  st().energy = 900;
  system.tick(70);
  ui.responses.push({ canceled: false, selection: 6 });
  suit.openControlPanel(p);
  await flush();
  await flush();
  const diag = ui.shown.at(-1);
  assert.ok(diag.title.includes("DIAGNÓSTICO"), diag.title);
  for (const s of ["Montagem da armadura §c-80", "Desmontagem §c-40", "Visão noturna"]) assert.ok(diag.body.includes(s), s);
});

test("suit-off hook, death and leave clean up", () => {
  suit.beforeSuitOff(p);
  assert.equal(lastTitle().trimEnd(), "MK5H0");
  assert.ok(p.hudCalls.at(-1).v === mc.HudVisibility.Reset);
  p.anims.length = 0;
  world.afterEvents.entityDie.fire({ deadEntity: p, damageSource: { cause: "none" } });
  const reset = p.anims.at(-1);
  assert.equal(reset?.id, "animation.sym.player.mk5_flight_reset", "death leaves the flight controller idle (S2)");
  assert.equal(reset.opts.controller, "sym_mk5_flight");
  world.beforeEvents.playerLeave.fire({ player: p });
  world.afterEvents.playerLeave.fire({ playerId: p.id, playerName: p.name });
  assert.equal(peekState(p.id), undefined);
  assert.equal(typeof p.getDynamicProperty("sym:mk5_energy"), "number");
  p.isValid = false;
  system.tick(5);
});
