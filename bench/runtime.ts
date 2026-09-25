// Node vs Bun as the runtime for postplan — the evidence behind ADR-0005.
//
// On macOS the upload numbers are not comparable: Node's fsync issues
// F_FULLFSYNC and Bun's does not, so Bun is measured doing less work. Run it in
// Linux (the Railway target) for a fair upload comparison.
//
// The driver always runs on Node, so the only thing that changes between the
// two columns is the runtime executing src/postplan.ts. Runs are interleaved
// (node, bun, node, bun, ...) so drift in machine load hits both equally.
//
//   node bench/runtime.ts            # full run
//   BENCH_QUICK=1 node bench/runtime.ts
//
// What it measures, and why each matters here:
//   cli-help     cold start of the linked CLI — agents invoke it per publish
//   cli-upload   `postplan upload` end to end against a live server
//   serve-start  spawn -> "serving on" — Railway restarts, test harness
//   GET /d/:id   the hot read path on the deployed instance
//   POST upload  parse5 + storage commit under concurrency
//   rss          resident memory of the server after load

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src/postplan.ts");
const QUICK = process.env.BENCH_QUICK === "1";

const RUNTIMES: Record<string, string> = {
  node: process.execPath,
  bun: spawnSync("which", ["bun"], { encoding: "utf8" }).stdout.trim(),
};

// A realistic draft: ~60 KB of nested markup, so parse5 does real work.
const section = (i: number): string =>
  `<section id="s${i}"><h2>Section ${i}</h2>` +
  `<p>Lorem ipsum <strong>dolor</strong> sit amet, <a href="#s${i}">consectetur</a> adipiscing elit — ünïcødé ✓.</p>` +
  `<ul>${Array.from({ length: 8 }, (_, j) => `<li>item ${i}.${j} <code>x=${j}</code></li>`).join("")}</ul>` +
  `<table><tr><th>a</th><th>b</th></tr><tr><td>${i}</td><td>${i * 2}</td></tr></table></section>`;
const HTML =
  `<!doctype html><html><head><title>Bench plan</title><style>body{font:14px sans-serif}</style></head>` +
  `<body>${Array.from({ length: 80 }, (_, i) => section(i)).join("")}</body></html>`;

// ---- stats ----
const pct = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};
const median = (xs: number[]): number => pct(xs, 50);
const fmt = (n: number, d = 1): string => n.toFixed(d);

// ---- process helpers ----
function timeRun(bin: string, args: string[], env: NodeJS.ProcessEnv): number {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(bin, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (r.status !== 0) throw new Error(`${bin} ${args.join(" ")} exited ${r.status}: ${r.stderr}`);
  return ms;
}

interface Server { child: ChildProcess; port: number; token: string; dataDir: string; startMs: number }

async function startServer(bin: string): Promise<Server> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "postplan-bench-"));
  const token = randomBytes(24).toString("hex");
  const t0 = process.hrtime.bigint();
  const child = spawn(bin, [SRC, "serve", "--port", "0"], {
    env: { ...process.env, POSTPLAN_TOKEN: token, POSTPLAN_DATA_DIR: dataDir, POSTPLAN_PUBLIC_READS: "true" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const port = await new Promise<number>((resolve, reject) => {
    let out = "";
    child.stdout!.on("data", (b: Buffer) => {
      out += b.toString();
      const m = out.match(/serving on http:\/\/localhost:(\d+)/);
      if (m) resolve(Number(m[1]));
    });
    child.on("exit", (c) => reject(new Error(`server exited ${c}: ${out}`)));
  });
  return { child, port, token, dataDir, startMs: Number(process.hrtime.bigint() - t0) / 1e6 };
}

async function stopServer(s: Server): Promise<void> {
  s.child.kill("SIGKILL");
  await new Promise<void>((r) => (s.child.exitCode != null ? r() : void s.child.on("exit", () => r())));
  fs.rmSync(s.dataDir, { recursive: true, force: true });
}

function rssMb(pid: number): number {
  const r = spawnSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" });
  return Number(r.stdout.trim()) / 1024;
}

// ---- HTTP load ----
const agent = new http.Agent({ keepAlive: true, maxSockets: 256 });

function request(port: number, method: string, urlPath: string, headers: Record<string, string>, body?: Buffer): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: urlPath, headers, agent }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode!));
    });
    req.on("error", reject);
    req.end(body);
  });
}

interface LoadResult { rps: number; p50: number; p99: number; errors: number }

async function load(
  port: number, concurrency: number, seconds: number,
  make: () => { method: string; path: string; headers: Record<string, string>; body?: Buffer; ok: number },
): Promise<LoadResult> {
  const lat: number[] = [];
  let errors = 0;
  const deadline = Date.now() + seconds * 1000;
  const worker = async (): Promise<void> => {
    while (Date.now() < deadline) {
      const r = make();
      const t0 = process.hrtime.bigint();
      const status = await request(port, r.method, r.path, r.headers, r.body).catch(() => -1);
      lat.push(Number(process.hrtime.bigint() - t0) / 1e6);
      if (status !== r.ok) errors++;
    }
  };
  const t0 = Date.now();
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { rps: lat.length / ((Date.now() - t0) / 1000), p50: median(lat), p99: pct(lat, 99), errors };
}

async function publish(s: Server): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${s.port}/api/uploads`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.token}` },
    body: JSON.stringify({ html: HTML, filename: "plan.html" }),
  });
  const j = (await res.json()) as { draftId?: string; id?: string };
  const id = j.draftId ?? j.id;
  if (!id) throw new Error(`publish failed: ${JSON.stringify(j)}`);
  return id;
}

// ---- benchmarks ----
type Row = Record<string, Record<string, string>>;
const table: Row = {};
const put = (metric: string, rt: string, v: string): void => void ((table[metric] ??= {})[rt] = v);

async function main(): Promise<void> {
  const names = Object.keys(RUNTIMES);
  console.log(`node ${spawnSync(RUNTIMES.node!, ["--version"], { encoding: "utf8" }).stdout.trim()}, ` +
    `bun ${spawnSync(RUNTIMES.bun!, ["--version"], { encoding: "utf8" }).stdout.trim()}, ` +
    `${os.cpus()[0]!.model} x${os.cpus().length}, quick=${QUICK}\n`);

  const cliRuns = QUICK ? 10 : 40;
  const env = { ...process.env };

  // cli-help: `postplan` with no args prints usage and exits 0.
  {
    const t: Record<string, number[]> = { node: [], bun: [] };
    for (const n of names) timeRun(RUNTIMES[n]!, [SRC], env); // warm the fs cache
    for (let i = 0; i < cliRuns; i++) for (const n of names) t[n]!.push(timeRun(RUNTIMES[n]!, [SRC], env));
    for (const n of names) put("cli-help ms (p50 / p90)", n, `${fmt(median(t[n]!))} / ${fmt(pct(t[n]!, 90))}`);
  }

  // cli-upload: the agent path, against one fixed (node) server so only the CLI runtime varies.
  {
    const srv = await startServer(RUNTIMES.node!);
    const file = path.join(srv.dataDir, "..", `bench-${process.pid}.html`);
    fs.writeFileSync(file, HTML);
    const uenv = { ...env, POSTPLAN_TOKEN: srv.token, POSTPLAN_API_URL: `http://127.0.0.1:${srv.port}`, HOME: srv.dataDir };
    const t: Record<string, number[]> = { node: [], bun: [] };
    for (let i = 0; i < cliRuns; i++) for (const n of names) t[n]!.push(timeRun(RUNTIMES[n]!, [SRC, "upload", file, "--new"], uenv));
    for (const n of names) put("cli-upload ms (p50 / p90)", n, `${fmt(median(t[n]!))} / ${fmt(pct(t[n]!, 90))}`);
    fs.rmSync(file);
    await stopServer(srv);
  }

  // serve-start
  {
    const t: Record<string, number[]> = { node: [], bun: [] };
    for (let i = 0; i < (QUICK ? 5 : 15); i++) for (const n of names) {
      const s = await startServer(RUNTIMES[n]!);
      t[n]!.push(s.startMs);
      await stopServer(s);
    }
    for (const n of names) put("serve-start ms (p50)", n, fmt(median(t[n]!)));
  }

  // server throughput, one fresh server per runtime per round
  const secs = QUICK ? 3 : 8;
  const rounds = QUICK ? 1 : 3;
  const res: Record<string, Record<string, LoadResult[]>> = {};
  const rss: Record<string, number[]> = { node: [], bun: [] };
  const idleRss: Record<string, number[]> = { node: [], bun: [] };
  const body = Buffer.from(JSON.stringify({ html: HTML, filename: "plan.html" }));
  for (let round = 0; round < rounds; round++) for (const n of names) {
    const s = await startServer(RUNTIMES[n]!);
    await new Promise((r) => setTimeout(r, 300));
    idleRss[n]!.push(rssMb(s.child.pid!));
    const id = await publish(s);
    const cases = {
      "GET /d/:id  c=64": () => load(s.port, 64, secs, () => ({ method: "GET", path: `/d/${id}`, headers: {}, ok: 200 })),
      "POST upload c=16": () => load(s.port, 16, secs, () => ({
        method: "POST", path: "/api/uploads", body, ok: 201,
        headers: { "Content-Type": "application/json", "Content-Length": String(body.length), Authorization: `Bearer ${s.token}` },
      })),
    };
    for (const [label, run] of Object.entries(cases)) {
      await load(s.port, 8, 1, () => ({ method: "GET", path: `/d/${id}`, headers: {}, ok: 200 })); // warm-up / JIT
      ((res[label] ??= {})[n] ??= []).push(await run());
    }
    rss[n]!.push(rssMb(s.child.pid!));
    await stopServer(s);
  }
  for (const [label, byRt] of Object.entries(res)) for (const n of names) {
    const rs = byRt[n]!;
    const errs = rs.reduce((a, r) => a + r.errors, 0);
    put(`${label} req/s`, n, fmt(median(rs.map((r) => r.rps)), 0) + (errs ? ` (${errs} errors!)` : ""));
    put(`${label} p50 / p99 ms`, n, `${fmt(median(rs.map((r) => r.p50)), 2)} / ${fmt(median(rs.map((r) => r.p99)), 2)}`);
  }
  for (const n of names) put("rss idle MB", n, fmt(median(idleRss[n]!)));
  for (const n of names) put("rss after load MB", n, fmt(median(rss[n]!)));

  // print
  const w = Math.max(...Object.keys(table).map((k) => k.length));
  console.log(`${"".padEnd(w)}  ${names.map((n) => n.padStart(22)).join("")}`);
  for (const [k, v] of Object.entries(table)) console.log(`${k.padEnd(w)}  ${names.map((n) => (v[n] ?? "").padStart(22)).join("")}`);
  agent.destroy();
}

main().catch((e) => { console.error(e); process.exit(1); });
