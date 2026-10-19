import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountSync } from '../public/account-sync.js';
import { SyncDocument, blankState, flattenState, expandState } from '../public/sync-core.js';

const note = 'note:exercise-lesson';
const record = (value, version) => ({ value, version, updatedAt: '2026-10-19T12:00:00.000Z' });
const copy = value => JSON.parse(JSON.stringify(value));
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(condition) { for (let index = 0; index < 100; index++) { if (condition()) return; await Promise.resolve(); } throw new Error('Expected request was not made'); }

class Storage {
  data = new Map();
  failWrites = false;
  get length() { return this.data.size; }
  key(index) { return [...this.data.keys()][index] ?? null; }
  getItem(key) { return this.data.get(key) ?? null; }
  setItem(key, value) { if (this.failWrites) throw new Error('quota'); this.data.set(key, String(value)); }
  removeItem(key) { this.data.delete(key); }
}

function harness(t, initialUser = 'A') {
  const originals = new Map();
  function stub(key, value) { originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); }
  const local = new Storage(), session = new Storage(), calls = [], states = [], stores = { A: {}, B: {} };
  let user = initialUser, intercept = null, state = blankState();
  stub('localStorage', local); stub('sessionStorage', session);
  stub('window', { addEventListener() {} }); stub('document', { addEventListener() {}, hidden: false });
  stub('setInterval', () => 1); stub('setTimeout', () => 1); stub('clearTimeout', () => {});
  stub('BroadcastChannel', class { postMessage() {} }); stub('confirm', () => true);
  const server = async (path, options = {}) => {
    if (path === '/api/account') return json({ user: user ? { id: user, displayName: 'Learner ' + user } : null });
    if (!user) return json({ code: 'AUTH_REQUIRED' }, 401);
    if (!options.method || options.method === 'GET') return json({ userId: user, items: stores[user] || {} });
    const body = JSON.parse(options.body);
    if (body.expectedUserId !== user) return json({ code: 'ACCOUNT_CHANGED' }, 409);
    const applied = {}, conflicts = {};
    for (const operation of body.operations) {
      assert.deepEqual(Object.keys(operation).sort(), ['baseVersion', 'key', 'value']);
      const current = stores[user][operation.key] || record(null, 0);
      if (JSON.stringify(current.value) === JSON.stringify(operation.value) && current.version) applied[operation.key] = current;
      else if (operation.baseVersion === current.version) applied[operation.key] = stores[user][operation.key] = record(operation.value, current.version + 1);
      else conflicts[operation.key] = current;
    }
    return json({ userId: user, applied, conflicts });
  };
  stub('fetch', async (path, options) => { calls.push({ path, options: copy({ ...options, signal: undefined }) }); return intercept ? intercept(path, options, server) : server(path, options); });
  const sync = new AccountSync({ onState(next, reason) { state = copy(next); states.push({ state, reason }); }, onStatus() {}, toast() {} });
  t.after(() => { for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  return { sync, local, session, stores, calls, states, get state() { return state; }, set user(value) { user = value; }, set intercept(value) { intercept = value; } };
}

function draft(value, baseValue = 'base', version = 1) { const doc = new SyncDocument(); doc.ingest({ [note]: record(baseValue, version) }); doc.stage({ [note]: value }); return doc.toJSON(); }

test('anonymous initialisation keeps legacy work local and sends no progress requests', async t => {
  const h = harness(t, null), legacy = { ...blankState(), notes: { 'exercise-lesson': 'guest work' } };
  h.local.setItem('health-atlas-v1', JSON.stringify(legacy));
  await h.sync.init();
  assert.equal(h.sync.user, null);
  assert.deepEqual(h.state, legacy);
  h.sync.save({ ...legacy, read: ['lesson'] });
  assert.deepEqual(JSON.parse(h.local.getItem('health-atlas-v1')).read, ['lesson']);
  assert.equal(h.calls.filter(call => call.path === '/api/progress').length, 0);
});

test('identity failure never opens an account cache or uploads guest work', async t => {
  const h = harness(t);
  h.local.setItem('health-atlas-account-v2:A:old', JSON.stringify(draft('private A')));
  h.intercept = async () => { throw new Error('offline'); };
  await h.sync.init();
  assert.equal(h.sync.user, null);
  assert.equal(h.sync.status, 'offline');
  assert.deepEqual(h.state, blankState());
  assert.deepEqual(h.sync.recoverableDrafts(), []);
});

test('progress-load failure after valid identity never substitutes guest records', async t => {
  const h = harness(t);
  h.local.setItem('health-atlas-v1', JSON.stringify({ ...blankState(), notes: { 'exercise-lesson': 'unclaimed guest' } }));
  h.local.setItem('health-atlas-account-v2:A:' + h.sync.tabId, JSON.stringify(draft('private A')));
  h.intercept = (path, options, server) => path === '/api/progress' ? Promise.reject(new Error('offline')) : server(path, options);
  await h.sync.init();
  assert.equal(h.sync.user.id, 'A');
  assert.equal(h.state.notes['exercise-lesson'], 'private A');
  assert.equal(h.sync.status, 'offline');
  assert.equal(JSON.parse(h.local.getItem('health-atlas-v1')).notes['exercise-lesson'], 'unclaimed guest');
});

test('signing in shows only account records until explicit legacy import', async t => {
  const h = harness(t), legacy = { ...blankState(), notes: { 'exercise-lesson': 'unclaimed guest' } };
  h.local.setItem('health-atlas-v1', JSON.stringify(legacy));
  h.stores.A[note] = record('private A', 1);
  await h.sync.init();
  assert.equal(h.state.notes['exercise-lesson'], 'private A');
  assert.equal(h.sync.hasLegacy(), 1);
  assert.deepEqual(h.sync.doc.pending, {});
});

test('queued A edits cannot write into B when authentication changes before POST', async t => {
  const h = harness(t);
  await h.sync.init();
  h.sync.save({ ...blankState(), notes: { 'exercise-lesson': 'private A' } });
  let changed = false;
  h.intercept = (path, options, server) => { if (options.method === 'POST' && !changed) { changed = true; h.user = 'B'; } return server(path, options); };
  await h.sync.refresh();
  assert.equal(h.sync.user.id, 'B');
  assert.equal(h.state.notes['exercise-lesson'], undefined);
  assert.equal(h.stores.B[note], undefined);
  assert.equal(JSON.parse(h.local.getItem('health-atlas-account-v2:A:' + h.sync.tabId)).pending[note].value, 'private A');
});

test('failed writes stay in the account queue and never become guest progress', async t => {
  const h = harness(t);
  await h.sync.init();
  h.sync.save({ ...blankState(), notes: { 'exercise-lesson': 'queued' } });
  h.intercept = (path, options, server) => options.method === 'POST' ? Promise.reject(new Error('offline')) : server(path, options);
  await h.sync.refresh();
  assert.equal(h.sync.status, 'offline');
  assert.equal(h.sync.doc.pending[note].value, 'queued');
  assert.equal(h.local.getItem('health-atlas-v1'), null);
  assert.equal(JSON.parse(h.local.getItem(h.sync.cacheKey())).pending[note].value, 'queued');
});

test('typing during an upload retains the later edit and flushes it with the acknowledged base', async t => {
  const h = harness(t), gate = deferred();
  await h.sync.init();
  h.sync.save({ ...blankState(), notes: { 'exercise-lesson': 'first' } });
  let waiting = false;
  h.intercept = async (path, options, server) => { if (options.method === 'POST' && !waiting) { waiting = true; await gate.promise; } return server(path, options); };
  const refresh = h.sync.refresh();
  await until(() => waiting);
  h.sync.save({ ...blankState(), notes: { 'exercise-lesson': 'second' } });
  gate.resolve(); await refresh;
  assert.equal(h.stores.A[note].value, 'second');
  assert.equal(h.stores.A[note].version, 2);
  assert.deepEqual(h.sync.doc.pending, {});
});

test('a delayed upload response cannot repopulate UI after sign-out', async t => {
  const h = harness(t), gate = deferred();
  await h.sync.init();
  h.sync.save({ ...blankState(), notes: { 'exercise-lesson': 'private A' } });
  let waiting = false;
  h.intercept = async (path, options, server) => { if (options.method === 'POST') { waiting = true; await gate.promise; } return server(path, options); };
  const refresh = h.sync.refresh(); await until(() => waiting);
  assert.equal(h.sync.beforeSignOut(), true); gate.resolve(); await refresh;
  assert.equal(h.sync.user, null); assert.deepEqual(h.state, blankState()); assert.deepEqual(h.sync.doc.records, {});
});

test('sign-out preserves the current account and draft when pending edits cannot be backed up', async t => {
  const h = harness(t); await h.sync.init();
  h.sync.save({ ...blankState(), notes: { 'exercise-lesson': 'unsynced work' } });
  h.local.failWrites = true;
  let message = ''; h.sync.hooks.toast = value => { message = value; };
  const doc = h.sync.doc, epoch = h.sync.epoch;
  assert.equal(h.sync.beforeSignOut(), false);
  assert.equal(h.sync.user.id, 'A'); assert.equal(h.sync.doc, doc); assert.equal(h.sync.epoch, epoch);
  assert.equal(h.sync.ready, true); assert.equal(h.sync.doc.pending[note].value, 'unsynced work');
  assert.match(message, /Sign-out paused/); assert.match(message, /reconnect and sync/);
  h.local.failWrites = false;
  assert.equal(h.sync.beforeSignOut(), true);
  assert.equal(h.sync.user, null);
});

test('a delayed identity response cannot reopen an account after sign-out', async t => {
  const h = harness(t), gate = deferred();
  await h.sync.init();
  h.intercept = async (path, options, server) => { if (path === '/api/account') await gate.promise; return server(path, options); };
  const refresh = h.sync.refresh(); await Promise.resolve();
  h.sync.beforeSignOut(); gate.resolve(); await refresh;
  assert.equal(h.sync.user, null); assert.deepEqual(h.state, blankState());
});

test('sign-out in another tab immediately hides account data and pauses saves until reload', async t => {
  const h = harness(t); await h.sync.init();
  h.sync.save({ ...blankState(), notes: { 'exercise-lesson': 'unsent A work' } });
  const cache = h.sync.cacheKey(), count = h.calls.length;
  // The old authentication cookie may still identify A while the other tab navigates.
  h.sync.channel.onmessage({ data: { type: 'identity-changed' } });
  assert.equal(h.sync.sessionChanged, true); assert.equal(h.sync.ready, false);
  assert.equal(h.sync.user, null); assert.deepEqual(h.state, blankState());
  assert.equal(JSON.parse(h.local.getItem(cache)).pending[note].value, 'unsent A work');
  h.sync.save({ ...blankState(), notes: { 'exercise-lesson': 'must not save as guest' } });
  await h.sync.refresh(); await h.sync.refreshIdentity();
  assert.equal(h.calls.length, count); assert.equal(h.local.getItem('health-atlas-v1'), null);
  await assert.rejects(h.sync.importState(blankState()), /Reload/);
  await assert.rejects(h.sync.reset(), /Reload/);
  assert.match(h.sync.label(), /reload/);
});

test('another-tab sign-out also invalidates an identity response already in flight', async t => {
  const h = harness(t), gate = deferred(); await h.sync.init();
  h.intercept = async (path, options, server) => { if (path === '/api/account') await gate.promise; return server(path, options); };
  const refresh = h.sync.refresh(); await Promise.resolve();
  h.sync.channel.onmessage({ data: { type: 'identity-changed' } }); gate.resolve(); await refresh;
  assert.equal(h.sync.user, null); assert.equal(h.sync.sessionChanged, true); assert.deepEqual(h.state, blankState());
});

test('a focused stale editor creates a conflict instead of overwriting an unseen remote note', async t => {
  const h = harness(t); h.stores.A[note] = record('base', 1); await h.sync.init();
  h.sync.editor = { key: note, baseVersion: 1 };
  h.stores.A[note] = record('remote change', 2); await h.sync.refresh();
  h.sync.save({ ...h.state, notes: { 'exercise-lesson': 'base typed further' } });
  assert.equal(h.sync.doc.conflicts[note].remote.value, 'remote change');
  assert.equal(h.sync.doc.pending[note].baseVersion, 1);
  await h.sync.refresh(); assert.equal(h.stores.A[note].value, 'remote change');
});

test('import aborts if account changes while refreshing', async t => {
  const h = harness(t); await h.sync.init(); h.user = 'B';
  await assert.rejects(h.sync.importState({ ...blankState(), notes: { 'exercise-lesson': 'for A' } }), /account changed/);
  assert.equal(h.stores.B[note], undefined); assert.deepEqual(h.sync.doc.pending, {});
});

test('import aborts if the account becomes anonymous without claiming guest data', async t => {
  const h = harness(t); await h.sync.init(); h.user = null;
  await assert.rejects(h.sync.importState({ ...blankState(), notes: { 'exercise-lesson': 'for A' } }), /account changed/);
  assert.equal(h.local.getItem('health-atlas-v1'), null);
});

test('reset aborts if account changes while refreshing', async t => {
  const h = harness(t); await h.sync.init(); h.stores.B[note] = record('B notes', 3); h.user = 'B';
  await assert.rejects(h.sync.reset(), /account changed/);
  assert.equal(h.stores.B[note].value, 'B notes'); assert.deepEqual(h.sync.doc.pending, {});
});

test('legacy records are removed only after a safe account draft and backup exist', async t => {
  const h = harness(t), legacy = { ...blankState(), notes: { 'exercise-lesson': 'old local' } };
  h.local.setItem('health-atlas-v1', JSON.stringify(legacy)); await h.sync.init();
  await h.sync.importState(legacy, true);
  assert.equal(h.local.getItem('health-atlas-v1'), null);
  assert.deepEqual(JSON.parse(h.local.getItem('health-atlas-legacy-backup:A')), legacy);
  assert.equal(JSON.parse(h.local.getItem(h.sync.cacheKey())).pending[note].value, 'old local');
});

test('failed local storage preserves the unclaimed legacy source', async t => {
  const h = harness(t), legacy = { ...blankState(), notes: { 'exercise-lesson': 'old local' } };
  h.local.setItem('health-atlas-v1', JSON.stringify(legacy)); await h.sync.init(); h.local.failWrites = true;
  await assert.rejects(h.sync.importState(legacy, true), /original browser records have been kept/);
  assert.deepEqual(JSON.parse(h.local.getItem('health-atlas-v1')), legacy);
});

test('account draft discovery excludes other accounts and creates unique runtime tab IDs', async t => {
  const h = harness(t); await h.sync.init();
  h.local.setItem('health-atlas-account-v2:A:closed-tab', JSON.stringify(draft('A local')));
  h.local.setItem('health-atlas-account-v2:B:closed-tab', JSON.stringify(draft('B local')));
  assert.deepEqual(h.sync.recoverableDrafts(), [{ cacheKey: 'health-atlas-account-v2:A:closed-tab', count: 1 }]);
  await assert.rejects(h.sync.recoverDraft('health-atlas-account-v2:B:closed-tab'), /does not belong/);
  const other = new AccountSync({ onState() {}, onStatus() {}, toast() {} });
  assert.notEqual(h.sync.tabId, other.tabId);
});

test('recovering an old tab keeps its base version and surfaces a cloud conflict', async t => {
  const h = harness(t); h.stores.A[note] = record('new remote', 3); await h.sync.init();
  const key = 'health-atlas-account-v2:A:closed-tab'; h.local.setItem(key, JSON.stringify(draft('old local', 'base', 1)));
  await h.sync.recoverDraft(key);
  assert.equal(h.sync.doc.pending[note].value, 'old local'); assert.equal(h.sync.doc.pending[note].baseVersion, 1);
  assert.equal(h.sync.doc.conflicts[note].remote.value, 'new remote');
  assert.deepEqual(JSON.parse(h.local.getItem(key)).pending, {});
  assert.ok([...h.local.data.keys()].some(key => key.startsWith('health-atlas-recovered-draft-backup:A:')));
  assert.equal(JSON.parse(h.local.getItem(h.sync.cacheKey())).pending[note].value, 'old local');
});

test('recovery refuses to destroy a different unresolved current draft', async t => {
  const h = harness(t); h.stores.A[note] = record('remote', 2); await h.sync.init();
  h.sync.doc = new SyncDocument(draft('current local', 'base', 1)); h.sync.doc.ingest(h.stores.A);
  const key = 'health-atlas-account-v2:A:closed-tab'; h.local.setItem(key, JSON.stringify(draft('other local', 'base', 1)));
  await assert.rejects(h.sync.recoverDraft(key), /Resolve or finish syncing/);
  assert.equal(h.sync.doc.pending[note].value, 'current local');
  assert.equal(JSON.parse(h.local.getItem(key)).pending[note].value, 'other local');
});

test('recovery leaves its source intact when the new queue cannot be persisted', async t => {
  const h = harness(t); await h.sync.init();
  const key = 'health-atlas-account-v2:A:closed-tab'; h.local.setItem(key, JSON.stringify(draft('old local'))); h.local.failWrites = true;
  await assert.rejects(h.sync.recoverDraft(key), /original draft is still safe/);
  assert.equal(JSON.parse(h.local.getItem(key)).pending[note].value, 'old local');
});
