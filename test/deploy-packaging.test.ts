// Pins the package.json fields the Railway deploy reads (issue #3).
//
// There is no Dockerfile here and no build or start command set on the service
// — `get_service_config` reports the builder as Railpack and nothing else — so
// every deploy-time decision comes from reading this manifest. Observed by
// running the railpack CLI (v0.35.0) against this repo, and by building and
// booting the resulting image locally:
//
//   install  installs dependencies, devDependencies kept
//   build    npm run build          (run only because a "build" script exists)
//   deploy   npm run start, on the latest Node 22 (engines ">=22.18" -> "22")
//
// None of that is enforced by the deploy itself: rename "build" or point
// "start" at src/ and Railway still reports a green build, serving nothing or
// the wrong artifact. These assertions are what stands between an edit here and
// finding out in production.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { REPO_ROOT } from "./helpers.ts";

interface PackageJson {
  scripts?: Record<string, string>;
  engines?: Record<string, string>;
}

const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as PackageJson;

// The scripts npm fires during a plain `npm install`, before the build step.
const INSTALL_TIME_SCRIPTS = ["preinstall", "install", "postinstall", "prepare"];

test("no install-time lifecycle script compiles", () => {
  // A `prepare` calling `npm run build` compiles a second time inside the
  // install layer. It survives there only because that layer happens to hold
  // the whole tree — the generated build plan copies just package.json and the
  // lockfile into it, so the layout it leans on is Railpack's business, not a
  // contract. dist/ exists for Railway alone (ADR-0004); nothing that runs
  // before the build step needs to produce it.
  const compiling = INSTALL_TIME_SCRIPTS.filter((name) => /\b(tsc|run build)\b/.test(pkg.scripts?.[name] ?? ""));
  assert.deepEqual(compiling, [], `${compiling.join(", ")} runs tsc during npm install`);
});

test("a build script exists, so the deploy compiles at all", () => {
  // Railpack's Node provider runs `npm run build` if and only if package.json
  // declares a `build` script. Rename it and the deploy still succeeds, with an
  // image that has no dist/ in it.
  assert.equal(typeof pkg.scripts?.build, "string");
  assert.match(pkg.scripts!.build!, /\btsc\b/);
});

test("start serves the build, not the source", () => {
  // src/ ships in the image too, so a `start` pointed there would boot cleanly
  // and quietly run type-stripped source in production.
  assert.match(pkg.scripts?.start ?? "", /\bdist\/postplan\.js\b/);
});

test("engines.node keeps the floor the shim needs", () => {
  // bin/postplan.mjs loads TypeScript directly, which needs 22.18. Railpack
  // reduces the range to its lower bound's major and installs the latest
  // release of it, so on the server the patch floor only has to be a floor —
  // but locally it is the whole guarantee, and npm enforces it verbatim.
  const node = pkg.engines?.node;
  const m = /^>=\s*(\d+)\.(\d+)/.exec(node ?? "");
  assert.ok(m, `engines.node must be a >= range with a minor, for Railpack to reduce: got ${node}`);
  const [major, minor] = [Number(m[1]), Number(m[2])];
  assert.ok(major > 22 || (major === 22 && minor >= 18), `${node} is below the 22.18 the shim needs`);
});
