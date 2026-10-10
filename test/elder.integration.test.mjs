// Mock-Foundry run of the real XP module through an Elder purchase session.
import test from 'node:test';
import assert from 'node:assert/strict';
import { install, notes } from './mock-foundry.mjs';

const ELDER = 'vtm-v20-powers.elderPower';
const env = install({
  actors: [{
    name: 'Ambrogino', type: 'vampire', ownerIds: ['p1'],
    system: {
      clan: 'Tremere', generation: 7, pathName: 'Humanity',
      attributes: { strength: 2 }, abilities: {}, virtues: { conscience: 3, selfControl: 3, courage: 3 },
      humanity: 6, willpower: { value: 5, max: 5 }, experience: { current: 0, total: 0 },
    },
    items: [{ name: 'Dominate', type: 'discipline', system: { level: 5 } }],
  }],
  worldItems: [
    { name: 'Mass Mesmerize', type: ELDER, system: { discipline: 'Dominate', level: 6, difficulty: 7 } },
    { name: 'Far Mastery', type: ELDER, system: { discipline: 'Dominate', level: 6, difficulty: 8 } },
  ],
});
await import('../scripts/main.mjs');
Hooks.callAll('init');
const api = env.moduleObj.api;
const a = env.actors[0];
const sys = () => a._source.system;
const elders = () => a.items.filter(i => i.type === ELDER).map(i => i.name).sort();

test('setup: finalize and award', async () => {
  env.as(env.gmUser);
  await a.setFlag('vtm-v20', 'sheetLocked', true);
  await new Promise(r => setTimeout(r, 10));
  await api.award([a], 60, 'Centuries');
  assert.equal(sys().experience.current, 60);
});

test('Storyteller-only switch blocks Elder dots for players', async () => {
  env.as(env.player);
  await api.spend(a, 'discipline|dominate#mass mesmerize'); // not offered while off
  assert.equal(a.items.find(i => i.name === 'Dominate').system.level, 5);
  assert.equal(sys().experience.current, 60);
});

test('dot 6 + chosen power: one purchase, 25 XP, power created', async () => {
  env.settings['vtm-v20-xp.elderPurchases'] = true;
  env.as(env.player);
  await api.spend(a, 'discipline|dominate#mass mesmerize');
  assert.equal(a.items.find(i => i.name === 'Dominate').system.level, 6);
  assert.deepEqual(elders(), ['Mass Mesmerize']);
  assert.equal(sys().experience.current, 35);
});

test('extra power at level 6 costs 25 more; audit clean', async () => {
  env.as(env.player);
  await api.spend(a, 'elder|far mastery');
  assert.deepEqual(elders(), ['Far Mastery', 'Mass Mesmerize']);
  assert.equal(sys().experience.current, 10);
  env.as(env.gmUser);
  assert.deepEqual(api.audit(a).drift, []);
});

test('players cannot drag Elder powers onto a locked sheet', async () => {
  env.as(env.player);
  const n = a.items.length;
  await a.createEmbeddedDocuments('Item', [{ name: 'Free Power', type: ELDER, system: { discipline: 'Dominate', level: 6 } }]);
  assert.equal(a.items.length, n);
  assert.match(notes.at(-1)[1], /locked sheet/);
});

test('GM undo reverses extra power, then dot + power together', async () => {
  env.as(env.gmUser);
  await api.undoLast(a);
  assert.deepEqual(elders(), ['Mass Mesmerize']);
  assert.equal(sys().experience.current, 35);
  await api.undoLast(a);
  assert.deepEqual(elders(), []);
  assert.equal(a.items.find(i => i.name === 'Dominate').system.level, 5);
  assert.equal(sys().experience.current, 60);
  assert.deepEqual(api.audit(a).drift, []);
});

test('GM-added Elder power on an NPC shows as drift until rebaselined', async () => {
  env.as(env.gmUser);
  await a.createEmbeddedDocuments('Item', [{ name: 'Far Mastery', type: ELDER, system: { discipline: 'Dominate', level: 6 } }]);
  assert.equal(api.audit(a).drift[0].key, 'elder|far mastery');
  await api.setBaseline(a);
  assert.deepEqual(api.audit(a).drift, []);
});
