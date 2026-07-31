# Drafts are publicly readable; the index of drafts is not

With `POSTPLAN_PUBLIC_READS=true`, anyone holding a Draft's unguessable URL can
read it — that is the whole point, since the URLs get pasted into chats and
opened on phones. The list of Drafts is deliberately *not* covered by that:
`GET /api/drafts` and every Dashboard route stay Token-gated even when reads are
public, because knowing that a Draft exists is a different privilege from being
able to read one you were given.

## Consequences

Unguessability is load-bearing. A Draft id is 12 hex characters and there is no
rate limiting, so the only thing standing between a stranger and your Drafts is
that they cannot enumerate them — which is exactly what the private index
preserves.

Dashboard routes answer `404`, never `401`, to an unauthenticated caller. This
extends to `/static/app.css` and `/static/app.js`: a `200` on a known asset path
would fingerprint the server as a postplan instance and reveal that a Dashboard
exists, which is the same leak in a different shape.
