// Tests for the shape check on POST /api/uploads bodies (issue #2).
//
// The handler used to cast the parsed body to UploadPayload. That held for
// every malformed body except the ones that parse to a non-object: `null` in
// particular reached `payload.html` and threw a TypeError mid-request instead
// of answering with a status. These pin the 400s down and confirm the 201/422/
// 401 paths either side of the check are untouched.

import test from "node:test";
import assert from "node:assert/strict";
import { startServer, rawUpload, draftCount, htmlDoc } from "./helpers.ts";

// Bodies that are valid JSON but cannot be an upload payload.
const NON_OBJECT_BODIES: Array<[label: string, body: string]> = [
  ["null", "null"],
  ["an array", `[{"html":"<p>x</p>"}]`],
  ["a string", `"just a string"`],
  ["a number", "42"],
  ["a boolean", "true"],
];

for (const [label, body] of NON_OBJECT_BODIES) {
  test(`a body that is ${label} is rejected with 400`, async (t) => {
    const srv = await startServer();
    t.after(srv.stop);

    const { status, body: resBody } = await rawUpload(srv.port, srv.token, Buffer.from(body, "utf8"));

    assert.equal(status, 400, `expected 400, got ${status}: ${resBody}`);
    assert.equal(JSON.parse(resBody).error, "Bad JSON.");
    assert.equal(await draftCount(srv.base, srv.token), 0, "no draft should have been created");
  });
}

test("the server survives a null body and still serves the next upload", async (t) => {
  const srv = await startServer();
  t.after(srv.stop);

  const rejected = await rawUpload(srv.port, srv.token, Buffer.from("null", "utf8"));
  assert.equal(rejected.status, 400);

  // The point of the test: an unhandled TypeError in the 'end' listener would
  // take the process down, so this second request is what proves it didn't.
  const good = Buffer.from(JSON.stringify({ filename: "plan.html", html: htmlDoc("t") }), "utf8");
  const { status, body } = await rawUpload(srv.port, srv.token, good);

  assert.equal(status, 201, `expected 201, got ${status}: ${body}`);
  assert.equal(await draftCount(srv.base, srv.token), 1);
});

test("an object body with no html still fails validation with 422", async (t) => {
  const srv = await startServer();
  t.after(srv.stop);

  const { status, body } = await rawUpload(srv.port, srv.token, Buffer.from("{}", "utf8"));

  assert.equal(status, 422, `expected 422, got ${status}: ${body}`);
  assert.equal(await draftCount(srv.base, srv.token), 0);
});

test("a non-string html on an object body still fails validation with 422", async (t) => {
  const srv = await startServer();
  t.after(srv.stop);

  const body = Buffer.from(JSON.stringify({ filename: "plan.html", html: 42 }), "utf8");
  const { status, body: resBody } = await rawUpload(srv.port, srv.token, body);

  assert.equal(status, 422, `expected 422, got ${status}: ${resBody}`);
  assert.equal(await draftCount(srv.base, srv.token), 0);
});

test("the shape check runs after auth: a null body without a token is 401", async (t) => {
  const srv = await startServer();
  t.after(srv.stop);

  const { status } = await rawUpload(srv.port, "wrong-token", Buffer.from("null", "utf8"));

  assert.equal(status, 401);
});

test("a well-formed object body is still accepted with 201", async (t) => {
  const srv = await startServer();
  t.after(srv.stop);

  const body = Buffer.from(JSON.stringify({ filename: "plan.html", html: htmlDoc("kept working") }), "utf8");
  const { status, body: resBody } = await rawUpload(srv.port, srv.token, body);

  assert.equal(status, 201, `expected 201, got ${status}: ${resBody}`);
  const { draftId, versionNumber } = JSON.parse(resBody) as { draftId: string; versionNumber: number };
  assert.ok(draftId, "response should carry a draftId");
  assert.equal(versionNumber, 1);
});
