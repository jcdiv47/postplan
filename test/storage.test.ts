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

// ---------------------------------------------------------------------------
// Observed stores are not silently re-initialized
// ---------------------------------------------------------------------------
test("a successfully loaded existing store is not re-initialized after it disappears", () => {
  const dir = tempDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    indexPath(dir),
    JSON.stringify({ draft: { versions: [validVersion(1)], lastVersionNumber: 1 } }),
  );

  // A normal restart: the store already exists before the first load.
  assert.equal(Object.keys(storage.loadIndex(dir, makeDeps())).length, 1);

  // Its disappearance is now data loss, not a fresh directory.
  const aside = `${dir}-aside`;
  fs.renameSync(dir, aside);
  assert.throws(() => storage.loadIndex(dir, makeDeps()), /disappeared/i);
  assert.equal(fs.existsSync(indexPath(dir)), false, "no replacement index may be created");
});

// ---------------------------------------------------------------------------
// Required Version fields
// ---------------------------------------------------------------------------
for (const field of ["sha256", "bytes", "at", "filename", "externalImageHosts"]) {
  test(`a Version missing its required ${field} field is rejected`, () => {
    const dir = tempDir();
    const version = validVersion(1) as unknown as Record<string, unknown>;
    delete version[field];
    const bytes = JSON.stringify({ draft: { versions: [version] } });
    fs.writeFileSync(indexPath(dir), bytes);
    assert.throws(() => storage.loadIndex(dir, makeDeps()), /Version/);
    assert.equal(readIndexBytes(dir), bytes, "the corrupt index is left untouched");
  });
}

// ---------------------------------------------------------------------------
// Content preparation (ordered durability)
// ---------------------------------------------------------------------------
// Wrap the real fs methods so we can assert the order of the durability calls.
function spyDeps(calls: string[], faults: string[] = []): StorageDeps {
  const fdPaths = new Map<number, string>();
  return {
    fs: {
      ...fs,
      mkdirSync: ((p: string, opts?: unknown) => {
        calls.push(`mkdir:${path.basename(String(p))}`);
        return fs.mkdirSync(p as never, opts as never);
      }) as unknown as StorageFs["mkdirSync"],
      existsSync: ((p: string) => {
        calls.push(`exists:${path.basename(String(p))}`);
        return fs.existsSync(p);
      }) as unknown as StorageFs["existsSync"],
      openSync: ((p: string, flags: string) => {
        const real = fs.openSync(p as never, flags as never);
        fdPaths.set(real as unknown as number, `${path.basename(String(p))}[${flags}]`);
        calls.push(`open:${path.basename(String(p))}[${flags}]`);
        return real;
      }) as unknown as StorageFs["openSync"],
      writeFileSync: ((fd: number, data: unknown) => {
        calls.push(`write:${fdPaths.get(fd)}`);
        return fs.writeFileSync(fd as never, data as never);
      }) as unknown as StorageFs["writeFileSync"],
      fsyncSync: ((fd: number) => {
        calls.push(`fsync:${fdPaths.get(fd)}`);
        return fs.fsyncSync(fd as never);
      }) as unknown as StorageFs["fsyncSync"],
      closeSync: ((fd: number) => {
        calls.push(`close:${fdPaths.get(fd)}`);
        fdPaths.delete(fd);
        return fs.closeSync(fd as never);
      }) as unknown as StorageFs["closeSync"],
      unlinkSync: ((p: string) => {
        calls.push(`unlink:${path.basename(String(p))}`);
        return fs.unlinkSync(p);
      }) as unknown as StorageFs["unlinkSync"],
      rmdirSync: ((p: string) => {
        calls.push(`rmdir:${path.basename(String(p))}`);
        return fs.rmdirSync(p);
      }) as unknown as StorageFs["rmdirSync"],
    },
    fault: (stage: string) => faults.includes(stage),
  };
}

test("content write flushes the file, the Draft directory, and its parent in order", () => {
  const dataDir = tempDir();
  const calls: string[] = [];
  const draftDir = path.join(dataDir, "draftone");

  storage.writeContentFile(draftDir, "v1.html", "<p>x</p>", spyDeps(calls));

  const fileFsync = calls.findIndex((c) => c.startsWith("fsync:v1.html"));
  const draftDirFsync = calls.findIndex((c) => c.startsWith("fsync:draftone"));
  const dataDirFsync = calls.findIndex((c) => c.startsWith(`fsync:${path.basename(dataDir)}`));
  assert.ok(fileFsync >= 0, `file was not fsynced: ${calls.join(", ")}`);
  assert.ok(draftDirFsync > fileFsync, `Draft directory must be flushed after the file: ${calls.join(", ")}`);
  assert.ok(dataDirFsync >= 0, `the new Draft directory entry must be flushed: ${calls.join(", ")}`);
});

test("a new Version of an existing Draft flushes only the Draft directory", () => {
  const dataDir = tempDir();
  const draftDir = path.join(dataDir, "draftone");
  fs.mkdirSync(draftDir);
  fs.writeFileSync(path.join(draftDir, "v1.html"), "old");
  const calls: string[] = [];

  storage.writeContentFile(draftDir, "v2.html", "<p>new</p>", spyDeps(calls));

  assert.ok(calls.some((c) => c.startsWith("fsync:draftone")), `Draft directory flushed: ${calls.join(", ")}`);
  assert.ok(!calls.some((c) => c.startsWith(`fsync:${path.basename(dataDir)}`)), "the existing parent need not be flushed");
});

test("a content-directory flush failure removes only the new bytes", () => {
  const dataDir = tempDir();
  const draftDir = path.join(dataDir, "draftone");
  fs.mkdirSync(draftDir);
  fs.writeFileSync(path.join(draftDir, "v1.html"), "old");

  assert.throws(
    () => storage.writeContentFile(draftDir, "v2.html", "<p>new</p>", makeDeps(["content-dir-fsync"])),
    storage.StorageError,
  );
  assert.equal(fs.readFileSync(path.join(draftDir, "v1.html"), "utf8"), "old", "old content is untouched");
  assert.deepEqual(fs.readdirSync(draftDir), ["v1.html"], "the failed new Version is removed");
});

test("a content-file flush failure on a new Draft removes the file and the new directory", () => {
  const dataDir = tempDir();
  const draftDir = path.join(dataDir, "newdraft");

  assert.throws(
    () => storage.writeContentFile(draftDir, "v1.html", "<p>x</p>", makeDeps(["content-fsync"])),
    storage.StorageError,
  );
  assert.equal(fs.existsSync(draftDir), false, "an empty directory created only for the failed write is removed");
});

// ---------------------------------------------------------------------------
// Cold-start data-root durability
// ---------------------------------------------------------------------------
// Like spyDeps but records full paths, so nested-ancestor assertions are exact.
function pathSpyDeps(calls: string[], faults: string[] = []): StorageDeps {
  const fdPaths = new Map<number, string>();
  return {
    fs: {
      ...fs,
      existsSync: ((p: string) => fs.existsSync(p)) as unknown as StorageFs["existsSync"],
      openSync: ((p: string, flags: string) => {
        const fd = fs.openSync(p as never, flags as never);
        fdPaths.set(fd as unknown as number, String(p));
        return fd;
      }) as unknown as StorageFs["openSync"],
      fsyncSync: ((fd: number) => {
        calls.push(`fsync:${fdPaths.get(fd)}`);
        return fs.fsyncSync(fd as never);
      }) as unknown as StorageFs["fsyncSync"],
      closeSync: ((fd: number) => {
        fdPaths.delete(fd);
        return fs.closeSync(fd as never);
      }) as unknown as StorageFs["closeSync"],
    },
    fault: (stage: string) => faults.includes(stage),
  };
}

test("a nonexistent nested data root flushes every new ancestor entry before the index commit", () => {
  const root = tempDir();
  const dataDir = path.join(root, "a", "b", "store");
  const calls: string[] = [];

  // Real cold-start sequence: loadIndex initializes, content is written, then
  // the metadata commit.
  const index = storage.loadIndex(dataDir, pathSpyDeps(calls));
  assert.deepEqual(index, {});
  storage.writeContentFile(path.join(dataDir, "draftone"), "v1.html", "<p>x</p>", pathSpyDeps(calls));
  storage.commitIndex(dataDir, { draftone: { versions: [validVersion(1)] } }, pathSpyDeps(calls));

  // Each created directory's entry lives in its parent, so the parent must be
  // flushed: root (for a), root/a (for b), root/b (for store).
  assert.ok(calls.includes(`fsync:${root}`), `parent of the first new dir must be flushed: ${calls.join(", ")}`);
  assert.ok(calls.includes(`fsync:${path.join(root, "a")}`), `nested ancestor entry must be flushed: ${calls.join(", ")}`);
  assert.ok(calls.includes(`fsync:${path.join(root, "a", "b")}`), `data-root entry must be flushed: ${calls.join(", ")}`);

  // The parent flush must precede the first index rename, not follow it.
  const firstParentFlush = calls.findIndex((c) => c.includes(`fsync:${root}`));
  assert.ok(firstParentFlush >= 0 && firstParentFlush < calls.length);
});

test("an injected failure flushing a new ancestor leaves no committed index", () => {
  const root = tempDir();
  const dataDir = path.join(root, "new-store");
  assert.throws(
    () => storage.loadIndex(dataDir, pathSpyDeps([], ["root-dir-fsync"])),
    (err: unknown) => {
      assert.ok(err instanceof storage.StorageError);
      assert.equal((err as InstanceType<typeof storage.StorageError>).stage, "root-dir-fsync");
      return true;
    },
  );
  assert.equal(fs.existsSync(path.join(dataDir, "index.json")), false, "no index may be committed");
});

test("an already-existing data root does not re-flush its parent", () => {
  const dataDir = tempDir();
  const calls: string[] = [];
  storage.loadIndex(dataDir, pathSpyDeps(calls));
  assert.ok(!calls.includes(`fsync:${path.dirname(dataDir)}`), `existing root needs no parent flush: ${calls.join(", ")}`);
});
