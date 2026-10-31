// Minimal fake of the parts of @minecraft/server 2.0.0 used by scripts/suit/* (smoke tests only).
// Records everything the scripts do so tests can assert on it. Names follow the 2.0.0 typings.

export const EquipmentSlot = Object.freeze({ Chest: "Chest", Head: "Head", Legs: "Legs", Feet: "Feet", Mainhand: "Mainhand", Offhand: "Offhand" });
export const ItemLockMode = Object.freeze({ inventory: "inventory", none: "none", slot: "slot" });
export const HudElement = Object.freeze({ Crosshair: 15, PaperDoll: 0 });
export const HudVisibility = Object.freeze({ Hide: 0, Reset: 1 });
export const ButtonState = Object.freeze({ Pressed: "Pressed", Released: "Released" });
export const InputButton = Object.freeze({ Jump: "Jump", Sneak: "Sneak" });
export const GameMode = Object.freeze({ Adventure: "Adventure", Creative: "Creative", Spectator: "Spectator", Survival: "Survival" });
export const EasingType = Object.freeze({ InOutSine: "InOutSine", OutCubic: "OutCubic" });
export const InputPermissionCategory = Object.freeze({ Camera: 1, Movement: 2 });
export const EntityDamageCause = Object.freeze(
  Object.fromEntries(
    "anvil blockExplosion campfire charging contact drowning entityAttack entityExplosion fall fallingBlock fire fireTick fireworks flyIntoWall freezing lava lightning maceSmash magic magma none override piston projectile ramAttack selfDestruct sonicBoom soulCampfire stalactite stalagmite starve suffocation temperature thorns wither"
      .split(" ")
      .map((k) => [k, k])
  )
);

export const log = { particles: [], sounds: [], events: [] };

export class MolangVariableMap {
  constructor() {
    this.vars = {};
  }
  setVector3(k, v) {
    this.vars[k] = { ...v };
  }
  setFloat(k, v) {
    if (!Number.isFinite(v)) throw new Error(`setFloat ${k} not finite`);
    this.vars[k] = v;
  }
  setColorRGBA(k, c) {
    this.vars[k] = { ...c };
  }
}

class Signal {
  constructor() {
    this.subs = [];
  }
  subscribe(cb, options) {
    this.subs.push({ cb, options });
    return cb;
  }
  unsubscribe(cb) {
    this.subs = this.subs.filter((s) => s.cb !== cb);
  }
  fire(ev) {
    for (const s of this.subs) s.cb(ev);
  }
}

const dynProps = () => {
  const m = new Map();
  return {
    getDynamicProperty: (k) => m.get(k),
    setDynamicProperty: (k, v) => (v === undefined ? m.delete(k) : m.set(k, v)),
    getDynamicPropertyIds: () => [...m.keys()],
  };
};

export class ItemStack {
  constructor(typeId, amount = 1) {
    if (typeof typeId !== "string" || !typeId.includes(":")) throw new Error(`bad item ${typeId}`);
    this.typeId = typeId;
    this.amount = amount;
    this.nameTag = undefined;
    this.lockMode = ItemLockMode.none;
    this.keepOnDeath = false;
    this._lore = [];
    this._props = dynProps();
    const armor = typeId.startsWith("sym:mark_5");
    this._dur = armor ? { damage: 0, maxDurability: 1815 } : undefined;
    this._ench = armor ? [] : undefined;
  }
  getComponent(id) {
    if (id === "minecraft:durability" && this._dur) return this._dur;
    if (id === "minecraft:enchantable" && this._ench) {
      const list = this._ench;
      return { getEnchantments: () => list.map((e) => ({ ...e })), addEnchantment: (e) => list.push({ ...e }) };
    }
    return undefined;
  }
  getLore() {
    return [...this._lore];
  }
  setLore(l) {
    this._lore = [...(l ?? [])];
  }
  getDynamicProperty(k) {
    return this._props.getDynamicProperty(k);
  }
  setDynamicProperty(k, v) {
    this._props.setDynamicProperty(k, v);
  }
  getDynamicPropertyIds() {
    return this._props.getDynamicPropertyIds();
  }
}

export class Dimension {
  constructor(id) {
    this.id = id;
    this.entities = [];
  }
  spawnParticle(id, loc, vars) {
    if (vars !== undefined && !(vars instanceof MolangVariableMap)) throw new Error("molang must be a MolangVariableMap");
    if (![loc.x, loc.y, loc.z].every(Number.isFinite)) throw new Error("bad particle location");
    log.particles.push({ id, loc, vars: vars?.vars, scope: "world" });
  }
  playSound(id, loc, opts) {
    log.sounds.push({ id, loc, opts, scope: "world" });
  }
  getEntities(q = {}) {
    return this.entities.filter((e) => {
      if (!e.isValid) return false;
      if (q.type && e.typeId !== q.type) return false;
      if (q.families && !q.families.every((f) => e.families.includes(f))) return false;
      if (q.location && q.maxDistance !== undefined) {
        const d = Math.hypot(e.location.x - q.location.x, e.location.y - q.location.y, e.location.z - q.location.z);
        if (d > q.maxDistance) return false;
      }
      return true;
    });
  }
  getBlock() {
    return { typeId: "minecraft:air" };
  }
  getBlockFromRay(from, dir, opts) {
    const groundY = 64;
    if (from.y - groundY > (opts?.maxDistance ?? 64)) return undefined;
    return { block: { location: { x: Math.floor(from.x), y: groundY - 1, z: Math.floor(from.z) } }, faceLocation: { x: 0.5, y: 1, z: 0.5 } };
  }
}

export class Entity {
  constructor(dimension, typeId, location, opts = {}) {
    this.id = String(Entity.next++);
    this.typeId = typeId;
    this.dimension = dimension;
    this.location = { ...location };
    this.isValid = true;
    this.families = opts.families ?? [];
    this.nameTag = opts.nameTag ?? "";
    this.hp = opts.hp ?? 20;
    this.maxHp = opts.hp ?? 20;
    Object.assign(this, dynProps());
    dimension.entities.push(this);
  }
  getComponent(id) {
    if (id === "minecraft:health") {
      const self = this;
      return {
        get currentValue() {
          return self.hp;
        },
        effectiveMax: this.maxHp,
        setCurrentValue: (v) => {
          self.hp = v;
          return true;
        },
      };
    }
    return undefined;
  }
  matches(q) {
    return (q.families ?? []).every((f) => this.families.includes(f));
  }
  kill() {
    this.hp = 0;
    this.isValid = false;
  }
}
Entity.next = 1;

export class Player extends Entity {
  constructor(dimension, name, location) {
    super(dimension, "minecraft:player", location, { nameTag: name, families: ["player"] });
    this.name = name;
    this.rotation = { x: 0, y: 0 };
    this.isSneaking = false;
    this.isJumping = false;
    this.isSprinting = false;
    this.isOnGround = true;
    this.isFlying = false;
    this.isGliding = false;
    this.isInWater = false;
    this.isSwimming = false;
    this.move = { x: 0, y: 0 };
    this.jumpHeld = false;
    this.equipment = {};
    this.effects = new Map();
    this.titles = [];
    this.actionbars = [];
    this.hudCalls = [];
    this.anims = [];
    this.knockbacks = [];
    this.commands = [];
    this.lookingAt = [];
    this.gameMode = GameMode.Survival;
    const self = this;
    this.inputInfo = {
      getMovementVector: () => ({ ...self.move }),
      getButtonState: (b) => (b === InputButton.Jump && self.jumpHeld ? ButtonState.Pressed : ButtonState.Released),
    };
    this.onScreenDisplay = {
      setTitle: (t, o) => self.titles.push({ t, o, tick: system.currentTick }),
      setActionBar: (t) => self.actionbars.push(t),
      setHudVisibility: (v, els) => self.hudCalls.push({ v, els }),
    };
  }
  getComponent(id) {
    const self = this;
    if (id === "minecraft:equippable") {
      return {
        getEquipment: (slot) => self.equipment[slot],
        setEquipment: (slot, item) => {
          if (item !== undefined && !(item instanceof ItemStack)) throw new Error("not an ItemStack");
          self.equipment[slot] = item;
          return true;
        },
      };
    }
    if (id === "minecraft:riding") return undefined;
    return super.getComponent(id);
  }
  getRotation() {
    return { ...this.rotation };
  }
  getViewDirection() {
    const p = (this.rotation.x * Math.PI) / 180;
    const y = (this.rotation.y * Math.PI) / 180;
    return { x: -Math.sin(y) * Math.cos(p), y: -Math.sin(p), z: Math.cos(y) * Math.cos(p) };
  }
  getHeadLocation() {
    return { x: this.location.x, y: this.location.y + 1.62, z: this.location.z };
  }
  getVelocity() {
    return { x: 0, y: 0, z: 0 };
  }
  getGameMode() {
    return this.gameMode;
  }
  playAnimation(id, opts) {
    this.anims.push({ id, opts });
  }
  applyKnockback(h, v) {
    if (![h.x, h.z, v].every(Number.isFinite)) throw new Error("bad knockback");
    this.knockbacks.push({ ...h, y: v });
  }
  addEffect(id, duration, opts) {
    this.effects.set(id, { amplifier: opts?.amplifier ?? 0, duration });
    return undefined;
  }
  removeEffect(id) {
    return this.effects.delete(id);
  }
  getEffect(id) {
    return this.effects.get(id);
  }
  spawnParticle(id, loc, vars) {
    if (vars !== undefined && !(vars instanceof MolangVariableMap)) throw new Error("molang must be a MolangVariableMap");
    log.particles.push({ id, loc, vars: vars?.vars, scope: "player", player: this.name });
  }
  playSound(id, opts) {
    log.sounds.push({ id, opts, scope: "player", player: this.name });
  }
  runCommand(c) {
    this.commands.push(c);
    return { successCount: 1 };
  }
  getEntitiesFromViewDirection() {
    return this.lookingAt.filter((e) => e.isValid).map((e) => ({ entity: e, distance: Math.hypot(e.location.x - this.location.x, e.location.z - this.location.z) }));
  }
}

const runs = [];
let nextRun = 1;
export const system = {
  currentTick: 0,
  runInterval(fn, every = 1) {
    const r = { id: nextRun++, fn, every, at: this.currentTick + every };
    runs.push(r);
    return r.id;
  },
  runTimeout(fn, delay = 1) {
    const r = { id: nextRun++, fn, at: this.currentTick + delay, once: true };
    runs.push(r);
    return r.id;
  },
  run(fn) {
    return this.runTimeout(fn, 1);
  },
  clearRun(id) {
    const i = runs.findIndex((r) => r.id === id);
    if (i >= 0) runs.splice(i, 1);
  },
  sendScriptEvent(id, message) {
    if (!id.includes(":") || id.startsWith("minecraft:")) throw new Error("bad script event id");
    log.events.push({ id, message: JSON.parse(message) });
    this.afterEvents.scriptEventReceive.fire({ id, message, sourceType: "Server" });
  },
  afterEvents: { scriptEventReceive: new Signal() },
  beforeEvents: { startup: new Signal() },
  /** advance n ticks */
  tick(n = 1) {
    for (let i = 0; i < n; i++) {
      this.currentTick++;
      for (const r of [...runs]) {
        if (r.at > this.currentTick) continue;
        if (r.once) runs.splice(runs.indexOf(r), 1);
        else r.at = this.currentTick + r.every;
        r.fn();
      }
    }
  },
};

let absTime = 1000;
export const world = {
  players: [],
  getAllPlayers() {
    return this.players.filter((p) => p.isValid);
  },
  getAbsoluteTime() {
    return absTime + system.currentTick;
  },
  afterEvents: {
    playerButtonInput: new Signal(),
    entityHurt: new Signal(),
    entityDie: new Signal(),
    playerLeave: new Signal(),
    itemUse: new Signal(),
  },
  beforeEvents: { playerLeave: new Signal() },
};
