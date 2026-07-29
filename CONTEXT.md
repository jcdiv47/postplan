# postplan

Single-user static HTML draft publishing. You write an HTML document somewhere
else, publish it here, and get a URL you can open on any device.

## Language

**Draft**:
A published HTML document with a stable id, title and URL that survives across
re-publishes. The unit the dashboard lists.
_Avoid_: file, post, page, document, article

**Version**:
One immutable HTML snapshot of a Draft, numbered from 1. Publishing the same
Draft again adds a Version; it never replaces one.
_Avoid_: revision, edit, update, snapshot

**Draft Summary**:
What the Dashboard knows about one Draft without opening it: its identity, its
latest Version number and how many there are — never the Versions themselves.
_Avoid_: row, card, listing, preview

**Draft Detail**:
One Draft together with every one of its Versions, as shown on that Draft's own
page.
_Avoid_: full draft, expanded draft, record

**Token**:
The single secret that gates the whole server. There are no accounts and no
sessions beyond it — holding the Token *is* being the owner.
_Avoid_: password, key, credential, API key

**Dashboard**:
The Token-gated web UI that lists every Draft. Distinct from a Draft's own
public URL, which needs no Token.
_Avoid_: index, admin, homepage, console

**Public read**:
Fetching a Draft by its unguessable URL without presenting the Token. Enabled
per-deployment; it never extends to the Dashboard or the list of Drafts.
_Avoid_: anonymous access, sharing, publishing
