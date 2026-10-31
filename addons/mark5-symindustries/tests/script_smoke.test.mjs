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
  assert.equal(field(t, "integrity_pct"), "094");
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
  press(InputButton.Jump);
  assert.ok(st().flight, "flying");
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
  assert.ok(log.particles.some((x) => x.id === "sym:mk5_thrust" && x.scope === "world"));
  assert.ok(log.particles.some((x) => x.id === "sym:mk5_boom"), "sonic boom");
  assert.equal(field(lastTitle(), "flight"), "b");
  p.isSprinting = false;
  p.move = { x: 0, y: 0 };
  system.tick(10);
  press(InputButton.Jump);
  system.tick(2);
  press(InputButton.Jump);
  assert.equal(st().flight, undefined, "landed");
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
  ui.responses.push({ canceled: false, selection: 4 });
  suit.openControlPanel(p);
  await flush();
  system.tick(6);
  await flush();
  assert.ok(suit.isLockArmed(p), "armed after the busy retry");
  assert.ok(ui.shown.length >= 2 && ui.shown[0].buttons.length === 7);
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
  st().energy = 0; // e.g. drained by the shield
  system.tick(1);
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
  assert.equal(chest().typeId, "sym:mark_5");
  assert.ok(!p.effects.has("slowness"));
  system.tick(5);
  assert.equal(field(lastTitle(), "mode"), "2");
  checkChest();
  checkTitles();
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

test("suit-off hook, death and leave clean up", () => {
  suit.beforeSuitOff(p);
  assert.equal(lastTitle().trimEnd(), "MK5H0");
  assert.ok(p.hudCalls.at(-1).v === mc.HudVisibility.Reset);
  world.afterEvents.entityDie.fire({ deadEntity: p, damageSource: { cause: "none" } });
  world.beforeEvents.playerLeave.fire({ player: p });
  world.afterEvents.playerLeave.fire({ playerId: p.id, playerName: p.name });
  assert.equal(peekState(p.id), undefined);
  assert.equal(typeof p.getDynamicProperty("sym:mk5_energy"), "number");
  p.isValid = false;
  system.tick(5);
});
