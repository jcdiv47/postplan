// Rendering tests for the dashboard's pure functions (ui.ts).
//
// The escaping cases matter most: a draft's title is extracted from uploaded
// HTML, so it is attacker-controlled, and it is rendered on the one page that
// carries the session cookie.

import test from "node:test";
import assert from "node:assert/strict";

import { escapeHtml, renderConfirm, renderList, renderVersions } from "../src/ui.ts";
import type { DraftDetail, DraftSummary } from "../src/types.ts";

const draft = (over: Partial<DraftSummary> = {}): DraftSummary => ({
  draftId: "abc123def456",
  title: "Quarterly plan",
  description: null,
  repo: "jcdiv47/postplan",
  latestVersionNumber: 2,
  versionCount: 2,
  updatedAt: "2026-07-22T10:31:00.000Z",
  publicUrl: "https://example.test/d/abc123def456",
  ...over,
});

const detail = (over: Partial<DraftDetail> = {}): DraftDetail => ({
  draftId: "abc123def456",
  title: "Quarterly plan",
  description: null,
  repo: "jcdiv47/postplan",
  updatedAt: "2026-07-22T10:31:00.000Z",
  publicUrl: "https://example.test/d/abc123def456",
  versions: [
    { n: 1, bytes: 2048, at: "2026-07-21T09:00:00.000Z", filename: "plan.html", sha256: "a".repeat(64), externalImageHosts: [], url: "https://example.test/d/abc123def456/v/1" },
    { n: 2, bytes: 4096, at: "2026-07-22T10:31:00.000Z", filename: "plan.html", sha256: "b".repeat(64), externalImageHosts: [], url: "https://example.test/d/abc123def456/v/2" },
  ],
  ...over,
});

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------
test("escapeHtml neutralises every HTML-significant character", () => {
  assert.equal(escapeHtml(`<a href="x" title='y'>&</a>`), "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(undefined), "");
  assert.equal(escapeHtml(0), "0");
});

test("a draft title containing a script tag is rendered inert", () => {
  const out = renderList([draft({ title: "<script>alert(1)</script>" })]);
  assert.ok(!out.includes("<script>alert(1)</script>"), "raw script tag must not survive");
  assert.ok(out.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  // The only <script> on the page is our own external one.
  assert.deepEqual(out.match(/<script[^>]*>/g), ['<script src="/static/app.js">']);
});

test("a title that tries to break out of an attribute cannot", () => {
  const out = renderList([draft({ title: `" onmouseover="alert(1)` })]);
  assert.ok(!out.includes('onmouseover="alert(1)"'), "must not produce a live event handler");
  assert.ok(out.includes("&quot; onmouseover=&quot;alert(1)"));
});

test("descriptions and repo names are escaped too", () => {
  const out = renderList([draft({ description: "<img onerror=x>", repo: "<b>evil</b>" })]);
  assert.ok(!out.includes("<img onerror=x>"));
  assert.ok(!out.includes("<b>evil</b>"));
});

test("the filter haystack is escaped and lowercased", () => {
  const out = renderList([draft({ title: "<Shanghai>", description: "Daning" })]);
  const m = out.match(/data-search="([^"]*)"/);
  assert.ok(m, "every draft carries a data-search attribute");
  assert.ok(!m[1].includes("<"), "no raw angle bracket inside the attribute");
  assert.ok(m[1].includes("daning"), "description is searchable, lowercased");
});

test("escaping holds on the versions and confirm pages", () => {
  const evil = "<script>alert(1)</script>";
  assert.ok(!renderVersions(detail({ title: evil })).includes(evil));
  assert.ok(!renderConfirm({ draft: detail({ title: evil }), version: null, csrf: "a" }).includes(evil));
});

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------
test("the list renders every draft, newest updated first", () => {
  const out = renderList([
    draft({ draftId: "newer", title: "Newer", updatedAt: "2026-07-22T00:00:00.000Z" }),
    draft({ draftId: "older", title: "Older", updatedAt: "2026-07-01T00:00:00.000Z" }),
  ]);
  assert.equal((out.match(/class="draft"/g) || []).length, 2);
  // renderList preserves the order it is given; the server sorts before calling.
  assert.ok(out.indexOf("Newer") < out.indexOf("Older"));
});

test("the list shows metadata and all three actions per draft", () => {
  const out = renderList([draft({ description: "Q3 planning" })]);
  assert.ok(out.includes("jcdiv47/postplan · v2 · 2 versions · updated 2026-07-22"));
  assert.ok(out.includes("Q3 planning"));
  assert.ok(out.includes('href="https://example.test/d/abc123def456"'), "links to the public URL");
  assert.ok(out.includes('href="/drafts/abc123def456"'), "links to version history");
  assert.ok(out.includes('href="/drafts/abc123def456/delete"'), "links to the delete confirmation");
});

test("a draft with no repo and one version reads correctly", () => {
  const out = renderList([draft({ repo: null, versionCount: 1, latestVersionNumber: 1 })]);
  assert.ok(out.includes("no repo · v1 · 1 version · updated 2026-07-22"));
});

test("an untitled draft falls back to a placeholder", () => {
  assert.ok(renderList([draft({ title: undefined })]).includes("Untitled Draft"));
});

test("the empty state names the command that fixes it", () => {
  const out = renderList([]);
  assert.ok(out.includes("0 drafts"));
  assert.ok(out.includes("postplan upload"));
  assert.ok(!out.includes('class="draft"'));
});

test("the list defaults to the cards view on the html element", () => {
  // The class sits on <html>, not <body>: app.js loads in <head> without defer
  // so it can restore the saved view before first paint, when <body> is absent.
  const out = renderList([draft()]);
  assert.ok(out.includes('<html lang="en" class="view-cards">'));
  assert.ok(out.includes('<div class="toolbar" id="toolbar" hidden>'), "toolbar is hidden until app.js enables it");
});

// ---------------------------------------------------------------------------
// Version history
// ---------------------------------------------------------------------------
test("the versions page lists every version, newest first, latest badged", () => {
  const out = renderVersions(detail());
  assert.equal((out.match(/class="version"/g) || []).length, 2);
  assert.ok(out.indexOf(">v2<") < out.indexOf(">v1<"), "newest first");
  assert.ok(out.includes('<span class="badge">latest</span>'));
  assert.equal((out.match(/class="badge"/g) || []).length, 1, "only one version is latest");
});

test("each version shows date, size and filename, and links to its own URL", () => {
  const out = renderVersions(detail());
  assert.ok(out.includes("2026-07-21 · 2.0 KB · plan.html"));
  assert.ok(out.includes('href="https://example.test/d/abc123def456/v/1"'));
  assert.ok(out.includes('href="/drafts/abc123def456/v/1/delete"'));
});

test("the versions page links back to the list", () => {
  assert.ok(renderVersions(detail()).includes('<a class="back" href="/">'));
});

// ---------------------------------------------------------------------------
// Delete confirmation
// ---------------------------------------------------------------------------
test("the whole-draft confirmation names the draft and its version count", () => {
  const out = renderConfirm({ draft: detail(), version: null, csrf: "deadbeef" });
  assert.ok(out.includes("Delete draft “Quarterly plan”?"));
  assert.ok(out.includes("all 2 versions"));
  assert.ok(out.includes("This cannot be undone."));
  assert.ok(out.includes('action="/drafts/abc123def456/delete"'));
  assert.ok(out.includes('name="csrf" value="deadbeef"'));
  assert.ok(out.includes('href="/"'), "cancel returns to the list");
});

test("a single-version confirmation says the others are untouched", () => {
  const out = renderConfirm({ draft: detail(), version: 1, csrf: "deadbeef" });
  assert.ok(out.includes("Delete version 1 of “Quarterly plan”?"));
  assert.ok(out.includes("1 version of this draft are untouched") || out.includes("The other 1 version"));
  assert.ok(out.includes('action="/drafts/abc123def456/v/1/delete"'));
  assert.ok(out.includes('href="/drafts/abc123def456"'), "cancel returns to the draft");
});

test("deleting the last remaining version warns the draft goes too", () => {
  const only = detail({ versions: [detail().versions[0]!] });
  const out = renderConfirm({ draft: only, version: 1, csrf: "deadbeef" });
  assert.ok(out.includes("the whole draft will be removed too"));
});
