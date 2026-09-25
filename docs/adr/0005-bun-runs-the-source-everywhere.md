# Bun runs the TypeScript source everywhere; the build only type-checks

Supersedes [ADR-0004](0004-the-linked-cli-runs-typescript-source.md).

Bun runs `src/postplan.ts` directly in all three places the code runs: the
`bun link`ed CLI, `bun test`, and Railway (`bun run start`). There is no
`dist/`. The `build` script is `tsc` with `noEmit`, and Railpack runs it, so a
type error fails the deploy instead of shipping.

ADR-0004 split the code into two paths — type-stripped source locally, `tsc`
output on Railway — and paid for it with a gap: the suite exercised the source,
production served the build, and `npm run test:dist` was the manual step that
closed the gap when someone remembered it. It rejected running source
everywhere for two reasons, both specific to Node:

- **Unpinned runtime.** Railpack reduced `engines.node` to a major and installed
  the latest release of it. Under Bun it reads `packageManager: "bun@x.y.z"` and
  installs exactly that version, so production runs the Bun the suite ran on.
- **Non-erasable syntax.** Local runs already required erasable syntax, so
  running source in production forbids nothing new. `erasableSyntaxOnly` stays on
  even though Bun would transpile enums and the like: it keeps the source
  runnable by plain type stripping, which is what makes leaving Bun cheap.

Measured before the move (`bench/runtime.ts`, Node 22.23 vs Bun 1.4.2 on Linux,
the Railway target, and Node 24 on macOS, where the CLI runs): CLI cold start
51 → 13 ms on Linux and 106 → 16 ms on macOS; `postplan upload` end to end
80 → 30 ms and 142 → 40 ms; server idle RSS 95 → 39 MB; the suite 13 s → 4 s;
read throughput 7.5k → 26k req/s. Upload throughput is equal on Linux — it is
bounded by `fsync`, and strace shows both runtimes issuing the same calls.
Running `.ts` versus pre-built `.js` under Bun costs nothing measurable
(15.7 ms either way), which is what makes dropping the build free.

## Considered options

Bun as package manager only, still running Node. Rejected: it keeps every cost
of ADR-0004 and gains only install speed. Swapping the lockfile alone does not
change the runtime either — Railpack then runs `bun run start`, which still
executes whatever `start` names.

Bun as the runtime, keeping the `tsc` build and serving `dist/`. Rejected:
keeps the tested-versus-deployed gap and the `dist/`-only config (`outDir`,
`rootDir`, `rewriteRelativeImportExtensions`, the `PUBLIC_DIR` depth rule) to
guard against a runtime version that is now pinned exactly.

## Consequences

Nothing checks types at run time, locally or in production. The deploy is the
only enforced check (`tsc` as the build step); locally it is still
`bun run typecheck`, which nothing forces. `tsconfig.json` now covers `test/`
too, so the deploy type-checks the suite as well.

On macOS, Bun's `fs.fsyncSync` is a plain `fsync`, whereas Node's issues
`F_FULLFSYNC`, which also flushes the drive's write cache. A server run locally
on a Mac therefore has weaker crash durability than it did under Node. Railway
runs Linux, where both runtimes issue the same `fsync`.

Tests import `node:test` and run under Bun's implementation of it. If Bun's
compatibility regresses, the suite is where it shows first.

Railpack installs a Node LTS alongside Bun even though nothing runs on it,
which makes the image about 85 MB larger (546 vs 462 MB).
