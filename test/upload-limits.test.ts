// Tests for the separate wire/HTML upload limits and the reliable 413 response
// (issue #7).
//
// The wire cap must be enforced without `req.destroy()`ing the connection before
// the error can be delivered, and the HTML cap must short-circuit before parse5
// ever sees the document. These drive the real server over raw sockets so a
// chunked request and an early Content-Length rejection are both exercised.

import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";

import {
  startServer,
  rawUpload,
  rawUploadChunked,
  rawSend,
  fetchDraft,
  draftCount,
  getStats,
  resetStats,
  htmlDoc,
} from "./helpers.ts";

const HTML_LIMIT = 1024;
const REQUEST_LIMIT = 4096;

// A minimal valid document whose UTF-8 byte length is exactly `n`.
function htmlOfSize(n: number): string {
  const prefix = "<!doctype html><html><head><title>t</title></head><body>";
  const suffix = "</body></html>";
  const pad = n - Buffer.byteLength(prefix + suffix, "utf8");
  assert.ok(pad >= 0, "requested size must fit the wrapper");
  return `${prefix}${"x".repeat(pad)}${suffix}`;
}

function bodyOf(html: string): Buffer {
  return Buffer.from(JSON.stringify({ filename: "plan.html", html }), "utf8");
}

const limitsEnv = { MAX_HTML_BYTES: String(HTML_LIMIT), MAX_REQUEST_BYTES: String(REQUEST_LIMIT), POSTPLAN_TEST_SEAMS: "1" };

test("decoded HTML at the exact byte limit succeeds; one byte over is a 413", async (t) => {
  const srv = await startServer({ env: limitsEnv });
  t.after(srv.stop);

  const exact = await rawUpload(srv.port, srv.token, bodyOf(htmlOfSize(HTML_LIMIT)));
  assert.equal(exact.status, 201, exact.body);

  const over = await rawUpload(srv.port, srv.token, bodyOf(htmlOfSize(HTML_LIMIT + 1)));
  assert.equal(over.status, 413, over.body);
  assert.equal(JSON.parse(over.body).error, "HTML failed validation.");
  assert.equal(await draftCount(srv.base, srv.token), 1, "the rejected upload created no Draft");

  // A subsequent valid upload still works.
  const after = await rawUpload(srv.port, srv.token, bodyOf(htmlDoc("again")));
  assert.equal(after.status, 201);
});

test("the HTML limit counts UTF-8 bytes, not characters", async (t) => {
  const srv = await startServer({ env: limitsEnv });
  t.after(srv.stop);

  // 400 CJK characters (3 bytes each) = 1200 bytes but only 400 code units.
  const html = htmlDoc("多".repeat(400));
  assert.ok(html.length < HTML_LIMIT, "sanity: string length is under the limit");
  assert.ok(Buffer.byteLength(html, "utf8") > HTML_LIMIT, "sanity: byte length is over the limit");

  const res = await rawUpload(srv.port, srv.token, bodyOf(html));
  assert.equal(res.status, 413, res.body);
  assert.equal(await draftCount(srv.base, srv.token), 0);
});

test("\\uXXXX expansion beyond the old 3x cap still publishes", async (t) => {
  const srv = await startServer({ env: limitsEnv });
  t.after(srv.stop);

  // Each BEL (U+0007) is one UTF-8 byte in the document but six wire bytes in
  // JSON as \u0007, so the body exceeds the old 3 * MAX_BYTES heuristic while
  // the decoded HTML stays under the cap.
  const html = htmlDoc("\u0007".repeat(600));
  const body = bodyOf(html);
  assert.ok(Buffer.byteLength(html, "utf8") <= HTML_LIMIT, "decoded HTML is under the cap");
  assert.ok(body.length > HTML_LIMIT * 3, "wire body exceeds the old heuristic");

  const res = await rawUpload(srv.port, srv.token, body);
  assert.equal(res.status, 201, res.body);
  const { draftId } = JSON.parse(res.body) as { draftId: string };
  const { status, text } = await fetchDraft(srv.base, draftId);
  assert.equal(status, 200);
  assert.deepEqual(Buffer.from(text, "utf8"), Buffer.from(html, "utf8"), "bytes survive intact");
});

test("an oversized declared Content-Length returns a complete 413 JSON body", async (t) => {
  const srv = await startServer({ env: limitsEnv });
  t.after(srv.stop);

  const head =
    `POST /api/uploads HTTP/1.1\r\n` +
    `Host: localhost\r\n` +
    `Authorization: Bearer ${srv.token}\r\n` +
    `Content-Type: application/json\r\n` +
    `Content-Length: ${REQUEST_LIMIT * 10}\r\n` +
    `Connection: close\r\n\r\n`;

  const res = await rawSend(srv.port, head, [Buffer.from("x".repeat(100), "utf8")]);
  assert.equal(res.status, 413, res.body);
  assert.equal(JSON.parse(res.body).error, "Request body too large.");
  assert.equal(await draftCount(srv.base, srv.token), 0);
});

test("a chunked request crossing the wire cap in a later chunk returns 413", async (t) => {
  const srv = await startServer({ env: limitsEnv });
  t.after(srv.stop);

  const body = Buffer.concat([Buffer.from('{"filename":"x.html","html":"', "utf8"), Buffer.alloc(REQUEST_LIMIT + 500, 0x61)]);
  const res = await rawUploadChunked(srv.port, srv.token, body, [1024]);
  assert.equal(res.status, 413, res.body);
  assert.equal(JSON.parse(res.body).error, "Request body too large.");
  assert.equal(await draftCount(srv.base, srv.token), 0);

  // The server survives and accepts the next request.
  const good = await rawUpload(srv.port, srv.token, bodyOf(htmlDoc("next")));
  assert.equal(good.status, 201, good.body);
});

test("oversized HTML never reaches the parser", async (t) => {
  const srv = await startServer({ env: limitsEnv });
  t.after(srv.stop);

  await resetStats(srv.base, srv.token);
  const res = await rawUpload(srv.port, srv.token, bodyOf(htmlOfSize(HTML_LIMIT + 10)));
  assert.equal(res.status, 413, res.body);
  assert.equal((await getStats(srv.base, srv.token)).htmlParses, 0, "parse5 must not be invoked for oversized HTML");

  // Under the limit it is parsed exactly once.
  const ok = await rawUpload(srv.port, srv.token, bodyOf(htmlDoc("parsed")));
  assert.equal(ok.status, 201);
  assert.equal((await getStats(srv.base, srv.token)).htmlParses, 1);
});

test("an invalid limit configuration fails startup clearly", async () => {
  await assert.rejects(
    startServer({ env: { MAX_HTML_BYTES: "not-a-number" } }),
    /Invalid MAX_HTML_BYTES/,
  );
});

test("a bad metadata field is a 400 and cannot poison the index", async (t) => {
  const srv = await startServer({ env: limitsEnv });
  t.after(srv.stop);

  const res = await rawUpload(
    srv.port,
    srv.token,
    Buffer.from(JSON.stringify({ filename: "x.html", html: htmlDoc("ok"), description: { nope: true } }), "utf8"),
  );
  assert.equal(res.status, 400, res.body);
  assert.equal(JSON.parse(res.body).error, "Invalid upload payload.");
  assert.equal(await draftCount(srv.base, srv.token), 0);
});

// ---------------------------------------------------------------------------
// Default derivation and configuration validation
// ---------------------------------------------------------------------------
test("the default wire cap derives from MAX_HTML_BYTES as 6x + 64 KiB", async (t) => {
  // Only the HTML limit is configured; the wire cap must default to
  // 6 * 1024 + 64 KiB = 71680.
  const srv = await startServer({ env: { MAX_HTML_BYTES: String(HTML_LIMIT) } });
  t.after(srv.stop);

  const payload = JSON.stringify({ filename: "plan.html", html: htmlDoc("under derived cap") });
  // 5000 bytes of trailing whitespace is still valid JSON and stays under the
  // derived cap, while exceeding the old 3 * MAX_HTML_BYTES heuristic.
  const under = Buffer.from(`${payload}${" ".repeat(5000)}`, "utf8");
  assert.ok(under.length > HTML_LIMIT * 3);
  assert.equal((await rawUpload(srv.port, srv.token, under)).status, 201);

  const over = Buffer.from(`${payload}${" ".repeat(80000)}`, "utf8");
  assert.ok(over.length > 6 * HTML_LIMIT + 64 * 1024);
  const res = await rawUpload(srv.port, srv.token, over);
  assert.equal(res.status, 413, res.body);
  assert.equal(JSON.parse(res.body).error, "Request body too large.");
});

test("an invalid MAX_REQUEST_BYTES fails startup clearly", async () => {
  await assert.rejects(
    startServer({ env: { MAX_REQUEST_BYTES: "-1" } }),
    /Invalid MAX_REQUEST_BYTES/,
  );
});

test("a client that disconnects mid-body leaves the server healthy", async (t) => {
  const srv = await startServer({ env: limitsEnv });
  t.after(srv.stop);

  await new Promise<void>((resolve) => {
    const socket = net.connect(srv.port, "127.0.0.1");
    socket.on("connect", () => {
      socket.write(
        `POST /api/uploads HTTP/1.1\r\nHost: localhost\r\n` +
        `Authorization: Bearer ${srv.token}\r\nContent-Type: application/json\r\n` +
        `Content-Length: 100000\r\nConnection: close\r\n\r\n`,
      );
      socket.write(Buffer.from('{"filename":"x.html","html":"<p>partial', "utf8"));
      // Hang up before completing the body.
      setTimeout(() => { socket.destroy(); resolve(); }, 30);
    });
    socket.on("error", () => resolve());
  });

  assert.equal((await fetch(`${srv.base}/healthz`)).status, 200, "the server must survive an aborted body");
  assert.equal(await draftCount(srv.base, srv.token), 0, "no partial upload may be published");
  const good = await rawUpload(srv.port, srv.token, bodyOf(htmlDoc("after abort")));
  assert.equal(good.status, 201, good.body);
});
