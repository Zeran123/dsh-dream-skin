/** Behavioural coverage for system-following skins. Only this file extends the shared VM. */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { buildSandbox, makeApplyContext, makeRequire, CODE, releaseAllIntervals } = require('./fixtures/page-sandbox.cjs');
const { waitFor } = require('./fixtures/converge.cjs');
const QUERY = '(prefers-color-scheme: dark)';
const KEY = { mode: 'dsh-dream-skin:skin-mode', light: 'dsh-dream-skin:skin-light', dark: 'dsh-dream-skin:skin-dark', manual: 'dsh-dream-skin:skin' };
const AUTO = { [KEY.mode]: 'system', [KEY.light]: 'mist', [KEY.dark]: 'midnight', [KEY.manual]: 'rose' };
after(releaseAllIntervals);
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
function recordingMql(matches, api) {
  const listeners = new Set();
  const mql = { matches, media: QUERY, listeners, set(value) {
    this.matches = value;
    for (const handler of Array.from(listeners)) handler({ matches: value, media: QUERY });
  } };
  if (api === 'modern') {
    mql.addEventListener = (type, fn) => { if (type === 'change') listeners.add(fn); };
    mql.removeEventListener = (type, fn) => { if (type === 'change') listeners.delete(fn); };
  } else if (api === 'legacy') {
    mql.addListener = (fn) => listeners.add(fn);
    mql.removeListener = (fn) => listeners.delete(fn);
  }
  return mql;
}
function nodes(tree, out = []) {
  if (Array.isArray(tree)) for (const child of tree) nodes(child, out);
  else if (tree && typeof tree === 'object') { out.push(tree); nodes(tree.props && tree.props.children, out); }
  return out;
}
function boot({ seed = AUTO, dark = false, api = 'modern', code = CODE, hash = '', fetchImpl = null, firstBoot = false } = {}) {
  const h = buildSandbox({ seed, code });
  if (firstBoot) h.localStorage.removeItem('dsh-dream-skin:factory-applied');
  h.window.location.hash = hash;
  // evaluate() also lets this test install missing browser globals in the VM;
  // production source stays untouched and every API still runs through apply().
  h.evaluate('FileReader = class { readAsText(file) { this.result = file.content; this.onload(); } };');
  if (fetchImpl) {
    h.window.__systemSkinFetch = fetchImpl;
    h.evaluate('fetch = (...args) => window.__systemSkinFetch(...args);');
  }
  const mql = recordingMql(dark, api);
  h.window.matchMedia = api === 'absent' ? undefined : (query) => {
    if (api === 'throw') throw new Error('media unavailable');
    return query === QUERY ? mql : { matches: false, addEventListener() {}, removeEventListener() {} };
  };
  const baseRequire = makeRequire();
  const requireMock = (name) => name === 'react/jsx-runtime'
    ? { jsx: (type, props, key) => ({ type, props, key }), jsxs: (type, props, key) => ({ type, props, key }) }
    : baseRequire(name);
  const entry = h.factory(requireMock);
  const registry = new Map(), changes = [], contexts = [], tokenLayers = [];
  let pref = 'system', revision = 0, depth = 0;
  const snapshot = () => {
    const id = pref === 'system' ? (mql.matches ? 'dark' : 'light') : pref;
    const active = registry.get(id) || { id, colorScheme: id === 'dark' ? 'dark' : 'light', tokens: {} };
    return { preference: pref, active, themes: Array.from(registry.values()), revision: ++revision };
  };
  const emit = () => {
    if (++depth > 60) throw new Error('synchronous theme/change recursion');
    try { const state = snapshot(); for (const ctx of contexts) for (const fn of (ctx.handlers.get('theme/change') || []).slice()) fn(state); }
    finally { depth--; }
  };
  const theme = {
    register(def) { registry.set(def.id, def); return () => { if (registry.get(def.id) === def) registry.delete(def.id); }; },
    getTheme: snapshot,
    setTheme(id) { pref = id; changes.push(id); emit(); },
    overrideTokens(source, overrides) {
      const layer = { source, overrides, live: true }; tokenLayers.push(layer);
      emit(); return () => { layer.live = false; };
    }
  };
  function mount(factoryEntry = entry) {
    const ctx = makeApplyContext(h);
    ctx.theme = theme; ctx.handlers = new Map(); ctx.states = {}; ctx.components = {};
    ctx.on = (name, fn) => {
      if (!ctx.handlers.has(name)) ctx.handlers.set(name, []);
      ctx.handlers.get(name).push(fn);
      return () => ctx.handlers.set(name, ctx.handlers.get(name).filter((handler) => handler !== fn));
    };
    ctx.slots.register = (desc, Component) => {
      ctx.components[desc.id] = Component;
      if (typeof desc.inject === 'function') {
        const spec = desc.store && desc.store.spec, state = spec ? spec.init() : {};
        ctx.states[desc.id] = state;
        const bag = spec && spec.actions.sync ? { sync: (...args) => spec.actions.sync(state, ...args) } : {};
        const actions = desc.inject(bag);
        if (actions && typeof actions === 'object') (ctx.actionBags || (ctx.actionBags = {}))[desc.id] = actions;
      }
      return {};
    };
    contexts.push(ctx); factoryEntry.apply(ctx);
    ctx.dispose = () => {
      ctx.handlers.clear();
      for (const dispose of ctx.disposers.slice().reverse()) dispose();
      const at = contexts.indexOf(ctx); if (at >= 0) contexts.splice(at, 1);
    };
    return ctx;
  }
  const ctx = mount();
  return {
    h, mql, ctx, entry, changes, tokenLayers, mount, preference: () => pref,
    renderSlot: (id) => ctx.components[id]({ t: (key) => key, ...ctx.actionBags[id], useStore: (select) => select(ctx.states[id]) }),
    state: () => ctx.states['dream-skin'], actions: () => ctx.actionBags['dream-skin'],
    render: () => ctx.components['dream-skin']({ t: (key) => key, ...ctx.actionBags['dream-skin'], useStore: (select) => select(ctx.states['dream-skin']) }),
    adopt(id) { pref = id; emit(); },
    reset() { for (const c of contexts) for (const fn of c.handlers.get('connection/reset') || []) fn(); },
    dispose() { for (const c of contexts.slice().reverse()) c.dispose(); h.releaseIntervals(); }
  };
}
const stored = (h) => Object.fromEntries(Object.values(KEY).map((key) => [key, h.localStorage.getItem(key)]));
function assertAutomaticFlip(p) {
  assert.equal(p.preference(), 'mist', 'light OS resolves the configured light skin');
  p.mql.set(true);
  assert.equal(p.preference(), 'midnight', 'live OS flip applies configured dark skin');
}
function assertManualExit(p, id = 'ember') {
  assert.equal(p.state().mode, 'system', 'precondition: automatic');
  p.actions().setSkin(id);
  assert.equal(p.state().mode, 'manual', 'explicit skin selection exits automatic');
  assert.equal(p.h.localStorage.getItem(KEY.mode), null, 'mode is durably cleared');
  p.mql.set(true);
  assert.equal(p.preference(), id, 'OS cannot revoke explicit choice');
}

test('system skin follows both OS directions without persisting resolved ids', async (t) => {
  const p = boot(); t.after(() => p.dispose()); await tick();
  const before = stored(p.h); assertAutomaticFlip(p);
  assert.equal(p.state().skin, 'midnight');
  assert.equal(p.h.documentElement.getAttribute('data-dsh-dream-skin-scheme'), 'dark');
  p.mql.set(false);
  assert.equal(p.preference(), 'mist'); assert.equal(p.state().skin, 'mist');
  assert.equal(p.h.documentElement.getAttribute('data-dsh-dream-skin-scheme'), 'light');
  const count = p.changes.length; p.mql.set(false);
  assert.equal(p.changes.length, count, 'repeated identical notification is idempotent');
  assert.deepEqual(stored(p.h), before, 'OS changes do not rewrite manual id, mode or pair');
});
test('pair choices are independent, validated by scheme and rendered in two accessible groups', (t) => {
  const p = boot(); t.after(() => p.dispose()); const before = p.changes.length;
  assert.equal(p.actions().setSystemSkin('dark', 'ember'), true);
  assert.equal(p.state().darkSkin, 'ember'); assert.equal(p.state().lightSkin, 'mist');
  assert.equal(p.preference(), 'mist'); assert.equal(p.changes.length, before, 'inactive side never switches current skin');
  const values = stored(p.h);
  for (const [scheme, id] of [['light', 'abyss'], ['dark', 'ivory'], ['other', 'mist'], ['light', 'dream-pack:foreign']])
    assert.equal(p.actions().setSystemSkin(scheme, id), false);
  assert.deepEqual(stored(p.h), values, 'invalid pair never reaches storage');
  p.actions().setSystemSkin('light', 'rose'); assert.equal(p.preference(), 'rose');
  p.mql.set(true); assert.equal(p.preference(), 'ember');
  const groups = nodes(p.render()).filter((node) => node.props && node.props.role === 'group');
  assert.equal(groups.length, 2);
  for (const group of groups) {
    const scheme = group.props['aria-label'].split('.').pop();
    const cards = nodes(group).filter((node) => node.props && node.props.skin);
    assert.equal(cards.length, p.entry.SKINS.filter((skin) => skin.colorScheme === scheme).length);
    assert.ok(cards.every((node) => node.props.skin.colorScheme === scheme));
  }
});
test('manual and Default exit automatic, including a pending sticky restore', async (t) => {
  const p = boot(), q = boot(); t.after(() => { p.dispose(); q.dispose(); });
  assertManualExit(p);
  q.adopt('system'); q.actions().setSkin('system');
  assert.equal(q.state().mode, 'manual'); assert.equal(q.h.localStorage.getItem(KEY.mode), null);
  assert.equal(q.h.localStorage.getItem(KEY.manual), null);
  q.mql.set(true); await tick();
  assert.equal(q.preference(), 'system', 'queued work cannot revive automatic after Default');
  assert.equal(nodes(q.render()).filter((node) => node.props && node.props.role === 'group').length, 0);
});
test('enabling automatic commits fallback pair but preserves old manual selection', (t) => {
  const p = boot({ seed: { [KEY.manual]: 'rose', [KEY.light]: 'midnight', [KEY.dark]: 'missing' }, dark: true });
  t.after(() => p.dispose()); assert.equal(p.preference(), 'rose', 'old users remain manual');
  p.actions().setSkinMode('system');
  const light = p.entry.SKINS.find((skin) => skin.colorScheme === 'light').id;
  const dark = p.entry.SKINS.find((skin) => skin.colorScheme === 'dark').id;
  assert.equal(p.h.localStorage.getItem(KEY.mode), 'system');
  assert.equal(p.h.localStorage.getItem(KEY.light), light); assert.equal(p.h.localStorage.getItem(KEY.dark), dark);
  assert.equal(p.h.localStorage.getItem(KEY.manual), 'rose'); assert.equal(p.preference(), dark);
  assert.equal(p.state().lightSkin, light); assert.equal(p.state().darkSkin, dark);
});
test('reload resolves current OS and more than eight host resets preserve automatic intent', async (t) => {
  const p = boot(), q = boot({ dark: true }); t.after(() => { p.dispose(); q.dispose(); });
  assert.equal(p.preference(), 'mist'); assert.equal(q.preference(), 'midnight');
  for (let round = 0; round < 10; round++) {
    q.reset(); q.adopt(round % 2 ? 'system' : 'light');
    assert.notEqual(q.preference(), 'midnight', 'observe intermediate adoption before recovery');
    await tick(); assert.equal(q.preference(), 'midnight', 'successful restore ' + round);
  }
  assert.equal(q.h.localStorage.getItem(KEY.mode), 'system'); assert.equal(q.h.localStorage.getItem(KEY.manual), 'rose');
});
test('stale fiber unload removes only its listener; final unload leaves no OS callback', async (t) => {
  const p = boot(); t.after(() => p.dispose()); await tick();
  assert.equal(p.mql.listeners.size, 1);
  const first = p.ctx, second = p.mount(); assert.equal(p.mql.listeners.size, 2);
  first.dispose(); assert.equal(p.mql.listeners.size, 1);
  p.mql.set(true); assert.equal(p.preference(), 'midnight');
  second.dispose(); assert.equal(p.mql.listeners.size, 0);
  const before = p.changes.length; p.mql.set(false); await tick();
  assert.equal(p.changes.length, before, 'no delayed work switches skin after unload');
});
test('page ownership prevents the stale bundle generation reacting before it unloads', async (t) => {
  const p = boot(); t.after(() => p.dispose()); await tick();
  p.mount(p.h.evaluate(CODE)(makeRequire()));
  const before = p.changes.length; p.mql.set(true);
  assert.equal(p.preference(), 'midnight'); assert.equal(p.changes.length - before, 1);
});
test('missing/throwing media APIs degrade safely; legacy listeners follow and clean up', (t) => {
  for (const api of ['absent', 'throw', 'none']) {
    const p = boot({ api }); t.after(() => p.dispose());
    assert.equal(p.preference(), 'mist', api + ': light default'); assert.equal(p.state().mode, 'system');
  }
  const p = boot({ api: 'legacy' }); t.after(() => p.dispose());
  assert.equal(p.mql.listeners.size, 1); assertAutomaticFlip(p);
  p.dispose(); assert.equal(p.mql.listeners.size, 0);
});
test('effective automatic skin drives following glow without rewriting stored gradient', async (t) => {
  const seed = { ...AUTO, 'dsh-dream-skin:wallpaper-kind': 'gradient',
    'dsh-dream-skin:wallpaper-gradient': 'linear-gradient(135deg, #101018, #2a2440)', 'dsh-dream-skin:wallpaper-follows-skin': '1' };
  const p = boot({ seed }); t.after(() => p.dispose()); await tick();
  const rendered = () => p.h.body.children.filter((node) => !node.removed).map((node) => node.style.backgroundImage || '').join(' ');
  assert.ok(rendered().includes(p.entry.SKINS.find((skin) => skin.id === 'mist').glow), 'light glow overrides old saved rose');
  p.mql.set(true); await tick();
  assert.ok(rendered().includes(p.entry.SKINS.find((skin) => skin.id === 'midnight').glow), 'dark glow follows OS');
  assert.equal(p.h.localStorage.getItem('dsh-dream-skin:wallpaper-gradient'), seed['dsh-dream-skin:wallpaper-gradient']);
});
test('custom wallpaper and accent remain user-owned across both OS changes', async (t) => {
  const gradient = 'linear-gradient(135deg, #102030, #405060)';
  const p = boot({ seed: { ...AUTO, 'dsh-dream-skin:wallpaper-kind': 'gradient', 'dsh-dream-skin:wallpaper-gradient': gradient,
    'dsh-dream-skin:wallpaper-follows-skin': '0', 'dsh-dream-skin:accent': '#123456' } });
  t.after(() => p.dispose()); await tick();
  const appliedAccent = () => p.tokenLayers.filter((layer) => layer.live).at(-1)?.overrides['--dsw-alias-brand-primary'];
  assert.equal(appliedAccent()?.light, '#123456', 'custom accent reaches the light presentation');
  assert.equal(p.preference(), 'mist'); p.mql.set(true); await tick(); assert.equal(p.preference(), 'midnight');
  assert.equal(appliedAccent()?.dark, '#123456', 'custom accent survives the dark presentation');
  p.mql.set(false); await tick();
  assert.equal(p.h.localStorage.getItem('dsh-dream-skin:wallpaper-gradient'), gradient);
  assert.equal(p.h.localStorage.getItem('dsh-dream-skin:wallpaper-follows-skin'), '0');
  assert.equal(p.h.localStorage.getItem('dsh-dream-skin:accent'), '#123456');
  assert.ok(p.h.body.children.some((node) => !node.removed && String(node.style.backgroundImage).includes(gradient)));
});
test('semantic mutation: live-flip oracle catches disabled OS resolution', (t) => {
  const mutated = CODE.replace('return colorSchemeMedia()?.matches ? "dark" : "light";', 'return "light";');
  assert.notEqual(mutated, CODE, 'mutation setup found expression');
  const p = boot({ code: mutated }); t.after(() => p.dispose());
  assert.throws(() => assertAutomaticFlip(p), { code: 'ERR_ASSERTION' }, 'behavioural assertion, not source mismatch, rejects mutation');
});
test('semantic mutation: explicit-selection oracle catches missing mode exit', (t) => {
  const mutated = CODE.replace('writeStorage(SKIN_MODE_KEY, null);', '/* mutation: forget mode clear */');
  assert.notEqual(mutated, CODE, 'mutation setup found mode-clear statement');
  const p = boot({ code: mutated }); t.after(() => p.dispose());
  assert.throws(() => assertManualExit(p), { code: 'ERR_ASSERTION' }, 'manual behaviour rejects mutation while source still executes');
});

test('automatic-only state is existing user intent and must not seed the factory skin or wallpaper', async (t) => {
  const p = boot({ seed: { [KEY.mode]: 'system' }, firstBoot: true }); t.after(() => p.dispose());
  const expected = p.entry.SKINS.find((skin) => skin.colorScheme === 'light').id;
  assert.equal(p.preference(), expected);
  assert.equal(p.h.localStorage.getItem(KEY.manual), null, 'no factory nebula saved over automatic-only state');
  await tick();
  assert.equal(p.preference(), expected);
  assert.equal(p.h.localStorage.getItem('dsh-dream-skin:wallpaper-kind'), null, 'host settlement does not seed factory wallpaper');
  assert.equal(p.h.localStorage.getItem('dsh-dream-skin:wallpaper'), null);
  assert.equal(p.h.localStorage.getItem(KEY.light), null, 'read-time fallback is not a user write');
});
test('semantic mutation: restoring the wrong validation-result path breaks built-in file selection', (t) => {
  const mutated = CODE.replaceAll('validate.pack.manifest', 'validate.manifest')
    .replace('if (SKINS.some((skin) => skin.id === validate.manifest.id))',
      'if (validate.manifest && SKINS.some((skin) => skin.id === validate.manifest.id))');
  assert.notEqual(mutated, CODE, 'mutation setup found validated pack-manifest path');
  const p = boot({ code: mutated }); t.after(() => p.dispose());
  assert.equal(p.state().mode, 'system', 'observe pre-import automatic state');
  importFile(p, manifestFor(p.entry.SKINS.find((skin) => skin.id === 'ember')));
  assert.throws(() => {
    assert.equal(p.preference(), 'ember', 'a built-in file must select the installed skin');
    assert.equal(p.state().mode, 'manual', 'a built-in file is an explicit manual selection');
  }, { code: 'ERR_ASSERTION' }, 'executable wrong-path mutation is caught by the selection oracle');
});
function delayedHost() {
  let finish;
  const answer = new Promise((resolve) => { finish = resolve; });
  const patches = [];
  return {
    patches,
    resolve: (value) => finish({ ok: true, status: 200, json: async () => ({ ok: true, value }) }),
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.method === 'get') return answer;
      patches.push(body.patch);
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
  };
}
test('slow host adoption outranks unpersisted local OS resolutions', async (t) => {
  const host = delayedHost(), p = boot({ fetchImpl: host.fetch }); t.after(() => p.dispose());
  assertAutomaticFlip(p);
  assert.equal(p.h.localStorage.getItem(KEY.dark), 'midnight', 'intermediate local seed is still untouched');
  host.resolve({ [KEY.mode]: 'system', [KEY.light]: 'ivory', [KEY.dark]: 'ember', [KEY.manual]: 'nebula' });
  await waitFor(() => ({ done: p.preference() === 'ember', observed: p.preference() }), { label: 'durable automatic pair adoption' });
  assert.equal(p.state().darkSkin, 'ember'); assert.equal(p.state().lightSkin, 'ivory');
  assert.equal(p.h.localStorage.getItem(KEY.manual), 'nebula', 'OS resolution never marked manual id written');
  p.mql.set(false); assert.equal(p.preference(), 'ivory');
});
test('explicit manual choice before slow host GET blocks remote automatic resurrection', async (t) => {
  const host = delayedHost();
  const p = boot({ seed: { [KEY.manual]: 'rose' }, fetchImpl: host.fetch }); t.after(() => p.dispose());
  assert.equal(p.state().mode, 'manual');
  p.actions().setSkin('ember');
  assert.equal(p.preference(), 'ember');
  host.resolve({ [KEY.mode]: 'system', [KEY.light]: 'ivory', [KEY.dark]: 'midnight', [KEY.manual]: 'nebula' });
  await waitFor(() => ({ done: p.h.localStorage.getItem(KEY.light) === 'ivory', observed: stored(p.h) }), { label: 'host answer adopted untouched side' });
  await tick();
  assert.equal(p.preference(), 'ember'); assert.equal(p.state().mode, 'manual');
  p.mql.set(true); assert.equal(p.preference(), 'ember');
  await waitFor(() => ({ done: host.patches.length > 0, observed: host.patches.length }), { label: 'explicit manual patch flushed' });
  assert.equal(host.patches.at(-1)[KEY.mode], null, 'even initially manual selection explicitly clears remote mode');
  assert.equal(host.patches.at(-1)[KEY.manual], 'ember');
});
test('manual pair editing does not opt in; explicit manual mode freezes the effective automatic side', (t) => {
  const p = boot({ seed: { [KEY.manual]: 'rose' } }); t.after(() => p.dispose());
  const before = p.changes.length;
  p.actions().setSystemSkin('dark', 'ember');
  assert.equal(p.preference(), 'rose'); assert.equal(p.state().mode, 'manual');
  assert.equal(p.changes.length, before); assert.equal(p.h.localStorage.getItem(KEY.mode), null);
  p.actions().setSkinMode('system'); p.mql.set(true); assert.equal(p.preference(), 'ember');
  p.actions().setSkinMode('manual'); assert.equal(p.state().mode, 'manual');
  assert.equal(p.h.localStorage.getItem(KEY.manual), 'ember');
  p.mql.set(false); assert.equal(p.preference(), 'ember');
});
test('theme library selection and random surprise both exit automatic mode', (t) => {
  for (const action of ['applyId', 'surprise']) {
    const p = boot(); t.after(() => p.dispose());
    assert.equal(p.state().mode, 'system');
    p.ctx.actionBags['dream-skin-packs'][action]('nebula');
    const selected = p.preference();
    assert.ok(p.entry.SKINS.some((skin) => skin.id === selected));
    assert.equal(p.state().mode, 'manual', action + ' exits automatic');
    assert.equal(p.h.localStorage.getItem(KEY.mode), null);
    p.mql.set(true); assert.equal(p.preference(), selected, action + ' survives later OS flip');
  }
});
function manifestFor(skin, id = skin.id) {
  return { format: 'dsh-dream-skin/pack', version: 1,
    manifest: { id, name: id, colorScheme: skin.colorScheme, tokens: { ...skin.tokens } } };
}
function importFile(p, data) {
  const input = nodes(p.renderSlot('dream-skin-packs')).find((node) => node.type === 'input' && node.props.type === 'file');
  assert.ok(input, 'drive the real file input handler, not private helpers');
  input.props.onChange({ target: { files: [{ size: 100, content: JSON.stringify(data) }], value: 'fixture.json' } });
}
test('built-in file import selects manually while ordinary pack import and deletion preserve automatic', (t) => {
  const p = boot(); t.after(() => p.dispose());
  const skin = p.entry.SKINS.find((skin) => skin.id === 'ember');
  importFile(p, manifestFor(skin, 'system-test-pack'));
  assert.equal(p.state().mode, 'system'); assert.equal(p.preference(), 'mist');
  const packs = p.ctx.states['dream-skin-packs'];
  assert.ok(packs.ids.includes('dream-pack:system-test-pack'));
  p.ctx.actionBags['dream-skin-packs'].removePack('dream-pack:system-test-pack');
  assert.equal(p.state().mode, 'system'); assert.equal(p.preference(), 'mist');
  assert.ok(!packs.ids.includes('dream-pack:system-test-pack'));
  importFile(p, manifestFor(skin));
  assert.equal(p.preference(), 'ember'); assert.equal(p.state().mode, 'manual');
  p.mql.set(true); assert.equal(p.preference(), 'ember');
});
test('built-in share hash is explicit selection; ordinary shared pack only enters the library', (t) => {
  const catalog = boot(); t.after(() => catalog.dispose());
  const skin = catalog.entry.SKINS.find((skin) => skin.id === 'ember');
  for (const isBuiltin of [false, true]) {
    const data = manifestFor(skin, isBuiltin ? skin.id : 'shared-system-test');
    const hash = '#dream-skin-pack=' + Buffer.from(JSON.stringify(data)).toString('base64');
    const p = boot({ hash }); t.after(() => p.dispose());
    assert.equal(p.state().mode, isBuiltin ? 'manual' : 'system');
    assert.equal(p.preference(), isBuiltin ? 'ember' : 'mist');
    p.mql.set(true);
    assert.equal(p.preference(), isBuiltin ? 'ember' : 'midnight');
  }
});
