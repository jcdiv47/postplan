// HTTP regressions for the fail-safe index boundary (issue #5).
//
// The unit tests in storage.test.ts inject fs/fault failures directly. These
// drive the real server and use the test-only seams (POSTPLAN_TEST_SEAMS=1) to
// corrupt the index on disk and schedule commit failures.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  startServer,
  publish,
  htmlDoc,
  fetchDraft,
  draftCount,
  getPage,
  csrfFrom,
  postDelete,
  setFault,
} from "./helpers.ts";
import type { TestServer } from "./helpers.ts";

const indexFile = (srv: TestServer): string => path.join(srv.dataDir, "index.json");
const draftDirs = (srv: TestServer): string[] =>
  fs.readdirSync(srv.dataDir).filter((name) => name !== "index.json" && !name.endsWith(".tmp"));

// ---------------------------------------------------------------------------
// Corrupt index: fail closed, change nothing, recover explicitly
// ---------------------------------------------------------------------------
test("a corrupt index turns mutations into 503s and preserves every byte", async (t) => {
  const srv = await startServer();
  t.after(srv.stop);

  const { draftId, versionNumber } = await publish(srv.base, srv.token, { html: htmlDoc("Safe", "original") });
  const goodIndex = fs.readFileSync(indexFile(srv));
  const htmlPath = path.join(srv.dataDir, draftId, `v${versionNumber}.html`);
  const goodHtml = fs.readFileSync(htmlPath);

  // Corrupt the live index.
  const corrupt = Buffer.from("{ corrupted, not json");
  fs.writeFileSync(indexFile(srv), corrupt);

  const res = await fetch(`${srv.base}/api/uploads`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${srv.token}` },
    body: JSON.stringify({ html: htmlDoc("Should not land") }),
  });
  assert.equal(res.status, 503, "a storage read failure is a generic 503");
  assert.equal((await res.json()).error, "Storage unavailable.");

  // Byte-for-byte: the corrupt index and the original HTML are untouched.
  assert.deepEqual(fs.readFileSync(indexFile(srv)), corrupt);
  assert.deepEqual(fs.readFileSync(htmlPath), goodHtml);
  assert.deepEqual(draftDirs(srv), [draftId], "no new draft directory appeared");

  // The process is alive.
  assert.equal((await fetch(`${srv.base}/healthz`)).status, 200);

  // Explicit recovery from the captured fixture, then the old Draft and a new
  // upload both work again.
  fs.writeFileSync(indexFile(srv), goodIndex);
  assert.equal(await draftCount(srv.base, srv.token), 1);
  const republished = await publish(srv.base, srv.token, { html: htmlDoc("Safe", "again"), draftId });
  assert.equal(republished.versionNumber, versionNumber + 1);
});

test("a missing index beside Draft content is a 503, never a new empty store", async (t) => {
  const srv = await startServer();
  t.after(srv.stop);

  const { draftId } = await publish(srv.base, srv.token, { html: htmlDoc("Still here") });
  fs.rmSync(indexFile(srv));

  const res = await fetch(`${srv.base}/api/uploads`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${srv.token}` },
    body: JSON.stringify({ html: htmlDoc("No") }),
  });
  assert.equal(res.status, 503);
  assert.equal(fs.existsSync(indexFile(srv)), false, "no empty index may be written");
  assert.deepEqual(draftDirs(srv), [draftId]);
});

// ---------------------------------------------------------------------------
// Fault injection at the commit boundary
// ---------------------------------------------------------------------------
test("an upload whose index commit fails leaves the old index and HTML intact", async (t) => {
  const srv = await startServer({ env: { POSTPLAN_TEST_SEAMS: "1" } });
  t.after(srv.stop);

  const { draftId, versionNumber } = await publish(srv.base, srv.token, { html: htmlDoc("D", "one") });
  const beforeIndex = fs.readFileSync(indexFile(srv));
  const beforeHtml = fs.readFileSync(path.join(srv.dataDir, draftId, `v${versionNumber}.html`));

  await setFault(srv.base, srv.token, "rename", 1);
  const res = await fetch(`${srv.base}/api/uploads`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${srv.token}` },
    body: JSON.stringify({ html: htmlDoc("D", "doomed"), draftId }),
  });
  assert.equal(res.status, 503);

  assert.deepEqual(fs.readFileSync(indexFile(srv)), beforeIndex, "index is byte-for-byte unchanged");
  assert.deepEqual(fs.readFileSync(path.join(srv.dataDir, draftId, `v${versionNumber}.html`)), beforeHtml);
  assert.deepEqual(
    fs.readdirSync(path.join(srv.dataDir, draftId)),
    [`v${versionNumber}.html`],
    "the failed upload's unreferenced bytes are cleaned up",
  );

  // The one-shot fault is spent: the next upload succeeds and numbering is sane.
  const retry = await publish(srv.base, srv.token, { html: htmlDoc("D", "after"), draftId });
  assert.equal(retry.versionNumber, versionNumber + 1);
});

test("a whole-draft delete whose commit fails removes nothing", async (t) => {
  const srv = await startServer({ env: { POSTPLAN_TEST_SEAMS: "1" } });
  t.after(srv.stop);

  const { draftId } = await publish(srv.base, srv.token, { html: htmlDoc("D", "keep") });
  const beforeIndex = fs.readFileSync(indexFile(srv));

  await setFault(srv.base, srv.token, "rename", 1);
  const res = await fetch(`${srv.base}/api/drafts/${draftId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${srv.token}` },
  });
  assert.equal(res.status, 503);

  assert.deepEqual(fs.readFileSync(indexFile(srv)), beforeIndex);
  const { status, text } = await fetchDraft(srv.base, draftId);
  assert.equal(status, 200, "the Draft must still be listed and servable");
  assert.ok(text.includes("keep"));
});

test("a single-version delete whose commit fails leaves that Version servable", async (t) => {
  const srv = await startServer({ env: { POSTPLAN_TEST_SEAMS: "1" } });
  t.after(srv.stop);

  const { draftId } = await publish(srv.base, srv.token, { html: htmlDoc("D", "one") });
  await publish(srv.base, srv.token, { html: htmlDoc("D", "two"), draftId });
  const beforeIndex = fs.readFileSync(indexFile(srv));

  await setFault(srv.base, srv.token, "rename", 1);
  const res = await fetch(`${srv.base}/api/drafts/${draftId}/v/1`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${srv.token}` },
  });
  assert.equal(res.status, 503);

  assert.deepEqual(fs.readFileSync(indexFile(srv)), beforeIndex);
  const v1 = await fetchDraft(srv.base, `${draftId}/v/1`);
  assert.equal(v1.status, 200);
  assert.ok(v1.text.includes("one"));
});

test("a Dashboard delete whose commit fails is a 503 and the Draft survives", async (t) => {
  const srv = await startServer({ env: { POSTPLAN_TEST_SEAMS: "1" } });
  t.after(srv.stop);
  const cookie = `pp_token=${srv.token}`;

  const { draftId } = await publish(srv.base, srv.token, { html: htmlDoc("Dashboard", "keep") });
  const csrf = csrfFrom((await getPage(srv.base, `/drafts/${draftId}/delete`, { cookie })).text);
  const beforeIndex = fs.readFileSync(indexFile(srv));

  await setFault(srv.base, srv.token, "rename", 1);
  const res = await postDelete(srv.base, `/drafts/${draftId}/delete`, { cookie, csrf });
  assert.equal(res.status, 503);
  assert.deepEqual(fs.readFileSync(indexFile(srv)), beforeIndex);

  const list = await getPage(srv.base, "/", { cookie });
  assert.ok(list.text.includes("Dashboard"), "the Draft must still be listed");
});

// ---------------------------------------------------------------------------
// Missing metadata vs unreadable content
// ---------------------------------------------------------------------------
test("an unreadable indexed Version is a logged 503, not a 404", async (t) => {
  const srv = await startServer();
  t.after(srv.stop);
  const { draftId } = await publish(srv.base, srv.token, { html: htmlDoc("Broken", "content") });

  // Replace the content file with a directory: readFileSync fails with EISDIR,
  // an I/O failure that must not masquerade as "Draft does not exist".
  const htmlPath = path.join(srv.dataDir, draftId, "v1.html");
  fs.rmSync(htmlPath);
  fs.mkdirSync(htmlPath);

  const res = await fetch(`${srv.base}/d/${draftId}`);
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, "Storage unavailable.");

  // A genuinely unknown Draft is still a 404, and a missing indexed file is too.
  assert.equal((await fetch(`${srv.base}/d/doesnotexist`)).status, 404);
  fs.rmdirSync(htmlPath);
  assert.equal((await fetch(`${srv.base}/d/${draftId}`)).status, 404);
});

// ---------------------------------------------------------------------------
// Crash leftovers must not wedge the store
// ---------------------------------------------------------------------------
test("an orphaned Version file left by a crash before commit does not block the next upload", async (t) => {
  const srv = await startServer();
  t.after(srv.stop);

  const { draftId } = await publish(srv.base, srv.token, { html: htmlDoc("Before") });
  // Bytes flushed for v2, then the process died before the index commit.
  fs.writeFileSync(path.join(srv.dataDir, draftId, "v2.html"), "orphan from a crash");

  const next = await publish(srv.base, srv.token, { html: htmlDoc("After", "fresh"), draftId });
  assert.equal(next.versionNumber, 2);
  const served = await fetchDraft(srv.base, draftId);
  assert.equal(served.status, 200);
  assert.match(served.text, /fresh/);
});

test("a fresh volume root holding only lost+found starts as an empty store", async (t) => {
  const srv = await startServer();
  t.after(srv.stop);
  fs.mkdirSync(path.join(srv.dataDir, "lost+found"));

  assert.equal(await draftCount(srv.base, srv.token), 0);
  await publish(srv.base, srv.token, { html: htmlDoc("First") });
  assert.equal(await draftCount(srv.base, srv.token), 1);
});
