// ui.ts — the postplan dashboard, rendered as HTML strings.
//
// Every export here is a pure function: data in, HTML out. No fs, no http, no
// globals. That keeps the interesting failure mode — an unescaped draft title
// reaching the page that holds your session cookie — testable without booting a
// server (see test/ui.test.ts).
//
// The view class (cards vs rows) lives on <html>, not <body>, because app.js is
// loaded in <head> without `defer` so it can restore your saved view before the
// first paint. At that point <body> does not exist yet.

import type { DraftDetail, DraftSummary } from "./types.ts";

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export const escapeHtml = (value: unknown): string =>
  value == null ? "" : String(value).replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);

const titleOf = (draft: { title?: string }): string => draft.title || "Untitled Draft";
const day = (iso: string | undefined): string => (typeof iso === "string" ? iso.slice(0, 10) : "?");
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "?";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------
function layout({ title, body }: { title: string; body: string }): string {
  return `<!doctype html>
<html lang="en" class="view-cards">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/static/app.css">
<script src="/static/app.js"></script>
</head>
<body>
${body}
</body>
</html>
`;
}

const backLink = (href: string, label: string): string => `<a class="back" href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;

// ---------------------------------------------------------------------------
// Draft list — the dashboard itself
// ---------------------------------------------------------------------------
export function renderList(drafts: DraftSummary[]): string {
  const items = drafts.map(renderDraftItem).join("\n");

  // The toolbar is hidden until app.js unhides it: filtering and the view
  // toggle are the only things here that need JavaScript, and a dead input box
  // is worse than no input box.
  const toolbar = `<div class="toolbar" id="toolbar" hidden>
      <input id="filter" type="search" placeholder="Filter drafts" autocomplete="off" spellcheck="false" aria-label="Filter drafts">
      <div class="views" role="group" aria-label="Layout">
        <button type="button" class="view-btn" data-view="cards" aria-pressed="true">Cards</button>
        <button type="button" class="view-btn" data-view="rows" aria-pressed="false">Rows</button>
      </div>
    </div>`;

  const body = drafts.length
    ? `<p class="count" id="count">${escapeHtml(plural(drafts.length, "draft"))}</p>
    <ul class="drafts">
${items}
    </ul>
    <p class="empty" id="no-matches" hidden>No drafts match that filter.</p>`
    : `<p class="count" id="count">${escapeHtml(plural(0, "draft"))}</p>
    <p class="empty">No drafts yet. Publish one with <code>postplan upload &lt;file&gt;</code>.</p>`;

  return layout({
    title: "postplan",
    body: `<header class="topbar">
    <h1>postplan</h1>
    ${toolbar}
  </header>
  <main>
    ${body}
  </main>`,
  });
}

function renderDraftItem(draft: DraftSummary): string {
  const title = titleOf(draft);
  // Everything the filter box matches against, pre-lowercased so app.js does no
  // work per keystroke beyond a substring test.
  const haystack = [title, draft.description, draft.repo, draft.draftId]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const meta = [
    draft.repo || "no repo",
    `v${draft.latestVersionNumber ?? "?"}`,
    plural(draft.versionCount ?? 0, "version"),
    `updated ${day(draft.updatedAt)}`,
  ].join(" · ");

  const description = draft.description
    ? `\n        <p class="desc">${escapeHtml(draft.description)}</p>`
    : "";

  return `      <li class="draft" data-search="${escapeHtml(haystack)}">
        <h2 class="draft-title"><a href="/drafts/${escapeHtml(draft.draftId)}">${escapeHtml(title)}</a></h2>${description}
        <p class="meta">${escapeHtml(meta)}</p>
        <p class="actions">
          <a href="${escapeHtml(draft.publicUrl)}">Open</a>
          <a href="/drafts/${escapeHtml(draft.draftId)}">Versions</a>
          <a class="danger" href="/drafts/${escapeHtml(draft.draftId)}/delete">Delete</a>
        </p>
      </li>`;
}

// ---------------------------------------------------------------------------
// Version history for one draft
// ---------------------------------------------------------------------------
export function renderVersions(draft: DraftDetail): string {
  const versions = draft.versions || [];
  const latest = versions.at(-1)?.n;

  const rows = versions
    .slice()
    .reverse()
    .map((v) => {
      const meta = [
        day(v.at),
        formatBytes(v.bytes),
        ...(v.filename ? [v.filename] : []),
      ].join(" · ");
      return `      <li class="version">
        <h3><a href="${escapeHtml(v.url)}">v${escapeHtml(v.n)}</a>${v.n === latest ? ' <span class="badge">latest</span>' : ""}</h3>
        <p class="meta">${escapeHtml(meta)}</p>
        <p class="actions">
          <a href="${escapeHtml(v.url)}">Open</a>
          <a class="danger" href="/drafts/${escapeHtml(draft.draftId)}/v/${escapeHtml(v.n)}/delete">Delete</a>
        </p>
      </li>`;
    })
    .join("\n");

  const description = draft.description
    ? `\n    <p class="desc">${escapeHtml(draft.description)}</p>`
    : "";

  const meta = [
    draft.repo || "no repo",
    draft.draftId,
    plural(versions.length, "version"),
    `updated ${day(draft.updatedAt)}`,
  ].join(" · ");

  return layout({
    title: `${titleOf(draft)} — postplan`,
    body: `<header class="topbar">
    ${backLink("/", "← All drafts")}
    <h1>${escapeHtml(titleOf(draft))}</h1>${description}
    <p class="meta">${escapeHtml(meta)}</p>
    <p class="actions">
      <a href="${escapeHtml(draft.publicUrl)}">Open latest</a>
      <a class="danger" href="/drafts/${escapeHtml(draft.draftId)}/delete">Delete draft</a>
    </p>
  </header>
  <main>
    <ul class="versions">
${rows}
    </ul>
  </main>`,
  });
}

// ---------------------------------------------------------------------------
// Delete confirmation
// ---------------------------------------------------------------------------
// `version` is null for "delete the whole draft". The page always names exactly
// what is about to be destroyed — it is the only safety net, since deletes are
// irreversible and the data dir is the only copy.
export function renderConfirm({ draft, version, csrf }: { draft: DraftDetail; version: number | null; csrf: string }): string {
  const versions = draft.versions || [];
  const lastOne = version != null && versions.length === 1;

  const heading = version == null
    ? `Delete draft “${titleOf(draft)}”?`
    : `Delete version ${version} of “${titleOf(draft)}”?`;

  const detail = version == null
    ? versions.length === 1
      ? `<p>This removes the draft and its only version. Anyone holding the link will get a 404.</p>`
      : `<p>This removes the draft and all ${escapeHtml(plural(versions.length, "version"))}. Anyone holding the link will get a 404.</p>`
    : lastOne
      ? `<p>This is the only remaining version, so the whole draft will be removed too.</p>`
      : `<p>The other ${escapeHtml(plural(versions.length - 1, "version"))} of this draft are untouched.</p>`;

  const action = version == null
    ? `/drafts/${escapeHtml(draft.draftId)}/delete`
    : `/drafts/${escapeHtml(draft.draftId)}/v/${escapeHtml(version)}/delete`;

  const cancelHref = version == null ? "/" : `/drafts/${escapeHtml(draft.draftId)}`;

  return layout({
    title: "Confirm delete — postplan",
    body: `<main class="confirm">
    <h1>${escapeHtml(heading)}</h1>
    ${detail}
    <p class="meta">${escapeHtml(draft.draftId)} · updated ${escapeHtml(day(draft.updatedAt))}</p>
    <p class="warning">This cannot be undone. There is no backup.</p>
    <form method="post" action="${action}">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <button type="submit" class="danger-btn">Yes, delete</button>
      <a class="cancel" href="${cancelHref}">Cancel</a>
    </form>
  </main>`,
  });
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
export function renderNotFound(): string {
  return layout({
    title: "Not found — postplan",
    body: `<main class="confirm">
    <h1>Not found</h1>
    <p>That draft or version no longer exists.</p>
    <p>${backLink("/", "← All drafts")}</p>
  </main>`,
  });
}
