import {
  MODULE_ID, buildOptions, stripGuarded, isGuardedActorKey, GUARDED_ITEM_TYPES,
  GUARDED_ITEM_KEYS, itemKey, audit, describeKey, primaryPaths, disciplineClass,
  DISC_FOR_CATEGORY, flatten, ELDER_TYPE,
} from './logic.mjs';

const SYSTEM_ID = 'vtm-v20';
const ACTOR_TYPES = ['vampire', 'mortal'];
const OPT = 'vtmXp'; // update-option marker: "this write came from the XP module"

// ---------------------------------------------------------------------------
// Small helpers

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const lc = s => String(s ?? '').trim().toLowerCase();
const flag = (doc, key) => doc.getFlag(MODULE_ID, key);
const getLog = actor => foundry.utils.deepClone(flag(actor, 'log') ?? []);
const isLocked = actor => actor.getFlag(SYSTEM_ID, 'sheetLocked') !== false;
const isFinalized = actor => isLocked(actor) && !!flag(actor, 'baseline');
const xpOf = actor => ({
  current: actor._source.system?.experience?.current ?? 0,
  total: actor._source.system?.experience?.total ?? 0,
});
const DialogV2 = () => foundry.applications.api.DialogV2;

function relevant(actor) {
  return game.system.id === SYSTEM_ID && actor && ACTOR_TYPES.includes(actor.type);
}

// ---------------------------------------------------------------------------
// Actor -> plain state for the rules logic

function clanDisciplines(clan) {
  const item = game.items.find(i => i.type === 'clan' && lc(i.name) === lc(clan));
  if (item?.system?.disciplines?.length) return item.system.disciplines;
  return CONFIG.VTM?.clanDisciplines?.[clan] ?? [];
}

function actorFields(actor) {
  const src = actor._source.system;
  const fields = {};
  for (const group of ['attributes', 'abilities', 'virtues']) {
    for (const [k, v] of Object.entries(src[group] ?? {})) fields[`system.${group}.${k}`] = Number(v) || 0;
  }
  if ('humanity' in src) fields['system.humanity'] = Number(src.humanity) || 0;
  if (src.willpower) fields['system.willpower.max'] = Number(src.willpower.max) || 0;
  return fields;
}

function actorItems(actor) {
  return actor.items
    .filter(i => ['discipline', 'path', 'ritual', ELDER_TYPE].includes(i.type))
    .map(i => ({ id: i.id, type: i.type, name: i.name, level: Number(i.system.level) || 0,
      category: i.system.category, ritualType: i.system.ritualType, discipline: i.system.discipline }));
}

function stateFor(actor, catalog) {
  const src = actor._source.system;
  const gen = CONFIG.VTM?.generationTable?.[src.generation];
  return {
    type: actor.type,
    clan: src.clan,
    traitMax: actor.type === 'vampire' ? (gen?.traitMax ?? 5) : 5,
    nosferatu: lc(src.clan) === 'nosferatu',
    xp: xpOf(actor),
    pathName: src.pathName,
    fields: actorFields(actor),
    items: actorItems(actor),
    clanDisciplines: actor.type === 'vampire' ? clanDisciplines(src.clan) : [],
    overrides: flag(actor, 'overrides') ?? {},
    primaryOverride: flag(actor, 'primaryOverride') ?? {},
    catalog: catalog ?? { disciplines: [], paths: [], elders: [] },
    elderEnabled: game.settings.get(MODULE_ID, 'elderPurchases'),
  };
}

// Everything the audit compares: permanent fields plus Disciplines, Paths, Backgrounds,
// Merits. Rituals are left out: they're learned in play from a teacher or tome, not XP.
function currentTraits(actor) {
  const traits = { ...actorFields(actor) };
  for (const i of actor.items) {
    if (['discipline', 'path'].includes(i.type)) traits[itemKey(i.type, i.name)] = Number(i.system.level) || 0;
    else if (i.type === ELDER_TYPE) traits[itemKey('elder', i.name)] = Number(i.system.level) || 0;
    else if (i.type === 'background') traits[itemKey(i.type, i.name)] = Number(i.system.rating) || 0;
    else if (i.type === 'merit') traits[itemKey(i.type, i.name)] = Number(i.system.cost) || 0;
  }
  return traits;
}

// World items first (Daimoinon, house content), then the system compendiums
async function buildCatalog() {
  const cat = { disciplines: [], paths: [], elders: [] };
  const seen = new Set();
  const add = (type, e) => {
    const k = itemKey(type, e.name);
    if (seen.has(k)) return;
    seen.add(k);
    cat[`${type}s`].push(e);
  };
  for (const i of game.items) {
    if (!['discipline', 'path'].includes(i.type)) continue;
    add(i.type, { name: i.name, uuid: i.uuid, level: i.system.level, category: i.system.category, ritualType: i.system.ritualType });
  }
  for (const [packName, type] of [['disciplines', 'discipline'], ['paths', 'path']]) {
    const pack = game.packs.get(`${SYSTEM_ID}.${packName}`);
    if (!pack) continue;
    const index = await pack.getIndex({ fields: ['system.level', 'system.category', 'system.ritualType'] });
    for (const e of index) {
      if (e.type !== type) continue;
      add(type, { name: e.name, uuid: e.uuid, level: e.system?.level, category: e.system?.category, ritualType: e.system?.ritualType });
    }
  }
  // The Storyteller's Elder Power library: world items of the powers module's type
  for (const i of game.items) {
    if (i.type !== ELDER_TYPE) continue;
    cat.elders.push({ name: i.name, uuid: i.uuid, level: Number(i.system.level) || 6, discipline: i.system.discipline });
  }
  for (const list of Object.values(cat)) list.sort((a, b) => a.name.localeCompare(b.name));
  return cat;
}

// ---------------------------------------------------------------------------
// Chat cards

async function postCard(actor, html) {
  const mode = game.settings.get(MODULE_ID, 'chatMode');
  if (mode === 'off') return;
  const data = { content: `<div class="vxp-card">${html}</div>`, speaker: ChatMessage.getSpeaker({ actor }) };
  if (mode === 'gm') {
    const ids = new Set(ChatMessage.getWhisperRecipients('GM').map(u => u.id));
    ids.add(game.user.id);
    data.whisper = [...ids];
  }
  await ChatMessage.create(data);
}

function entryBase(kind) {
  return { id: foundry.utils.randomID(), ts: Date.now(), kind, userId: game.user.id, userName: game.user.name };
}

// ---------------------------------------------------------------------------
// Award (GM)

async function award(actors, amount, reason = '') {
  if (!game.user.isGM) return ui.notifications.warn('Only the Storyteller can award XP.');
  amount = Math.trunc(Number(amount));
  if (!amount) return ui.notifications.warn('Enter a non-zero amount.');
  const done = [];
  for (const actor of actors) {
    if (!relevant(actor)) continue;
    const xp = xpOf(actor);
    if (xp.current + amount < 0 || xp.total + amount < 0) {
      ui.notifications.warn(`${actor.name}: that would take XP below zero. Skipped.`);
      continue;
    }
    const entry = { ...entryBase('award'), amount, reason };
    await actor.update({
      'system.experience.current': xp.current + amount,
      'system.experience.total': xp.total + amount,
      [`flags.${MODULE_ID}.log`]: [...getLog(actor), entry],
    }, { [OPT]: true });
    done.push(actor);
  }
  if (!done.length) return;
  const verb = amount > 0 ? `awarded <b>${amount} XP</b>` : `adjusted XP by <b>${amount}</b>`;
  for (const a of done) {
    await postCard(a, `<h3>Experience</h3><p><b>${esc(a.name)}</b> ${verb}${reason ? ` for <i>${esc(reason)}</i>` : ''}.</p>
      <p class="vxp-sub">Unspent ${xpOf(a).current} · Total ${xpOf(a).total}</p>`);
  }
  ui.notifications.info(`XP ${amount > 0 ? 'awarded to' : 'adjusted for'} ${done.map(a => a.name).join(', ')}.`);
}

// ---------------------------------------------------------------------------
// Spend (owner)

async function spend(actor, key, note = '') {
  if (!actor.isOwner) return ui.notifications.warn('You do not own this character.');
  const catalog = await buildCatalog();
  const opt = buildOptions(stateFor(actor, catalog)).find(o => o.key === key);
  if (!opt) return ui.notifications.warn('That purchase is no longer available. The sheet may have changed; try again.');
  if (opt.blocked) return ui.notifications.warn(`${opt.name}: ${opt.blocked}`);

  const xp = xpOf(actor);
  const entry = {
    ...entryBase('spend'), key: opt.auditKey ?? opt.key, label: opt.name, from: opt.from, to: opt.to, cost: opt.cost, note,
    op: { kind: opt.op.kind, path: opt.op.path ?? null, itemId: opt.op.itemId ?? null, created: false },
    extras: [],
  };

  // Item changes first, so a failure never costs XP
  if (opt.op.kind === 'create') {
    const source = await fromUuid(opt.op.uuid);
    if (!source) return ui.notifications.error(`Could not load ${opt.name} from its compendium or world item.`);
    const data = source.toObject();
    for (const k of ['_id', 'folder', 'sort', 'ownership', '_stats']) delete data[k];
    if (opt.op.level != null) data.system.level = opt.op.level;
    const [doc] = await actor.createEmbeddedDocuments('Item', [data], { [OPT]: true });
    entry.op.itemId = doc.id;
    entry.op.created = true;
  } else if (opt.op.kind === 'itemLevel') {
    await actor.items.get(opt.op.itemId)?.update({ 'system.level': opt.to }, { [OPT]: true });
  }
  for (const x of opt.extras ?? []) {
    await actor.items.get(x.itemId)?.update({ 'system.level': x.to }, { [OPT]: true });
    entry.extras.push({ itemId: x.itemId, key: x.key, name: x.name, from: x.from, to: x.to });
  }
  // Elder dot: the chosen power comes with it
  if (opt.alsoCreate) {
    const src = await fromUuid(opt.alsoCreate.uuid);
    if (src) {
      const data = src.toObject();
      for (const k of ['_id', 'folder', 'sort', 'ownership', '_stats']) delete data[k];
      const [doc] = await actor.createEmbeddedDocuments('Item', [data], { [OPT]: true });
      entry.alsoCreated = { itemId: doc.id, key: opt.alsoCreate.key, name: opt.alsoCreate.name, to: opt.alsoCreate.to };
    } else {
      ui.notifications.warn(`${opt.alsoCreate.name} could not be loaded; the Storyteller will need to add it.`);
    }
  }

  const update = {
    'system.experience.current': xp.current - opt.cost,
    [`flags.${MODULE_ID}.log`]: [...getLog(actor), entry],
  };
  if (opt.op.kind === 'field') update[opt.op.path] = opt.to;
  await actor.update(update, { [OPT]: true });

  let extra = entry.extras.map(x => `<br>${esc(x.name)} ${x.from} → ${x.to} (primary path)`).join('');
  if (entry.alsoCreated) extra += `<br>Learned Elder power: <b>${esc(entry.alsoCreated.name)}</b>`;
  // First dot of blood magic: the ST supplies the primary path, and Thaumaturgy brings a free Level One ritual
  if (opt.from === 0 && opt.key === itemKey('discipline', 'thaumaturgy')) {
    extra += '<br><b>Storyteller:</b> add the primary path and one Level One ritual (free).';
  } else if (opt.from === 0 && opt.key === itemKey('discipline', 'necromancy')) {
    extra += '<br><b>Storyteller:</b> add the primary path.';
  }
  await postCard(actor, `<h3>Experience Spent</h3><p><b>${esc(actor.name)}</b>: ${esc(opt.name)} ${opt.from} → ${opt.to}
    for <b>${opt.cost} XP</b>${extra}</p>${note ? `<p><i>${esc(note)}</i></p>` : ''}
    <p class="vxp-sub">Unspent ${xp.current - opt.cost} · Total ${xp.total}</p>`);
}

// ---------------------------------------------------------------------------
// Undo (GM): reverses the most recent live entry

async function undoLast(actor) {
  if (!game.user.isGM) return;
  const log = getLog(actor);
  const idx = log.findLastIndex(e => !e.undone && (e.kind === 'award' || e.kind === 'spend'));
  if (idx < 0) return ui.notifications.info('Nothing to undo.');
  const e = log[idx];
  const xp = xpOf(actor);
  const update = {};
  if (e.kind === 'award') {
    update['system.experience.current'] = Math.max(0, xp.current - e.amount);
    update['system.experience.total'] = Math.max(0, xp.total - e.amount);
  } else {
    update['system.experience.current'] = xp.current + e.cost;
    if (e.op.created) {
      if (actor.items.get(e.op.itemId)) await actor.deleteEmbeddedDocuments('Item', [e.op.itemId], { [OPT]: true });
    } else if (e.op.kind === 'itemLevel') {
      await actor.items.get(e.op.itemId)?.update({ 'system.level': e.from }, { [OPT]: true });
    } else if (e.op.kind === 'field') {
      update[e.op.path] = e.from;
    }
    for (const x of e.extras ?? []) await actor.items.get(x.itemId)?.update({ 'system.level': x.from }, { [OPT]: true });
    if (e.alsoCreated?.itemId && actor.items.get(e.alsoCreated.itemId)) {
      await actor.deleteEmbeddedDocuments('Item', [e.alsoCreated.itemId], { [OPT]: true });
    }
  }
  log[idx] = { ...e, undone: true, undoneBy: game.user.name, undoneAt: Date.now() };
  update[`flags.${MODULE_ID}.log`] = log;
  await actor.update(update, { [OPT]: true });
  const what = e.kind === 'award' ? `award of ${e.amount} XP` : `${e.label} ${e.from} → ${e.to} (${e.cost} XP refunded)`;
  await postCard(actor, `<h3>Experience Undone</h3><p><b>${esc(actor.name)}</b>: Storyteller reversed ${esc(what)}.</p>`);
}

// ---------------------------------------------------------------------------
// Baseline (GM)

async function setBaseline(actor) {
  if (!game.user.isGM) return;
  // Pairs, not an object: Foundry expands dotted keys inside stored objects
  const baseline = { ts: Date.now(), xp: xpOf(actor), traitPairs: Object.entries(currentTraits(actor)) };
  const update = { [`flags.${MODULE_ID}.baseline`]: baseline };
  if (!isLocked(actor)) update[`flags.${SYSTEM_ID}.sheetLocked`] = true;
  await actor.update(update, { [OPT]: true });
  ui.notifications.info(`${actor.name}: XP tracking baseline set.`);
}

function runAudit(actor) {
  const stored = flag(actor, 'baseline');
  if (!stored) return null;
  const baseline = { ts: stored.ts, xp: stored.xp, traits: Object.fromEntries(stored.traitPairs ?? []) };
  return audit(baseline, getLog(actor), { xp: xpOf(actor), traits: currentTraits(actor) });
}

// ---------------------------------------------------------------------------
// Dialogs

async function openAward(preselect = []) {
  if (!game.user.isGM) return;
  const pcs = game.actors.filter(a => relevant(a) && (a.hasPlayerOwner || preselect.includes(a.id)));
  if (!pcs.length) return ui.notifications.warn('No player-owned vampire or mortal characters found.');
  const checked = a => (preselect.length ? preselect.includes(a.id) : true) ? 'checked' : '';
  const content = `<div class="vxp-form">
    <label>Amount <input type="number" name="amount" value="1" step="1" autofocus></label>
    <label>Reason <input type="text" name="reason" placeholder="e.g. Session 4, learning, roleplay"></label>
    <fieldset><legend>Characters</legend>
      ${pcs.map(a => `<label class="vxp-check"><input type="checkbox" name="actor" value="${a.id}" ${checked(a)}>
        ${esc(a.name)} <span class="vxp-sub">(${xpOf(a).current} unspent)</span></label>`).join('')}
    </fieldset>
    <p class="vxp-sub">Negative amounts correct a mistake and reduce both Unspent and Total.</p></div>`;
  const res = await DialogV2().wait({
    window: { title: 'Award Experience' }, content, rejectClose: false,
    buttons: [
      { action: 'award', label: 'Award', icon: 'fas fa-star', default: true,
        callback: (ev, btn) => ({
          amount: btn.form.elements.amount.value,
          reason: btn.form.elements.reason.value.trim(),
          ids: [...btn.form.querySelectorAll('input[name="actor"]:checked')].map(i => i.value),
        }) },
      { action: 'cancel', label: 'Cancel' },
    ],
  });
  if (!res || typeof res !== 'object') return;
  await award(res.ids.map(id => game.actors.get(id)).filter(Boolean), res.amount, res.reason);
}

async function openSpend(actor) {
  if (!actor?.isOwner) return;
  const catalog = await buildCatalog();
  const opts = buildOptions(stateFor(actor, catalog));
  const groups = {};
  for (const o of opts) (groups[o.group] ??= []).push(o);
  const xp = xpOf(actor);
  const optionHtml = o => `<option value="${esc(o.key)}" ${o.blocked ? 'disabled' : ''}>${esc(o.name)}  ${o.from} → ${o.to}  ·  ${o.cost} XP${o.blocked ? `  (${esc(o.blocked)})` : ''}</option>`;
  const content = `<div class="vxp-form">
    <p class="vxp-xp">Unspent: <b>${xp.current} XP</b> <span class="vxp-sub">of ${xp.total} earned</span></p>
    <label>Raise <select name="key" autofocus><option value="">Choose a trait…</option>
      ${Object.entries(groups).map(([g, list]) => `<optgroup label="${esc(g)}">${list.map(optionHtml).join('')}</optgroup>`).join('')}
    </select></label>
    <label>Note <input type="text" name="note" placeholder="Optional: training, mentor, in-story reason"></label>
    <p class="vxp-sub">One dot at a time. Greyed options show why they're unavailable.</p></div>`;
  const res = await DialogV2().wait({
    window: { title: `Spend Experience: ${actor.name}` }, content, rejectClose: false,
    position: { width: 520 },
    buttons: [
      { action: 'spend', label: 'Spend', icon: 'fas fa-check', default: true,
        callback: (ev, btn) => ({ key: btn.form.elements.key.value, note: btn.form.elements.note.value.trim() }) },
      { action: 'cancel', label: 'Cancel' },
    ],
  });
  if (!res || typeof res !== 'object' || !res.key) return;
  await spend(actor, res.key, res.note);
}

function fmtDate(ts) { return new Date(ts).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }); }

function ledgerRow(e) {
  let what, delta;
  if (e.kind === 'award') { what = `Award${e.reason ? `: ${esc(e.reason)}` : ''}`; delta = `${e.amount > 0 ? '+' : ''}${e.amount}`; }
  else {
    const extras = (e.extras ?? []).map(x => `; ${esc(x.name)} ${x.from}→${x.to}`).join('');
    what = `${esc(e.label)} ${e.from}→${e.to}${extras}${e.note ? ` <i>(${esc(e.note)})</i>` : ''}`;
    delta = `−${e.cost}`;
  }
  return `<tr class="${e.undone ? 'vxp-undone' : ''}"><td>${fmtDate(e.ts)}</td><td>${esc(e.userName)}</td><td>${what}${e.undone ? ` <span class="vxp-sub">(undone by ${esc(e.undoneBy)})</span>` : ''}</td><td class="vxp-num">${delta}</td></tr>`;
}

function gmControls(actor) {
  if (!game.user.isGM || actor.type !== 'vampire') return '';
  const state = stateFor(actor);
  const discs = state.items.filter(i => i.type === 'discipline');
  const ov = state.overrides;
  const discRows = discs.map(d => {
    const auto = disciplineClass({ ...state, overrides: {} }, d.name);
    const cur = ov[lc(d.name)] ?? '';
    return `<label class="vxp-row">${esc(d.name)}
      <select name="ov-${esc(lc(d.name))}">
        <option value="" ${cur === '' ? 'selected' : ''}>Auto (${auto === 'clan' ? 'clan' : auto === 'caitiff' ? 'Caitiff' : 'out-of-clan'})</option>
        <option value="clan" ${cur === 'clan' ? 'selected' : ''}>Clan cost</option>
        <option value="out" ${cur === 'out' ? 'selected' : ''}>Out-of-clan cost</option>
      </select></label>`;
  }).join('');
  const prim = primaryPaths(state);
  const pathRows = Object.keys(DISC_FOR_CATEGORY).map(cat => {
    const inCat = state.items.filter(i => i.type === 'path' && lc(i.category || 'thaumaturgical') === cat);
    if (!inCat.length) return '';
    return `<label class="vxp-row">Primary ${cat} path
      <select name="prim-${cat}">${inCat.map(p => `<option value="${esc(p.name)}" ${prim[cat]?.id === p.id ? 'selected' : ''}>${esc(p.name)} (${p.level})</option>`).join('')}</select></label>`;
  }).join('');
  if (!discRows && !pathRows) return '';
  return `<details class="vxp-gm"><summary>Storyteller: cost overrides</summary>
    <p class="vxp-sub">Use for the Additional Discipline merit, bloodline quirks, or a primary path the auto-pick got wrong.</p>
    ${discRows}${pathRows}</details>`;
}

async function openLedger(actor) {
  if (!actor?.isOwner && !game.user.isGM) return;
  for (;;) {
    const xp = xpOf(actor);
    const baseline = flag(actor, 'baseline');
    const log = getLog(actor);
    const result = runAudit(actor);
    let status;
    if (!baseline) status = `<p class="vxp-warn">Not finalized. The Storyteller locks the sheet or clicks <b>Finalize</b> after character creation to start tracking.</p>`;
    else if (!result.drift.length) status = `<p class="vxp-ok">Finalized ${fmtDate(baseline.ts)}. Audit clean: every change since then is in the ledger.</p>`;
    else status = `<p class="vxp-warn">Finalized ${fmtDate(baseline.ts)}. Audit found ${result.drift.length} unrecorded change(s):</p>
      <table class="vxp-table"><tr><th>Trait</th><th>Ledger says</th><th>Sheet has</th></tr>
      ${result.drift.map(d => `<tr><td>${esc(describeKey(d.key))}</td><td class="vxp-num">${d.expected}</td><td class="vxp-num">${d.actual}</td></tr>`).join('')}</table>
      ${game.user.isGM ? '<p class="vxp-sub">If these were your own edits, click <b>Rebaseline</b> to accept them.</p>' : ''}`;
    const rows = log.slice().reverse().slice(0, 60).map(ledgerRow).join('');
    const content = `<div class="vxp-form vxp-ledger">
      <p class="vxp-xp">Unspent <b>${xp.current}</b> · Total <b>${xp.total}</b></p>
      ${status}
      <table class="vxp-table"><tr><th>When</th><th>By</th><th>Entry</th><th>XP</th></tr>${rows || '<tr><td colspan="4">No entries yet.</td></tr>'}</table>
      ${gmControls(actor)}</div>`;
    const buttons = [];
    if (game.user.isGM) {
      buttons.push({ action: 'undo', label: 'Undo last', icon: 'fas fa-rotate-left' });
      buttons.push({ action: 'baseline', label: baseline ? 'Rebaseline' : 'Finalize', icon: 'fas fa-lock' });
      buttons.push({ action: 'save', label: 'Save overrides', icon: 'fas fa-floppy-disk',
        callback: (ev, btn) => {
          const els = [...btn.form.querySelectorAll('select')];
          const overrides = {}, primaryOverride = {};
          for (const s of els) {
            if (s.name.startsWith('ov-') && s.value) overrides[s.name.slice(3)] = s.value;
            if (s.name.startsWith('prim-')) primaryOverride[s.name.slice(5)] = s.value;
          }
          return { action: 'save', overrides, primaryOverride };
        } });
    }
    buttons.push({ action: 'close', label: 'Close', default: true });
    const res = await DialogV2().wait({ window: { title: `XP Ledger: ${actor.name}` }, content, rejectClose: false,
      position: { width: 640 }, buttons });
    const action = typeof res === 'object' && res ? res.action : res;
    if (!action || action === 'close') return;
    if (action === 'undo') {
      const ok = await DialogV2().confirm({ window: { title: 'Undo last XP entry?' },
        content: '<p>This reverses the most recent award or purchase and refunds or removes the XP.</p>', rejectClose: false });
      if (ok) await undoLast(actor);
    } else if (action === 'baseline') {
      const ok = baseline ? await DialogV2().confirm({ window: { title: 'Rebaseline?' },
        content: '<p>Accept the sheet as it stands now. Earlier ledger entries stay visible but are no longer audited.</p>', rejectClose: false }) : true;
      if (ok) await setBaseline(actor);
    } else if (action === 'save') {
      await actor.update({
        [`flags.${MODULE_ID}.-=overrides`]: null,
        [`flags.${MODULE_ID}.-=primaryOverride`]: null,
      }, { [OPT]: true });
      await actor.update({
        [`flags.${MODULE_ID}.overrides`]: res.overrides,
        [`flags.${MODULE_ID}.primaryOverride`]: res.primaryOverride,
      }, { [OPT]: true });
      ui.notifications.info('Overrides saved.');
    }
  }
}

// ---------------------------------------------------------------------------
// Sheet integration

function onRenderSheet(app, element) {
  const actor = app.document;
  if (!relevant(actor)) return;
  const root = element instanceof HTMLElement ? element : element?.[0];
  const fields = root?.querySelector('.exp-fields');
  if (!fields) return;

  if (!game.user.isGM) {
    for (const input of fields.querySelectorAll('input')) {
      input.readOnly = true;
      input.classList.add('vxp-readonly');
      input.title = 'Use Spend XP. The Storyteller awards experience.';
    }
  }

  const block = fields.parentElement;
  block.querySelector('.vxp-bar')?.remove();
  const bar = document.createElement('div');
  bar.className = 'vxp-bar';
  const btn = (action, icon, label) => `<button type="button" data-vxp="${action}"><i class="fas ${icon}"></i> ${label}</button>`;
  bar.innerHTML = [
    actor.isOwner ? btn('spend', 'fa-arrow-up', 'Spend') : '',
    game.user.isGM ? btn('award', 'fa-star', 'Award') : '',
    btn('ledger', 'fa-book', 'Ledger'),
  ].join('') + (flag(actor, 'baseline') ? '' : (game.user.isGM ? '<span class="vxp-sub vxp-hint">Not finalized</span>' : ''));
  bar.addEventListener('click', ev => {
    const b = ev.target.closest('button[data-vxp]');
    if (!b) return;
    ev.preventDefault();
    ev.stopPropagation();
    if (b.dataset.vxp === 'spend') openSpend(actor);
    if (b.dataset.vxp === 'award') openAward([actor.id]);
    if (b.dataset.vxp === 'ledger') openLedger(actor);
  });
  fields.after(bar);
}

function onRenderDirectory(app, element) {
  if (!game.user.isGM || game.system.id !== SYSTEM_ID) return;
  const root = element instanceof HTMLElement ? element : element?.[0];
  const header = root?.querySelector('.header-actions');
  if (!header || header.querySelector('.vxp-award-all')) return;
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'vxp-award-all';
  b.innerHTML = '<i class="fas fa-star"></i> Award XP';
  b.addEventListener('click', ev => { ev.preventDefault(); openAward(); });
  header.append(b);
}

// When the GM locks a sheet: first lock sets the baseline; later locks offer to refresh it
async function onUpdateActor(actor, changes, options, userId) {
  if (userId !== game.user.id || !game.user.isGM || !relevant(actor) || options?.[OPT]) return;
  if (flatten(changes)[`flags.${SYSTEM_ID}.sheetLocked`] !== true) return;
  if (!flag(actor, 'baseline')) return setBaseline(actor);
  const drift = runAudit(actor)?.drift ?? [];
  if (!drift.length) return;
  const ok = await DialogV2().confirm({ window: { title: `${actor.name}: update XP baseline?` },
    content: `<p>The sheet changed in ${drift.length} place(s) while unlocked. Accept those changes as the new baseline?</p>`, rejectClose: false });
  if (ok) await setBaseline(actor);
}

// ---------------------------------------------------------------------------
// Guards (player clients only; see README for the limits)

const PROTECTED_FLAG_KEYS = [
  `flags.${MODULE_ID}.baseline`, `flags.${MODULE_ID}.overrides`, `flags.${MODULE_ID}.primaryOverride`,
  `flags.${SYSTEM_ID}.sheetLocked`,
];
const isLogKey = k => k.startsWith(`flags.${MODULE_ID}.log`);

function warnOnce(msg) {
  const now = Date.now();
  if (warnOnce.last === msg && now - warnOnce.at < 1500) return;
  warnOnce.last = msg; warnOnce.at = now;
  ui.notifications.warn(msg);
}

function onlyIdLeft(changes) { return Object.keys(changes).every(k => k === '_id'); }

function preUpdateActor(actor, changes, options) {
  if (game.user.isGM || !relevant(actor)) return;
  // Bookkeeping flags: never writable by players; the log only via the module
  const flagGuard = k => PROTECTED_FLAG_KEYS.some(p => k === p || k.startsWith(`${p}.`)) || (!options?.[OPT] && isLogKey(k));
  const strippedFlags = stripGuarded(changes, actor._source, flagGuard);
  let stripped = [];
  if (!options?.[OPT] && isFinalized(actor)) stripped = stripGuarded(changes, actor._source, isGuardedActorKey);
  if (!stripped.length && !strippedFlags.length) return;
  if (stripped.length) warnOnce('This sheet is locked. Raise traits with Spend XP, or ask your Storyteller.');
  if (onlyIdLeft(changes)) { actor.sheet?.render(); return false; }
}

function guardedItem(item, options) {
  if (game.user.isGM || options?.[OPT]) return false;
  const actor = item.parent;
  return actor?.documentName === 'Actor' && relevant(actor) && isFinalized(actor) && GUARDED_ITEM_TYPES.includes(item.type);
}

function preUpdateItem(item, changes, options) {
  if (!guardedItem(item, options)) return;
  const stripped = stripGuarded(changes, item._source, k => GUARDED_ITEM_KEYS.includes(k));
  if (!stripped.length) return;
  warnOnce('This sheet is locked. Raise traits with Spend XP, or ask your Storyteller.');
  if (onlyIdLeft(changes)) { item.parent.sheet?.render(); return false; }
}

function preCreateItem(item, data, options) {
  if (!guardedItem(item, options)) return;
  warnOnce(`Can't add ${item.type}s to a locked sheet. Use Spend XP, or ask your Storyteller.`);
  return false;
}

function preDeleteItem(item, options) {
  if (!guardedItem(item, options)) return;
  warnOnce(`Can't remove ${item.type}s from a locked sheet. Ask your Storyteller.`);
  return false;
}

// ---------------------------------------------------------------------------
// Registration

Hooks.once('init', () => {
  game.settings.register(MODULE_ID, 'elderPurchases', {
    name: 'Players can buy Elder Discipline levels',
    hint: 'Discipline dots 6+ and extra Elder powers (requires the VtM V20 Powers module). Off: only the Storyteller adds them.',
    scope: 'world', config: true, type: Boolean, default: false,
  });
  game.settings.register(MODULE_ID, 'chatMode', {
    name: 'XP chat cards',
    hint: 'Who sees the chat card for each award, purchase, and undo.',
    scope: 'world', config: true, type: String, default: 'public',
    choices: { public: 'Everyone', gm: 'Storyteller and the acting player', off: 'No chat cards' },
  });

  Hooks.on('preUpdateActor', preUpdateActor);
  Hooks.on('preUpdateItem', preUpdateItem);
  Hooks.on('preCreateItem', preCreateItem);
  Hooks.on('preDeleteItem', preDeleteItem);
  Hooks.on('updateActor', onUpdateActor);
  Hooks.on('renderActorSheetV2', onRenderSheet);
  Hooks.on('renderActorDirectory', onRenderDirectory);

  const mod = game.modules.get(MODULE_ID);
  mod.api = { award, spend, undoLast, setBaseline, openAward, openSpend, openLedger, audit: runAudit, buildCatalog };
});

Hooks.once('ready', () => {
  if (game.system.id !== SYSTEM_ID) {
    ui.notifications.warn('VtM V20 XP Tracker only works with the Vampire: The Masquerade V20 system.');
  }
});
