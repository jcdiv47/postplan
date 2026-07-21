# postplan

Single-user static HTML draft publishing — a locked-down, zero-infra draft
server. No Postgres, no S3, no OAuth. Drafts live on local disk and one secret
token gates everything.

## Setup

```sh
npm install                       # installs parse5 (the only dependency)
export POSTPLAN_TOKEN=$(openssl rand -hex 24)   # your one secret
node postplan.mjs serve           # starts on :3000
```

The server refuses to start without a `POSTPLAN_TOKEN` of at least 16 chars, so
you can't accidentally run it wide open.

Point the CLI at your server and save the same token:

```sh
node postplan.mjs auth set "$POSTPLAN_TOKEN" --api-url http://localhost:3000
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
node postplan.mjs upload ./plan.html                       # publish (v1)
node postplan.mjs upload ./plan.html --description "Q3 plan"
node postplan.mjs upload ./plan.html                       # same file -> v2
node postplan.mjs list                                     # your drafts
node postplan.mjs versions <draft-id>                      # every version of a draft
node postplan.mjs rm <draft-id>                            # delete the whole draft
node postplan.mjs rm <draft-id> --version 2                # delete just one version
```

Re-uploading the same file path updates the existing draft (new version).
Use `--new` to force a fresh draft, or `--draft <id>` to target a specific one.

`rm` is token-locked and irreversible; it prompts for confirmation unless you
pass `--yes` (required when stdin isn't a TTY). Deleting the last remaining
version of a draft removes the whole draft.

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
