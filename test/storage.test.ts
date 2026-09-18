// Unit tests for the storage boundary (issue #5).
//
// These import the module directly — the source under `npm test`, the build
// under `npm run test:dist` — and inject filesystem/fault dependencies so the
// interesting failures are deterministic instead of chmod-dependent.

import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { REPO_ROOT } from "./helpers.ts";
import type { StorageDeps, StorageFs } from "../src/storage.ts";
import type { Version } from "../src/types.ts";

const storagePath = process.env.POSTPLAN_TEST_TARGET
  ? path.join(REPO_ROOT, "dist", "storage.js")
  : path.join(REPO_ROOT, "src", "storage.ts");
const storage = (await import(storagePath)) as typeof import("../src/storage.ts");

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "postplan-storage-"));
}

function makeDeps(faults: string[] = [], overrides: Partial<StorageFs> = {}): StorageDeps {
  return {
    fs: { ...fs, ...overrides } as StorageFs,
    fault: (stage: string) => faults.includes(stage),
  };
}

function indexPath(dir: string): string {
  return path.join(dir, "index.json");
}

function readIndexBytes(dir: string): string {
  return fs.readFileSync(indexPath(dir), "utf8");
}

const validVersion = (n: number): Version => ({
  n,
  sha256: "a".repeat(64),
  bytes: 10,
  at: "2024-01-01T00:00:00.000Z",
  filename: null,
  externalImageHosts: [],
});

beforeEach(() => storage.__resetStorageState());

// ---------------------------------------------------------------------------
// Initialization vs. reading
// ---------------------------------------------------------------------------
test("a fresh empty directory initializes an empty store on disk", () => {
  const dir = tempDir();
  const index = storage.loadIndex(dir, makeDeps());
  assert.deepEqual(index, {});
  assert.equal(readIndexBytes(dir).trim(), "{}", "the empty store must be materialized");
});

test("a missing index beside a Draft directory is an error, not a new store", () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, "somedraft"));
  assert.throws(() => storage.loadIndex(dir, makeDeps()), (err: unknown) => {
    assert.ok(err instanceof storage.StorageError);
    assert.equal((err as InstanceType<typeof storage.StorageError>).stage, "presence");
    return true;
  });
  assert.equal(fs.existsSync(indexPath(dir)), false, "no empty index may be written");
});

test("a missing index after initialization is an error even if the directory is empty", () => {
  const dir = tempDir();
  storage.loadIndex(dir, makeDeps()); // initializes
  fs.rmSync(indexPath(dir));
  assert.throws(() => storage.loadIndex(dir, makeDeps()), /disappeared|missing/i);
});

test("malformed JSON is rejected without rewriting the file", () => {
  const dir = tempDir();
  fs.mkdirSync(dir, { recursive: true });
  const bytes = "{ this is not json";
  fs.writeFileSync(indexPath(dir), bytes);
  assert.throws(() => storage.loadIndex(dir, makeDeps()), /not valid JSON/i);
  assert.equal(readIndexBytes(dir), bytes, "the damaged file is preserved for diagnosis");
});

// ---------------------------------------------------------------------------
// Shape validation
// ---------------------------------------------------------------------------
for (const [label, value] of [
  ["null", "null"],
  ["an array", "[]"],
  ["a string", '"hi"'],
] as Array<[string, string]>) {
  test(`a persisted index that is ${label} is rejected`, () => {
    const dir = tempDir();
    fs.writeFileSync(indexPath(dir), value);
    assert.throws(() => storage.loadIndex(dir, makeDeps()), /must be a JSON object/i);
  });
}

test("non-object Draft records and invalid Version structures are rejected", () => {
  const cases: Array<Record<string, unknown>> = [
    { draft: 42 },
    { draft: { versions: "nope" } },
    { draft: { versions: [] } },
    { draft: { versions: [{ n: 0 }] } },
    { draft: { versions: [{ n: -1 }] } },
    { draft: { versions: [{ n: 1 }, { n: 1 }] } },
    { draft: { versions: [{ n: 2 }, { n: 1 }] } },
    { draft: { versions: [{ n: 1, bytes: -5 }] } },
  ];
  for (const candidate of cases) {
    const dir = tempDir();
    fs.writeFileSync(indexPath(dir), JSON.stringify(candidate));
    assert.throws(() => storage.loadIndex(dir, makeDeps()), storage.StorageError, JSON.stringify(candidate));
  }
});

test("lastVersionNumber must be at least the highest surviving Version", () => {
  const dir = tempDir();
  fs.writeFileSync(
    indexPath(dir),
    JSON.stringify({ draft: { versions: [validVersion(1), validVersion(3)], lastVersionNumber: 2 } }),
  );
  assert.throws(() => storage.loadIndex(dir, makeDeps()), /lastVersionNumber below/i);
});

test("unsafe Draft ids are rejected", () => {
  const dir = tempDir();
  // Written as raw JSON: an object literal's __proto__ key sets the prototype
  // rather than becoming an own property, so JSON.stringify would drop it.
  fs.writeFileSync(indexPath(dir), `{"__proto__":{"versions":[${JSON.stringify(validVersion(1))}]}}`);
  assert.throws(() => storage.loadIndex(dir, makeDeps()), /Unsafe Draft id/i);
});

test("a legacy record without lastVersionNumber still loads", () => {
  const dir = tempDir();
  const record = { versions: [validVersion(1), validVersion(3)] };
  fs.writeFileSync(indexPath(dir), JSON.stringify({ legacy: record }));
  const index = storage.loadIndex(dir, makeDeps());
  assert.deepEqual(Object.keys(index), ["legacy"]);
  assert.equal(index.legacy!.versions.length, 2);
});

// ---------------------------------------------------------------------------
// Atomic commit
// ---------------------------------------------------------------------------
test("a pre-rename write failure leaves the previous index byte-for-byte unchanged", () => {
  const dir = tempDir();
  const good = { draft: { versions: [validVersion(1)], lastVersionNumber: 1 } };
  storage.commitIndex(dir, good, makeDeps());
  const before = readIndexBytes(dir);

  assert.throws(() => storage.commitIndex(dir, { other: { versions: [validVersion(1)] } }, makeDeps(["write"])), storage.StorageError);
  assert.equal(readIndexBytes(dir), before);
  assert.deepEqual(
    fs.readdirSync(dir).filter((name) => name.endsWith(".tmp")),
    [],
    "the failed operation's temporary file is removed",
  );
});

test("a rename failure leaves the previous index byte-for-byte unchanged", () => {
  const dir = tempDir();
  storage.commitIndex(dir, { draft: { versions: [validVersion(1)] } }, makeDeps());
  const before = readIndexBytes(dir);

  assert.throws(() => storage.commitIndex(dir, {}, makeDeps(["rename"])), storage.StorageError);
  assert.equal(readIndexBytes(dir), before);
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp")), []);
});

test("a file-fsync failure leaves the previous index byte-for-byte unchanged", () => {
  const dir = tempDir();
  storage.commitIndex(dir, { draft: { versions: [validVersion(1)] } }, makeDeps());
  const before = readIndexBytes(dir);

  assert.throws(() => storage.commitIndex(dir, {}, makeDeps(["fsync"])), storage.StorageError);
  assert.equal(readIndexBytes(dir), before);
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp")), []);
});

test("a filesystem write error (not just an injected fault) is contained", () => {
  const dir = tempDir();
  storage.commitIndex(dir, { draft: { versions: [validVersion(1)] } }, makeDeps());
  const before = readIndexBytes(dir);
  const failing = makeDeps([], {
    writeFileSync: (() => {
      throw new Error("disk full");
    }) as unknown as StorageFs["writeFileSync"],
  });
  assert.throws(() => storage.commitIndex(dir, {}, failing), storage.StorageError);
  assert.equal(readIndexBytes(dir), before);
});

test("an invalid candidate is rejected before anything is written", () => {
  const dir = tempDir();
  assert.throws(
    () => storage.commitIndex(dir, { bad: { versions: [{ n: 0 }] } } as never, makeDeps()),
    storage.StorageError,
  );
  assert.equal(fs.existsSync(indexPath(dir)), false, "no index is created for a rejected candidate");
});

test("a post-rename directory-flush failure is flagged uncertain and blocks further commits", () => {
  const dir = tempDir();
  storage.commitIndex(dir, { draft: { versions: [validVersion(1)] } }, makeDeps());
  const before = readIndexBytes(dir);

  assert.throws(
    () => storage.commitIndex(dir, { other: { versions: [validVersion(1)] } }, makeDeps(["dir-fsync"])),
    (err: unknown) => {
      assert.ok(err instanceof storage.StorageError);
      assert.equal((err as InstanceType<typeof storage.StorageError>).committed, true);
      return true;
    },
  );
  assert.equal(storage.isStorageUncertain(), true);
  // The rename did commit: the new index is visible.
  assert.notEqual(readIndexBytes(dir), before);
  // Further commits refuse until reconciliation/restart.
  assert.throws(() => storage.commitIndex(dir, {}, makeDeps()), /uncertain/i);
});
