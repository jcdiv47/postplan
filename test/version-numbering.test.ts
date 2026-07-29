// Regression tests for how the next Version number is chosen (issue #1).
//
// The rule, from CONTEXT.md and types.ts: publishing a Draft again adds a
// Version and never replaces one, and deleting a Version retires its number for
// good. Numbering off `versions.length` broke both — the array shrinks on
// delete, so the count stops tracking what was issued.
//
// These drive the real HTTP API: publish, then DELETE /api/drafts/<id>/v/<n>,
// then publish again and check what number came back and what is stored.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { startServer, publish, htmlDoc, fetchDraft } from "./helpers.ts";
import type { TestServer } from "./helpers.ts";

interface DetailVersion {
  n: number;
  sha256: string;
  url: string;
}

async function detail(srv: TestServer, draftId: string): Promise<{ versions: DetailVersion[] }> {
  const res = await fetch(`${srv.base}/api/drafts/${draftId}`, {
    headers: { Authorization: `Bearer ${srv.token}` },
  });
  assert.equal(res.status, 200);
  return (await res.json()) as { versions: DetailVersion[] };
}

async function deleteVersion(srv: TestServer, draftId: string, n: number): Promise<number> {
  const res = await fetch(`${srv.base}/api/drafts/${draftId}/v/${n}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${srv.token}` },
  });
  return res.status;
}

// Publish three Versions of one Draft, distinguishable by their body text.
async function publishThree(srv: TestServer): Promise<string> {
  const { draftId } = await publish(srv.base, srv.token, { html: htmlDoc("D", "one") });
  for (const body of ["two", "three"]) {
    const res = await publish(srv.base, srv.token, { html: htmlDoc("D", body), draftId });
    assert.equal(res.draftId, draftId);
  }
  return draftId;
}

test("deleting a middle version does not reissue a live number", async (t) => {
  const srv = await startServer();
  t.after(srv.stop);

  const draftId = await publishThree(srv);
  assert.deepEqual((await detail(srv, draftId)).versions.map((v) => v.n), [1, 2, 3]);

  assert.equal(await deleteVersion(srv, draftId, 2), 200);

  // The bug: length is now 2, so the next upload was numbered 3 — overwriting
  // v3.html and filing a second entry with n: 3.
  const republished = await publish(srv.base, srv.token, { html: htmlDoc("D", "four"), draftId });
  assert.equal(republished.versionNumber, 4);

  const { versions } = await detail(srv, draftId);
  assert.deepEqual(versions.map((v) => v.n), [1, 3, 4], "2 stays retired, nothing is renumbered");
  assert.equal(new Set(versions.map((v) => v.n)).size, versions.length, "version numbers must be unique");
});

test("deleting the newest version retires its number too", async (t) => {
  const srv = await startServer();
  t.after(srv.stop);

  const draftId = await publishThree(srv);
  assert.equal(await deleteVersion(srv, draftId, 3), 200);

  // Nothing surviving records that 3 was ever issued — only the stored counter
  // does, which is why it is stored.
  const republished = await publish(srv.base, srv.token, { html: htmlDoc("D", "four"), draftId });
  assert.equal(republished.versionNumber, 4);
  assert.deepEqual((await detail(srv, draftId)).versions.map((v) => v.n), [1, 2, 4]);
});

test("an existing version's bytes are never overwritten by a later upload", async (t) => {
  const srv = await startServer();
  t.after(srv.stop);

  const draftId = await publishThree(srv);
  const before = (await detail(srv, draftId)).versions.find((v) => v.n === 3)!;
  const v3Html = await fetch(before.url).then((r) => r.text());

  assert.equal(await deleteVersion(srv, draftId, 2), 200);
  await publish(srv.base, srv.token, { html: htmlDoc("D", "four"), draftId });

  const after = (await detail(srv, draftId)).versions.find((v) => v.n === 3)!;
  assert.equal(after.sha256, before.sha256, "v3's digest must not change");
  assert.equal(await fetch(after.url).then((r) => r.text()), v3Html, "v3 must still serve its own bytes");
  assert.ok(v3Html.includes("three"), "sanity: v3 is the third upload, not the fourth");
});

test("repeated delete-then-publish keeps numbers strictly increasing", async (t) => {
  const srv = await startServer();
  t.after(srv.stop);

  // Two to begin with: v1 is never deleted, so the Draft always outlives a
  // round. Deleting the last surviving Version would remove the Draft itself.
  const { draftId } = await publish(srv.base, srv.token, { html: htmlDoc("D", "keep") });
  const issued = [1, (await publish(srv.base, srv.token, { html: htmlDoc("D", "2"), draftId })).versionNumber];

  // Each round deletes the newest Version and publishes a fresh one. Numbering
  // off the surviving array would hand back the same number every time.
  for (let i = 0; i < 4; i++) {
    assert.equal(await deleteVersion(srv, draftId, issued[issued.length - 1]!), 200);
    const { versionNumber } = await publish(srv.base, srv.token, { html: htmlDoc("D", `r${i}`), draftId });
    assert.ok(
      versionNumber > issued[issued.length - 1]!,
      `round ${i}: ${versionNumber} should exceed ${issued[issued.length - 1]}`,
    );
    issued.push(versionNumber);
  }

  assert.deepEqual(issued, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual((await detail(srv, draftId)).versions.map((v) => v.n), [1, 6]);
});

test("an index written before lastVersionNumber existed still numbers correctly", async (t) => {
  const srv = await startServer();
  t.after(srv.stop);

  const draftId = await publishThree(srv);

  // Rewrite index.json as the pre-fix server would have left it: no counter.
  const indexPath = path.join(srv.dataDir, "index.json");
  const idx = JSON.parse(fs.readFileSync(indexPath, "utf8")) as Record<string, { lastVersionNumber?: number }>;
  delete idx[draftId]!.lastVersionNumber;
  fs.writeFileSync(indexPath, JSON.stringify(idx, null, 2));

  const { versionNumber } = await publish(srv.base, srv.token, { html: htmlDoc("D", "four"), draftId });
  assert.equal(versionNumber, 4, "backfilled from the highest surviving version");

  const { versions } = await detail(srv, draftId);
  assert.equal(new Set(versions.map((v) => v.n)).size, versions.length);
});

test("deleting every version drops the draft, so no number is reused", async (t) => {
  const srv = await startServer();
  t.after(srv.stop);

  const { draftId } = await publish(srv.base, srv.token, { html: htmlDoc("D", "only") });
  assert.equal(await deleteVersion(srv, draftId, 1), 200);

  // The Draft is gone with it, so the id cannot be republished into.
  const { status } = await fetchDraft(srv.base, draftId);
  assert.equal(status, 404);

  const fresh = await publish(srv.base, srv.token, { html: htmlDoc("D", "new"), draftId });
  assert.notEqual(fresh.draftId, draftId, "a dead id starts a new draft");
  assert.equal(fresh.versionNumber, 1);
});
