// Pure state transformations shared by the browser sync controller and its tests.
export const MAX_NOTE_LENGTH = 32 * 1024;
const own = (value, key) => Object.hasOwn(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const copy = value => JSON.parse(JSON.stringify(value));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const token = () => crypto.randomUUID();
const id = '[A-Za-z0-9][A-Za-z0-9_-]{0,95}';
const booleanKey = new RegExp(`^(?:read:${id}|(?:check|lab):${id}:[0-9]{1,4}|pref:zh)$`);
const answerKey = new RegExp(`^answer:${id}:[0-9]{1,4}$`);
const noteKey = new RegExp(`^note:(?:exercise|lab)-${id}$`);

function valueFor(key, value) {
  const kind = booleanKey.test(key) ? 'boolean' : answerKey.test(key) ? 'answer' : noteKey.test(key) ? 'note' : null;
  if (!kind) throw new Error('Invalid progress key.');
  if (value === null) return null;
  if (kind === 'boolean' && typeof value === 'boolean') return value;
  if (kind === 'note' && typeof value === 'string' && value.length <= MAX_NOTE_LENGTH) return value;
  if (kind === 'answer' && object(value) && Object.keys(value).length === 4 &&
      ['correct', 'selected', 'attempts', 'at'].every(key => own(value, key)) &&
      typeof value.correct === 'boolean' && Number.isInteger(value.selected) && value.selected >= 0 && value.selected <= 99 &&
      Number.isSafeInteger(value.attempts) && value.attempts >= 1 && value.attempts <= 1_000_000 &&
      typeof value.at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value.at) &&
      Number.isFinite(Date.parse(value.at))) {
    return { correct: value.correct, selected: value.selected, attempts: value.attempts, at: value.at };
  }
  throw new Error(kind === 'note' ? `Notes must be at most ${MAX_NOTE_LENGTH.toLocaleString()} characters.` : 'Invalid progress value.');
}

function flatValues(values) {
  if (!object(values)) throw new Error('Invalid progress map.');
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, valueFor(key, value)]));
}

function recordFor(key, record) {
  if (!object(record) || !Number.isSafeInteger(record.version) || record.version < 0 || !own(record, 'value')) {
    throw new Error('Invalid progress version.');
  }
  return { value: valueFor(key, record.value), version: record.version, updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : null };
}

export function blankState() {
  return { read: [], answers: {}, checks: {}, labChecks: {}, notes: {}, zh: true };
}

export function sanitizeLegacyState(input) {
  if (!object(input) || !Array.isArray(input.read) ||
      !['answers', 'checks', 'labChecks', 'notes'].every(key => object(input[key])) ||
      (own(input, 'zh') && typeof input.zh !== 'boolean') ||
      Object.keys(input).some(key => !['read', 'answers', 'checks', 'labChecks', 'notes', 'zh'].includes(key))) {
    throw new Error('This file is not a valid Atlas progress backup.');
  }
  const flat = {};
  for (const key of input.read) {
    if (typeof key !== 'string') throw new Error('Invalid lesson ID.');
    flat['read:' + key] = valueFor('read:' + key, true);
  }
  for (const [field, prefix] of [['answers', 'answer'], ['checks', 'check'], ['labChecks', 'lab'], ['notes', 'note']]) {
    for (const [key, value] of Object.entries(input[field])) {
      if (value === null) throw new Error('Invalid legacy progress value.');
      flat[prefix + ':' + key] = valueFor(prefix + ':' + key, value);
    }
  }
  flat['pref:zh'] = input.zh !== false;
  return expandState(flat);
}

export function flattenState(state) {
  const clean = sanitizeLegacyState(state);
  const flat = { 'pref:zh': clean.zh };
  for (const key of clean.read) flat['read:' + key] = true;
  for (const [field, prefix] of [['answers', 'answer'], ['checks', 'check'], ['labChecks', 'lab'], ['notes', 'note']]) {
    for (const [key, value] of Object.entries(clean[field])) flat[prefix + ':' + key] = value;
  }
  return flat;
}

export function expandState(itemsMap) {
  const state = blankState();
  for (const [key, value] of Object.entries(flatValues(itemsMap))) {
    if (value === null) continue;
    const split = key.indexOf(':'), prefix = key.slice(0, split), suffix = key.slice(split + 1);
    if (prefix === 'read') { if (value) state.read.push(suffix); }
    else if (prefix === 'pref') state.zh = value;
    else state[({ answer: 'answers', check: 'checks', lab: 'labChecks', note: 'notes' })[prefix]][suffix] = value;
  }
  return state;
}

export class SyncDocument {
  constructor(saved = {}) {
    if (!object(saved)) throw new Error('Invalid saved sync state.');
    this.records = {};
    this.pending = {};
    this.conflicts = {};
    for (const [key, record] of Object.entries(saved.records || {})) this.records[key] = recordFor(key, record);
    for (const [key, pending] of Object.entries(saved.pending || {})) {
      if (!object(pending) || !Number.isSafeInteger(pending.baseVersion) || pending.baseVersion < 0 ||
          typeof pending.token !== 'string' || !pending.token) throw new Error('Invalid pending progress.');
      this.pending[key] = { value: valueFor(key, pending.value), baseVersion: pending.baseVersion, token: pending.token };
    }
    for (const [key, conflict] of Object.entries(saved.conflicts || {})) {
      if (!this.pending[key] || !object(conflict)) continue;
      const remote = recordFor(key, conflict.remote);
      this._record(key, remote);
      this.conflicts[key] = { local: copy(this.pending[key].value), remote: copy(this.records[key]) };
    }
  }

  valueSnapshot() {
    const result = {};
    for (const [key, record] of Object.entries(this.records)) if (record.value !== null) result[key] = copy(record.value);
    for (const [key, pending] of Object.entries(this.pending)) {
      if (pending.value === null) delete result[key];
      else result[key] = copy(pending.value);
    }
    return result;
  }

  stage(nextFlat) {
    const next = flatValues(nextFlat), current = this.valueSnapshot();
    for (const key of new Set([...Object.keys(current), ...Object.keys(next)])) {
      const previous = own(current, key) ? current[key] : null;
      const value = own(next, key) ? next[key] : null;
      if (equal(previous, value)) continue;
      const old = this.pending[key];
      this.pending[key] = { value: copy(value), baseVersion: old?.baseVersion ?? this.records[key]?.version ?? 0, token: token() };
      if (this.conflicts[key]) this.conflicts[key].local = copy(value);
    }
    return this;
  }

  batch(max = 100) {
    const result = [];
    let bytes = 0;
    for (const [key, pending] of Object.entries(this.pending)) {
      if (this.conflicts[key]) continue;
      const operation = { key, ...copy(pending) };
      const size = new TextEncoder().encode(JSON.stringify(operation)).length;
      if (result.length >= Math.min(100, Math.max(0, max)) || bytes + size > 220 * 1024) break;
      result.push(operation);
      bytes += size;
    }
    return result;
  }

  _record(key, record) {
    const previous = this.records[key];
    if (previous && previous.version >= record.version) return previous;
    this.records[key] = copy(record);
    return this.records[key];
  }

  _conflict(key) {
    if (this.pending[key]) this.conflicts[key] = { local: copy(this.pending[key].value), remote: copy(this.records[key]) };
  }

  ingest(items) {
    if (!object(items)) throw new Error('Invalid cloud progress.');
    for (const [key, input] of Object.entries(items)) {
      const record = recordFor(key, input);
      if (this.records[key] && record.version < this.records[key].version) continue;
      const remote = this._record(key, record), pending = this.pending[key];
      if (!pending) continue;
      if (equal(pending.value, remote.value)) {
        delete this.pending[key];
        delete this.conflicts[key];
      } else if (remote.version !== pending.baseVersion) this._conflict(key);
    }
    return this;
  }

  acceptResponse(sentOps, response) {
    if (!object(response) || !object(response.applied) || !object(response.conflicts)) throw new Error('Invalid sync response.');
    const sent = new Map(sentOps.map(operation => [operation.key, operation]));
    for (const [key, input] of Object.entries(response.applied)) {
      const operation = sent.get(key);
      if (!operation) continue;
      const record = recordFor(key, input), remote = this._record(key, record), pending = this.pending[key];
      if (!pending) continue;
      if (!equal(record.value, operation.value) || remote.version > record.version) {
        this._conflict(key);
        continue;
      }
      if (pending.token === operation.token) {
        delete this.pending[key];
        delete this.conflicts[key];
      } else if (pending.baseVersion === operation.baseVersion && !this.conflicts[key]) {
        // A later local edit continues this acknowledged write, so its base can advance.
        pending.baseVersion = record.version;
      } else if (pending.baseVersion !== remote.version) this._conflict(key);
    }
    for (const [key, input] of Object.entries(response.conflicts)) {
      if (!sent.has(key)) continue;
      this._record(key, recordFor(key, input));
      this._conflict(key);
    }
    return this;
  }

  resolve(key, choice) {
    const conflict = this.conflicts[key], pending = this.pending[key];
    if (!conflict || !pending) return this;
    const remote = this.records[key];
    if (choice === 'remote') {
      delete this.pending[key];
      delete this.conflicts[key];
      return this;
    }
    if (choice !== 'local' && choice !== 'both') throw new Error('Choose a conflict resolution.');
    let value = pending.value;
    if (choice === 'both') {
      if (!noteKey.test(key)) throw new Error('Only notes can keep both versions.');
      value = `--- This device ---\n${pending.value ?? ''}\n\n--- Saved on another device ---\n${remote.value ?? ''}`;
      value = valueFor(key, value);
    }
    this.pending[key] = { value: copy(value), baseVersion: remote.version, token: token() };
    delete this.conflicts[key];
    return this;
  }

  toJSON() {
    return copy({ records: this.records, pending: this.pending, conflicts: this.conflicts });
  }
}
