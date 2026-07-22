// Test helpers for driving the real Postplan HTTP server.
//
// These spawn `postplan.mjs serve` as a child process against a throwaway data
// dir and a random token, then talk to it over a raw TCP socket so a test can
// control exactly where HTTP request-body bytes are split.

import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "postplan.mjs");

// Spawn a fresh server on an OS-assigned port with public reads enabled and an
// isolated data dir. Resolves once the server logs the port it actually bound.
export async function startServer() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "postplan-test-"));
  const token = randomBytes(24).toString("hex");
  const child = spawn(process.execPath, [SERVER, "serve", "--port", "0"], {
    env: {
      ...process.env,
      POSTPLAN_TOKEN: token,
      POSTPLAN_DATA_DIR: dataDir,
      POSTPLAN_PUBLIC_READS: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const port = await new Promise((resolve, reject) => {
    let out = "";
    const onData = (buf) => {
      out += buf.toString("utf8");
      const m = out.match(/serving on http:\/\/localhost:(\d+)/);
      if (m) {
        child.stdout.off("data", onData);
        resolve(Number(m[1]));
      }
    };
    child.stdout.on("data", onData);
    child.on("exit", (code) => reject(new Error(`server exited early (code ${code}): ${out}`)));
    setTimeout(() => reject(new Error(`server did not start in time: ${out}`)), 10_000);
  });

  const stop = async () => {
    if (!child.killed) child.kill("SIGKILL");
    await new Promise((r) => (child.exitCode != null ? r() : child.on("exit", r)));
    fs.rmSync(dataDir, { recursive: true, force: true });
  };

  return { port, token, dataDir, base: `http://localhost:${port}`, stop };
}

// Send a POST /api/uploads request over a raw socket, splitting the body buffer
// at the given byte offsets (each split forces a separate TCP write with a
// short gap, so the server sees the boundary between two 'data' events).
// `contentLength` overrides the declared Content-Length (used to send a body
// that ends mid-character). Returns { status, body }.
export function rawUpload(port, token, bodyBuf, splits = [], { contentLength } = {}) {
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
  const parts = [];
  for (let i = 0; i < bounds.length - 1; i++) parts.push(bodyBuf.subarray(bounds[i], bounds[i + 1]));

  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.setNoDelay(true);
    const chunks = [];
    socket.on("data", (d) => chunks.push(d));
    socket.on("error", reject);
    socket.on("close", () => {
      resolve(parseHttpResponse(Buffer.concat(chunks)));
    });

    socket.on("connect", async () => {
      socket.write(head);
      for (let i = 0; i < parts.length; i++) {
        socket.write(parts[i]);
        // Force a boundary: let the write flush before the next part.
        if (i < parts.length - 1) await new Promise((r) => setTimeout(r, 15));
      }
    });
  });
}

// Minimal HTTP/1.1 response parser: status line + (optionally chunked) body.
function parseHttpResponse(buf) {
  const sep = buf.indexOf("\r\n\r\n");
  const head = buf.slice(0, sep).toString("utf8");
  const lines = head.split("\r\n");
  const status = Number(lines[0].split(" ")[1]);
  const chunked = lines.some((l) => /^transfer-encoding:\s*chunked/i.test(l));
  let rest = buf.subarray(sep + 4);

  if (!chunked) return { status, body: rest.toString("utf8") };

  const out = [];
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
export function byteIndexOf(bodyBuf, needle) {
  const idx = bodyBuf.indexOf(Buffer.from(needle, "utf8"));
  if (idx === -1) throw new Error(`needle not found in body: ${needle}`);
  return idx;
}

// Fetch a stored draft's served HTML.
export async function fetchDraft(base, draftId) {
  const res = await fetch(`${base}/d/${draftId}`);
  return { status: res.status, text: await res.text() };
}

// How many drafts the server currently has (via the token-locked list API).
export async function draftCount(base, token) {
  const res = await fetch(`${base}/api/drafts`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const { drafts } = await res.json();
  return drafts.length;
}
