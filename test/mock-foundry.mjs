// Minimal Foundry stand-in: enough document/hook behavior to drive main.mjs.
// It is not Foundry; it checks our wiring, not Foundry's own behavior.

const hooks = {};
export const Hooks = {
  on(name, fn) { (hooks[name] ??= []).push(fn); },
  once(name, fn) { (hooks[name] ??= []).push(fn); },
  callAll(name, ...args) { for (const fn of hooks[name] ?? []) fn(...args); },
  call(name, ...args) { for (const fn of hooks[name] ?? []) if (fn(...args) === false) return false; return true; },
};

const clone = o => JSON.parse(JSON.stringify(o));
const getProperty = (o, p) => p.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
function setProperty(o, p, v) {
  const parts = p.split('.');
  let t = o;
  for (const k of parts.slice(0, -1)) t = (t[k] ??= {});
  const last = parts.at(-1);
  if (last.startsWith('-=')) delete t[last.slice(2)]; else t[last] = v;
}
function applyChanges(target, changes, prefix = '') {
  for (const [k, v] of Object.entries(changes)) {
    if (k === '_id') continue;
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v) && !k.startsWith('-=')) applyChanges(target, v, key);
    else setProperty(target, key, v);
  }
}

// Foundry expands dotted update keys before pre-hooks run
function expand(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const val = v && typeof v === 'object' && !Array.isArray(v) ? expand(v) : v;
    const parts = k.split('.');
    let t = out;
    for (const p of parts.slice(0, -1)) t = (t[p] ??= {});
    const last = parts.at(-1);
    t[last] = (t[last] && typeof t[last] === 'object' && val && typeof val === 'object' && !Array.isArray(val)) ? { ...t[last], ...val } : val;
  }
  return out;
}

let idn = 0;
const rid = () => `id${++idn}`;

class Doc {
  constructor(data, parent) { this._source = clone(data); this._source._id ??= rid(); this.parent = parent ?? null; }
  get id() { return this._source._id; }
  get name() { return this._source.name; }
  get type() { return this._source.type; }
  get system() { return this._source.system; }
  get uuid() { return this.parent ? `${this.parent.uuid}.Item.${this.id}` : `Item.${this.id}`; }
  getFlag(scope, key) { return this._source.flags?.[scope]?.[key]; }
  toObject() { return clone(this._source); }
}

export class MockItem extends Doc {
  get documentName() { return 'Item'; }
  async update(changes, options = {}) {
    changes = expand(clone(changes));
    if (!Hooks.call('preUpdateItem', this, changes, options, game.user.id)) return null;
    applyChanges(this._source, changes);
    return this;
  }
}

export class MockActor extends Doc {
  constructor(data) {
    super({ flags: {}, ...data, items: undefined });
    this.itemMap = new Map((data.items ?? []).map(i => { const it = new MockItem(i, this); return [it.id, it]; }));
    this.ownerIds = data.ownerIds ?? [];
  }
  get documentName() { return 'Actor'; }
  get uuid() { return `Actor.${this.id}`; }
  get items() {
    const arr = [...this.itemMap.values()];
    arr.get = id => this.itemMap.get(id);
    return arr;
  }
  get isOwner() { return game.user.isGM || this.ownerIds.includes(game.user.id); }
  get hasPlayerOwner() { return this.ownerIds.length > 0; }
  get sheet() { return { render() {} }; }
  async update(changes, options = {}) {
    changes = expand(clone(changes));
    if (!Hooks.call('preUpdateActor', this, changes, options, game.user.id)) return null;
    applyChanges(this._source, changes);
    Hooks.callAll('updateActor', this, changes, options, game.user.id);
    return this;
  }
  async setFlag(scope, key, value) { return this.update({ [`flags.${scope}.${key}`]: value }); }
  async createEmbeddedDocuments(_t, list, options = {}) {
    const out = [];
    for (const data of list) {
      const item = new MockItem(data, this);
      if (!Hooks.call('preCreateItem', item, data, options, game.user.id)) continue;
      this.itemMap.set(item.id, item);
      out.push(item);
    }
    return out;
  }
  async deleteEmbeddedDocuments(_t, ids, options = {}) {
    for (const id of ids) {
      const item = this.itemMap.get(id);
      if (item && Hooks.call('preDeleteItem', item, options, game.user.id)) this.itemMap.delete(id);
    }
  }
}

export const chat = [];
export const notes = [];
const uuidRegistry = new Map();
export const registerUuid = (uuid, doc) => uuidRegistry.set(uuid, doc);

export function install({ worldItems = [], actors = [], pack = [] } = {}) {
  const gmUser = { id: 'gm', name: 'Storyteller', isGM: true };
  const player = { id: 'p1', name: 'Player One', isGM: false };
  const worldItemDocs = worldItems.map(d => new MockItem(d));
  for (const w of worldItemDocs) registerUuid(w.uuid, w);
  const packDocs = pack.map(d => new MockItem(d));
  for (const p of packDocs) registerUuid(`Compendium.vtm-v20.${p.type}s.${p.id}`, p);
  const settings = { 'vtm-v20-xp.ritualMult': 2, 'vtm-v20-xp.chatMode': 'public' };
  const moduleObj = {};
  globalThis.Hooks = Hooks;
  globalThis.CONFIG = {
    VTM: {
      clanDisciplines: { Tremere: ['Auspex', 'Dominate', 'Thaumaturgy'], Brujah: ['Celerity', 'Potence', 'Presence'] },
      generationTable: { 13: { traitMax: 5 }, 7: { traitMax: 6 } },
    },
  };
  globalThis.foundry = {
    utils: { deepClone: clone, getProperty, randomID: rid },
    applications: { api: { DialogV2: { wait: async () => null, confirm: async () => true } } },
  };
  globalThis.ui = { notifications: {
    warn: m => notes.push(['warn', m]), info: m => notes.push(['info', m]), error: m => notes.push(['error', m]) } };
  globalThis.ChatMessage = {
    getSpeaker: ({ actor }) => ({ alias: actor?.name }),
    getWhisperRecipients: () => [gmUser],
    create: async d => chat.push(d),
  };
  globalThis.fromUuid = async u => uuidRegistry.get(u) ?? null;
  const actorDocs = actors.map(a => new MockActor(a));
  const coll = arr => Object.assign(arr, { get: id => arr.find(x => x.id === id) });
  globalThis.game = {
    system: { id: 'vtm-v20' },
    user: gmUser,
    users: { gm: gmUser, p1: player },
    items: coll(worldItemDocs),
    actors: coll(actorDocs),
    packs: { get: name => {
      const type = { 'vtm-v20.disciplines': 'discipline', 'vtm-v20.paths': 'path', 'vtm-v20.rituals': 'ritual' }[name];
      if (!type) return null;
      return { getIndex: async () => packDocs.filter(d => d.type === type).map(d => ({
        _id: d.id, name: d.name, type: d.type, uuid: `Compendium.vtm-v20.${d.type}s.${d.id}`, system: d.system })) };
    } },
    settings: { register() {}, get: (m, k) => settings[`${m}.${k}`], set: (m, k, v) => { settings[`${m}.${k}`] = v; } },
    modules: { get: () => moduleObj },
  };
  return { gmUser, player, actors: actorDocs, moduleObj, as(user) { game.user = user; } };
}
