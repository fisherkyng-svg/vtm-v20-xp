// Pure rules logic for vtm-v20-xp. No Foundry globals in this file, so it
// can be unit-tested in Node. The Foundry glue builds a plain "state" object
// from an actor and hands it here.

export const MODULE_ID = 'vtm-v20-xp';

// V20 experience costs (V20 core, Experience chart). "c" is the current rating.
export const COST = {
  attribute: c => c * 4,
  abilityNew: () => 3,
  ability: c => c * 2,
  disciplineNew: () => 10,
  disciplineClan: c => c * 5,
  disciplineOut: c => c * 7,
  disciplineCaitiff: c => c * 6,
  pathNew: () => 7,
  path: c => c * 4,
  virtue: c => c * 2,
  humanity: c => c * 2,
  willpower: c => c * 1,
};

// Path / ritual categories and the Discipline that governs them
export const DISC_FOR_CATEGORY = { thaumaturgical: 'thaumaturgy', necromantic: 'necromancy' };
export const CLANLESS = ['caitiff', 'pander'];

// Actor fields a player may not change directly once the sheet is finalized
export const GUARDED_ACTOR_PREFIXES = [
  'system.attributes.', 'system.abilities.', 'system.virtues.',
  'system.experience.',
];
export const GUARDED_ACTOR_KEYS = [
  'system.humanity', 'system.pathName', 'system.willpower.max',
  'system.generation', 'system.clan',
];
// Elder Power items come from the vtm-v20-powers module (Foundry namespaces the subtype)
export const ELDER_TYPE = 'vtm-v20-powers.elderPower';
export const ELDER_MIN = 6;
export const GUARDED_ITEM_TYPES = ['discipline', 'path', 'ritual', 'background', 'merit', ELDER_TYPE];
export const GUARDED_ITEM_KEYS = ['name', 'system.level', 'system.rating', 'system.cost', 'system.category', 'system.ritualType', 'system.discipline'];

const lc = s => String(s ?? '').trim().toLowerCase();

export function titleCase(key) {
  return String(key)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, c => c.toUpperCase());
}

export function itemKey(type, name) { return `${type}|${lc(name)}`; }

// ---------------------------------------------------------------------------
// Discipline cost class: clan, out-of-clan, or caitiff
export function disciplineClass(state, name) {
  const ov = state.overrides?.[lc(name)];
  if (ov === 'clan' || ov === 'out') return ov;
  if (CLANLESS.includes(lc(state.clan))) return 'caitiff';
  const clanList = (state.clanDisciplines || []).map(lc);
  return clanList.includes(lc(name)) ? 'clan' : 'out';
}

export function disciplineRaiseCost(state, name, current) {
  if (current <= 0) return COST.disciplineNew();
  const cls = disciplineClass(state, name);
  if (cls === 'clan') return COST.disciplineClan(current);
  if (cls === 'caitiff') return COST.disciplineCaitiff(current);
  return COST.disciplineOut(current);
}

// Primary path per category: GM override by name, else the highest-rated path
// in that category (first by sheet order on a tie).
export function primaryPaths(state) {
  const out = {};
  const paths = (state.items || []).filter(i => i.type === 'path');
  for (const cat of Object.keys(DISC_FOR_CATEGORY)) {
    const inCat = paths.filter(p => lc(p.category || 'thaumaturgical') === cat);
    if (!inCat.length) continue;
    const ovName = state.primaryOverride?.[cat];
    const ov = ovName && inCat.find(p => lc(p.name) === lc(ovName));
    out[cat] = ov || inCat.reduce((best, p) => (p.level > best.level ? p : best), inCat[0]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Everything the character could buy right now, with cost and any block reason
export function buildOptions(state) {
  const opts = [];
  const xp = state.xp?.current ?? 0;
  const max = state.traitMax ?? 5;
  const isVampire = state.type === 'vampire';
  const f = state.fields || {};

  const push = (o) => {
    if (!o.blocked && o.cost > xp) o.blocked = `need ${o.cost}, have ${xp}`;
    opts.push(o);
  };

  // Attributes
  for (const [path, cur] of Object.entries(f)) {
    if (!path.startsWith('system.attributes.')) continue;
    const name = path.split('.').pop();
    let blocked = null;
    if (cur >= max) blocked = `max ${max}`;
    if (name === 'appearance' && state.nosferatu) blocked = 'Nosferatu: always 0';
    push({ key: path, group: 'Attributes', name: titleCase(name), from: cur, to: cur + 1,
      cost: COST.attribute(Math.max(cur, 1)), blocked, op: { kind: 'field', path } });
  }

  // Abilities
  for (const [path, cur] of Object.entries(f)) {
    if (!path.startsWith('system.abilities.')) continue;
    const name = path.split('.').pop();
    push({ key: path, group: 'Abilities', name: titleCase(name), from: cur, to: cur + 1,
      cost: cur <= 0 ? COST.abilityNew() : COST.ability(cur),
      blocked: cur >= max ? `max ${max}` : null, op: { kind: 'field', path } });
  }

  // Virtues
  for (const [path, cur] of Object.entries(f)) {
    if (!path.startsWith('system.virtues.')) continue;
    const name = path.split('.').pop();
    push({ key: path, group: 'Virtues', name: titleCase(name), from: cur, to: cur + 1,
      cost: COST.virtue(Math.max(cur, 1)), blocked: cur >= 5 ? 'max 5' : null,
      op: { kind: 'field', path } });
  }

  // Humanity / Path of Enlightenment and Willpower
  if ('system.humanity' in f) {
    const cur = f['system.humanity'];
    push({ key: 'system.humanity', group: 'Morality & Willpower', name: state.pathName || 'Humanity',
      from: cur, to: cur + 1, cost: COST.humanity(Math.max(cur, 1)),
      blocked: cur >= 10 ? 'max 10' : null, op: { kind: 'field', path: 'system.humanity' } });
  }
  if ('system.willpower.max' in f) {
    const cur = f['system.willpower.max'];
    push({ key: 'system.willpower.max', group: 'Morality & Willpower', name: 'Willpower',
      from: cur, to: cur + 1, cost: COST.willpower(Math.max(cur, 1)),
      blocked: cur >= 10 ? 'max 10' : null, op: { kind: 'field', path: 'system.willpower.max' } });
  }

  if (!isVampire) return opts;

  const items = state.items || [];
  const owned = new Set(items.map(i => itemKey(i.type === ELDER_TYPE ? 'elder' : i.type, i.name)));
  const primaries = primaryPaths(state);
  const discLevel = name => items.find(i => i.type === 'discipline' && lc(i.name) === lc(name))?.level ?? 0;

  // Disciplines already known
  const elderLib = state.catalog?.elders || [];
  const clsName = cls => (cls === 'clan' ? 'clan' : cls === 'caitiff' ? 'Caitiff' : 'out-of-clan');
  for (const d of items.filter(i => i.type === 'discipline')) {
    const cls = disciplineClass(state, d.name);
    const extras = [];
    // Raising Thaumaturgy / Necromancy carries the primary path with it
    const cat = Object.entries(DISC_FOR_CATEGORY).find(([, disc]) => disc === lc(d.name))?.[0];
    const prim = cat && primaries[cat];
    if (prim && prim.level < d.level + 1) extras.push({ itemId: prim.id, key: itemKey('path', prim.name), name: prim.name, from: prim.level, to: d.level + 1 });
    const base = { group: 'Disciplines', from: d.level, to: d.level + 1, cost: disciplineRaiseCost(state, d.name, d.level),
      auditKey: itemKey('discipline', d.name), op: { kind: 'itemLevel', itemId: d.id }, extras };
    const label = `${d.name} (${clsName(cls)})`;
    if (d.level >= max) { push({ ...base, key: itemKey('discipline', d.name), name: label, blocked: `max ${max}` }); continue; }
    if (d.level + 1 < ELDER_MIN) { push({ ...base, key: itemKey('discipline', d.name), name: label, blocked: null }); continue; }

    // Elder dot: the purchase includes choosing one power of the new level
    if (!state.elderEnabled) { push({ ...base, key: itemKey('discipline', d.name), name: label, blocked: 'Elder levels: Storyteller only' }); continue; }
    const choices = elderLib.filter(c => lc(c.discipline) === lc(d.name) && Number(c.level) === d.level + 1
      && !owned.has(itemKey('elder', c.name)));
    if (!choices.length) {
      push({ ...base, key: itemKey('discipline', d.name), name: label, blocked: `no level ${d.level + 1} ${d.name} powers in the Storyteller's list` });
      continue;
    }
    for (const c of choices) {
      push({ ...base, key: `${itemKey('discipline', d.name)}#${lc(c.name)}`, name: `${label} + ${c.name}`, blocked: null,
        alsoCreate: { uuid: c.uuid, itemType: ELDER_TYPE, key: itemKey('elder', c.name), name: c.name, to: Number(c.level) } });
    }
  }

  // Additional Elder powers at a level already reached: same cost as buying that dot again
  for (const c of elderLib) {
    if (owned.has(itemKey('elder', c.name))) continue;
    const d = items.find(i => i.type === 'discipline' && lc(i.name) === lc(c.discipline));
    const lvl = Number(c.level) || ELDER_MIN;
    if (!d || d.level < lvl) continue;
    push({ key: itemKey('elder', c.name), group: 'New Elder Powers', name: `${c.name} (${d.name} ${lvl}, ${clsName(disciplineClass(state, d.name))})`,
      from: 0, to: lvl, cost: disciplineRaiseCost(state, d.name, lvl - 1),
      blocked: state.elderEnabled ? null : 'Elder powers: Storyteller only',
      op: { kind: 'create', uuid: c.uuid, itemType: ELDER_TYPE, level: null } });
  }

  // New Disciplines
  for (const c of state.catalog?.disciplines || []) {
    if (owned.has(itemKey('discipline', c.name))) continue;
    const cls = disciplineClass(state, c.name);
    push({ key: itemKey('discipline', c.name), group: 'New Disciplines',
      name: `${c.name} (${cls === 'clan' ? 'clan' : cls === 'caitiff' ? 'Caitiff' : 'out-of-clan'})`,
      from: 0, to: 1, cost: COST.disciplineNew(), blocked: null,
      op: { kind: 'create', uuid: c.uuid, itemType: 'discipline', level: 1 } });
  }

  // Secondary paths already known (primary rises with its Discipline)
  for (const p of items.filter(i => i.type === 'path')) {
    const cat = lc(p.category || 'thaumaturgical');
    const prim = primaries[cat];
    if (prim && prim.id === p.id) continue;
    let blocked = null;
    if (p.level >= 5) blocked = 'max 5';
    else if (!prim || p.level + 1 > prim.level) blocked = `can't exceed primary path (${prim?.level ?? 0})`;
    push({ key: itemKey('path', p.name), group: 'Secondary Paths', name: p.name,
      from: p.level, to: p.level + 1, cost: p.level <= 0 ? COST.pathNew() : COST.path(p.level),
      blocked, op: { kind: 'itemLevel', itemId: p.id } });
  }

  // New secondary paths
  for (const c of state.catalog?.paths || []) {
    if (owned.has(itemKey('path', c.name))) continue;
    const cat = lc(c.category || 'thaumaturgical');
    if (!DISC_FOR_CATEGORY[cat]) continue;
    if (!discLevel(DISC_FOR_CATEGORY[cat])) continue; // no Thaumaturgy/Necromancy, don't list
    const prim = primaries[cat];
    push({ key: itemKey('path', c.name), group: 'New Secondary Paths', name: c.name,
      from: 0, to: 1, cost: COST.pathNew(),
      blocked: prim ? null : 'GM must add your primary path first',
      op: { kind: 'create', uuid: c.uuid, itemType: 'path', level: 1 } });
  }

  return opts;
}

// ---------------------------------------------------------------------------
// Guard helpers

export function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}

export function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

// Changes may be nested ({system:{attributes:{strength:3}}}) or dotted
// ({'system.attributes.strength':3}) or a mix. Remove one flat key either way.
export function deletePath(obj, path) {
  if (path in obj) { delete obj[path]; return; }
  const parts = path.split('.');
  for (let i = parts.length - 1; i > 0; i--) {
    const head = parts.slice(0, i).join('.');
    const tail = parts.slice(i).join('.');
    if (head in obj && obj[head] && typeof obj[head] === 'object') {
      deletePath(obj[head], tail);
      if (!Object.keys(obj[head]).length) delete obj[head];
      return;
    }
  }
  const [first, ...rest] = parts;
  if (obj[first] && typeof obj[first] === 'object' && rest.length) {
    deletePath(obj[first], rest.join('.'));
    if (!Object.keys(obj[first]).length) delete obj[first];
  }
}

export function isGuardedActorKey(key) {
  return GUARDED_ACTOR_KEYS.includes(key) || GUARDED_ACTOR_PREFIXES.some(p => key.startsWith(p));
}

// Strip any guarded key whose value differs from the stored source. Unchanged
// values pass, because the sheet resubmits the whole form on every change.
// Returns the list of stripped keys; mutates `changes`.
export function stripGuarded(changes, source, isGuarded) {
  const stripped = [];
  for (const [key, val] of Object.entries(flatten(changes))) {
    if (!isGuarded(key)) continue;
    if (getPath(source, key) === val) continue;
    deletePath(changes, key);
    stripped.push(key);
  }
  return stripped;
}

// ---------------------------------------------------------------------------
// Baseline and audit

// snapshot: { xp:{current,total}, traits:{ key: value } }
export function expectedFromLedger(baseline, log) {
  const traits = { ...baseline.traits };
  let current = baseline.xp.current;
  let total = baseline.xp.total;
  for (const e of log || []) {
    if (e.undone || e.ts < baseline.ts) continue;
    if (e.kind === 'award') { current += e.amount; total += e.amount; }
    if (e.kind === 'spend') {
      current -= e.cost;
      traits[e.key] = e.to;
      for (const x of e.extras || []) if (x.key) traits[x.key] = x.to;
      if (e.alsoCreated?.key) traits[e.alsoCreated.key] = e.alsoCreated.to;
    }
  }
  return { xp: { current, total }, traits };
}

export function audit(baseline, log, now) {
  const exp = expectedFromLedger(baseline, log);
  const drift = [];
  const keys = new Set([...Object.keys(exp.traits), ...Object.keys(now.traits)]);
  for (const k of keys) {
    const want = exp.traits[k] ?? 0;
    const have = now.traits[k] ?? 0;
    if (want !== have) drift.push({ key: k, expected: want, actual: have });
  }
  if (exp.xp.current !== now.xp.current) drift.push({ key: 'XP unspent', expected: exp.xp.current, actual: now.xp.current });
  if (exp.xp.total !== now.xp.total) drift.push({ key: 'XP total', expected: exp.xp.total, actual: now.xp.total });
  return { expected: exp, drift };
}

export function describeKey(key) {
  if (key.includes('|')) {
    const [type, name] = key.split('|');
    return `${titleCase(type)}: ${name.replace(/\b\w/g, c => c.toUpperCase())}`;
  }
  if (key.startsWith('system.')) return titleCase(key.split('.').filter(p => p !== 'max').pop());
  return key;
}
