# Browser sessions are the raw Token in an HttpOnly cookie

A browser navigating to `/` cannot send `Authorization: Bearer`, so the
Dashboard needs some other way to present the Token. Visiting `/?token=<token>`
once validates it, sets it as an `HttpOnly; Secure; SameSite=Strict` cookie and
redirects to a clean URL, so the secret stops appearing in the address bar,
browser history, access logs and `Referer` headers on every subsequent visit.

The cookie holds the Token verbatim rather than a signed session value. That
keeps `tokenMatches()` — the constant-time comparison every other code path
already uses — as the single place authentication is decided, and it means
rotating `POSTPLAN_TOKEN` invalidates every browser session for free.

## Considered options

A signed session value (`<expiry>.<HMAC(expiry, token)>`) would stop a stolen
cookie being replayed as an API Bearer token and would allow server-side
expiry. Rejected: for a single-user server the cookie is already `HttpOnly` and
`SameSite=Strict`, so the extra sign/verify path and second authentication
branch buy little against the cost of two ways to be authenticated.

A login form that POSTs the Token would keep it out of URLs entirely, but an
unauthenticated `GET /` would have to render a form — breaking the rule from
ADR-0001 that strangers get a `404` and learn nothing.

## Consequences

Token lookup order is Bearer header, then `?token=` query, then cookie. The
query parameter deliberately outranks the cookie so that visiting `/?token=` with
a *new* Token replaces a stale session instead of being shadowed by it.

The cookie is scoped `Path=/`, so it is also sent to `/d/<id>`. Draft links in
the Dashboard therefore work in local development where public reads are off,
and can stay plain shareable URLs with no Token appended.
