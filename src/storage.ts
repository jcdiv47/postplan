// storage.ts — the on-disk index boundary (issue #5).
//
// index.json has exactly one writer per data directory, and this module is it.
// Two rules shape everything here:
//
//   1. A read must never invent state. A missing index is only an empty store
//      for a genuinely new/empty data directory; anything else is an error.
//   2. A mutation must never destroy committed state. Candidate metadata is
//      validated, fully written to a temporary file beside index.json, flushed,
//      and renamed over it. The rename is the commit boundary: before it the
//      old index is authoritative, after it the new one is (even if the
//      directory flush then fails).
//
// This is not a multi-process lock. The load/mutate/commit section in the
// server is synchronous and there is one server process per data directory;
// see the note in src/postplan.ts. Making this asynchronous would require
// serializing the whole read-modify-write, not just the final write.

import fs from "node:fs";
import path from "node:path";
import type { Draft, DraftIndex, Version } from "./types.ts";

/** Where a storage failure happened. Kept on the error for server diagnostics. */
export type StorageStage =
  | "read"
  | "parse"
  | "validate"
  | "presence"
  | "write"
  | "fsync"
  | "rename"
  | "dir-fsync"
  | "content-write"
  | "content-fsync"
  | "content-dir-fsync"
  | "parent-dir-fsync"
  | "uncertain";

/**
 * A storage failure safe to surface as a generic 503. `committed` is true only
 * for a failure *after* the rename: the new index is visible but its durability
 * is uncertain, so callers must retain any content it references.
 */
export class StorageError extends Error {
  readonly stage: StorageStage;
  readonly committed: boolean;

  constructor(message: string, stage: StorageStage, cause?: unknown, committed = false) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "StorageError";
    this.stage = stage;
    this.committed = committed;
  }
}

// ---------------------------------------------------------------------------
// Failure injection (test-only)
// ---------------------------------------------------------------------------
// Enabled only when POSTPLAN_TEST_SEAMS=1. `stage` fails every time;
// `stage@N` fails the next N times. Never enabled in normal deployments.
const faultCounters = new Map<string, number>();
let faultsLoaded = false;

function loadFaultsFromEnv(): void {
  if (faultsLoaded) return;
  faultsLoaded = true;
  if (process.env.POSTPLAN_TEST_SEAMS !== "1") return;
  for (const part of (process.env.POSTPLAN_STORAGE_FAULT || "").split(",")) {
    const [rawName, rawCount] = part.split("@");
    const name = rawName?.trim();
    if (!name) continue;
    const count = rawCount ? Number(rawCount) : Infinity;
    faultCounters.set(name, Number.isFinite(count) ? count : Infinity);
  }
}

function envFault(stage: string): boolean {
  loadFaultsFromEnv();
  const remaining = faultCounters.get(stage);
  if (remaining == null || remaining <= 0) return false;
  if (remaining !== Infinity) faultCounters.set(stage, remaining - 1);
  return true;
}

// ---------------------------------------------------------------------------
// Dependency seam (tests inject fs failures directly)
// ---------------------------------------------------------------------------
export interface StorageFs {
  readFileSync: typeof fs.readFileSync;
  writeFileSync: typeof fs.writeFileSync;
  openSync: typeof fs.openSync;
  closeSync: typeof fs.closeSync;
  fsyncSync: typeof fs.fsyncSync;
  renameSync: typeof fs.renameSync;
  unlinkSync: typeof fs.unlinkSync;
  rmdirSync: typeof fs.rmdirSync;
  existsSync: typeof fs.existsSync;
  mkdirSync: typeof fs.mkdirSync;
  readdirSync: typeof fs.readdirSync;
}

export interface StorageDeps {
  fs: StorageFs;
  /** Return true to inject a failure at `stage` before that step runs. */
  fault: (stage: StorageStage) => boolean;
}

const defaultDeps = (): StorageDeps => ({ fs, fault: envFault });

/**
 * Throws a StorageError when a test-only fault is scheduled at `stage`. Exposed
 * so content preparation in the server can participate in the same injection
 * seam as the index boundary; a no-op outside POSTPLAN_TEST_SEAMS=1.
 */
export function injectedFault(stage: StorageStage): void {
  if (envFault(stage)) throw new StorageError(`Injected fault at ${stage}`, stage);
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------
// Directories that this process has already initialised as empty stores. Once a
// directory is in here, a vanished index is an error even if the directory
// happens to be empty again — we do not silently re-create an empty store.
const initializedDirs = new Set<string>();

let loadCount = 0;
let parseCount = 0;
let commitCount = 0;
let uncertain = false;

export function storageStats(): { loads: number; parses: number; commits: number; uncertain: boolean } {
  return { loads: loadCount, parses: parseCount, commits: commitCount, uncertain };
}

/** Test-only reset of process-local storage state. */
export function __resetStorageState(): void {
  initializedDirs.clear();
  faultCounters.clear();
  faultsLoaded = false;
  loadCount = 0;
  parseCount = 0;
  commitCount = 0;
  uncertain = false;
}

/** Test-only: schedule `count` failures at `stage` (Infinity for permanent). */
export function __setStorageFault(stage: string, count: number): void {
  faultsLoaded = true; // do not let the env parse overwrite a programmatic set
  faultCounters.set(stage, count);
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as NodeJS.ErrnoException).code === "ENOENT";
}

function indexFile(dataDir: string): string {
  return path.join(dataDir, "index.json");
}

/**
 * Read and validate index.json. Returns `{}` only for a genuinely new/empty
 * data directory; every other failure throws a StorageError without touching
 * the filesystem.
 */
export function loadIndex(dataDir: string, deps: StorageDeps = defaultDeps()): DraftIndex {
  loadCount++;
  if (deps.fault("read")) throw new StorageError("Injected fault at read", "read");

  let raw: string;
  try {
    raw = deps.fs.readFileSync(indexFile(dataDir), "utf8") as string;
  } catch (err) {
    if (isNotFound(err)) return initializeOrThrow(dataDir, deps);
    throw new StorageError("Could not read index.json.", "read", err);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new StorageError("index.json is not valid JSON.", "parse", err);
  }
  parseCount++;
  validateIndex(parsed);
  // A store we have successfully read is ours: if it disappears later (while
  // the process runs), that is data loss, not a fresh directory.
  initializedDirs.add(dataDir);
  return parsed;
}

// A missing index is only "new" when nothing else suggests lost state.
function initializeOrThrow(dataDir: string, deps: StorageDeps): DraftIndex {
  if (initializedDirs.has(dataDir)) {
    throw new StorageError("index.json disappeared after the store was initialized.", "presence");
  }
  if (deps.fault("presence")) throw new StorageError("Injected fault at presence", "presence");

  let entries: string[];
  try {
    entries = deps.fs.readdirSync(dataDir) as string[];
  } catch (err) {
    if (isNotFound(err)) {
      // Materialise the empty store so the next reader sees a real index
      // rather than re-initialising (or, worse, re-initialising after loss).
      commitIndex(dataDir, {}, deps);
      initializedDirs.add(dataDir);
      return {};
    }
    throw new StorageError("Could not inspect the data directory.", "read", err);
  }

  if (entries.length > 0) {
    throw new StorageError(
      "index.json is missing but the data directory is not empty; refusing to create an empty store.",
      "presence",
    );
  }
  commitIndex(dataDir, {}, deps);
  initializedDirs.add(dataDir);
  return {};
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const RESERVED_IDS = new Set(["__proto__", "constructor", "prototype"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeDraftId(id: string): boolean {
  return SAFE_ID.test(id) && !RESERVED_IDS.has(id);
}

function isPositiveSafeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function invalid(message: string, cause?: unknown): never {
  throw new StorageError(message, "validate", cause);
}

function validateVersion(value: unknown, draftId: string): asserts value is Version {
  if (!isPlainObject(value)) invalid(`Draft "${draftId}" has a non-object Version.`);
  if (!isPositiveSafeInt(value.n)) invalid(`Draft "${draftId}" has a Version with an invalid number.`);
  // Every non-`n` Version field is required by the storage interface. Only a
  // missing `lastVersionNumber` on the Draft is a documented legacy shape, so
  // absent Version fields are corruption, not an older format.
  if (typeof value.sha256 !== "string") {
    invalid(`Draft "${draftId}" has a Version with a missing or non-string sha256.`);
  }
  if (!(typeof value.bytes === "number" && Number.isSafeInteger(value.bytes) && value.bytes >= 0)) {
    invalid(`Draft "${draftId}" has a Version with missing or invalid bytes.`);
  }
  if (typeof value.at !== "string") {
    invalid(`Draft "${draftId}" has a Version with a missing or non-string timestamp.`);
  }
  if (!("filename" in value) || (value.filename !== null && typeof value.filename !== "string")) {
    invalid(`Draft "${draftId}" has a Version with a missing or invalid filename.`);
  }
  if (!(Array.isArray(value.externalImageHosts) && value.externalImageHosts.every((h) => typeof h === "string"))) {
    invalid(`Draft "${draftId}" has a Version with missing or invalid externalImageHosts.`);
  }
}

function validateDraft(value: unknown, draftId: string): asserts value is Draft {
  if (!isPlainObject(value)) invalid(`Draft "${draftId}" is not an object.`);
  if (!Array.isArray(value.versions)) invalid(`Draft "${draftId}" has no versions array.`);
  if (value.versions.length === 0) invalid(`Draft "${draftId}" has an empty versions array.`);

  let previous = 0;
  const seen = new Set<number>();
  for (const version of value.versions) {
    validateVersion(version, draftId);
    if (seen.has(version.n)) invalid(`Draft "${draftId}" has a duplicate Version number ${version.n}.`);
    if (version.n <= previous) invalid(`Draft "${draftId}" has non-increasing Version numbers.`);
    seen.add(version.n);
    previous = version.n;
  }

  for (const key of ["title", "description", "updatedAt"] as const) {
    if (key in value && value[key] != null && typeof value[key] !== "string") {
      invalid(`Draft "${draftId}" has a non-string ${key}.`);
    }
  }
  if ("repo" in value && value.repo !== null && typeof value.repo !== "string") {
    invalid(`Draft "${draftId}" has an invalid repo.`);
  }
  if ("lastVersionNumber" in value && value.lastVersionNumber != null) {
    if (!isPositiveSafeInt(value.lastVersionNumber)) {
      invalid(`Draft "${draftId}" has an invalid lastVersionNumber.`);
    }
    if (value.lastVersionNumber < previous) {
      invalid(`Draft "${draftId}" has a lastVersionNumber below its highest Version.`);
    }
  }
}

/**
 * Runtime shape check for a persisted or candidate DraftIndex. Throws
 * StorageError("validate") on the first problem. Does not mutate or repair.
 */
export function validateIndex(value: unknown): asserts value is DraftIndex {
  if (!isPlainObject(value)) invalid("index.json must be a JSON object.");
  for (const [draftId, record] of Object.entries(value)) {
    if (!isSafeDraftId(draftId)) invalid(`Unsafe Draft id "${draftId}".`);
    validateDraft(record, draftId);
  }
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------
export interface CommitResult {
  /** Path of a temporary file that could not be removed after a pre-commit failure. */
  leftoverTemp: string | null;
}

function serialize(index: DraftIndex): string {
  return JSON.stringify(index, null, 2);
}

function fsyncDirectory(dataDir: string, deps: StorageDeps): void {
  // Directory fsync is meaningful on Linux/macOS. Windows does not support
  // opening a directory for fsync, so the rename's durability there is only as
  // strong as the filesystem's metadata journal.
  if (process.platform === "win32") return;
  let fd: number | undefined;
  try {
    fd = deps.fs.openSync(dataDir, "r") as number;
    deps.fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) {
      try { deps.fs.closeSync(fd); } catch { /* best effort */ }
    }
  }
}

/**
 * Atomically replace index.json with `index`.
 *
 * Stage order: validate -> temp write -> fsync file -> close -> rename ->
 * fsync directory. A failure before the rename leaves the previous index
 * byte-for-byte unchanged and removes this call's temporary file. A failure
 * after the rename means the new index is committed but not provably durable:
 * the module enters an uncertain state, further commits are refused, and the
 * caller must retain referenced content.
 */
export function commitIndex(dataDir: string, index: DraftIndex, deps: StorageDeps = defaultDeps()): CommitResult {
  if (uncertain) {
    throw new StorageError(
      "Refusing to commit: a previous commit's durability is uncertain; reconcile or restart.",
      "uncertain",
    );
  }
  commitCount++;

  // Validate the candidate before any filesystem work.
  validateIndex(index);
  if (deps.fault("validate")) throw new StorageError("Injected fault at validate", "validate");

  const serialized = serialize(index);
  const target = indexFile(dataDir);
  const tmp = path.join(dataDir, `.index.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);

  try {
    deps.fs.mkdirSync(dataDir, { recursive: true });
  } catch (err) {
    throw new StorageError("Could not create the data directory.", "write", err);
  }

  let fd: number | undefined;
  let leftoverTemp: string | null = null;
  try {
    if (deps.fault("write")) throw new StorageError("Injected fault at write", "write");
    fd = deps.fs.openSync(tmp, "wx", 0o600) as number;
    deps.fs.writeFileSync(fd, serialized);
    if (deps.fault("fsync")) throw new StorageError("Injected fault at fsync", "fsync");
    deps.fs.fsyncSync(fd);
    deps.fs.closeSync(fd);
    fd = undefined;

    if (deps.fault("rename")) throw new StorageError("Injected fault at rename", "rename");
    deps.fs.renameSync(tmp, target);
  } catch (err) {
    if (fd !== undefined) {
      try { deps.fs.closeSync(fd); } catch { /* do not mask the original failure */ }
    }
    try { deps.fs.unlinkSync(tmp); } catch { leftoverTemp = tmp; }
    if (err instanceof StorageError) throw err;
    throw new StorageError("Could not write index.json.", "write", err);
  }

  // Rename done: the new index is visible. Record the store so a later
  // disappearance is treated as loss, not as a fresh directory.
  initializedDirs.add(dataDir);

  // If the directory flush fails, we do not roll back — we cannot know whether
  // the rename survived a crash.
  try {
    if (deps.fault("dir-fsync")) throw new StorageError("Injected fault at dir-fsync", "dir-fsync");
    fsyncDirectory(dataDir, deps);
  } catch (err) {
    uncertain = true;
    throw new StorageError(
      "index.json was replaced but the data directory could not be flushed; durability is uncertain.",
      "dir-fsync",
      err,
      true,
    );
  }

  return { leftoverTemp };
}

/** True once a post-rename durability failure has been observed in this process. */
export function isStorageUncertain(): boolean {
  return uncertain;
}

// ---------------------------------------------------------------------------
// Version content
// ---------------------------------------------------------------------------
export interface ContentWriteResult {
  path: string;
  /** Removes the bytes this call created, and an empty Draft directory if it created one. */
  remove: () => void;
}

/**
 * Create one immutable Version file: exclusive create (`wx`, no clobber), write,
 * fsync the file, then fsync the directories whose entries the new file and
 * directory added. This runs before the index commit, so a failure here leaves
 * the previous index and all previously referenced content untouched and lets
 * the caller remove only the bytes it just created.
 *
 * File fsync does not necessarily persist the containing directory entry; the
 * directory flushes are what make the new filename survive a power loss.
 */
export function writeContentFile(
  directory: string,
  fileName: string,
  contents: string,
  deps: StorageDeps = defaultDeps(),
): ContentWriteResult {
  const finalPath = path.join(directory, fileName);
  const parent = path.dirname(directory);
  const parentExisted = deps.fs.existsSync(parent);
  const dirExisted = deps.fs.existsSync(directory);
  let fd: number | undefined;
  let created = false;

  try {
    deps.fs.mkdirSync(directory, { recursive: true });

    // Persist any directory entries mkdir just created, closest to the root
    // first: the Draft directory's entry in its parent, then (if the parent was
    // also new) the parent's own entry.
    if (!parentExisted) {
      if (deps.fault("parent-dir-fsync")) throw new StorageError("Injected fault at parent-dir-fsync", "parent-dir-fsync");
      fsyncDirectory(path.dirname(parent), deps);
    }
    if (!dirExisted) {
      if (deps.fault("parent-dir-fsync")) throw new StorageError("Injected fault at parent-dir-fsync", "parent-dir-fsync");
      fsyncDirectory(parent, deps);
    }

    if (deps.fault("content-write")) throw new StorageError("Injected fault at content-write", "content-write");
    fd = deps.fs.openSync(finalPath, "wx", 0o600) as number;
    created = true;
    deps.fs.writeFileSync(fd, contents);
    if (deps.fault("content-fsync")) throw new StorageError("Injected fault at content-fsync", "content-fsync");
    deps.fs.fsyncSync(fd);
    deps.fs.closeSync(fd);
    fd = undefined;

    // Persist the new filename entry in the Draft directory.
    if (deps.fault("content-dir-fsync")) throw new StorageError("Injected fault at content-dir-fsync", "content-dir-fsync");
    fsyncDirectory(directory, deps);
  } catch (err) {
    if (fd !== undefined) {
      try { deps.fs.closeSync(fd); } catch { /* do not mask the original failure */ }
    }
    if (created) {
      try { deps.fs.unlinkSync(finalPath); } catch { /* best effort */ }
    }
    if (!dirExisted) {
      try { deps.fs.rmdirSync(directory); } catch { /* only succeeds when empty */ }
    }
    if (err instanceof StorageError) throw err;
    throw new StorageError("Could not write Version content.", "write", err);
  }

  return {
    path: finalPath,
    remove: () => {
      try { deps.fs.unlinkSync(finalPath); } catch { /* best effort */ }
      if (!dirExisted) {
        try { deps.fs.rmdirSync(directory); } catch { /* only succeeds when empty */ }
      }
    },
  };
}
