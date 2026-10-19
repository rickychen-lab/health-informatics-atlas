/** Durable progress storage. Identity is supplied only by the server's Sites session. */
export type SessionUser = { userId: string; displayName: string };
export type AnswerValue = { correct: boolean; selected: number; attempts: number; at: string };
export type ProgressValue = boolean | string | AnswerValue | null;
export type ProgressRecord = { value: ProgressValue; version: number; updatedAt: string | null };
export type ProgressOperation = { key: string; value: ProgressValue; baseVersion: number };

type StoredRow = { key: string; value_json: string; version: number; updated_at: string };
type BindValue = string | number | null;
export interface ProgressStatement {
  bind(...values: BindValue[]): ProgressStatement;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
}
export interface ProgressDatabase { prepare(query: string): ProgressStatement }

export const MAX_BODY_BYTES = 256 * 1024;
export const MAX_NOTE_LENGTH = 32 * 1024;
export const MAX_OPERATIONS = 100;

const keyPatterns = {
  boolean: /^(?:(?:read):[A-Za-z0-9][A-Za-z0-9_-]{0,95}|(?:check|lab):[A-Za-z0-9][A-Za-z0-9_-]{0,95}:[0-9]{1,4}|pref:zh)$/,
  answer: /^answer:[A-Za-z0-9][A-Za-z0-9_-]{0,95}:[0-9]{1,4}$/,
  note: /^note:(?:exercise|lab)-[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/,
};

class RequestFailure extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function privateJson(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
      Vary: "Cookie",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function failure(status: number, code: string, message: string): Response {
  return privateJson({ code, error: message }, status);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).length === allowed.length && allowed.every(key => Object.hasOwn(value, key));
}

function invalid(message: string): never {
  throw new RequestFailure(400, "INVALID_REQUEST", message);
}

/** Validates and canonicalises values so retried JSON objects compare consistently. */
export function validateOperations(body: unknown, authenticatedUserId: string): ProgressOperation[] {
  if (!isObject(body) || !hasOnlyKeys(body, ["expectedUserId", "operations"])) {
    invalid("The request must contain expectedUserId and operations only.");
  }
  if (typeof body.expectedUserId !== "string" || !body.expectedUserId) {
    invalid("expectedUserId is required.");
  }
  // This is an account-switch guard, never the source of authorization or a SQL owner ID.
  if (body.expectedUserId !== authenticatedUserId) {
    throw new RequestFailure(409, "ACCOUNT_CHANGED", "Your signed-in account changed. Reload before syncing.");
  }
  if (!Array.isArray(body.operations) || body.operations.length > MAX_OPERATIONS) {
    invalid(`Send no more than ${MAX_OPERATIONS} operations at once.`);
  }
  const seen = new Set<string>();
  return body.operations.map((input: unknown) => {
    if (!isObject(input) || !hasOnlyKeys(input, ["key", "value", "baseVersion"])) {
      invalid("Each operation must contain key, value and baseVersion only.");
    }
    const { key, value, baseVersion } = input;
    if (typeof key !== "string" || seen.has(key)) invalid("Progress keys must be valid and unique.");
    seen.add(key);
    if (!Number.isSafeInteger(baseVersion) || (baseVersion as number) < 0) {
      invalid("baseVersion must be a non-negative safe integer.");
    }
    const isBoolean = keyPatterns.boolean.test(key);
    const isAnswer = keyPatterns.answer.test(key);
    const isNote = keyPatterns.note.test(key);
    if (!isBoolean && !isAnswer && !isNote) invalid("Unknown progress key.");
    if (value === null) return { key, value: null, baseVersion: baseVersion as number };
    if (isBoolean) {
      if (typeof value !== "boolean") invalid("This progress value must be a boolean.");
      return { key, value, baseVersion: baseVersion as number };
    }
    if (isNote) {
      if (typeof value !== "string" || value.length > MAX_NOTE_LENGTH) {
        invalid(`Notes must be strings of at most ${MAX_NOTE_LENGTH} characters.`);
      }
      return { key, value, baseVersion: baseVersion as number };
    }
    if (!isObject(value) || !hasOnlyKeys(value, ["correct", "selected", "attempts", "at"])) {
      invalid("Invalid answer record.");
    }
    if (typeof value.correct !== "boolean" || !Number.isInteger(value.selected) ||
        (value.selected as number) < 0 || (value.selected as number) > 99 ||
        !Number.isSafeInteger(value.attempts) || (value.attempts as number) < 1 ||
        (value.attempts as number) > 1_000_000 || typeof value.at !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value.at) ||
        !Number.isFinite(Date.parse(value.at))) {
      invalid("Invalid answer record.");
    }
    return {
      key,
      baseVersion: baseVersion as number,
      value: {
        correct: value.correct,
        selected: value.selected as number,
        attempts: value.attempts as number,
        at: value.at,
      },
    };
  });
}

async function readLimitedJson(request: Request): Promise<unknown> {
  const advertisedLength = Number(request.headers.get("content-length"));
  if (advertisedLength > MAX_BODY_BYTES) {
    throw new RequestFailure(413, "REQUEST_TOO_LARGE", "Sync requests must be smaller than 256 KiB.");
  }
  if (!request.body) invalid("A JSON request body is required.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new RequestFailure(413, "REQUEST_TOO_LARGE", "Sync requests must be smaller than 256 KiB.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    invalid("The request must contain valid UTF-8 JSON.");
  }
}

function record(row: StoredRow): ProgressRecord {
  return { value: JSON.parse(row.value_json) as ProgressValue, version: row.version, updatedAt: row.updated_at };
}

export class ProgressStore {
  database: ProgressDatabase;
  constructor(database: ProgressDatabase) { this.database = database; }

  async list(userId: string): Promise<Record<string, ProgressRecord>> {
    const { results } = await this.database.prepare(
      "SELECT key, value_json, version, updated_at FROM progress_records WHERE user_id = ? ORDER BY key",
    ).bind(userId).all<StoredRow>();
    return Object.fromEntries(results.map(row => [row.key, record(row)]));
  }

  async apply(userId: string, operations: ProgressOperation[]): Promise<{
    applied: Record<string, ProgressRecord>; conflicts: Record<string, ProgressRecord>;
  }> {
    const applied: Record<string, ProgressRecord> = {};
    const conflicts: Record<string, ProgressRecord> = {};
    for (const operation of operations) {
      const valueJson = JSON.stringify(operation.value);
      const updatedAt = new Date().toISOString();
      // Each write is a single atomic SQL statement. Resets keep versioned null tombstones.
      const updated = operation.baseVersion === 0
        ? await this.database.prepare(
          `INSERT INTO progress_records (user_id, key, value_json, version, updated_at)
           VALUES (?, ?, ?, 1, ?) ON CONFLICT (user_id, key) DO NOTHING
           RETURNING key, value_json, version, updated_at`,
        ).bind(userId, operation.key, valueJson, updatedAt).first<StoredRow>()
        : await this.database.prepare(
          `UPDATE progress_records SET value_json = ?, version = version + 1, updated_at = ?
           WHERE user_id = ? AND key = ? AND version = ? AND value_json <> ?
           RETURNING key, value_json, version, updated_at`,
        ).bind(valueJson, updatedAt, userId, operation.key, operation.baseVersion, valueJson).first<StoredRow>();
      if (updated) {
        applied[operation.key] = record(updated);
        continue;
      }
      const current = await this.database.prepare(
        "SELECT key, value_json, version, updated_at FROM progress_records WHERE user_id = ? AND key = ?",
      ).bind(userId, operation.key).first<StoredRow>();
      if (current && current.value_json === valueJson) {
        // A lost response / repeated unchanged value is acknowledged without incrementing its version.
        applied[operation.key] = record(current);
      } else {
        conflicts[operation.key] = current ? record(current) : { value: null, version: 0, updatedAt: null };
      }
    }
    return { applied, conflicts };
  }
}

export async function getProgressResponse(user: SessionUser | null, database?: ProgressDatabase): Promise<Response> {
  if (!user) return failure(401, "AUTH_REQUIRED", "Sign in with ChatGPT to sync your progress.");
  if (!database) return failure(503, "STORAGE_UNAVAILABLE", "Account sync is temporarily unavailable.");
  try {
    return privateJson({ userId: user.userId, items: await new ProgressStore(database).list(user.userId) });
  } catch {
    return failure(503, "STORAGE_UNAVAILABLE", "Account sync is temporarily unavailable. Your local changes are safe.");
  }
}

export async function postProgressResponse(request: Request, user: SessionUser | null, database?: ProgressDatabase): Promise<Response> {
  if (!user) return failure(401, "AUTH_REQUIRED", "Sign in with ChatGPT to sync your progress.");
  if (request.headers.get("origin") !== new URL(request.url).origin ||
      ["cross-site", "same-site"].includes(request.headers.get("sec-fetch-site") || "")) {
    return failure(403, "ORIGIN_REJECTED", "Sync requests must come from this website.");
  }
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    return failure(415, "JSON_REQUIRED", "Use an application/json request body.");
  }
  try {
    const operations = validateOperations(await readLimitedJson(request), user.userId);
    if (!database) return failure(503, "STORAGE_UNAVAILABLE", "Account sync is temporarily unavailable.");
    const result = await new ProgressStore(database).apply(user.userId, operations);
    return privateJson({ userId: user.userId, ...result });
  } catch (error) {
    if (error instanceof RequestFailure) return failure(error.status, error.code, error.message);
    return failure(503, "STORAGE_UNAVAILABLE", "Account sync is temporarily unavailable. Your local changes are safe.");
  }
}
