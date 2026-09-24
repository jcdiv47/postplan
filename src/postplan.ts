#!/usr/bin/env node
// postplan — single-user static HTML draft publishing.
//
// A locked-down, zero-infra draft server: no Postgres, no S3, no OAuth. Drafts
// live on local disk; one secret token gates everything.
//
//   POSTPLAN_TOKEN=$(openssl rand -hex 24) postplan serve
//   postplan auth set <token>          # save token for the CLI
//   postplan upload ./plan.html        # publish (locked to your token)
//   postplan list                      # your drafts
//
// URLs (all require the token unless POSTPLAN_PUBLIC_READS=true):
//   /d/<id>            current version
//   /d/<id>/raw        alias, identical bytes
//   /d/<id>/v/<n>      a specific version
//   /d/<id>/v/<n>/raw  alias
//
// Reads accept the token as `Authorization: Bearer <token>` OR `?token=<token>`
// (the query form is for pasting a URL into a browser — note it lands in
// browser history / access logs, so prefer the header for agents/curl).

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import * as parse5 from "parse5";
import type { AddressInfo } from "node:net";
import { renderConfirm, renderList, renderNotFound, renderVersions } from "./ui.ts";
import {
  commitIndex,
  loadIndex,
  storageStats,
  StorageError,
  writeContentFile,
  __resetStorageState,
  __setStorageFault,
} from "./storage.ts";
import type {
  CliOptions,
  Credentials,
  DashboardRoute,
  DeleteResult,
  Draft,
  DraftDetail,
  DraftIndex,
  DraftSummary,
  DraftsState,
  UploadPayload,
  ValidationResult,
} from "./types.ts";

// The DOM walk below touches four fields and does not care which parse5 node
// type it is looking at, so it walks this structural shape rather than
// narrowing parse5's Element/TextNode union at every step.
interface HtmlNode {
  nodeName?: string;
  tagName?: string;
  value?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: HtmlNode[];
}

const DEFAULT_API_URL = "http://localhost:3000";
const DATA_DIR = path.resolve(process.env.POSTPLAN_DATA_DIR || ".postplan-data");
const STATE_DIR = path.join(os.homedir(), ".postplan");
const CRED_PATH = path.join(STATE_DIR, "credentials.json");
const DRAFTS_PATH = path.join(STATE_DIR, "drafts.json");
const MAX_BYTES = Number(process.env.MAX_HTML_BYTES || 512 * 1024);

// Resolved from this file, not the cwd: the CLI is `npm link`ed and runs from
// arbitrary directories. Both src/ and dist/ sit one level below the repo root,
// so `../public` is correct whether this is the source or the build (ADR-0004).
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

// ===========================================================================
// HTML safety policy — a parse5 DOM walk.
// Allows inline <script>; rejects the things a strict serving CSP can't undo
// for a human who opens the draft in a browser (external scripts, forms,
// iframes, event handlers, javascript: URLs, meta-refresh, etc.).
// ===========================================================================
const BLOCKED_TAGS = new Set(["form", "iframe", "object", "embed", "applet", "base", "link"]);
const URL_ATTRS = new Set(["href", "src", "action", "formaction", "poster", "srcdoc", "xlink:href"]);
const BLOCKED_PROTOCOLS = ["javascript:", "vbscript:", "file:"];
const ALLOWED_SCRIPT_TYPES = new Set(["", "text/javascript", "application/javascript"]);
const MAX_DEPTH = 512;

function validateHtml(html: unknown, { maxBytes = MAX_BYTES }: { maxBytes?: number } = {}): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (typeof html !== "string" || html.trim() === "") {
    return { ok: false, errors: ["HTML document is empty."], warnings, title: null };
  }
  const byteLength = Buffer.byteLength(html, "utf8");
  if (byteLength > maxBytes) {
    errors.push(`HTML document is ${byteLength} bytes; maximum is ${maxBytes} bytes.`);
  }

  let document: HtmlNode;
  try {
    document = parse5.parse(html, { scriptingEnabled: false }) as unknown as HtmlNode;
  } catch {
    return { ok: false, errors: ["HTML document could not be parsed."], warnings, title: null };
  }

  let title: string | null = null;
  const externalImageHosts = new Set<string>();

  const visit = (node: HtmlNode): void => {
    if (node.tagName) {
      const tag = node.tagName.toLowerCase();
      if (BLOCKED_TAGS.has(tag)) errors.push(`Blocked <${tag}> tag found.`);

      if (tag === "script") {
        const attrs = new Map((node.attrs || []).map((a) => [a.name.toLowerCase(), String(a.value || "").trim()]));
        if (attrs.has("src")) errors.push("External script sources are not allowed.");
        const type = (attrs.get("type") || "").toLowerCase();
        if (!ALLOWED_SCRIPT_TYPES.has(type)) errors.push(`Unsupported script type "${type}" found.`);
      }

      for (const attr of node.attrs || []) {
        const name = attr.name.toLowerCase();
        const value = String(attr.value || "").trim();
        if (name.startsWith("on")) errors.push(`Blocked inline event handler attribute "${name}" found.`);
        if (name === "srcdoc") errors.push('Blocked "srcdoc" attribute found.');
        if (URL_ATTRS.has(name)) {
          const normalized = value.replace(/[\u0000-\u0020]+/g, "").toLowerCase();
          if (BLOCKED_PROTOCOLS.some((p) => normalized.startsWith(p))) {
            errors.push(`Blocked unsafe URL in "${name}" attribute.`);
          }
        }
        if (name === "style" && /expression\s*\(|behavior\s*:|url\s*\(\s*javascript:/i.test(value)) {
          errors.push("Blocked unsafe inline CSS.");
        }
      }

      if (tag === "meta") {
        const httpEquiv = (node.attrs || []).find((a) => a.name.toLowerCase() === "http-equiv");
        if (httpEquiv && httpEquiv.value.trim().toLowerCase() === "refresh") {
          errors.push("Blocked meta refresh tag found.");
        }
      }

      if (tag === "img") {
        const src = (node.attrs || []).find((a) => a.name.toLowerCase() === "src");
        const host = externalHost(src?.value);
        if (host) externalImageHosts.add(host);
      }
    }
    if (node.tagName === "title" && !title) {
      title = collectText(node).trim().slice(0, 140) || null;
    }
  };

  let tooDeep = false;
  const stack: { node: HtmlNode; depth: number }[] = [{ node: document, depth: 0 }];
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    visit(node);
    if (depth >= MAX_DEPTH) { tooDeep = true; continue; }
    const children = node.childNodes || [];
    for (let i = children.length - 1; i >= 0; i--) stack.push({ node: children[i]!, depth: depth + 1 });
  }
  if (tooDeep) errors.push(`HTML is nested more than ${MAX_DEPTH} levels deep.`);
  if (!title) warnings.push("No <title> found; a generic title will be used.");

  return {
    ok: errors.length === 0,
    errors: [...new Set(errors)],
    warnings: [...new Set(warnings)],
    title,
    externalImageHosts: [...externalImageHosts].sort(),
  };
}

function externalHost(value: unknown): string | null {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const candidate = raw.startsWith("//") ? `https:${raw}` : raw;
  try {
    const url = new URL(candidate);
    if (url.protocol === "http:" || url.protocol === "https:") return url.hostname.toLowerCase();
  } catch { /* relative / data: URI */ }
  return null;
}

function collectText(node: HtmlNode): string {
  let out = "";
  for (const child of node.childNodes || []) {
    if (child.nodeName === "#text") out += child.value || "";
    out += collectText(child);
  }
  return out;
}

const sha256 = (v: string): string => createHash("sha256").update(v).digest("hex");

// ===========================================================================
// Server
// ===========================================================================
function requireServerToken(): string {
  const token = process.env.POSTPLAN_TOKEN;
  if (!token || token.length < 16) {
    console.error(
      "Refusing to start: set POSTPLAN_TOKEN to a secret of at least 16 chars.\n" +
      "  e.g.  POSTPLAN_TOKEN=$(openssl rand -hex 24) postplan serve"
    );
    process.exit(1);
  }
  return token;
}

// Constant-time comparison; also guards the length-mismatch throw.
function tokenMatches(provided: unknown, expected: string): boolean {
  if (typeof provided !== "string" || provided.length === 0) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Lookup order: Bearer header, then ?token=, then the session cookie. The query
// parameter deliberately outranks the cookie so visiting /?token=<new secret>
// replaces a stale session instead of being shadowed by it.
function presentedToken(req: http.IncomingMessage, url: URL): string {
  const header = req.headers.authorization || "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1]!.trim();
  const query = url.searchParams.get("token");
  if (query) return query;
  return readCookies(req)[SESSION_COOKIE] || "";
}

// ---- Dashboard session ----------------------------------------------------
const SESSION_COOKIE = "pp_token";
const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

function readCookies(req: http.IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    try { out[name] = decodeURIComponent(part.slice(eq + 1).trim()); }
    catch { out[name] = part.slice(eq + 1).trim(); }
  }
  return out;
}

function sessionCookie(token: string): string {
  // Secure is accepted on http://localhost (browsers treat it as a secure
  // context), so this does not break local development.
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${SESSION_MAX_AGE}; HttpOnly; Secure; SameSite=Strict`;
}

// Deletes are irreversible, so they are guarded three ways: the session cookie,
// SameSite=Strict, and this token — which also holds if the draft-serving CSP is
// ever loosened enough to let uploaded HTML forge a same-origin request.
function csrfToken(secret: string, draftId: string, version: number | null): string {
  return createHmac("sha256", secret).update(`${draftId}:${version ?? "all"}`).digest("hex");
}

function csrfMatches(provided: unknown, expected: string): boolean {
  if (typeof provided !== "string" || provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

const STATIC_ASSETS: Record<string, [file: string, contentType: string]> = {
  "/static/app.css": ["app.css", "text/css; charset=utf-8"],
  "/static/app.js": ["app.js", "text/javascript; charset=utf-8"],
};

// Stricter than the draft-serving policy in one direction (no inline styles)
// and looser in another (own scripts allowed). Inline script stays blocked, so
// a missed escape on a draft title is a layout bug, not code execution.
const DASHBOARD_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'none'; " +
  "connect-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

// Own-property lookup. index.json keys are untrusted strings, so inherited
// object properties (constructor, __proto__, ...) must never stand in for a
// Draft.
function own<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

// The number the next upload to this Draft should be published under.
//
// Counting the Versions would be wrong: deleting one shortens the array, so the
// count stops tracking what has been issued and the next upload collides with a
// live Version — overwriting its HTML and filing a duplicate `n`. Gaps in the
// sequence are the correct outcome; a deleted number stays retired.
//
// lastVersionNumber is the record of what was issued, but indexes written
// before it existed don't carry it. There, the highest surviving Version is the
// best available lower bound — it only understates the truth if the newest
// Version was deleted before this shipped, and from the first upload onwards
// the stored counter takes over.
function nextVersionNumber(record: Draft): number {
  const issued = record.lastVersionNumber ?? Math.max(0, ...record.versions.map((v) => v.n));
  return issued + 1;
}

// The draft list, newest-updated first. Shared by GET /api/drafts and the
// dashboard so the two can never drift apart.
function draftSummaries(base: string): DraftSummary[] {
  return Object.entries(loadIndex(DATA_DIR))
    .map(([id, r]) => ({
      draftId: id,
      title: r.title,
      description: r.description || null,
      repo: r.repo || null,
      latestVersionNumber: r.versions.at(-1)?.n ?? null,
      versionCount: r.versions.length,
      updatedAt: r.updatedAt,
      publicUrl: `${base}/d/${id}`,
    }))
    .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}

// One draft with every version. Returns null when it doesn't exist.
function draftDetail(draftId: string, base: string): DraftDetail | null {
  const record = own(loadIndex(DATA_DIR), draftId);
  if (!record || !record.versions.length) return null;
  return {
    draftId,
    title: record.title,
    description: record.description || null,
    repo: record.repo || null,
    updatedAt: record.updatedAt,
    publicUrl: `${base}/d/${draftId}`,
    versions: record.versions.map((v) => ({ ...v, url: `${base}/d/${draftId}/v/${v.n}` })),
  };
}

// Content writes are ordered the same way index commits are: get the bytes
// durably in place before metadata points at them. The storage boundary does
// the exclusive create and the directory flushes; see writeContentFile.
interface ContentHandle {
  path: string;
  remove: () => void;
}

// `versionNumber` comes from nextVersionNumber, which is above every Version the
// committed index references for this Draft, so a file already at that name is
// an unreferenced orphan and must not wedge the Draft's uploads.
function writeVersionContent(draftId: string, versionNumber: number, html: string): ContentHandle {
  return writeContentFile(path.join(DATA_DIR, draftId), `v${versionNumber}.html`, html, undefined, { replaceUnreferenced: true });
}

// Physical removal happens only after the metadata commit. A failure here is
// logged and the logical deletion stands: the Version is already unlisted and
// unservable through the index.
function removeContent(target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (err) {
    console.error(`[postplan] index committed but files could not be removed at ${target}; run a manual cleanup:`, err);
  }
}

// Irreversible removal, shared by the JSON API and the dashboard's POST
// handler. `versionArg` null means the whole draft. Deleting the last remaining
// version removes the draft too.
//
// The candidate is a shallow copy, so a failed commit cannot leave the caller's
// snapshot mutated, and the index is committed before any bytes are removed —
// a failed commit leaves every previously referenced Version intact.
function deleteDraftOrVersion(draftId: string, versionArg: number | null): DeleteResult {
  const index = loadIndex(DATA_DIR);
  const record = own(index, draftId);
  if (!record || !record.versions.length) return { ok: false, reason: "draft" };
  const draftDir = path.join(DATA_DIR, draftId);

  if (versionArg == null) {
    const candidate: DraftIndex = { ...index };
    delete candidate[draftId];
    commitIndex(DATA_DIR, candidate);
    removeContent(draftDir);
    return { ok: true, draftId, versionNumber: null, draftRemoved: true };
  }

  if (!record.versions.some((v) => v.n === versionArg)) return { ok: false, reason: "version" };
  const remaining = record.versions.filter((v) => v.n !== versionArg);
  const candidate: DraftIndex = { ...index };

  if (remaining.length === 0) {
    delete candidate[draftId];
    commitIndex(DATA_DIR, candidate);
    removeContent(draftDir);
    return { ok: true, draftId, versionNumber: versionArg, draftRemoved: true };
  }

  candidate[draftId] = { ...record, versions: remaining, updatedAt: new Date().toISOString() };
  commitIndex(DATA_DIR, candidate);
  removeContent(path.join(draftDir, `v${versionArg}.html`));
  return { ok: true, draftId, versionNumber: versionArg, draftRemoved: false };
}

// Publishes one already-validated upload. Runs inside the request's storage
// error boundary: a failed commit throws StorageError and the caller answers
// 503.
function publishUpload(payload: UploadPayload, validation: ValidationResult, req: http.IncomingMessage, url: URL): { status: number; body: unknown } {
  const html = payload.html as string;
  const index = loadIndex(DATA_DIR);
  const existing = payload.draftId ? own(index, payload.draftId) : undefined;
  const draftId = existing ? payload.draftId! : randomUUID().slice(0, 12);
  const record: Draft = existing
    ? { ...existing, versions: [...existing.versions] }
    : { versions: [] };
  const versionNumber = nextVersionNumber(record);
  record.lastVersionNumber = versionNumber;

  // Bytes first: the Version file is durably in place before the index can
  // reference it.
  const content = writeVersionContent(draftId, versionNumber, html);

  record.title = validation.title || record.title || payload.filename || "Untitled Draft";
  if (payload.description != null) record.description = payload.description;
  record.repo = payload.metadata?.repoOrg && payload.metadata?.repoName
    ? `${payload.metadata.repoOrg}/${payload.metadata.repoName}`
    : record.repo || null;
  record.versions.push({
    n: versionNumber,
    sha256: sha256(html),
    bytes: Buffer.byteLength(html, "utf8"),
    at: new Date().toISOString(),
    filename: payload.filename || null,
    externalImageHosts: validation.externalImageHosts!,
  });
  record.updatedAt = new Date().toISOString();

  const candidate: DraftIndex = { ...index, [draftId]: record };
  try {
    commitIndex(DATA_DIR, candidate);
  } catch (err) {
    // A pre-rename failure leaves the old index authoritative, so the new
    // bytes are unreferenced and safe to remove. A post-rename failure means
    // the index may already point at them: retain them for reconciliation.
    if (!(err instanceof StorageError && err.committed)) content.remove();
    throw err;
  }

  const base = originFor(req, url);
  return {
    status: existing ? 200 : 201,
    body: {
      draftId,
      versionNumber,
      publicUrl: `${base}/d/${draftId}`,
      rawUrl: `${base}/d/${draftId}/raw`,
      warnings: validation.warnings,
    },
  };
}

function serve(port: number): void {
  const TOKEN = requireServerToken();
  const publicReads = process.env.POSTPLAN_PUBLIC_READS === "true";
  const testSeams = process.env.POSTPLAN_TEST_SEAMS === "1";

  const server = http.createServer((req, res) => {
    try {
      handleRoute(req, res, TOKEN, publicReads, testSeams);
    } catch (err) {
      reportRequestError(res, err);
    }
  });

  server.listen(port, () => {
    const boundPort = (server.address() as AddressInfo).port;
    console.log(`postplan serving on http://localhost:${boundPort}`);
    console.log(publicReads
      ? "Reads: PUBLIC (anyone with a draft URL can fetch). Uploads: token-locked."
      : "Reads + uploads: token-locked to you.");
    console.log(`Dashboard: http://localhost:${boundPort}/?token=<your token> (sets a session cookie)`);
  });
}

// Every request handler runs inside this function. Synchronous throws bubble to
// serve()'s try/catch; the upload 'end' callback and the Dashboard POST promise
// attach their own error boundary, because a later callback or rejected promise
// is not caught by a try/catch around registration.
function handleRoute(req: http.IncomingMessage, res: http.ServerResponse, TOKEN: string, publicReads: boolean, testSeams: boolean): void {
  const url = new URL(req.url!, `http://${req.headers.host || "localhost"}`);
  const { pathname } = url;
  const authed = tokenMatches(presentedToken(req, url), TOKEN);

  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");

  if (pathname === "/healthz") return json(res, 200, { ok: true });

  // Test-only seams, enabled by POSTPLAN_TEST_SEAMS=1. They expose storage
  // counters and let tests schedule storage failures, so the failure-injection
  // regressions do not need a production debugging surface.
  if (testSeams && pathname === "/__test/stats") {
    if (!authed) return json(res, 401, { error: "Missing or invalid token." });
    if (req.method === "DELETE") { __resetStorageState(); return json(res, 200, { ok: true }); }
    if (req.method === "GET") return json(res, 200, storageStats());
    return json(res, 405, { error: "Method not allowed." });
  }
  if (testSeams && pathname === "/__test/faults" && req.method === "POST") {
    if (!authed) return json(res, 401, { error: "Missing or invalid token." });
    const stage = url.searchParams.get("stage");
    const countRaw = url.searchParams.get("count");
    const count = countRaw == null ? Number.POSITIVE_INFINITY : Number(countRaw);
    if (!stage || Number.isNaN(count)) return json(res, 400, { error: "Bad request." });
    __setStorageFault(stage, count);
    return json(res, 200, { ok: true });
  }

    // ---- Upload (always requires the token) ----
    if (req.method === "POST" && pathname === "/api/uploads") {
      if (!authed) return json(res, 401, { error: "Missing or invalid token." });
      // Decode with a streaming UTF-8 decoder so multi-byte characters that
      // straddle a network chunk boundary aren't corrupted into U+FFFD. Do NOT
      // setEncoding() — we need the raw Buffer chunks for the byte-accurate
      // size guard and for the decoder to retain partial byte sequences.
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const decodedParts: string[] = [];
      let receivedBytes = 0;
      let tooBig = false;
      let invalidUtf8 = false;
      const rejectInvalidUtf8 = () => json(res, 400, { error: "Request body is not valid UTF-8 JSON." });
      req.on("data", (chunk) => {
        receivedBytes += chunk.length;
        if (receivedBytes > MAX_BYTES * 3) { tooBig = true; req.destroy(); return; }
        if (invalidUtf8) return;
        try { decodedParts.push(decoder.decode(chunk, { stream: true })); }
        catch { invalidUtf8 = true; }
      });
      req.on("end", () => {
        if (tooBig) return;
        if (invalidUtf8) return rejectInvalidUtf8();
        try {
          // Flush retained bytes; also throws on a truncated final character.
          decodedParts.push(decoder.decode());
        } catch { return rejectInvalidUtf8(); }
        const raw = decodedParts.join("");

        let parsed: unknown;
        try { parsed = JSON.parse(raw); } catch { return json(res, 400, { error: "Bad JSON." }); }
        if (!isUploadPayload(parsed)) return json(res, 400, { error: "Bad JSON." });
        const payload = parsed;

        const v = validateHtml(payload.html || "");
        if (!v.ok) return json(res, 422, { error: "HTML failed validation.", errors: v.errors });

        try {
          const result = publishUpload(payload, v, req, url);
          json(res, result.status, result.body);
        } catch (err) {
          reportRequestError(res, err);
        }
      });
      return;
    }

    // ---- List (always requires the token) ----
    if (req.method === "GET" && pathname === "/api/drafts") {
      if (!authed) return json(res, 401, { error: "Missing or invalid token." });
      return json(res, 200, { drafts: draftSummaries(originFor(req, url)) });
    }

    // ---- Draft detail + delete (always requires the token) ----
    const dm = pathname.match(/^\/api\/drafts\/([\w-]+)(?:\/v\/(\d+))?\/?$/);
    if (dm && (req.method === "GET" || req.method === "DELETE")) {
      if (!authed) return json(res, 401, { error: "Missing or invalid token." });
      const draftId = dm[1]!;
      const versionArg = dm[2] ? Number(dm[2]) : null;
      const idx = loadIndex(DATA_DIR);
      const record = own(idx, draftId);
      if (!record || !record.versions.length) return json(res, 404, { error: "Not found." });

      if (req.method === "GET") return json(res, 200, draftDetail(draftId, originFor(req, url)));

      // DELETE
      const result = deleteDraftOrVersion(draftId, versionArg);
      if (!result.ok) {
        return json(res, 404, { error: result.reason === "version" ? "Version not found." : "Not found." });
      }
      if (versionArg == null) return json(res, 200, { deleted: true, draftId });
      return json(res, 200, {
        deleted: true,
        draftId,
        versionNumber: versionArg,
        draftRemoved: result.draftRemoved,
      });
    }

    // ---- Dashboard assets (token-gated; a 200 here would fingerprint the server) ----
    const asset = STATIC_ASSETS[pathname];
    if (asset && req.method === "GET") {
      if (!authed) return json(res, 404, { error: "Not found." });
      const [file, contentType] = asset;
      let body;
      // One hardcoded path per route — no user input ever reaches the filesystem.
      try { body = fs.readFileSync(path.join(PUBLIC_DIR, file)); }
      catch { return json(res, 404, { error: "Not found." }); }
      res.writeHead(200, { "Content-Type": contentType });
      res.end(body);
      return;
    }

    // ---- Dashboard (token-gated; 404 to everyone else, never 401) ----
    const route = dashboardRoute(pathname);
    if (route) {
      if (!authed) return json(res, 404, { error: "Not found." });

      // A valid ?token= trades itself for a session cookie, then redirects to a
      // clean URL so the secret leaves the address bar and browser history.
      if (url.searchParams.has("token")) {
        const clean = new URL(url);
        clean.searchParams.delete("token");
        res.writeHead(302, {
          Location: `${clean.pathname}${clean.search}`,
          "Set-Cookie": sessionCookie(TOKEN),
        });
        res.end();
        return;
      }

      const base = originFor(req, url);

      if (route.kind === "list" && req.method === "GET") {
        return html(res, 200, renderList(draftSummaries(base)));
      }

      if (route.kind === "detail" && req.method === "GET") {
        const draft = draftDetail(route.draftId, base);
        if (!draft) return html(res, 404, renderNotFound());
        return html(res, 200, renderVersions(draft));
      }

      if (route.kind === "delete" && req.method === "GET") {
        const draft = draftDetail(route.draftId, base);
        if (!draft) return html(res, 404, renderNotFound());
        if (route.version != null && !draft.versions.some((v) => v.n === route.version)) {
          return html(res, 404, renderNotFound());
        }
        return html(res, 200, renderConfirm({
          draft,
          version: route.version,
          csrf: csrfToken(TOKEN, route.draftId, route.version),
        }));
      }

      if (route.kind === "delete" && req.method === "POST") {
        return void readForm(req).then((form) => {
          const expected = csrfToken(TOKEN, route.draftId, route.version);
          if (!form || !csrfMatches(form.get("csrf") || "", expected)) {
            return html(res, 403, renderNotFound());
          }
          const result = deleteDraftOrVersion(route.draftId, route.version);
          if (!result.ok) return html(res, 404, renderNotFound());
          // 303 so a refresh doesn't re-POST an irreversible action.
          const location = result.draftRemoved ? "/" : `/drafts/${route.draftId}`;
          res.writeHead(303, { Location: location });
          res.end();
        }).catch((err) => reportRequestError(res, err));
      }

      return json(res, 404, { error: "Not found." });
    }

    // ---- Serving ----
    const m = pathname.match(/^\/d\/([\w-]+)(?:\/v\/(\d+))?(?:\/raw)?\/?$/);
    if (req.method === "GET" && m) {
      if (!publicReads && !authed) {
        // 404, not 401 — don't confirm a draft ID exists to someone without the token.
        return json(res, 404, { error: "Not found." });
      }
      const record = own(loadIndex(DATA_DIR), m[1]!);
      if (!record || !record.versions.length) return json(res, 404, { error: "Not found." });

      // Guarded non-empty just above.
      const n = m[2] ? Number(m[2]) : record.versions.at(-1)!.n;
      const version = record.versions.find((x) => x.n === n);
      if (!version) return json(res, 404, { error: "Not found." });

      let body: string;
      try {
        body = fs.readFileSync(path.join(DATA_DIR, m[1]!, `v${n}.html`), "utf8");
      } catch (err) {
        // A genuinely missing file is an inconsistent store but a normal 404;
        // anything else (EACCES/EIO) is a storage failure and must be logged
        // and answered with the shared 503, not disguised as "not found".
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return json(res, 404, { error: "Not found." });
        throw new StorageError("Could not read indexed Version content.", "read", err);
      }
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        // Verbatim bytes; the CSP only limits what a browser executes.
        "Content-Security-Policy":
          "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src https: data:; connect-src 'none'; base-uri 'none'; form-action 'none'",
        "X-Postplan-Draft-Id": m[1]!,
        "X-Postplan-Draft-Version": String(n),
      });
      res.end(body);
      return;
    }

    json(res, 404, { error: "Not found." });
}

/**
 * Last-resort boundary for any request handler. A storage failure is a generic
 * 503 (the cause is logged server-side, never sent to the client); anything
 * else is a 500, so a bug cannot take the process down with it.
 */
function reportRequestError(res: http.ServerResponse, err: unknown): void {
  if (err instanceof StorageError) {
    console.error(`[postplan] storage ${err.stage} failure:`, err);
    if (!res.headersSent) return json(res, 503, { error: "Storage unavailable." });
  } else {
    console.error("[postplan] unhandled request error:", err);
    if (!res.headersSent) return json(res, 500, { error: "Internal server error." });
  }
  try { res.end(); } catch { /* the client is already gone */ }
}

function originFor(req: http.IncomingMessage, url: URL): string {
  // Honors a reverse proxy if present; falls back to the request host.
  const proto = ((req.headers["x-forwarded-proto"] as string) || url.protocol.replace(":", "")).split(",")[0]!.trim();
  const host = ((req.headers["x-forwarded-host"] as string) || req.headers.host || `localhost`).split(",")[0]!.trim();
  return `${proto}://${host}`;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function html(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": DASHBOARD_CSP,
  });
  res.end(body);
}

// Dashboard URL surface:
//   /                            the draft list
//   /drafts/<id>                 version history
//   /drafts/<id>/delete          confirm (GET) / perform (POST) — whole draft
//   /drafts/<id>/v/<n>/delete    confirm (GET) / perform (POST) — one version
function dashboardRoute(pathname: string): DashboardRoute | null {
  if (pathname === "/") return { kind: "list", draftId: null, version: null };
  const m = pathname.match(/^\/drafts\/([\w-]+)(?:\/v\/(\d+))?(\/delete)?\/?$/);
  if (!m) return null;
  const version = m[2] ? Number(m[2]) : null;
  // A version on its own has no page of its own — the draft's HTML lives at /d/.
  if (version != null && !m[3]) return null;
  return { kind: m[3] ? "delete" : "detail", draftId: m[1]!, version };
}

// The upload body is genuinely external, so its shape is checked rather than
// asserted. Only object-ness is checked here: JSON.parse("null"), an array or a
// bare string/number cannot carry the fields the handler reads, so they are
// rejected outright. Individual fields stay unchecked on purpose — html is
// vetted by validateHtml, which already 422s on a non-string, and the rest are
// normalised where they are read.
function isUploadPayload(value: unknown): value is UploadPayload {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Reads an application/x-www-form-urlencoded body. Resolves null if it's absent,
// oversized or unparseable — every one of which means "reject the request".
function readForm(req: http.IncomingMessage, limit = 8 * 1024): Promise<URLSearchParams | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on("data", (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > limit) { aborted = true; req.destroy(); return resolve(null); }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (aborted) return;
      try { resolve(new URLSearchParams(Buffer.concat(chunks).toString("utf8"))); }
      catch { resolve(null); }
    });
    req.on("error", () => resolve(null));
  });
}

// ===========================================================================
// CLI
// ===========================================================================
function readCreds(): Credentials { return readJson<Credentials>(CRED_PATH, {}); }

function resolveAuth(opts: CliOptions): { apiUrl: string; token: string | null } {
  const creds = readCreds();
  const apiUrl = (opts.apiUrl || process.env.POSTPLAN_API_URL || creds.apiUrl || DEFAULT_API_URL).replace(/\/+$/, "");
  const token = process.env.POSTPLAN_TOKEN || creds.token || null;
  return { apiUrl, token };
}

function authSet(token: string | undefined, opts: CliOptions): void {
  if (!token) return fail("Usage: postplan auth set <token> [--api-url URL]");
  const creds = readCreds();
  writeJson(CRED_PATH, {
    ...creds,
    token,
    ...(opts.apiUrl ? { apiUrl: opts.apiUrl.replace(/\/+$/, "") } : {}),
  });
  console.log("Token saved to ~/.postplan/credentials.json");
}

async function upload(file: string | undefined, opts: CliOptions): Promise<void> {
  const resolved = path.resolve(file!);
  if (!fs.existsSync(resolved)) return fail(`File does not exist: ${resolved}`);
  const { apiUrl, token } = resolveAuth(opts);
  if (!token) return fail("No token. Run: postplan auth set <token>");

  const html = fs.readFileSync(resolved, "utf8");
  const v = validateHtml(html);
  if (!v.ok) return fail(`HTML failed validation:\n- ${v.errors.join("\n- ")}`);

  const drafts = readJson<DraftsState>(DRAFTS_PATH, { files: {} });
  const draftId = opts.new ? null : opts.draft || drafts.files[resolved]?.draftId || null;

  const res = await fetch(`${apiUrl}/api/uploads`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      html,
      filename: path.basename(resolved),
      draftId,
      description: opts.description,
      metadata: { fileSha256: sha256(html) },
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return fail(`${body.error || "Upload failed."}${body.errors ? `\n- ${body.errors.join("\n- ")}` : ""}`);

  drafts.files[resolved] = { draftId: body.draftId, publicUrl: body.publicUrl, updatedAt: new Date().toISOString() };
  writeJson(DRAFTS_PATH, drafts);

  console.log(draftId ? "Updated draft" : "Uploaded draft");
  console.log(`URL:      ${body.publicUrl}`);
  console.log(`Raw HTML: ${body.rawUrl}`);
  console.log(`Draft ID: ${body.draftId}`);
  console.log(`Version:  ${body.versionNumber}`);
  for (const w of body.warnings || []) console.warn(`Warning: ${w}`);
}

async function list(opts: CliOptions): Promise<void> {
  const { apiUrl, token } = resolveAuth(opts);
  if (!token) return fail("No token. Run: postplan auth set <token>");
  const res = await fetch(`${apiUrl}/api/drafts`, { headers: { Authorization: `Bearer ${token}` } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return fail(body.error || "Failed to list drafts.");
  const drafts = body.drafts || [];
  if (opts.json) return void console.log(JSON.stringify(drafts, null, 2));
  if (!drafts.length) return void console.log("No drafts yet. Publish one with: postplan upload <file>");
  console.log(`Drafts (${drafts.length})\n`);
  for (const d of drafts) {
    console.log(d.title || "Untitled Draft");
    console.log(`  ${d.repo || "no repo"} · v${d.latestVersionNumber} · ${d.versionCount} version${d.versionCount === 1 ? "" : "s"} · updated ${d.updatedAt?.slice(0, 10) || "?"}`);
    console.log(`  ${d.publicUrl}`);
    if (d.description) console.log(`  ${d.description}`);
    console.log("");
  }
}

async function versions(id: string | undefined, opts: CliOptions): Promise<void> {
  if (!id) return fail("Usage: postplan versions <draft-id>");
  const { apiUrl, token } = resolveAuth(opts);
  if (!token) return fail("No token. Run: postplan auth set <token>");
  const res = await fetch(`${apiUrl}/api/drafts/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${token}` } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return fail(body.error || "Failed to load draft.");
  if (opts.json) return void console.log(JSON.stringify(body, null, 2));
  const vs = body.versions || [];
  const latest = vs.at(-1)?.n;
  console.log(body.title || "Untitled Draft");
  console.log(`  ${body.draftId} · ${vs.length} version${vs.length === 1 ? "" : "s"}`);
  console.log(`  ${body.publicUrl}\n`);
  for (const v of vs) {
    console.log(`  v${v.n}${v.n === latest ? " (latest)" : ""} · ${v.at?.slice(0, 10) || "?"} · ${v.bytes} bytes${v.filename ? ` · ${v.filename}` : ""}`);
    console.log(`    ${v.url}`);
  }
}

async function rm(id: string | undefined, opts: CliOptions): Promise<void> {
  if (!id) return fail("Usage: postplan rm <draft-id> [--version N] [--yes]");
  const { apiUrl, token } = resolveAuth(opts);
  if (!token) return fail("No token. Run: postplan auth set <token>");
  let ver: number | null = null;
  if (opts.version != null) {
    ver = Number(opts.version);
    if (!Number.isInteger(ver) || ver < 1) return fail(`Invalid --version: ${opts.version}`);
  }
  const target = ver != null ? `version ${ver} of draft ${id}` : `draft ${id} and all its versions`;
  if (!opts.yes) {
    const ok = await confirm(`Permanently delete ${target}? [y/N] `);
    if (!ok) return void console.log("Aborted.");
  }
  const urlPath = ver != null
    ? `/api/drafts/${encodeURIComponent(id)}/v/${ver}`
    : `/api/drafts/${encodeURIComponent(id)}`;
  const res = await fetch(`${apiUrl}${urlPath}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return fail(body.error || "Delete failed.");

  if (ver != null) {
    console.log(body.draftRemoved
      ? `Deleted version ${ver} — it was the last one, so draft ${id} was removed.`
      : `Deleted version ${ver} of draft ${id}.`);
  } else {
    console.log(`Deleted draft ${id}.`);
  }

  // Drop the local file→draft mapping if the whole draft is now gone.
  if (ver == null || body.draftRemoved) {
    const drafts = readJson<DraftsState>(DRAFTS_PATH, { files: {} });
    let changed = false;
    for (const [k, v] of Object.entries(drafts.files || {})) {
      if (v.draftId === id) { delete drafts.files[k]; changed = true; }
    }
    if (changed) writeJson(DRAFTS_PATH, drafts);
  }
}

function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    fail("Refusing to delete without confirmation. Re-run with --yes.");
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

// Local state files, like index.json, have exactly one writer — shape asserted.
const readJson = <T,>(f: string, fb: T): T => { try { return JSON.parse(fs.readFileSync(f, "utf8")) as T; } catch { return fb; } };
function writeJson(f: string, v: unknown): void {
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  fs.writeFileSync(f, `${JSON.stringify(v, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(f, 0o600);
}
const fail = (msg: string): never => { console.error(msg); process.exit(1); };

// ---- arg parsing ----
const [cmd, sub, ...rest0] = process.argv.slice(2);
const rest = [sub, ...rest0].filter((x) => x !== undefined);
const opts: CliOptions = {};
const positional: string[] = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === "--new") opts.new = true;
  else if (rest[i] === "--json") opts.json = true;
  else if (rest[i] === "--yes" || rest[i] === "-y") opts.yes = true;
  // Flags are mapped to camelCase keys dynamically; CliOptions names the ones
  // that are actually read.
  else if (rest[i]?.startsWith("--")) (opts as Record<string, unknown>)[rest[i]!.slice(2).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = rest[++i];
  else positional.push(rest[i]!);
}

// Port 0 means "let the OS pick" — so this can't use `||`, which would treat a
// deliberate 0 as absent and silently fall through to 3000.
function resolvePort(): number {
  for (const value of [opts.port, process.env.PORT]) {
    if (value == null || value === "") continue;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0 || n > 65535) return fail(`Invalid port: ${value}`);
    return n;
  }
  return 3000;
}

if (cmd === "serve") serve(resolvePort());
else if (cmd === "auth" && positional[0] === "set") authSet(positional[1], opts);
else if (cmd === "upload") upload(positional[0], opts);
else if (cmd === "list") list(opts);
else if (cmd === "versions") versions(positional[0], opts);
else if (cmd === "rm" || cmd === "remove" || cmd === "delete") rm(positional[0], opts);
else {
  console.log(
    "postplan — single-user HTML draft publishing\n\n" +
    "  POSTPLAN_TOKEN=<secret> postplan serve [--port 3000]\n" +
    "  postplan auth set <token> [--api-url URL]\n" +
    "  postplan upload <file.html> [--new] [--draft ID] [--description TEXT] [--api-url URL]\n" +
    "  postplan list [--json] [--api-url URL]\n" +
    "  postplan versions <draft-id> [--json] [--api-url URL]\n" +
    "  postplan rm <draft-id> [--version N] [--yes] [--api-url URL]\n\n" +
    "Env: POSTPLAN_TOKEN (required to serve), POSTPLAN_PUBLIC_READS=true (open reads),\n" +
    "     POSTPLAN_DATA_DIR, MAX_HTML_BYTES, PORT, POSTPLAN_API_URL"
  );
  process.exit(cmd ? 1 : 0);
}
