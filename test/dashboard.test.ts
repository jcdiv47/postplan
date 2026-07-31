// HTTP tests for the dashboard: authentication, the 404-to-strangers rule,
// the ?token= → cookie handshake, and the CSRF-guarded delete flow.
//
// See docs/adr/0001 (the draft index is private even when reads are public),
// 0002 (browser sessions are the token in a cookie) and 0003 (separate CSP).

import test from "node:test";
import assert from "node:assert/strict";

import {
  csrfFrom,
  getPage,
  htmlDoc,
  postDelete,
  publish,
  startServer,
} from "./helpers.ts";

const UI_PATHS = ["/", "/static/app.css", "/static/app.js"];

// ---------------------------------------------------------------------------
// Nothing is visible without the token
// ---------------------------------------------------------------------------
test("every dashboard path 404s without a token, even with public reads on", async (t) => {
  const srv = await startServer({ publicReads: true });
  t.after(srv.stop);
  const { draftId } = await publish(srv.base, srv.token, { html: htmlDoc("Secret") });

  for (const p of [...UI_PATHS, `/drafts/${draftId}`, `/drafts/${draftId}/delete`]) {
    const res = await getPage(srv.base, p);
    assert.equal(res.status, 404, `${p} should 404 for a stranger`);
    assert.ok(!res.text.includes("Secret"), `${p} must not leak a draft title`);
  }
});

test("a wrong token is indistinguishable from no token", async (t) => {
  const srv = await startServer();
  t.after(srv.stop);
  const res = await getPage(srv.base, "/?token=not-the-right-token");
  assert.equal(res.status, 404);
  assert.equal(res.headers.get("set-cookie"), null, "a bad token must never set a session cookie");
});

test("a stale cookie does not shadow a fresh ?token=", async (t) => {
  const srv = await startServer();
  t.after(srv.stop);
  // Query param outranks the cookie, so re-unlocking always works.
  const res = await getPage(srv.base, `/?token=${srv.token}`, { cookie: "pp_token=stale-value" });
  assert.equal(res.status, 302);
});

// ---------------------------------------------------------------------------
// The ?token= → cookie handshake
// ---------------------------------------------------------------------------
test("a valid ?token= sets a hardened session cookie and redirects to a clean URL", async (t) => {
  const srv = await startServer();
  t.after(srv.stop);

  const res = await getPage(srv.base, `/?token=${srv.token}`);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/", "the token must not survive in the redirect target");

  const cookie = res.headers.get("set-cookie")!;
  assert.ok(cookie.startsWith(`pp_token=${srv.token};`));
  for (const flag of ["Path=/", "HttpOnly", "Secure", "SameSite=Strict", "Max-Age=2592000"]) {
    assert.ok(cookie.includes(flag), `cookie should carry ${flag}: ${cookie}`);
  }
});

test("the session cookie authenticates later requests", async (t) => {
  const srv = await startServer();
  t.after(srv.stop);
  await publish(srv.base, srv.token, { html: htmlDoc("Cookie draft") });

  const res = await getPage(srv.base, "/", { cookie: `pp_token=${srv.token}` });
  assert.equal(res.status, 200);
  assert.ok(res.text.includes("Cookie draft"));
});

test("the cookie also unlocks draft reads when public reads are off", async (t) => {
  const srv = await startServer({ publicReads: false });
  t.after(srv.stop);
  const { draftId } = await publish(srv.base, srv.token, { html: htmlDoc("Locked", "body text") });

  const stranger = await getPage(srv.base, `/d/${draftId}`);
  assert.equal(stranger.status, 404);

  // Path=/ means dashboard links can be plain public URLs and still work here.
  const owner = await getPage(srv.base, `/d/${draftId}`, { cookie: `pp_token=${srv.token}` });
  assert.equal(owner.status, 200);
  assert.ok(owner.text.includes("body text"));
});

// ---------------------------------------------------------------------------
// Rendering against real data
// ---------------------------------------------------------------------------
test("the list renders every draft, newest updated first", async (t) => {
  const srv = await startServer();
  t.after(srv.stop);
  const cookie = `pp_token=${srv.token}`;

  await publish(srv.base, srv.token, { html: htmlDoc("Older draft"), filename: "older.html" });
  await new Promise((r) => setTimeout(r, 10)); // distinct updatedAt timestamps
  await publish(srv.base, srv.token, { html: htmlDoc("Newer draft"), filename: "newer.html" });

  const res = await getPage(srv.base, "/", { cookie });
  assert.equal(res.status, 200);
  assert.equal((res.text.match(/class="draft"/g) || []).length, 2);
  assert.ok(res.text.indexOf("Newer draft") < res.text.indexOf("Older draft"));
  assert.ok(res.text.includes("2 drafts"));
});

test("the empty state appears when there are no drafts", async (t) => {
  const srv = await startServer();
  t.after(srv.stop);
  const res = await getPage(srv.base, "/", { cookie: `pp_token=${srv.token}` });
  assert.equal(res.status, 200);
  assert.ok(res.text.includes("No drafts yet"));
  assert.ok(res.text.includes("0 drafts"));
});

test("the versions page lists every version of a draft", async (t) => {
  const srv = await startServer();
  t.after(srv.stop);
  const cookie = `pp_token=${srv.token}`;

  const first = await publish(srv.base, srv.token, { html: htmlDoc("Iterating", "v1") });
  await publish(srv.base, srv.token, { html: htmlDoc("Iterating", "v2"), draftId: first.draftId });
  await publish(srv.base, srv.token, { html: htmlDoc("Iterating", "v3"), draftId: first.draftId });

  const res = await getPage(srv.base, `/drafts/${first.draftId}`, { cookie });
  assert.equal(res.status, 200);
  assert.equal((res.text.match(/class="version"/g) || []).length, 3);
  assert.equal((res.text.match(/class="badge"/g) || []).length, 1);
  assert.ok(res.text.indexOf(">v3<") < res.text.indexOf(">v1<"), "newest first");
});

test("an unknown draft renders a 404 page, not a crash", async (t) => {
  const srv = await startServer();
  t.after(srv.stop);
  const cookie = `pp_token=${srv.token}`;
  for (const p of ["/drafts/doesnotexist", "/drafts/doesnotexist/delete"]) {
    const res = await getPage(srv.base, p, { cookie });
    assert.equal(res.status, 404);
    assert.ok(res.text.includes("Not found"));
  }
});

// ---------------------------------------------------------------------------
// CSP and assets
// ---------------------------------------------------------------------------
test("the dashboard blocks inline script while drafts block all script", async (t) => {
  const srv = await startServer();
  t.after(srv.stop);
  const cookie = `pp_token=${srv.token}`;
  const { draftId } = await publish(srv.base, srv.token, { html: htmlDoc("CSP") });

  const dash = await getPage(srv.base, "/", { cookie });
  const csp = dash.headers.get("content-security-policy")!;
  assert.ok(csp.includes("script-src 'self'"));
  assert.ok(!csp.includes("unsafe-inline"), "inline script must stay blocked on the page holding the cookie");
  assert.ok(csp.includes("form-action 'self'"), "the delete form must be allowed to post");

  const draft = await getPage(srv.base, `/d/${draftId}`);
  assert.ok(draft.headers.get("content-security-policy")!.includes("script-src 'none'"),
    "draft serving policy must be unchanged");
});

test("assets are served with the right content types, only to the owner", async (t) => {
  const srv = await startServer();
  t.after(srv.stop);
  const cookie = `pp_token=${srv.token}`;

  const css = await getPage(srv.base, "/static/app.css", { cookie });
  assert.equal(css.status, 200);
  assert.match(css.headers.get("content-type")!, /^text\/css/);
  assert.ok(css.text.includes(".view-rows"));

  const js = await getPage(srv.base, "/static/app.js", { cookie });
  assert.equal(js.status, 200);
  assert.match(js.headers.get("content-type")!, /^text\/javascript/);
  assert.ok(js.text.includes("postplan.view"));
});

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------
test("delete requires a valid CSRF token", async (t) => {
  const srv = await startServer();
  t.after(srv.stop);
  const cookie = `pp_token=${srv.token}`;
  const { draftId } = await publish(srv.base, srv.token, { html: htmlDoc("Survives") });
  const confirm = await getPage(srv.base, `/drafts/${draftId}/delete`, { cookie });
  const csrf = csrfFrom(confirm.text);

  const missing = await postDelete(srv.base, `/drafts/${draftId}/delete`, { cookie });
  assert.equal(missing.status, 403);

  const wrong = await postDelete(srv.base, `/drafts/${draftId}/delete`, { cookie, csrf: "f".repeat(64) });
  assert.equal(wrong.status, 403);

  // A CSRF token minted for a different target must not be reusable here.
  const otherConfirm = await getPage(srv.base, `/drafts/${draftId}/v/1/delete`, { cookie });
  const crossed = await postDelete(srv.base, `/drafts/${draftId}/delete`, { cookie, csrf: csrfFrom(otherConfirm.text) });
  assert.equal(crossed.status, 403);

  // Nothing above touched the data.
  const list = await getPage(srv.base, "/", { cookie });
  assert.ok(list.text.includes("Survives"));

  // ...and the real one still works.
  const ok = await postDelete(srv.base, `/drafts/${draftId}/delete`, { cookie, csrf });
  assert.equal(ok.status, 303);
});

test("delete requires the session cookie even with a valid CSRF token", async (t) => {
  const srv = await startServer();
  t.after(srv.stop);
  const cookie = `pp_token=${srv.token}`;
  const { draftId } = await publish(srv.base, srv.token, { html: htmlDoc("Guarded") });
  const csrf = csrfFrom((await getPage(srv.base, `/drafts/${draftId}/delete`, { cookie })).text);

  const res = await postDelete(srv.base, `/drafts/${draftId}/delete`, { csrf });
  assert.equal(res.status, 404);
  const list = await getPage(srv.base, "/", { cookie });
  assert.ok(list.text.includes("Guarded"), "the draft must survive an unauthenticated post");
});

test("deleting a whole draft removes it and redirects to the list", async (t) => {
  const srv = await startServer();
  t.after(srv.stop);
  const cookie = `pp_token=${srv.token}`;
  const { draftId } = await publish(srv.base, srv.token, { html: htmlDoc("Doomed") });
  const csrf = csrfFrom((await getPage(srv.base, `/drafts/${draftId}/delete`, { cookie })).text);

  const res = await postDelete(srv.base, `/drafts/${draftId}/delete`, { cookie, csrf });
  assert.equal(res.status, 303, "303 so a refresh cannot repeat an irreversible action");
  assert.equal(res.headers.get("location"), "/");

  const list = await getPage(srv.base, "/", { cookie });
  assert.ok(list.text.includes("No drafts yet"));
  assert.equal((await getPage(srv.base, `/d/${draftId}`)).status, 404);
});

test("deleting one version keeps the draft and returns to it", async (t) => {
  const srv = await startServer();
  t.after(srv.stop);
  const cookie = `pp_token=${srv.token}`;
  const first = await publish(srv.base, srv.token, { html: htmlDoc("Kept", "v1") });
  await publish(srv.base, srv.token, { html: htmlDoc("Kept", "v2"), draftId: first.draftId });

  const csrf = csrfFrom((await getPage(srv.base, `/drafts/${first.draftId}/v/1/delete`, { cookie })).text);
  const res = await postDelete(srv.base, `/drafts/${first.draftId}/v/1/delete`, { cookie, csrf });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), `/drafts/${first.draftId}`);

  const page = await getPage(srv.base, `/drafts/${first.draftId}`, { cookie });
  assert.equal(page.status, 200);
  assert.equal((page.text.match(/class="version"/g) || []).length, 1);
});

test("deleting the last remaining version removes the draft entirely", async (t) => {
  const srv = await startServer();
  t.after(srv.stop);
  const cookie = `pp_token=${srv.token}`;
  const { draftId } = await publish(srv.base, srv.token, { html: htmlDoc("Only one") });

  const confirm = await getPage(srv.base, `/drafts/${draftId}/v/1/delete`, { cookie });
  assert.ok(confirm.text.includes("the whole draft will be removed too"), "the page must warn about this");

  const res = await postDelete(srv.base, `/drafts/${draftId}/v/1/delete`, { cookie, csrf: csrfFrom(confirm.text) });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/", "nowhere to return to — back to the list");
  assert.ok((await getPage(srv.base, "/", { cookie })).text.includes("No drafts yet"));
});

test("a version that does not exist cannot be confirmed for deletion", async (t) => {
  const srv = await startServer();
  t.after(srv.stop);
  const cookie = `pp_token=${srv.token}`;
  const { draftId } = await publish(srv.base, srv.token, { html: htmlDoc("One version") });

  const res = await getPage(srv.base, `/drafts/${draftId}/v/9/delete`, { cookie });
  assert.equal(res.status, 404);
});
