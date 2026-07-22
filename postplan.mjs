#!/usr/bin/env node
// postplan — single-user static HTML draft publishing.
//
// A locked-down, zero-infra draft server: no Postgres, no S3, no OAuth. Drafts
// live on local disk; one secret token gates everything.
//
//   POSTPLAN_TOKEN=$(openssl rand -hex 24) node postplan.mjs serve
//   node postplan.mjs auth set <token>          # save token for the CLI
//   node postplan.mjs upload ./plan.html        # publish (locked to your token)
//   node postplan.mjs list                      # your drafts
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
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import * as parse5 from "parse5";

const DEFAULT_API_URL = "http://localhost:3000";
const DATA_DIR = path.resolve(process.env.POSTPLAN_DATA_DIR || ".postplan-data");
const STATE_DIR = path.join(os.homedir(), ".postplan");
const CRED_PATH = path.join(STATE_DIR, "credentials.json");
const DRAFTS_PATH = path.join(STATE_DIR, "drafts.json");
const MAX_BYTES = Number(process.env.MAX_HTML_BYTES || 512 * 1024);

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

function validateHtml(html, { maxBytes = MAX_BYTES } = {}) {
  const errors = [];
  const warnings = [];

  if (typeof html !== "string" || html.trim() === "") {
    return { ok: false, errors: ["HTML document is empty."], warnings, title: null };
  }
  const byteLength = Buffer.byteLength(html, "utf8");
  if (byteLength > maxBytes) {
    errors.push(`HTML document is ${byteLength} bytes; maximum is ${maxBytes} bytes.`);
  }

  let document;
  try {
    document = parse5.parse(html, { scriptingEnabled: false });
  } catch {
    return { ok: false, errors: ["HTML document could not be parsed."], warnings, title: null };
  }

  let title = null;
  const externalImageHosts = new Set();

  const visit = (node) => {
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
  const stack = [{ node: document, depth: 0 }];
  while (stack.length) {
    const { node, depth } = stack.pop();
    visit(node);
    if (depth >= MAX_DEPTH) { tooDeep = true; continue; }
    const children = node.childNodes || [];
    for (let i = children.length - 1; i >= 0; i--) stack.push({ node: children[i], depth: depth + 1 });
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

function externalHost(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const candidate = raw.startsWith("//") ? `https:${raw}` : raw;
  try {
    const url = new URL(candidate);
    if (url.protocol === "http:" || url.protocol === "https:") return url.hostname.toLowerCase();
  } catch { /* relative / data: URI */ }
  return null;
}

function collectText(node) {
  let out = "";
  for (const child of node.childNodes || []) {
    if (child.nodeName === "#text") out += child.value || "";
    out += collectText(child);
  }
  return out;
}

const sha256 = (v) => createHash("sha256").update(v).digest("hex");

// ===========================================================================
// Server
// ===========================================================================
function requireServerToken() {
  const token = process.env.POSTPLAN_TOKEN;
  if (!token || token.length < 16) {
    console.error(
      "Refusing to start: set POSTPLAN_TOKEN to a secret of at least 16 chars.\n" +
      "  e.g.  POSTPLAN_TOKEN=$(openssl rand -hex 24) node postplan.mjs serve"
    );
    process.exit(1);
  }
  return token;
}

// Constant-time comparison; also guards the length-mismatch throw.
function tokenMatches(provided, expected) {
  if (typeof provided !== "string" || provided.length === 0) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function presentedToken(req, url) {
  const header = req.headers.authorization || "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  return url.searchParams.get("token") || "";
}

function loadIndex() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, "index.json"), "utf8")); }
  catch { return {}; }
}
function saveIndex(idx) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, "index.json"), JSON.stringify(idx, null, 2));
}

function serve(port) {
  const TOKEN = requireServerToken();
  const publicReads = process.env.POSTPLAN_PUBLIC_READS === "true";

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const { pathname } = url;
    const authed = tokenMatches(presentedToken(req, url), TOKEN);

    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");

    if (pathname === "/healthz") return json(res, 200, { ok: true });

    // ---- Upload (always requires the token) ----
    if (req.method === "POST" && pathname === "/api/uploads") {
      if (!authed) return json(res, 401, { error: "Missing or invalid token." });
      // Decode with a streaming UTF-8 decoder so multi-byte characters that
      // straddle a network chunk boundary aren't corrupted into U+FFFD. Do NOT
      // setEncoding() — we need the raw Buffer chunks for the byte-accurate
      // size guard and for the decoder to retain partial byte sequences.
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const decodedParts = [];
      let receivedBytes = 0;
      let tooBig = false;
      let invalidUtf8 = false;
      req.on("data", (chunk) => {
        receivedBytes += chunk.length;
        if (receivedBytes > MAX_BYTES * 3) { tooBig = true; req.destroy(); return; }
        if (invalidUtf8) return;
        try { decodedParts.push(decoder.decode(chunk, { stream: true })); }
        catch { invalidUtf8 = true; }
      });
      req.on("end", () => {
        if (tooBig) return;
        if (invalidUtf8) return json(res, 400, { error: "Request body is not valid UTF-8." });
        try {
          // Flush retained bytes; also throws on a truncated final character.
          decodedParts.push(decoder.decode());
        } catch { return json(res, 400, { error: "Request body is not valid UTF-8." }); }
        const raw = decodedParts.join("");

        let payload;
        try { payload = JSON.parse(raw); } catch { return json(res, 400, { error: "Bad JSON." }); }

        const v = validateHtml(payload.html || "");
        if (!v.ok) return json(res, 422, { error: "HTML failed validation.", errors: v.errors });

        const idx = loadIndex();
        const reuse = payload.draftId && idx[payload.draftId];
        const draftId = reuse ? payload.draftId : randomUUID().slice(0, 12);
        const record = idx[draftId] || { versions: [] };
        const versionNumber = record.versions.length + 1;

        fs.mkdirSync(path.join(DATA_DIR, draftId), { recursive: true });
        fs.writeFileSync(path.join(DATA_DIR, draftId, `v${versionNumber}.html`), payload.html);

        record.title = v.title || record.title || payload.filename || "Untitled Draft";
        if (payload.description != null) record.description = payload.description;
        record.repo = payload.metadata?.repoOrg && payload.metadata?.repoName
          ? `${payload.metadata.repoOrg}/${payload.metadata.repoName}`
          : record.repo || null;
        record.versions.push({
          n: versionNumber,
          sha256: sha256(payload.html),
          bytes: Buffer.byteLength(payload.html, "utf8"),
          at: new Date().toISOString(),
          filename: payload.filename || null,
          externalImageHosts: v.externalImageHosts,
        });
        record.updatedAt = new Date().toISOString();
        idx[draftId] = record;
        saveIndex(idx);

        const base = originFor(req, url);
        json(res, reuse ? 200 : 201, {
          draftId,
          versionNumber,
          publicUrl: `${base}/d/${draftId}`,
          rawUrl: `${base}/d/${draftId}/raw`,
          warnings: v.warnings,
        });
      });
      return;
    }

    // ---- List (always requires the token) ----
    if (req.method === "GET" && pathname === "/api/drafts") {
      if (!authed) return json(res, 401, { error: "Missing or invalid token." });
      const idx = loadIndex();
      const base = originFor(req, url);
      const drafts = Object.entries(idx).map(([id, r]) => ({
        draftId: id,
        title: r.title,
        description: r.description || null,
        repo: r.repo || null,
        latestVersionNumber: r.versions.at(-1)?.n ?? null,
        versionCount: r.versions.length,
        updatedAt: r.updatedAt,
        publicUrl: `${base}/d/${id}`,
      })).sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
      return json(res, 200, { drafts });
    }

    // ---- Draft detail + delete (always requires the token) ----
    const dm = pathname.match(/^\/api\/drafts\/([\w-]+)(?:\/v\/(\d+))?\/?$/);
    if (dm && (req.method === "GET" || req.method === "DELETE")) {
      if (!authed) return json(res, 401, { error: "Missing or invalid token." });
      const draftId = dm[1];
      const versionArg = dm[2] ? Number(dm[2]) : null;
      const idx = loadIndex();
      const record = idx[draftId];
      if (!record || !record.versions.length) return json(res, 404, { error: "Not found." });

      if (req.method === "GET") {
        const base = originFor(req, url);
        return json(res, 200, {
          draftId,
          title: record.title,
          description: record.description || null,
          repo: record.repo || null,
          updatedAt: record.updatedAt,
          publicUrl: `${base}/d/${draftId}`,
          versions: record.versions.map((v) => ({
            ...v,
            url: `${base}/d/${draftId}/v/${v.n}`,
          })),
        });
      }

      // DELETE
      if (versionArg == null) {
        // Whole draft.
        fs.rmSync(path.join(DATA_DIR, draftId), { recursive: true, force: true });
        delete idx[draftId];
        saveIndex(idx);
        return json(res, 200, { deleted: true, draftId });
      }

      // Single version.
      const version = record.versions.find((v) => v.n === versionArg);
      if (!version) return json(res, 404, { error: "Version not found." });
      fs.rmSync(path.join(DATA_DIR, draftId, `v${versionArg}.html`), { force: true });
      record.versions = record.versions.filter((v) => v.n !== versionArg);
      if (!record.versions.length) {
        // Removed the last remaining version — drop the whole draft.
        fs.rmSync(path.join(DATA_DIR, draftId), { recursive: true, force: true });
        delete idx[draftId];
        saveIndex(idx);
        return json(res, 200, { deleted: true, draftId, versionNumber: versionArg, draftRemoved: true });
      }
      record.updatedAt = new Date().toISOString();
      idx[draftId] = record;
      saveIndex(idx);
      return json(res, 200, { deleted: true, draftId, versionNumber: versionArg, draftRemoved: false });
    }

    // ---- Serving ----
    const m = pathname.match(/^\/d\/([\w-]+)(?:\/v\/(\d+))?(?:\/raw)?\/?$/);
    if (req.method === "GET" && m) {
      if (!publicReads && !authed) {
        // 404, not 401 — don't confirm a draft ID exists to someone without the token.
        return json(res, 404, { error: "Not found." });
      }
      const record = loadIndex()[m[1]];
      if (!record || !record.versions.length) return json(res, 404, { error: "Not found." });

      const n = m[2] ? Number(m[2]) : record.versions.at(-1).n;
      const version = record.versions.find((x) => x.n === n);
      if (!version) return json(res, 404, { error: "Not found." });

      const html = fs.readFileSync(path.join(DATA_DIR, m[1], `v${n}.html`), "utf8");
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        // Verbatim bytes; the CSP only limits what a browser executes.
        "Content-Security-Policy":
          "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src https: data:; connect-src 'none'; base-uri 'none'; form-action 'none'",
        "X-Postplan-Draft-Id": m[1],
        "X-Postplan-Draft-Version": String(n),
      });
      return res.end(html);
    }

    json(res, 404, { error: "Not found." });
  });

  server.listen(port, () => {
    const boundPort = server.address().port;
    console.log(`postplan serving on http://localhost:${boundPort}`);
    console.log(publicReads
      ? "Reads: PUBLIC (anyone with a draft URL can fetch). Uploads: token-locked."
      : "Reads + uploads: token-locked to you.");
  });
}

function originFor(req, url) {
  // Honors a reverse proxy if present; falls back to the request host.
  const proto = (req.headers["x-forwarded-proto"] || url.protocol.replace(":", "")).split(",")[0].trim();
  const host = (req.headers["x-forwarded-host"] || req.headers.host || `localhost`).split(",")[0].trim();
  return `${proto}://${host}`;
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// ===========================================================================
// CLI
// ===========================================================================
function readCreds() { return readJson(CRED_PATH, {}); }

function resolveAuth(opts) {
  const creds = readCreds();
  const apiUrl = (opts.apiUrl || process.env.POSTPLAN_API_URL || creds.apiUrl || DEFAULT_API_URL).replace(/\/+$/, "");
  const token = process.env.POSTPLAN_TOKEN || creds.token || null;
  return { apiUrl, token };
}

function authSet(token, opts) {
  if (!token) return fail("Usage: postplan auth set <token> [--api-url URL]");
  const creds = readCreds();
  writeJson(CRED_PATH, {
    ...creds,
    token,
    ...(opts.apiUrl ? { apiUrl: opts.apiUrl.replace(/\/+$/, "") } : {}),
  });
  console.log("Token saved to ~/.postplan/credentials.json");
}

async function upload(file, opts) {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) return fail(`File does not exist: ${resolved}`);
  const { apiUrl, token } = resolveAuth(opts);
  if (!token) return fail("No token. Run: postplan auth set <token>");

  const html = fs.readFileSync(resolved, "utf8");
  const v = validateHtml(html);
  if (!v.ok) return fail(`HTML failed validation:\n- ${v.errors.join("\n- ")}`);

  const drafts = readJson(DRAFTS_PATH, { files: {} });
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

async function list(opts) {
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

async function versions(id, opts) {
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

async function rm(id, opts) {
  if (!id) return fail("Usage: postplan rm <draft-id> [--version N] [--yes]");
  const { apiUrl, token } = resolveAuth(opts);
  if (!token) return fail("No token. Run: postplan auth set <token>");
  let ver = null;
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
    const drafts = readJson(DRAFTS_PATH, { files: {} });
    let changed = false;
    for (const [k, v] of Object.entries(drafts.files || {})) {
      if (v.draftId === id) { delete drafts.files[k]; changed = true; }
    }
    if (changed) writeJson(DRAFTS_PATH, drafts);
  }
}

function confirm(question) {
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

const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fb; } };
function writeJson(f, v) {
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  fs.writeFileSync(f, `${JSON.stringify(v, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(f, 0o600);
}
const fail = (msg) => { console.error(msg); process.exit(1); };

// ---- arg parsing ----
const [cmd, sub, ...rest0] = process.argv.slice(2);
const rest = [sub, ...rest0].filter((x) => x !== undefined);
const opts = {};
const positional = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === "--new") opts.new = true;
  else if (rest[i] === "--json") opts.json = true;
  else if (rest[i] === "--yes" || rest[i] === "-y") opts.yes = true;
  else if (rest[i]?.startsWith("--")) opts[rest[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = rest[++i];
  else positional.push(rest[i]);
}

if (cmd === "serve") serve(Number(opts.port) || Number(process.env.PORT) || 3000);
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
