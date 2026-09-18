# postplan

Single-user static HTML draft publishing — a locked-down, zero-infra draft
server. No Postgres, no S3, no OAuth. Drafts live on local disk and one secret
token gates everything.

## Setup

```sh
npm install                       # parse5 at runtime; typescript to build
export POSTPLAN_TOKEN=$(openssl rand -hex 24)   # your one secret
npm run serve                     # starts on :3000
```

The server refuses to start without a `POSTPLAN_TOKEN` of at least 16 chars, so
you can't accidentally run it wide open.

Point the CLI at your server and save the same token:

```sh
postplan auth set "$POSTPLAN_TOKEN" --api-url http://localhost:3000
```

## Deployed instance

This repo is deployed to Railway with **public reads** (anyone with a draft's
unguessable URL can open it) and **token-locked uploads**:

- Live server: `https://postplan-production.up.railway.app`
- Data persists on a Railway volume mounted at `/data`
  (`POSTPLAN_DATA_DIR=/data`).
- Railway project `postplan` (workspace *jcdiv47's Projects*).

The CLI is installed globally via `npm link`, so agents can publish from any
directory with just `postplan`. The API URL and upload token are stored in
`~/.postplan/credentials.json` (created by `postplan auth set`). The token is
**not** committed to this repo.

```sh
postplan upload ./plan.html          # agents publish; prints a public URL
postplan list                        # see your drafts
```

Open the printed `URL` on any device — no token needed to read.

## Use

```sh
postplan upload ./plan.html                       # publish (v1)
postplan upload ./plan.html --description "Q3 plan"
postplan upload ./plan.html                       # same file -> v2
postplan list                                     # your drafts
postplan versions <draft-id>                      # every version of a draft
postplan rm <draft-id>                            # delete the whole draft
postplan rm <draft-id> --version 2                # delete just one version
```

Re-uploading the same file path updates the existing draft (new version).
Use `--new` to force a fresh draft, or `--draft <id>` to target a specific one.

`rm` is token-locked and irreversible; it prompts for confirmation unless you
pass `--yes` (required when stdin isn't a TTY). Deleting the last remaining
version of a draft removes the whole draft.

## Dashboard

A web UI listing every draft lives at `/`. Unlock it once per browser:

```
https://postplan.jiaqicai.com/?token=<your token>
```

That validates the token, stores it in an `HttpOnly; Secure; SameSite=Strict`
cookie for 30 days, and redirects to a clean `/` — so the secret leaves the
address bar and stays out of your history from then on. Bookmark the bare `/`.

| Path | Page |
| --- | --- |
| `/` | Every draft, newest updated first |
| `/drafts/<id>` | Version history for one draft |
| `/drafts/<id>/delete` | Confirm deleting the whole draft |
| `/drafts/<id>/v/<n>/delete` | Confirm deleting one version |

The dashboard is **always** token-gated, even when `POSTPLAN_PUBLIC_READS=true`:
a link to a draft grants read access to *that* draft, never the list of them.
Without the cookie every dashboard path returns `404`, including
`/static/app.css` — so the server never reveals it's a postplan instance.

Deletes are irreversible and there is no backup, so they go through a
confirmation page that names exactly what will be destroyed and carries a CSRF
token. Switch between card and row layouts with the toggle; the choice is
remembered per browser. Everything except the layout toggle and the filter box
works with JavaScript disabled.

## URLs

All require the token unless you set `POSTPLAN_PUBLIC_READS=true`.

| URL | Serves |
| --- | --- |
| `/d/<id>` | current version |
| `/d/<id>/raw` | alias, identical bytes |
| `/d/<id>/v/<n>` | a specific version |
| `/d/<id>/v/<n>/raw` | alias |

The token can be sent two ways:

- `Authorization: Bearer <token>` — for curl and agents.
- `?token=<token>` — for pasting a URL into a browser. Note it lands in browser
  history and access logs, so prefer the header where you can.

When reads are locked, a request without the token gets a `404` (not `401`), so
the server never confirms whether a draft ID exists to anyone but you.

## Security model

HTML is validated at upload time (parse5 walk — rejects external scripts, forms,
iframes, event handlers, `javascript:` URLs, meta-refresh, etc.; inline
`<script>` is allowed) and then served **byte for byte**. Every response carries
a strict `Content-Security-Policy` that blocks script execution, network
requests, and form posts *if a human opens the draft in a browser* — it never
alters the bytes a curl/agent client reads.

## Config

| Env var | Meaning |
| --- | --- |
| `POSTPLAN_TOKEN` | **Required to serve.** Your single secret. |
| `POSTPLAN_PUBLIC_READS` | `true` opens reads (uploads stay locked). |
| `POSTPLAN_DATA_DIR` | Where drafts are stored (default `./.postplan-data`). |
| `MAX_HTML_BYTES` | Upload size cap (default 512 KiB). |
| `PORT` | Server port (default 3000). |
| `POSTPLAN_API_URL` | Default API URL for the CLI. |

Drafts are plain files under the data dir (`<id>/v<n>.html` + `index.json`), so
backing up or grepping them needs no tooling.

## Data safety and recovery

`index.json` is the committed metadata; Version HTML is content. The server
keeps one writer per data directory and commits metadata with a temp write,
file `fsync`, atomic rename, then directory `fsync` on Linux/macOS. Uploads
write and flush the Version bytes before the index can reference them; deletes
commit the index before removing bytes. A failed commit before the rename
leaves the previous index and all referenced HTML untouched.

If the index is missing while Draft directories exist, or is malformed, the
server fails closed: reads that need the index and all mutations return
`503 Storage unavailable` and nothing is rewritten. Recover by stopping the
server and restoring a known-good, consistent `index.json` from backup — one
whose referenced HTML and Version counters match. Keep the damaged file for
diagnosis. There is no automatic reconstruction.

A directory-`fsync` failure *after* the rename means the new index is visible
but its durability is uncertain. The server retains referenced content, stops
accepting further mutations, and logs the failure; restart after reconciling.
If deleting content fails after the index commit, the deletion stands (it is
unlisted and unservable) and the leftover files can be removed manually.

## Development

The source is TypeScript. There are two ways it runs, on purpose:

| Command | Runs |
| --- | --- |
| `npm run serve` | `src/postplan.ts` directly — Node strips the types, no build |
| `npm start` | `dist/postplan.js` — what Railway serves |
| `npm run build` | `tsc` → `dist/` |
| `npm run typecheck` | `tsc --noEmit` over `src/` **and** `test/` |
| `npm test` | The suite against `src/` (fast, no build) |
| `npm run test:dist` | The same suite against `dist/`. Run before deploying. |

The globally-linked `postplan` command goes through `bin/postplan.mjs`, which
loads the TypeScript source, so it can never run a stale build — see
[ADR-0004](docs/adr/0004-the-linked-cli-runs-typescript-source.md). Stripping
types is not type-checking, so `npm run typecheck` is a separate step.

## Layout

| File | Role |
| --- | --- |
| `bin/postplan.mjs` | The linked CLI entry point; loads the source |
| `src/postplan.ts` | Server, HTML validation, and the CLI |
| `src/storage.ts` | The atomic `index.json` read/validate/commit boundary |
| `src/ui.ts` | Pure functions rendering the dashboard to HTML strings |
| `src/types.ts` | Draft, Version, and the read models derived from them |
| `public/` | `app.css` and `app.js`, served from `/static/` |
| `CONTEXT.md` | Glossary — Draft, Version, Token, Dashboard |
| `docs/adr/` | Why the security posture is shaped the way it is |
