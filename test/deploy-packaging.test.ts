// Pins the package.json fields the Railway deploy reads (issue #3, ADR-0005).
//
// There is no Dockerfile here and no build or start command set on the service
// — `get_service_config` reports the builder as Railpack and nothing else — so
// every deploy-time decision comes from reading this manifest. Observed by
// running the railpack CLI (v0.40.0) against this repo, and by building and
// booting the resulting image locally:
//
//   packages  bun at exactly the packageManager version
//   install   bun install --frozen-lockfile      (bun.lock selects bun)
//   build     bun run build   (run only because a "build" script exists)
//   deploy    bun run start   -> bun src/postplan.ts serve
//
// None of that is enforced by the deploy itself: drop the lockfile or the
// build script, or point "start" at node, and Railway still reports a green
// build — on the wrong runtime, or without the type check. These assertions are
// what stands between an edit here and finding out in production.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { REPO_ROOT } from "./helpers.ts";

interface PackageJson {
  packageManager?: string;
  bin?: Record<string, string>;
  scripts?: Record<string, string>;
}

const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as PackageJson;

test("packageManager pins an exact Bun version", () => {
  // Railpack installs precisely this version. Without it, it installs whatever
  // Bun is latest at build time, so production would drift from the Bun the
  // suite ran on.
  assert.match(pkg.packageManager ?? "", /^bun@\d+\.\d+\.\d+$/);
});

test("bun.lock is the only lockfile", () => {
  // Railpack picks the package manager from the lockfile it finds; a stray
  // package-lock.json makes it assume npm.
  assert.ok(fs.existsSync(path.join(REPO_ROOT, "bun.lock")), "bun.lock is missing");
  const others = ["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb"]
    .filter((f) => fs.existsSync(path.join(REPO_ROOT, f)));
  assert.deepEqual(others, [], `unexpected lockfiles: ${others.join(", ")}`);
});

// The scripts a package manager fires during install, before the build step.
const INSTALL_TIME_SCRIPTS = ["preinstall", "install", "postinstall", "prepare"];

test("no install-time lifecycle script runs tsc", () => {
  // The generated build plan copies just package.json and the lockfile into the
  // install layer, so a `prepare` running tsc there finds no src/ to check.
  const checking = INSTALL_TIME_SCRIPTS.filter((name) => /\b(tsc|run (build|typecheck))\b/.test(pkg.scripts?.[name] ?? ""));
  assert.deepEqual(checking, [], `${checking.join(", ")} runs tsc during install`);
});

test("the build script type-checks, so a type error fails the deploy", () => {
  // Bun runs TypeScript without checking it. The build step emits nothing; it
  // is the only thing that stops an ill-typed commit from deploying. Railpack
  // runs it if and only if a `build` script exists.
  assert.match(pkg.scripts?.build ?? "", /^tsc\b/);
  const tsconfig = fs.readFileSync(path.join(REPO_ROOT, "tsconfig.json"), "utf8");
  assert.match(tsconfig, /"noEmit":\s*true/, "tsconfig must not emit: nothing serves the output");
});

test("start serves the source on Bun", () => {
  // The source is what the suite runs, so it is what production must run.
  // `node` here would still boot — Railpack installs Node alongside Bun.
  assert.match(pkg.scripts?.start ?? "", /^bun src\/postplan\.ts serve\b/);
});

test("the linked CLI is the source, run by Bun", () => {
  assert.equal(pkg.bin?.postplan, "./src/postplan.ts");
  const shebang = fs.readFileSync(path.join(REPO_ROOT, "src/postplan.ts"), "utf8").split("\n")[0];
  assert.equal(shebang, "#!/usr/bin/env bun");
});
