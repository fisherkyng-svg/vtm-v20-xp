import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOptions, disciplineClass, primaryPaths, stripGuarded, isGuardedActorKey,
  audit, itemKey,
} from '../scripts/logic.mjs';

const baseVamp = () => ({
  type: 'vampire', clan: 'Tremere', generation: 13, traitMax: 5, nosferatu: false,
  xp: { current: 30, total: 30 },
  pathName: 'Humanity',
  fields: {
    'system.attributes.strength': 2, 'system.attributes.appearance': 3,
    'system.abilities.occult': 0, 'system.abilities.brawl': 3, 'system.abilities.melee': 5,
    'system.virtues.conscience': 3, 'system.virtues.courage': 5,
    'system.humanity': 6, 'system.willpower.max': 4,
  },
  items: [
    { id: 'd1', type: 'discipline', name: 'Thaumaturgy', level: 2 },
    { id: 'd2', type: 'discipline', name: 'Potence', level: 1 },
    { id: 'p1', type: 'path', name: 'Path of Blood', category: 'thaumaturgical', level: 2 },
    { id: 'p2', type: 'path', name: 'Lure of Flames', category: 'thaumaturgical', level: 1 },
    { id: 'r1', type: 'ritual', name: 'Defense of the Sacred Haven', level: 1, ritualType: 'thaumaturgical' },
  ],
  clanDisciplines: ['Auspex', 'Dominate', 'Thaumaturgy'],
  overrides: {}, primaryOverride: {},
  catalog: {
    disciplines: [{ name: 'Auspex', uuid: 'c.auspex' }, { name: 'Daimoinon', uuid: 'w.daim' }, { name: 'Potence', uuid: 'c.pot' }],
    paths: [{ name: 'Movement of the Mind', category: 'thaumaturgical', uuid: 'c.mom' },
            { name: 'Sepulchre Path', category: 'necromantic', uuid: 'c.sep' }],
    rituals: [{ name: 'Ward vs Ghouls', level: 2, ritualType: 'thaumaturgical', uuid: 'c.w' },
              { name: 'Big Ritual', level: 4, ritualType: 'thaumaturgical', uuid: 'c.b' },
              { name: 'Call of the Hungry Dead', level: 1, ritualType: 'necromantic', uuid: 'c.n' }],
  },
  ritualMult: 2,
});

const find = (opts, key) => opts.find(o => o.key === key);

test('V20 attribute / ability / virtue / humanity / willpower costs', () => {
  const o = buildOptions(baseVamp());
  assert.equal(find(o, 'system.attributes.strength').cost, 8);      // 2 x4
  assert.equal(find(o, 'system.abilities.occult').cost, 3);         // new ability
  assert.equal(find(o, 'system.abilities.brawl').cost, 6);          // 3 x2
  assert.equal(find(o, 'system.virtues.conscience').cost, 6);       // 3 x2
  assert.equal(find(o, 'system.humanity').cost, 12);                // 6 x2
  assert.equal(find(o, 'system.willpower.max').cost, 4);            // 4 x1
});

test('caps: generation trait max, virtue 5, Nosferatu appearance', () => {
  const s = baseVamp();
  assert.match(find(buildOptions(s), 'system.abilities.melee').blocked, /max 5/);
  assert.match(find(buildOptions(s), 'system.virtues.courage').blocked, /max 5/);
  s.traitMax = 6; // 7th gen
  assert.equal(find(buildOptions(s), 'system.abilities.melee').blocked, null);
  s.nosferatu = true;
  assert.match(find(buildOptions(s), 'system.attributes.appearance').blocked, /Nosferatu/);
});

test('in-clan vs out-of-clan vs caitiff discipline costs', () => {
  const s = baseVamp();
  assert.equal(disciplineClass(s, 'Thaumaturgy'), 'clan');
  assert.equal(find(buildOptions(s), itemKey('discipline', 'Thaumaturgy')).cost, 10); // 2 x5
  assert.equal(find(buildOptions(s), itemKey('discipline', 'Potence')).cost, 7);      // 1 x7
  s.overrides = { potence: 'clan' }; // e.g. Additional Discipline merit
  assert.equal(find(buildOptions(s), itemKey('discipline', 'Potence')).cost, 5);
  s.overrides = {}; s.clan = 'Caitiff';
  assert.equal(find(buildOptions(s), itemKey('discipline', 'Potence')).cost, 6);      // 1 x6
});

test('Baali world clan: Daimoinon is in-clan', () => {
  const s = baseVamp();
  s.clan = 'Baali'; s.clanDisciplines = ['Daimoinon', 'Obfuscate', 'Presence'];
  const d = find(buildOptions(s), itemKey('discipline', 'Daimoinon'));
  assert.equal(d.cost, 10);
  assert.match(d.name, /\(clan\)/);
  assert.equal(find(buildOptions(s), itemKey('discipline', 'Potence')) !== undefined, true);
  assert.equal(find(buildOptions(s), itemKey('discipline', 'Auspex')).op.kind, 'create');
});

test('raising Thaumaturgy carries the primary path', () => {
  const o = find(buildOptions(baseVamp()), itemKey('discipline', 'Thaumaturgy'));
  assert.equal(o.extras.length, 1);
  assert.equal(o.extras[0].itemId, 'p1');
  assert.equal(o.extras[0].to, 3);
});

test('primary path: highest-rated, GM override wins', () => {
  const s = baseVamp();
  assert.equal(primaryPaths(s).thaumaturgical.id, 'p1');
  s.primaryOverride = { thaumaturgical: 'Lure of Flames' };
  assert.equal(primaryPaths(s).thaumaturgical.id, 'p2');
});

test('secondary paths: new 7, current x4, capped at primary', () => {
  const s = baseVamp();
  const o = buildOptions(s);
  assert.equal(find(o, itemKey('path', 'Path of Blood')), undefined); // primary not buyable
  const lure = find(o, itemKey('path', 'Lure of Flames'));
  assert.equal(lure.cost, 4);
  assert.equal(lure.blocked, null); // 1 -> 2, primary is 2
  s.items[3].level = 2;
  assert.match(find(buildOptions(s), itemKey('path', 'Lure of Flames')).blocked, /primary/);
  assert.equal(find(o, itemKey('path', 'Movement of the Mind')).cost, 7);
  assert.equal(find(o, itemKey('path', 'Sepulchre Path')), undefined); // no Necromancy
});

test('rituals are never purchasable', () => {
  assert.equal(buildOptions(baseVamp()).some(o => o.key.startsWith('ritual|')), false);
});

test('unaffordable options are blocked with a reason', () => {
  const s = baseVamp(); s.xp.current = 5;
  assert.match(find(buildOptions(s), 'system.attributes.strength').blocked, /need 8, have 5/);
});

test('mortals: no disciplines, paths, or rituals', () => {
  const s = baseVamp(); s.type = 'mortal';
  assert.equal(buildOptions(s).some(o => o.group.includes('Discipline')), false);
});

test('guard strips changed guarded keys, keeps unchanged resubmits and pools', () => {
  const source = { system: { attributes: { strength: 2 }, experience: { current: 10, total: 30 }, willpower: { value: 3, max: 4 } } };
  const changes = { system: { attributes: { strength: 3 }, experience: { current: 10, total: 30 }, willpower: { value: 2, max: 4 } } };
  const stripped = stripGuarded(changes, source, isGuardedActorKey);
  assert.deepEqual(stripped, ['system.attributes.strength']);
  assert.equal(changes.system.willpower.value, 2);
  assert.equal(changes.system.attributes, undefined);
  const dotted = { 'system.experience.current': 99, 'system.willpower.value': 1 };
  assert.deepEqual(stripGuarded(dotted, source, isGuardedActorKey), ['system.experience.current']);
  assert.deepEqual(dotted, { 'system.willpower.value': 1 });
});

test('audit: clean ledger has no drift; manual edits show up', () => {
  const baseline = { ts: 100, xp: { current: 0, total: 0 }, traits: { 'system.attributes.strength': 2 } };
  const log = [
    { kind: 'award', amount: 20, ts: 200 },
    { kind: 'spend', cost: 8, key: 'system.attributes.strength', to: 3, ts: 300 },
    { kind: 'spend', cost: 10, key: 'discipline|auspex', to: 1, ts: 400, undone: true },
    { kind: 'award', amount: 99, ts: 50 }, // before baseline, ignored
  ];
  const clean = audit(baseline, log, { xp: { current: 12, total: 20 }, traits: { 'system.attributes.strength': 3 } });
  assert.deepEqual(clean.drift, []);
  const dirty = audit(baseline, log, { xp: { current: 12, total: 20 }, traits: { 'system.attributes.strength': 4, 'discipline|celerity': 1 } });
  assert.equal(dirty.drift.length, 2);
});
