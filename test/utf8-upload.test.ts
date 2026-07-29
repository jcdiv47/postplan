// Regression tests for the UTF-8 upload path (spec: fix.md, ticket 01).
//
// These exercise the real POST /api/uploads HTTP endpoint over a raw TCP socket
// so we control exactly where request-body bytes are split. They must FAIL
// against the pre-fix `raw += chunk` implementation and PASS after the
// streaming-TextDecoder fix.

import test from "node:test";
import assert from "node:assert/strict";
import {
  startServer,
  rawUpload,
  byteIndexOf,
  fetchDraft,
  draftCount,
} from "./helpers.ts";
import type { TestServer } from "./helpers.ts";

const GUANGXIN = "普陀·光新"; // mixed ASCII punct + CJK; 新 = U+65B0 (3-byte)
const HOUSE = "🏠"; // U+1F3E0 (4-byte)

function htmlDoc(inner: string): string {
  return `<!doctype html><html><head><title>t</title></head><body><p>${inner}</p></body></html>`;
}

function jsonBody(html: string): Buffer {
  return Buffer.from(JSON.stringify({ filename: "plan.html", html }), "utf8");
}

// Upload `html` split at `splits` byte offsets, then return the served HTML.
async function uploadAndFetch(srv: TestServer, html: string, splits: number[]): Promise<string> {
  const body = jsonBody(html);
  const { status, body: resBody } = await rawUpload(srv.port, srv.token, body, splits);
  assert.equal(status, 201, `expected 201, got ${status}: ${resBody}`);
  const { draftId } = JSON.parse(resBody) as { draftId: string };
  const { status: getStatus, text } = await fetchDraft(srv.base, draftId);
  assert.equal(getStatus, 200);
  return text;
}

test("multi-byte char split at the e6|96 b0 boundary survives intact", async (t) => {
  const srv = await startServer();
  t.after(srv.stop);

  const html = htmlDoc(GUANGXIN);
  // Split immediately after the first byte of 新 (e6 | 96 b0).
  const split = byteIndexOf(jsonBody(html), "新") + 1;
  const text = await uploadAndFetch(srv, html, [split]);

  assert.ok(text.includes(GUANGXIN), "served HTML should contain 普陀·光新 intact");
  assert.equal((text.match(/�/g) || []).length, 0, "served HTML should have zero replacement chars");
  // Byte-for-byte fidelity against the local UTF-8 source.
  assert.deepEqual(Buffer.from(text, "utf8"), Buffer.from(html, "utf8"));
});

test("sweep every interior split of the 3-byte char 新", async (t) => {
  const srv = await startServer();
  t.after(srv.stop);

  const html = htmlDoc(GUANGXIN);
  const base = byteIndexOf(jsonBody(html), "新");
  // Interior boundaries of a 3-byte char: after byte 1 and after byte 2.
  for (const off of [1, 2]) {
    const text = await uploadAndFetch(srv, html, [base + off]);
    assert.ok(text.includes(GUANGXIN), `split at +${off}: 普陀·光新 should survive`);
    assert.equal((text.match(/�/g) || []).length, 0, `split at +${off}: zero replacement chars`);
  }
});

test("sweep every interior split of the 4-byte char 🏠", async (t) => {
  const srv = await startServer();
  t.after(srv.stop);

  const html = htmlDoc(`home ${HOUSE} sweet`);
  const base = byteIndexOf(jsonBody(html), HOUSE);
  // Interior boundaries of a 4-byte char: after bytes 1, 2, and 3.
  for (const off of [1, 2, 3]) {
    const text = await uploadAndFetch(srv, html, [base + off]);
    assert.ok(text.includes(HOUSE), `split at +${off}: 🏠 should survive`);
    assert.equal((text.match(/�/g) || []).length, 0, `split at +${off}: zero replacement chars`);
  }
});

test("complete-but-invalid UTF-8 body returns 400 and creates no draft", async (t) => {
  const srv = await startServer();
  t.after(srv.stop);

  // 0xFF is never a valid UTF-8 byte. Body is otherwise well-formed JSON text.
  const body = Buffer.concat([
    Buffer.from('{"filename":"x.html","html":"<p>x', "utf8"),
    Buffer.from([0xff]),
    Buffer.from('</p>"}', "utf8"),
  ]);
  // Split around the bad byte to prove it's rejected regardless of chunking.
  const bad = body.indexOf(0xff);
  const { status, body: resBody } = await rawUpload(srv.port, srv.token, body, [bad, bad + 1]);

  assert.equal(status, 400, resBody);
  assert.equal(JSON.parse(resBody).error, "Request body is not valid UTF-8 JSON.");
  assert.equal(await draftCount(srv.base, srv.token), 0);
});

test("body ending in a truncated multi-byte character returns 400 and creates no draft", async (t) => {
  const srv = await startServer();
  t.after(srv.stop);

  // Body whose final character is a 3-byte char (e6 96 b0), then drop its last
  // byte and declare the truncated length. The streaming decoder's end-flush
  // must reject the dangling e6 96.
  const full = Buffer.from('{"filename":"x.html","html":"<p>新', "utf8");
  const truncated = full.subarray(0, full.length - 1); // ...e6 96
  const { status, body: resBody } = await rawUpload(
    srv.port,
    srv.token,
    truncated,
    [truncated.length - 2],
    { contentLength: truncated.length },
  );

  assert.equal(status, 400, resBody);
  assert.equal(JSON.parse(resBody).error, "Request body is not valid UTF-8 JSON.");
  assert.equal(await draftCount(srv.base, srv.token), 0);
});

test("a legitimately-encoded U+FFFD stays valid", async (t) => {
  const srv = await startServer();
  t.after(srv.stop);

  // A real replacement character (ef bf bd) is valid UTF-8 — fatal decoding
  // rejects invalid *bytes*, not a legitimately-encoded U+FFFD.
  const html = htmlDoc("before�after");
  const text = await uploadAndFetch(srv, html, []);
  assert.ok(text.includes("before�after"), "the encoded U+FFFD should be preserved");
});
