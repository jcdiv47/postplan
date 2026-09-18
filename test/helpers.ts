// Test helpers for driving the real Postplan HTTP server.
//
// These spawn the server as a child process against a throwaway data dir and a
// random token, then talk to it over a raw TCP socket so a test can control
// exactly where HTTP request-body bytes are split.
//
// The target defaults to the TypeScript source, which is what the linked CLI
// runs (ADR-0004). `npm run test:dist` sets POSTPLAN_TEST_TARGET to the build so
// the same suite covers what Railway serves.

import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.resolve(REPO_ROOT, process.env.POSTPLAN_TEST_TARGET || "src/postplan.ts");

// Spawn a fresh server on an OS-assigned port with an isolated data dir.
// Resolves once the server logs the port it actually bound. Public reads are on
// by default (matching the deployed instance); pass `{ publicReads: false }` to
// exercise the fully locked-down configuration.
export interface TestServer {
  port: number;
  token: string;
  dataDir: string;
  base: string;
  stop: () => Promise<void>;
}

export async function startServer(
  { publicReads = true, env = {} }: { publicReads?: boolean; env?: Record<string, string> } = {},
): Promise<TestServer> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "postplan-test-"));
  const token = randomBytes(24).toString("hex");
  const child = spawn(process.execPath, [SERVER, "serve", "--port", "0"], {
    env: {
      ...process.env,
      POSTPLAN_TOKEN: token,
      POSTPLAN_DATA_DIR: dataDir,
      POSTPLAN_PUBLIC_READS: String(publicReads),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const port = await new Promise<number>((resolve, reject) => {
    let out = "";
    let err = "";
    const onData = (buf: Buffer): void => {
      out += buf.toString("utf8");
      const m = out.match(/serving on http:\/\/localhost:(\d+)/);
      if (m) {
        child.stdout!.off("data", onData);
        resolve(Number(m[1]));
      }
    };
    child.stdout!.on("data", onData);
    // Keep stderr: a server that dies on startup explains itself there, and
    // without it the failure reads as an empty "exited early (code 1)".
    child.stderr!.on("data", (buf: Buffer) => { err += buf.toString("utf8"); });
    child.on("exit", (code) => reject(new Error(`server exited early (code ${code}): ${out}${err}`)));
    setTimeout(() => reject(new Error(`server did not start in time: ${out}${err}`)), 10_000);
  });

  const stop = async () => {
    if (!child.killed) child.kill("SIGKILL");
    await new Promise<void>((r) => (child.exitCode != null ? r() : void child.on("exit", () => r())));
    fs.rmSync(dataDir, { recursive: true, force: true });
  };

  return { port, token, dataDir, base: `http://localhost:${port}`, stop };
}

// Send a POST /api/uploads request over a raw socket, splitting the body buffer
// at the given byte offsets (each split forces a separate TCP write with a
// short gap, so the server sees the boundary between two 'data' events).
// `contentLength` overrides the declared Content-Length (used to send a body
// that ends mid-character). Returns { status, body }.
export interface RawResponse {
  status: number;
  body: string;
}

export function rawUpload(
  port: number,
  token: string,
  bodyBuf: Buffer,
  splits: number[] = [],
  { contentLength }: { contentLength?: number } = {},
): Promise<RawResponse> {
  const len = contentLength ?? bodyBuf.length;
  const head =
    `POST /api/uploads HTTP/1.1\r\n` +
    `Host: localhost\r\n` +
    `Authorization: Bearer ${token}\r\n` +
    `Content-Type: application/json\r\n` +
    `Content-Length: ${len}\r\n` +
    `Connection: close\r\n\r\n`;

  // Byte ranges to write in order: [0,s1), [s1,s2), ... , [sk, end).
  const bounds = [0, ...splits, bodyBuf.length].filter((v, i, a) => a.indexOf(v) === i);
  const parts: Buffer[] = [];
  for (let i = 0; i < bounds.length - 1; i++) parts.push(bodyBuf.subarray(bounds[i], bounds[i + 1]));

  return new Promise<RawResponse>((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.setNoDelay(true);
    const chunks: Buffer[] = [];
    socket.on("data", (d: Buffer) => void chunks.push(d));
    socket.on("error", reject);
    socket.on("close", () => {
      resolve(parseHttpResponse(Buffer.concat(chunks)));
    });

    socket.on("connect", async () => {
      socket.write(head);
      for (let i = 0; i < parts.length; i++) {
        socket.write(parts[i]!);
        // Force a boundary: let the write flush before the next part.
        if (i < parts.length - 1) await new Promise<void>((r) => void setTimeout(r, 15));
      }
    });
  });
}

// Minimal HTTP/1.1 response parser: status line + (optionally chunked) body.
function parseHttpResponse(buf: Buffer): RawResponse {
  const sep = buf.indexOf("\r\n\r\n");
  const head = buf.slice(0, sep).toString("utf8");
  const lines = head.split("\r\n");
  const status = Number(lines[0]!.split(" ")[1]);
  const chunked = lines.some((l) => /^transfer-encoding:\s*chunked/i.test(l));
  let rest = buf.subarray(sep + 4);

  if (!chunked) return { status, body: rest.toString("utf8") };

  const out: Buffer[] = [];
  while (rest.length) {
    const nl = rest.indexOf("\r\n");
    const size = parseInt(rest.slice(0, nl).toString("utf8"), 16);
    if (!size) break;
    out.push(rest.subarray(nl + 2, nl + 2 + size));
    rest = rest.subarray(nl + 2 + size + 2); // skip chunk data + trailing CRLF
  }
  return { status, body: Buffer.concat(out).toString("utf8") };
}

// Byte offset of `needle` (a string) within `bodyBuf`, as a UTF-8 byte index.
export function byteIndexOf(bodyBuf: Buffer, needle: string): number {
  const idx = bodyBuf.indexOf(Buffer.from(needle, "utf8"));
  if (idx === -1) throw new Error(`needle not found in body: ${needle}`);
  return idx;
}

// Fetch a stored draft's served HTML.
export async function fetchDraft(base: string, draftId: string): Promise<{ status: number; text: string }> {
  const res = await fetch(`${base}/d/${draftId}`);
  return { status: res.status, text: await res.text() };
}

// A minimal valid document with the given <title> and body text.
export const htmlDoc = (title: string, body = "hello"): string =>
  `<!doctype html><html><head><title>${title}</title></head><body><p>${body}</p></body></html>`;

// Publish a draft through the real upload endpoint. Returns the JSON response.
interface PublishOptions {
  html?: string;
  filename?: string;
  description?: string;
  draftId?: string | null;
}

// The upload response is left loose: each test asserts the fields it cares about.
export async function publish(
  base: string,
  token: string,
  { html, filename = "plan.html", description, draftId }: PublishOptions = {},
): Promise<any> {
  const res = await fetch(`${base}/api/uploads`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ html, filename, description, draftId }),
  });
  return res.json();
}

// GET a dashboard page as a browser would: session cookie, no redirect
// following. Returns { status, headers, text }.
export interface PageResponse {
  status: number;
  headers: Headers;
  text: string;
}

export async function getPage(base: string, urlPath: string, { cookie }: { cookie?: string } = {}): Promise<PageResponse> {
  const res = await fetch(`${base}${urlPath}`, {
    redirect: "manual",
    headers: cookie ? { cookie } : {},
  });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

// Pull the hidden CSRF value out of a rendered confirmation page.
export function csrfFrom(pageHtml: string): string {
  const m = pageHtml.match(/name="csrf" value="([a-f0-9]+)"/);
  if (!m) throw new Error("no csrf field found in page");
  return m[1]!;
}

// POST a delete as the confirmation form would.
export async function postDelete(
  base: string,
  urlPath: string,
  { cookie, csrf }: { cookie?: string; csrf?: string | null } = {},
): Promise<PageResponse> {
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  if (cookie) headers.cookie = cookie;
  const res = await fetch(`${base}${urlPath}`, {
    method: "POST",
    redirect: "manual",
    headers,
    body: new URLSearchParams(csrf == null ? {} : { csrf }).toString(),
  });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

// How many drafts the server currently has (via the token-locked list API).
export async function draftCount(base: string, token: string): Promise<number> {
  const res = await fetch(`${base}/api/drafts`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const { drafts } = (await res.json()) as { drafts: unknown[] };
  return drafts.length;
}

// Read the test-only counters exposed by POSTPLAN_TEST_SEAMS=1.
export interface TestStats {
  loads: number;
  parses: number;
  commits: number;
  uncertain: boolean;
}

export async function getStats(base: string, token: string): Promise<TestStats> {
  const res = await fetch(`${base}/__test/stats`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status !== 200) throw new Error(`stats endpoint returned ${res.status}`);
  return (await res.json()) as TestStats;
}

export async function resetStats(base: string, token: string): Promise<void> {
  const res = await fetch(`${base}/__test/stats`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status !== 200) throw new Error(`stats reset returned ${res.status}`);
}

// Schedule storage failures at a named stage (test-only seam).
export async function setFault(base: string, token: string, stage: string, count = 1): Promise<void> {
  const url = `${base}/__test/faults?stage=${encodeURIComponent(stage)}&count=${count}`;
  const res = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
  if (res.status !== 200) throw new Error(`fault injection returned ${res.status}`);
}
