import test from 'node:test';
import assert from 'node:assert/strict';
import { blankState, flattenState, expandState, sanitizeLegacyState, SyncDocument, MAX_NOTE_LENGTH } from '../public/sync-core.js';

const note = 'note:exercise-lesson';
const record = (value, version) => ({ value, version, updatedAt: '2026-10-19T12:00:00.000Z' });
const applied = (key, value, version) => ({ applied: { [key]: record(value, version) }, conflicts: {} });

test('legacy state roundtrips without changing IDs or answer values', () => {
  const state = { ...blankState(), read: ['lesson'], answers: { 'lesson:0': { correct: true, selected: 2, attempts: 3, at: '2026-10-19T12:00:00.000Z' } }, checks: { 'lesson:0': false }, labChecks: { 'lab:0': true }, notes: { 'exercise-lesson': '中文笔记', 'lab-lab': 'lab note' }, zh: false };
  assert.deepEqual(expandState(flattenState(state)), state);
  assert.deepEqual(sanitizeLegacyState(state), state);
});

test('legacy validation rejects prototype keys, wrong types and oversized notes', () => {
  assert.throws(() => sanitizeLegacyState({ ...blankState(), notes: JSON.parse('{"__proto__":"bad"}') }));
  assert.throws(() => sanitizeLegacyState({ ...blankState(), checks: { 'lesson:0': 'true' } }));
  assert.throws(() => sanitizeLegacyState({ ...blankState(), notes: { 'exercise-lesson': 'x'.repeat(MAX_NOTE_LENGTH + 1) } }));
  assert.throws(() => sanitizeLegacyState({ ...blankState(), read: ['constructor'] , constructor: {} }));
  assert.throws(() => sanitizeLegacyState({ ...blankState(), answers: { 'lesson:0': { correct: true, attempts: 1 } } }));
});

test('independent changes on separate devices are retained', () => {
  const doc = new SyncDocument();
  doc.stage({ 'read:lesson': true });
  doc.ingest({ [note]: record('other device', 1) });
  assert.deepEqual(doc.valueSnapshot(), { [note]: 'other device', 'read:lesson': true });
  assert.equal(Object.keys(doc.conflicts).length, 0);
});

test('a changed remote note creates a durable conflict containing both versions', () => {
  const doc = new SyncDocument();
  doc.ingest({ [note]: record('base', 1) });
  doc.stage({ [note]: 'mine' });
  doc.ingest({ [note]: record('theirs', 2) });
  assert.equal(doc.valueSnapshot()[note], 'mine');
  assert.equal(doc.conflicts[note].remote.value, 'theirs');
  assert.deepEqual(doc.batch(), []);
  const restored = new SyncDocument(doc.toJSON());
  restored.resolve(note, 'both');
  assert.match(restored.pending[note].value, /mine[\s\S]*theirs/);
  assert.equal(restored.pending[note].baseVersion, 2);
});

test('stage preserves original base and later edits survive acknowledgement of an in-flight save', () => {
  const doc = new SyncDocument();
  doc.ingest({ [note]: record('original', 4) });
  doc.stage({ [note]: 'first' });
  const sent = doc.batch();
  doc.stage({ [note]: 'second' });
  assert.equal(doc.pending[note].baseVersion, 4);
  doc.acceptResponse(sent, applied(note, 'first', 5));
  assert.equal(doc.valueSnapshot()[note], 'second');
  assert.equal(doc.pending[note].baseVersion, 5);
  assert.equal(Object.keys(doc.conflicts).length, 0);
  const next = doc.batch();
  doc.acceptResponse(next, applied(note, 'second', 6));
  assert.equal(Object.keys(doc.pending).length, 0);
});

test('reverting an edit while it is in flight is queued instead of lost', () => {
  const doc = new SyncDocument();
  doc.ingest({ [note]: record('original', 1) });
  doc.stage({ [note]: 'temporary' });
  const sent = doc.batch();
  doc.stage({ [note]: 'original' });
  doc.acceptResponse(sent, applied(note, 'temporary', 2));
  assert.equal(doc.pending[note].value, 'original');
  assert.equal(doc.pending[note].baseVersion, 2);
});

test('a retried write with a lost response is acknowledged at its existing version', () => {
  const doc = new SyncDocument();
  doc.stage({ [note]: 'saved' });
  const sent = doc.batch();
  doc.acceptResponse(sent, applied(note, 'saved', 1));
  doc.acceptResponse(sent, applied(note, 'saved', 1));
  assert.equal(doc.records[note].version, 1);
  assert.deepEqual(doc.pending, {});
});

test('reset emits tombstones and a stale device cannot silently resurrect them', () => {
  const doc = new SyncDocument();
  doc.ingest({ [note]: record('old', 7), 'read:lesson': record(true, 2), 'pref:zh': record(false, 1) });
  doc.stage({ 'pref:zh': false });
  assert.equal(doc.pending[note].value, null);
  assert.equal(doc.pending[note].baseVersion, 7);
  const stale = new SyncDocument({ records: { [note]: record('old', 7) } });
  stale.stage({ [note]: 'offline edit' });
  stale.ingest({ [note]: record(null, 8) });
  assert.equal(stale.conflicts[note].remote.value, null);
  stale.resolve(note, 'remote');
  assert.equal(stale.records[note].version, 8);
  assert.deepEqual(stale.valueSnapshot(), {});
});

test('old responses never move versions backwards or overwrite newer remote records', () => {
  const doc = new SyncDocument();
  doc.ingest({ [note]: record('base', 1) });
  doc.stage({ [note]: 'mine' });
  const sent = doc.batch();
  doc.ingest({ [note]: record('newer remote', 5) });
  doc.acceptResponse(sent, applied(note, 'mine', 2));
  assert.equal(doc.records[note].version, 5);
  assert.equal(doc.conflicts[note].remote.value, 'newer remote');
  doc.ingest({ [note]: record('older', 3) });
  assert.equal(doc.records[note].version, 5);
});

test('conflict resolution can retain local changes using the remote base', () => {
  const doc = new SyncDocument();
  doc.stage({ [note]: 'mine' });
  const sent = doc.batch();
  doc.acceptResponse(sent, { applied: {}, conflicts: { [note]: record('theirs', 3) } });
  const oldToken = doc.pending[note].token;
  doc.resolve(note, 'local');
  assert.equal(doc.pending[note].baseVersion, 3);
  assert.notEqual(doc.pending[note].token, oldToken);
  assert.equal(doc.batch().length, 1);
});

test('ingest can acknowledge an unchanged write after response loss', () => {
  const doc = new SyncDocument();
  doc.stage({ [note]: 'saved' });
  doc.ingest({ [note]: record('saved', 1) });
  assert.deepEqual(doc.pending, {});
});

test('batch limits count and UTF-8 payload size', () => {
  const doc = new SyncDocument();
  doc.stage(Object.fromEntries(Array.from({ length: 105 }, (_, i) => ['read:lesson-' + i, true])));
  assert.equal(doc.batch().length, 100);
  assert.equal(doc.batch(1).length, 1);
  const long = new SyncDocument();
  long.stage(Object.fromEntries(Array.from({ length: 5 }, (_, i) => ['note:exercise-lesson-' + i, '中'.repeat(MAX_NOTE_LENGTH)])));
  const batch = long.batch();
  assert.equal(batch.length, 2);
  assert.ok(new TextEncoder().encode(JSON.stringify({ expectedUserId: 'some-user', operations: batch })).length < 256 * 1024);
});

test('keeping both oversized notes fails without discarding either original', () => {
  const doc = new SyncDocument();
  doc.stage({ [note]: 'a'.repeat(MAX_NOTE_LENGTH) });
  doc.ingest({ [note]: record('b'.repeat(MAX_NOTE_LENGTH), 1) });
  assert.throws(() => doc.resolve(note, 'both'));
  assert.equal(doc.pending[note].value.length, MAX_NOTE_LENGTH);
  assert.equal(doc.conflicts[note].remote.value.length, MAX_NOTE_LENGTH);
});
