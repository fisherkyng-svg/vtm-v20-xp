import test from 'node:test';
import assert from 'node:assert/strict';
import { install, Hooks, chat, notes } from './mock-foundry.mjs';

const vampire = {
  name: 'Lucien', type: 'vampire', ownerIds: ['p1'],
  system: {
    clan: 'Baali', generation: 13, pathName: 'Humanity',
    attributes: { strength: 2, appearance: 3 },
    abilities: { occult: 0, brawl: 2 },
    virtues: { conscience: 3, selfControl: 3, courage: 3 },
    humanity: 6, willpower: { value: 3, max: 3 },
    experience: { current: 0, total: 0 },
  },
  items: [
    { name: 'Obfuscate', type: 'discipline', system: { level: 1 } },
    { name: 'Resources', type: 'background', system: { rating: 2 } },
  ],
};

const env = install({
  actors: [vampire],
  worldItems: [
    { name: 'Baali', type: 'clan', system: { disciplines: ['Daimoinon', 'Obfuscate', 'Presence'], weakness: '' } },
    { name: 'Daimoinon', type: 'discipline', system: { level: 0 } },
  ],
  pack: [
    { name: 'Potence', type: 'discipline', system: { level: 0 } },
    { name: 'Lure of Flames', type: 'path', system: { level: 0, category: 'thaumaturgical' } },
  ],
});
await import('../scripts/main.mjs');
Hooks.callAll('init');
const api = env.moduleObj.api;
const actor = env.actors[0];
const sys = () => actor._source.system;
const log = () => actor._source.flags['vtm-v20-xp']?.log ?? [];

test('GM finalizes on lock: baseline taken', async () => {
  env.as(env.gmUser);
  await actor.setFlag('vtm-v20', 'sheetLocked', true); await new Promise(r => setTimeout(r, 20));
  const b = actor._source.flags['vtm-v20-xp'].baseline;
  assert.ok(b);
  const t = Object.fromEntries(b.traitPairs);
  assert.equal(t['system.attributes.strength'], 2);
  assert.equal(t['discipline|obfuscate'], 1);
});

test('GM awards XP; player cannot', async () => {
  env.as(env.gmUser);
  await api.award([actor], 40, 'Sessions 1-3');
  assert.deepEqual(sys().experience, { current: 40, total: 40 });
  env.as(env.player);
  await api.award([actor], 100);
  assert.equal(sys().experience.current, 40);
});

test('player spends: attribute, in-clan new Daimoinon, out-of-clan Potence', async () => {
  env.as(env.player);
  await api.spend(actor, 'system.attributes.strength', 'training');
  assert.equal(sys().attributes.strength, 3);
  assert.equal(sys().experience.current, 32); // 2 x4 = 8
  await api.spend(actor, 'discipline|daimoinon');
  const d = actor.items.find(i => i.name === 'Daimoinon');
  assert.equal(d.system.level, 1);
  assert.equal(sys().experience.current, 22); // new = 10
  await api.spend(actor, 'discipline|daimoinon');
  assert.equal(d.system.level, 2);
  assert.equal(sys().experience.current, 17); // in-clan 1 x5
  await api.spend(actor, 'discipline|potence');
  await api.spend(actor, 'discipline|potence');
  assert.equal(sys().experience.current, 0); // 10 new + 1 x7
  assert.equal(log().filter(e => e.kind === 'spend').length, 5);
  assert.equal(chat.length >= 6, true);
});

test('cannot overspend', async () => {
  env.as(env.player);
  await api.spend(actor, 'system.attributes.strength');
  assert.equal(sys().attributes.strength, 3);
  assert.match(notes.at(-1)[1], /need 12, have 0/);
});

test('guards: direct dot edits, XP edits, item drops/deletes blocked for player', async () => {
  env.as(env.player);
  // whole-form resubmit with one sneaky change and one legit pool change
  await actor.update({ system: { attributes: { strength: 5, appearance: 3 }, willpower: { value: 1, max: 3 }, experience: { current: 50, total: 40 } } });
  assert.equal(sys().attributes.strength, 3);
  assert.equal(sys().experience.current, 0);
  assert.equal(sys().willpower.value, 1); // pools still work
  const before = actor.items.length;
  await actor.createEmbeddedDocuments('Item', [{ name: 'Celerity', type: 'discipline', system: { level: 3 } }]);
  assert.equal(actor.items.length, before);
  const obf = actor.items.find(i => i.name === 'Obfuscate');
  await obf.update({ 'system.level': 5 });
  assert.equal(obf.system.level, 1);
  await actor.deleteEmbeddedDocuments('Item', [obf.id]);
  assert.ok(actor.items.get(obf.id));
  // weapons / equipment aren't guarded
  await actor.createEmbeddedDocuments('Item', [{ name: 'Knife', type: 'weapon', system: {} }]);
  assert.ok(actor.items.find(i => i.name === 'Knife'));
  // bookkeeping flags
  await actor.update({ 'flags.vtm-v20-xp.log': [], 'flags.vtm-v20.sheetLocked': false });
  assert.equal(log().length > 0, true);
  assert.equal(actor._source.flags['vtm-v20'].sheetLocked, true);
});

test('audit clean after ledgered changes; GM edits show as drift', async () => {
  env.as(env.gmUser);
  assert.deepEqual(api.audit(actor).drift, []);
  await actor.update({ 'system.abilities.brawl': 4 }); // GM may edit directly
  const drift = api.audit(actor).drift;
  assert.equal(drift.length, 1);
  assert.equal(drift[0].key, 'system.abilities.brawl');
  await api.setBaseline(actor);
  assert.deepEqual(api.audit(actor).drift, []);
});

test('GM undo reverses the last spend, then the last award', async () => {
  env.as(env.gmUser);
  // fresh award + a create, then undo the create
  await api.award([actor], 10, 'bonus');
  env.as(env.player);
  await api.spend(actor, 'path|lure of flames'); // no Thaumaturgy: not listed
  assert.equal(actor.items.find(i => i.name === 'Lure of Flames'), undefined);
  await api.spend(actor, 'system.virtues.conscience'); // 3 x2 = 6
  assert.equal(sys().virtues.conscience, 4);
  env.as(env.gmUser);
  await api.undoLast(actor);
  assert.equal(sys().virtues.conscience, 3);
  assert.equal(sys().experience.current, 10);
  assert.equal(log().at(-1).undone, true);
  await api.undoLast(actor); // undoes the award
  assert.deepEqual(sys().experience, { current: 0, total: 40 });
  assert.deepEqual(api.audit(actor).drift, []);
});

test('undo a created discipline deletes it', async () => {
  env.as(env.gmUser);
  await api.award([actor], 10);
  env.as(env.player);
  await api.spend(actor, 'discipline|presence'); // not in catalog: not available
  assert.equal(actor.items.find(i => i.name === 'Presence'), undefined);
  await api.spend(actor, 'discipline|daimoinon'); // 2 -> 3 in-clan = 10
  assert.equal(actor.items.find(i => i.name === 'Daimoinon').system.level, 3);
  env.as(env.gmUser);
  await api.undoLast(actor);
  assert.equal(actor.items.find(i => i.name === 'Daimoinon').system.level, 2);
});

test('unlocked sheet: guards off for player (chargen still works)', async () => {
  env.as(env.gmUser);
  await actor.setFlag('vtm-v20', 'sheetLocked', false);
  env.as(env.player);
  await actor.update({ 'system.abilities.occult': 2 });
  assert.equal(sys().abilities.occult, 2);
  env.as(env.gmUser);
  await actor.setFlag("vtm-v20", "sheetLocked", true); await new Promise(r => setTimeout(r, 20)); // relock: drift -> confirm (mock says yes) -> rebaseline
  assert.deepEqual(api.audit(actor).drift, []);
});

test('rituals: GM grants freely with audit clean; player cannot self-add', async () => {
  env.as(env.gmUser);
  await actor.createEmbeddedDocuments('Item', [{ name: 'Wake with Evening\'s Freshness', type: 'ritual', system: { level: 1 } }]);
  assert.ok(actor.items.find(i => i.type === 'ritual'));
  assert.deepEqual(api.audit(actor).drift, []);
  env.as(env.player);
  const n = actor.items.length;
  await actor.createEmbeddedDocuments('Item', [{ name: 'Rite of Introduction', type: 'ritual', system: { level: 1 } }]);
  assert.equal(actor.items.length, n);
});
