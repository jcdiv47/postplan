# The linked CLI runs TypeScript source, the server runs the build

`package.json#bin` points at `bin/postplan.mjs`, a shim that imports
`src/postplan.ts` directly and lets Node strip the type annotations at load.
Railway does not use the shim: it runs `tsc` and serves `dist/postplan.js`.

The repo is `npm link`ed globally, so `postplan` on `PATH` resolves through this
working tree, and local agents publish Drafts with it at arbitrary times. Had
`bin` pointed at `dist/`, every edit to `src/` would silently leave those agents
running the last build — no error, no warning, just stale behaviour until
someone remembered to rebuild.

## Considered options

Pointing `bin` at `dist/postplan.js` with a `prepare` script is the conventional
setup, and it is conventional because most packages' `bin` is not symlinked into
a tree that is actively being edited. Here it converts "forgot to rebuild" into
wrong output from an agent, which is exactly the failure mode that is hardest to
notice.

Committing `dist/` would keep the linked CLI working without a build step and
make staleness visible in `git status`. Rejected: generated JavaScript in every
diff, for a guarantee the shim gives without the noise.

Skipping the build entirely and running `.ts` everywhere via type stripping
would collapse the two paths into one, but leaves production depending on an
unpinned Node version on the deployment target and forbids non-erasable syntax
forever.

## Consequences

Local runs are not type-checked — stripping erases annotations without
verifying them, so `tsc --noEmit` is a separate step that nothing forces you to
run.

The code exercised locally is not the artifact deployed. `npm test` spawns
`src/postplan.ts`; `npm run test:dist` runs the same suite against the build via
`POSTPLAN_TEST_TARGET` and should be run before deploying.

`PUBLIC_DIR` is resolved from `import.meta.url`, and both `src/` and `dist/` sit
one level below the repo root, so `../public` is correct on both paths. Moving
either directory to a different depth breaks asset serving on that path only.

The shim requires Node >= 22.18 locally, pinned via `engines`.
