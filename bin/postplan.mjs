#!/usr/bin/env node
// The globally-linked `postplan` entry point.
//
// This repo is `npm link`ed, so `postplan` on PATH resolves through the working
// tree and local agents publish Drafts with it at arbitrary times. Loading the
// TypeScript source directly — Node strips the annotations — means those agents
// can never run a stale build. Railway does not use this file; it runs `tsc` and
// serves dist/postplan.js. See docs/adr/0004-the-linked-cli-runs-typescript-source.md
//
// Nothing here is type-checked. Run `npm run typecheck` for that.
import "../src/postplan.ts";
