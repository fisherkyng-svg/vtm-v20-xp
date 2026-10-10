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

import { ELDER_TYPE, expectedFromLedger } from '../scripts/logic.mjs';

const elderState = () => {
  const s = baseVamp();
  s.traitMax = 6; // 7th generation
  s.xp.current = 100;
  s.items = [
    { id: 'dom', type: 'discipline', name: 'Dominate', level: 5 },
    { id: 'pot', type: 'discipline', name: 'Potence', level: 6 },
  ];
  s.catalog.elders = [
    { name: 'Mass Mesmerize', discipline: 'Dominate', level: 6, uuid: 'w.mm' },
    { name: 'Far Mastery', discipline: 'Dominate', level: 6, uuid: 'w.fm' },
    { name: 'Speak Through the Blood', discipline: 'Dominate', level: 7, uuid: 'w.sb' },
    { name: 'Flick', discipline: 'Potence', level: 6, uuid: 'w.fl' },
  ];
  s.elderEnabled = true;
  return s;
};

test('Elder: dot 6 is one option per level-6 power, at the normal dot cost', () => {
  const o = buildOptions(elderState());
  const mm = find(o, 'discipline|dominate#mass mesmerize');
  assert.equal(mm.cost, 25);                       // in-clan 5 x5
  assert.equal(mm.auditKey, 'discipline|dominate');
  assert.deepEqual(mm.alsoCreate, { uuid: 'w.mm', itemType: ELDER_TYPE, key: 'elder|mass mesmerize', name: 'Mass Mesmerize', to: 6 });
  assert.ok(find(o, 'discipline|dominate#far mastery'));
  assert.equal(find(o, 'discipline|dominate#speak through the blood'), undefined); // level 7
  assert.equal(o.filter(x => x.group === 'New Elder Powers' && x.name.includes('Dominate')).length, 0); // not at 6 yet
});

test('Elder: extra power at an owned level costs that dot again (out-of-clan 35)', () => {
  const o = buildOptions(elderState());
  const flick = find(o, 'elder|flick');
  assert.equal(flick.cost, 35);                    // Potence out-of-clan 5 x7
  assert.equal(flick.to, 6);
  assert.equal(flick.op.itemType, ELDER_TYPE);
});

test('Elder: owned powers drop out; next dot offers the next level; in-clan extra = 25', () => {
  const s = elderState();
  s.traitMax = 7; // 6th generation
  s.items[0].level = 6;
  s.items.push({ id: 'e1', type: ELDER_TYPE, name: 'Mass Mesmerize', level: 6, discipline: 'Dominate' });
  const o = buildOptions(s);
  assert.equal(find(o, 'elder|mass mesmerize'), undefined);
  assert.equal(find(o, 'elder|far mastery').cost, 25);
  const sb = find(o, 'discipline|dominate#speak through the blood');
  assert.equal(sb.cost, 30);                       // 6 x5
  assert.equal(sb.blocked, null);
});

test('Elder: generation cap, empty library, and the Storyteller-only switch', () => {
  const s = elderState();
  s.traitMax = 5;
  assert.match(find(buildOptions(s), 'discipline|dominate').blocked, /max 5/);
  const s2 = elderState(); s2.catalog.elders = [];
  assert.match(find(buildOptions(s2), 'discipline|dominate').blocked, /no level 6 Dominate powers/);
  const s3 = elderState(); s3.elderEnabled = false;
  assert.match(find(buildOptions(s3), 'discipline|dominate').blocked, /Storyteller only/);
  assert.match(find(buildOptions(s3), 'elder|flick').blocked, /Storyteller only/);
});

test('Elder: dot 6 at max cap shows max, not a power list', () => {
  const s = elderState();
  s.items[0].level = 6;
  const o = buildOptions(s);
  assert.match(find(o, 'discipline|dominate').blocked, /max 6/);
});

test('audit follows Elder purchases', () => {
  const baseline = { ts: 1, xp: { current: 50, total: 50 }, traits: { 'discipline|dominate': 5 } };
  const log = [{ kind: 'spend', ts: 2, cost: 25, key: 'discipline|dominate', to: 6, alsoCreated: { key: 'elder|mass mesmerize', to: 6 } }];
  const exp = expectedFromLedger(baseline, log);
  assert.equal(exp.traits['discipline|dominate'], 6);
  assert.equal(exp.traits['elder|mass mesmerize'], 6);
  assert.equal(exp.xp.current, 25);
});
