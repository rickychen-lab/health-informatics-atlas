import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { ProgressDatabase, ProgressStatement, ProgressOperation, ProgressRecord, SessionUser } from "../lib/progress-store";

// Dynamic URL import works with Node's native TypeScript stripping without changing app imports.
const moduleUrl = new URL("../lib/progress-store.ts", import.meta.url).href;
const { ProgressStore, getProgressResponse, postProgressResponse, MAX_BODY_BYTES, MAX_NOTE_LENGTH } =
  await import(moduleUrl) as typeof import("../lib/progress-store");

const alice: SessionUser = { userId: "account-alice", displayName: "Alice" };
const bob: SessionUser = { userId: "account-bob", displayName: "Bob" };

/** Runs the production SQL against real SQLite, using D1's small prepared-statement interface. */
class SQLiteD1 implements ProgressDatabase {
  sqlite = new DatabaseSync(":memory:");
  constructor() {
    this.sqlite.exec(`CREATE TABLE progress_records (
      user_id TEXT NOT NULL, key TEXT NOT NULL, value_json TEXT NOT NULL,
      version INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (user_id, key)
    )`);
  }
  prepare(query: string): ProgressStatement {
    const prepared = this.sqlite.prepare(query);
    let values: (string | number | null)[] = [];
    const statement: ProgressStatement = {
      bind(...input) { values = input; return statement; },
      async first<T>() { return (prepared.get(...values) ?? null) as T | null; },
      async all<T>() { return { results: prepared.all(...values) as T[] }; },
    };
    return statement;
  }
  close() { this.sqlite.close(); }
}

function request(user: SessionUser, operations: unknown[], init: RequestInit = {}): Request {
  return new Request("https://atlas.example/api/progress", {
    method: "POST",
    headers: { Origin: "https://atlas.example", "Content-Type": "application/json" },
    body: JSON.stringify({ expectedUserId: user.userId, operations }),
    ...init,
  });
}

function operation(key: string, value: ProgressOperation["value"], baseVersion = 0): ProgressOperation {
  return { key, value, baseVersion };
}

type Reply = {
  code: string; userId: string; items: Record<string, ProgressRecord>;
  applied: Record<string, ProgressRecord>; conflicts: Record<string, ProgressRecord>;
};
async function payload(response: Response): Promise<Reply> { return await response.json() as Reply; }

test("anonymous read/write is rejected before any database access", async () => {
  const noAccess: ProgressDatabase = { prepare() { throw new Error("Must not touch storage"); } };
  for (const response of [
    await getProgressResponse(null, noAccess),
    await postProgressResponse(request(alice, [operation("read:lesson-1", true)]), null, noAccess),
  ]) {
    assert.equal(response.status, 401);
    assert.equal((await payload(response)).code, "AUTH_REQUIRED");
    assert.match(response.headers.get("cache-control")!, /no-store/);
    assert.equal(response.headers.get("vary"), "Cookie");
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  }
});

test("accounts with the same keys can read and update only their own rows", async t => {
  const database = new SQLiteD1(); t.after(() => database.close());
  for (const [user, value] of [[alice, "Alice's private note"], [bob, "Bob's private note"]] as const) {
    const response = await postProgressResponse(request(user, [operation("note:exercise-lesson-1", value)]), user, database);
    assert.equal(response.status, 200);
  }
  assert.deepEqual((await payload(await getProgressResponse(alice, database))).items["note:exercise-lesson-1"].value, "Alice's private note");
  assert.deepEqual((await payload(await getProgressResponse(bob, database))).items["note:exercise-lesson-1"].value, "Bob's private note");
  await postProgressResponse(request(alice, [operation("note:exercise-lesson-1", "Alice updated", 1)]), alice, database);
  const bobResult = await payload(await getProgressResponse(bob, database));
  assert.equal(bobResult.userId, bob.userId);
  assert.equal(bobResult.items["note:exercise-lesson-1"].value, "Bob's private note");
  assert.equal(bobResult.items["note:exercise-lesson-1"].version, 1);
});

test("an account change between queueing and upload writes neither user's data", async t => {
  const database = new SQLiteD1(); t.after(() => database.close());
  const response = await postProgressResponse(request(alice, [operation("note:lab-first", "Alice queued this")]), bob, database);
  assert.equal(response.status, 409);
  assert.equal((await payload(response)).code, "ACCOUNT_CHANGED");
  assert.deepEqual(await new ProgressStore(database).list(alice.userId), {});
  assert.deepEqual(await new ProgressStore(database).list(bob.userId), {});
});

test("client-supplied ownership fields are rejected rather than becoming SQL identity", async t => {
  const database = new SQLiteD1(); t.after(() => database.close());
  const response = await postProgressResponse(request(alice, [], {
    body: JSON.stringify({ expectedUserId: alice.userId, userId: bob.userId, operations: [operation("read:lesson-1", true)] }),
  }), alice, database);
  assert.equal(response.status, 400);
  assert.deepEqual(await new ProgressStore(database).list(bob.userId), {});
});

test("compare-and-swap prevents simultaneous devices from overwriting a newer note", async t => {
  const database = new SQLiteD1(); t.after(() => database.close());
  const store = new ProgressStore(database);
  await store.apply(alice.userId, [operation("note:exercise-lesson-1", "Original")]);
  const results = await Promise.all([
    store.apply(alice.userId, [operation("note:exercise-lesson-1", "Laptop edit", 1)]),
    store.apply(alice.userId, [operation("note:exercise-lesson-1", "Phone edit", 1)]),
  ]);
  assert.equal(results.filter(result => result.applied["note:exercise-lesson-1"]).length, 1);
  const conflict = results.find(result => result.conflicts["note:exercise-lesson-1"])!.conflicts["note:exercise-lesson-1"];
  const current = (await store.list(alice.userId))["note:exercise-lesson-1"];
  assert.deepEqual(conflict, current);
  assert.equal(current.version, 2);
});

test("retries and unchanged edits acknowledge the current version without incrementing it", async t => {
  const database = new SQLiteD1(); t.after(() => database.close());
  const store = new ProgressStore(database);
  const initial = await store.apply(alice.userId, [operation("read:lesson-1", true)]);
  const retry = await store.apply(alice.userId, [operation("read:lesson-1", true)]);
  const noChange = await store.apply(alice.userId, [operation("read:lesson-1", true, 1)]);
  assert.deepEqual(retry, initial);
  assert.deepEqual(noChange, initial);
  const updated = await store.apply(alice.userId, [operation("read:lesson-1", false, 1)]);
  assert.equal(updated.applied["read:lesson-1"].version, 2);
  assert.deepEqual(await store.apply(alice.userId, [operation("read:lesson-1", false, 1)]), updated);
});

test("stale resets cannot erase newer notes; valid resets preserve a versioned tombstone", async t => {
  const database = new SQLiteD1(); t.after(() => database.close());
  const store = new ProgressStore(database);
  await store.apply(alice.userId, [operation("note:lab-first", "Original")]);
  await store.apply(alice.userId, [operation("note:lab-first", "Newer note", 1)]);
  const staleReset = await store.apply(alice.userId, [operation("note:lab-first", null, 1)]);
  assert.equal(staleReset.conflicts["note:lab-first"].value, "Newer note");
  assert.equal(staleReset.conflicts["note:lab-first"].version, 2);
  const reset = await store.apply(alice.userId, [operation("note:lab-first", null, 2)]);
  assert.equal(reset.applied["note:lab-first"].value, null);
  assert.equal(reset.applied["note:lab-first"].version, 3);
  assert.equal((await store.list(alice.userId))["note:lab-first"].version, 3);
  const staleResurrection = await store.apply(alice.userId, [operation("note:lab-first", "Old offline note", 2)]);
  assert.equal(staleResurrection.conflicts["note:lab-first"].value, null);
  assert.equal(staleResurrection.conflicts["note:lab-first"].version, 3);
});

test("baseVersion zero only inserts absent rows; missing nonzero bases return a conflict", async t => {
  const database = new SQLiteD1(); t.after(() => database.close());
  const store = new ProgressStore(database);
  await store.apply(alice.userId, [operation("check:lesson-1:0", true)]);
  assert.equal((await store.apply(alice.userId, [operation("check:lesson-1:0", false)])).conflicts["check:lesson-1:0"].value, true);
  const missing = await store.apply(alice.userId, [operation("read:missing", true, 4)]);
  assert.deepEqual(missing.conflicts["read:missing"], { value: null, version: 0, updatedAt: null });
  assert.equal((await store.list(alice.userId))["read:missing"], undefined);
});

test("all supported progress types round-trip, including canonicalised answer retries", async t => {
  const database = new SQLiteD1(); t.after(() => database.close());
  const answer = { correct: true, selected: 1, attempts: 2, at: "2026-10-19T12:00:00.000Z" };
  const operations = [
    operation("read:lesson-1", true), operation("answer:lesson-1:0", answer),
    operation("check:lesson-1:0", false), operation("lab:first:0", true),
    operation("note:exercise-lesson-1", "My explanation / 我的理解"),
    operation("note:lab-first", "My practical"), operation("pref:zh", false),
  ];
  const response = await postProgressResponse(request(alice, operations), alice, database);
  assert.equal(response.status, 200);
  const first = await payload(response);
  assert.equal(Object.keys(first.applied).length, operations.length);
  const reorderedAnswer = { at: answer.at, attempts: 2, selected: 1, correct: true };
  const retry = await postProgressResponse(request(alice, [operation("answer:lesson-1:0", reorderedAnswer)]), alice, database);
  assert.deepEqual((await payload(retry)).applied["answer:lesson-1:0"], first.applied["answer:lesson-1:0"]);
  const items = (await payload(await getProgressResponse(alice, database))).items;
  for (const input of operations) assert.deepEqual(items[input.key].value, input.value);
});

test("cross-origin, missing-origin and non-JSON writes are rejected", async t => {
  const database = new SQLiteD1(); t.after(() => database.close());
  const headersList: Record<string, string>[] = [
    { "Content-Type": "application/json" },
    { Origin: "https://evil.example", "Content-Type": "application/json" },
    { Origin: "https://atlas.example", "Content-Type": "application/json", "Sec-Fetch-Site": "same-site" },
  ];
  for (const headers of headersList) {
    assert.equal((await postProgressResponse(request(alice, [], { headers }), alice, database)).status, 403);
  }
  assert.equal((await postProgressResponse(request(alice, [], {
    headers: { Origin: "https://atlas.example", "Content-Type": "text/plain" },
  }), alice, database)).status, 415);
  assert.deepEqual(await new ProgressStore(database).list(alice.userId), {});
});

test("malformed operations fail as a whole before writes, including valid earlier operations", async t => {
  const database = new SQLiteD1(); t.after(() => database.close());
  const badOperations = [
    { key: "__proto__", value: true, baseVersion: 0 },
    operation("note:other", "unsupported"),
    operation("read:lesson-1", "not boolean"),
    operation("note:lab-first", true),
    operation("note:lab-first", "x".repeat(MAX_NOTE_LENGTH + 1)),
    { key: "read:lesson-1", value: true, baseVersion: -1 },
    { key: "read:lesson-1", value: true, baseVersion: 0.5 },
    { key: "read:lesson-1", value: true, baseVersion: 0, userId: bob.userId },
    { key: "answer:lesson-1:0", value: { correct: true, selected: 0, attempts: 1, at: "yesterday" }, baseVersion: 0 },
    { key: "answer:lesson-1:0", value: { correct: true, selected: -1, attempts: 1, at: "2026-10-19T12:00:00Z" }, baseVersion: 0 },
    { key: "answer:lesson-1:0", value: { correct: true, selected: 1, attempts: 0, at: "2026-10-19T12:00:00Z" }, baseVersion: 0 },
    { key: "note:lab-first", baseVersion: 0 },
    null,
  ];
  for (const bad of badOperations) {
    const response = await postProgressResponse(request(alice, [operation("read:valid", true), bad]), alice, database);
    assert.equal(response.status, 400, JSON.stringify(bad)?.slice(0, 120));
  }
  const duplicate = await postProgressResponse(request(alice, [operation("read:valid", true), operation("read:valid", false)]), alice, database);
  assert.equal(duplicate.status, 400);
  assert.deepEqual(await new ProgressStore(database).list(alice.userId), {});
});

test("request limits reject too many operations, oversized streaming bodies and malformed JSON", async t => {
  const database = new SQLiteD1(); t.after(() => database.close());
  const tooMany = Array.from({ length: 101 }, (_, i) => operation(`read:lesson-${i}`, true));
  assert.equal((await postProgressResponse(request(alice, tooMany), alice, database)).status, 400);
  assert.equal((await postProgressResponse(request(alice, [], { body: " ".repeat(MAX_BODY_BYTES + 1) }), alice, database)).status, 413);
  assert.equal((await postProgressResponse(request(alice, [], { body: "{" }), alice, database)).status, 400);
  assert.equal((await postProgressResponse(request(alice, [], { body: "[]" }), alice, database)).status, 400);
  assert.equal((await postProgressResponse(request(alice, [], { body: JSON.stringify({ operations: [] }) }), alice, database)).status, 400);
  assert.deepEqual(await new ProgressStore(database).list(alice.userId), {});
});

test("storage failures return a non-cacheable retryable response without private error data", async () => {
  const broken: ProgressDatabase = { prepare() { throw new Error("secret note / private database detail"); } };
  for (const response of [
    await getProgressResponse(alice, broken),
    await postProgressResponse(request(alice, [operation("read:lesson-1", true)]), alice, broken),
    await getProgressResponse(alice),
  ]) {
    assert.equal(response.status, 503);
    assert.match(response.headers.get("cache-control")!, /no-store/);
    const text = await response.text();
    assert.doesNotMatch(text, /secret note|private database detail/);
    assert.equal(JSON.parse(text).code, "STORAGE_UNAVAILABLE");
  }
});
