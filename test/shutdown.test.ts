// Graceful shutdown on SIGTERM.
//
// Railway stops a replaced deployment with SIGTERM, sent to `bun run start`.
// Before this, the server died from the signal, `bun run` exited non-zero, and
// every routine redeploy was recorded as CRASHED. These run the server exactly
// that way — through the package.json start script — and check the exit.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";

import { REPO_ROOT, htmlDoc, parseHttpResponse } from "./helpers.ts";

interface Started { child: ChildProcess; port: number; token: string; output: () => string; exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> }

async function startViaScript(): Promise<Started> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "postplan-shutdown-"));
  const token = randomBytes(24).toString("hex");
  const child = spawn(process.execPath, ["run", "start"], {
    cwd: REPO_ROOT,
    env: { ...process.env, PORT: "0", POSTPLAN_TOKEN: token, POSTPLAN_DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout!.on("data", (b: Buffer) => { out += b.toString("utf8"); });
  child.stderr!.on("data", (b: Buffer) => { out += b.toString("utf8"); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("exit", (code, signal) => {
      fs.rmSync(dataDir, { recursive: true, force: true });
      resolve({ code, signal });
    });
  });
  const port = await new Promise<number>((resolve, reject) => {
    const poll = setInterval(() => {
      const m = out.match(/serving on http:\/\/localhost:(\d+)/);
      if (m) { clearInterval(poll); resolve(Number(m[1])); }
    }, 10);
    setTimeout(() => { clearInterval(poll); reject(new Error(`did not start: ${out}`)); }, 10_000);
  });
  return { child, port, token, output: () => out, exited };
}

test("SIGTERM to `bun run start` exits 0, so a redeploy is not recorded as a crash", async () => {
  const s = await startViaScript();
  s.child.kill("SIGTERM");
  const { code, signal } = await s.exited;
  assert.deepEqual({ code, signal }, { code: 0, signal: null }, s.output());
  assert.match(s.output(), /SIGTERM: shutting down/);
});

test("an upload in flight when SIGTERM arrives still completes", async () => {
  const s = await startViaScript();
  const body = Buffer.from(JSON.stringify({ html: htmlDoc("in flight"), filename: "plan.html" }));
  const head =
    `POST /api/uploads HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${s.token}\r\n` +
    `Content-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`;

  const response = new Promise<Buffer>((resolve, reject) => {
    const socket = net.connect(s.port, "127.0.0.1");
    const chunks: Buffer[] = [];
    socket.on("data", (d: Buffer) => void chunks.push(d));
    socket.on("error", reject);
    socket.on("close", () => resolve(Buffer.concat(chunks)));
    socket.on("connect", async () => {
      // Half the body, then the signal, then the rest.
      const half = Math.floor(body.length / 2);
      socket.write(head);
      socket.write(body.subarray(0, half));
      await new Promise((r) => setTimeout(r, 100));
      s.child.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 100));
      socket.write(body.subarray(half));
    });
  });

  const res = parseHttpResponse(await response);
  assert.equal(res.status, 201, res.body);
  const { code } = await s.exited;
  assert.equal(code, 0, s.output());
});

test("no new connections are accepted once shutdown starts", async () => {
  const s = await startViaScript();
  // Hold one request open so the server stays in its shutting-down state.
  const held = net.connect(s.port, "127.0.0.1");
  await new Promise((r) => held.on("connect", r));
  held.write(`POST /api/uploads HTTP/1.1\r\nHost: localhost\r\nContent-Length: 10\r\n\r\n`);
  await new Promise((r) => setTimeout(r, 50));

  s.child.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 100));
  const refused = await fetch(`http://127.0.0.1:${s.port}/healthz`).then(() => false, () => true);
  assert.ok(refused, "a new request was served after SIGTERM");

  held.destroy();
  const { code } = await s.exited;
  assert.equal(code, 0, s.output());
});
