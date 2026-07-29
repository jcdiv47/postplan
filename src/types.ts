// The shapes postplan stores and serves. See CONTEXT.md for what the words
// mean; this file is only about what the data looks like.
//
// Two families live here. `Draft`/`Version` are what sits in index.json on
// disk. `DraftSummary`/`DraftDetail`/`LinkedVersion` are read models derived
// for the Dashboard and the JSON API — they carry a resolved id and absolute
// URLs, which storage deliberately does not, because a Draft's URL depends on
// the host it was requested through.

/** A Draft's stable id. The key it is filed under in index.json. */
export type DraftId = string;

/** One immutable HTML snapshot of a Draft, as stored. */
export interface Version {
  /** Version number, from 1. Gaps are expected — deleting a Version keeps its number retired. */
  n: number;
  sha256: string;
  bytes: number;
  /** ISO 8601 timestamp of when this Version was published. */
  at: string;
  filename: string | null;
  externalImageHosts: string[];
}

/**
 * A Draft as stored. Carries no id — it is the value of a DraftId key in the
 * index — and no URL, since that is per-request.
 */
export interface Draft {
  title?: string;
  /** Absent when never supplied; the read models normalise this to null. */
  description?: string;
  repo?: string | null;
  versions: Version[];
  updatedAt?: string;
}

/** The whole of index.json: every Draft, keyed by id. */
export type DraftIndex = Record<DraftId, Draft>;

/** A Version with the URL it is served at. */
export interface LinkedVersion extends Version {
  url: string;
}

/** One row of the Dashboard list. Deliberately carries no Versions. */
export interface DraftSummary {
  draftId: DraftId;
  title: string | undefined;
  description: string | null;
  repo: string | null;
  latestVersionNumber: number | null;
  versionCount: number;
  updatedAt: string | undefined;
  publicUrl: string;
}

/** One Draft with every one of its Versions. */
export interface DraftDetail {
  draftId: DraftId;
  title: string | undefined;
  description: string | null;
  repo: string | null;
  updatedAt: string | undefined;
  publicUrl: string;
  versions: LinkedVersion[];
}

/**
 * The outcome of an irreversible removal. A union rather than a flat object so
 * `reason` is only reachable on failure and `draftRemoved` only on success.
 */
export type DeleteResult =
  | { ok: false; reason: "draft" | "version" }
  | { ok: true; draftId: DraftId; versionNumber: number | null; draftRemoved: boolean };

/**
 * A matched Dashboard URL. The list page is the whole Dashboard and has no
 * Draft, which is why it carries a null id the other two cannot.
 */
export type DashboardRoute =
  | { kind: "list"; draftId: null; version: null }
  | { kind: "detail" | "delete"; draftId: DraftId; version: number | null };

// ---------------------------------------------------------------------------
// Wire + local state
// ---------------------------------------------------------------------------

/**
 * The body of POST /api/uploads. Narrowed from `unknown` by isUploadPayload,
 * which checks object-ness only — every field here is still an unverified
 * claim about external input, so read them defensively.
 */
export interface UploadPayload {
  html?: string;
  filename?: string | null;
  draftId?: DraftId | null;
  description?: string | null;
  metadata?: {
    fileSha256?: string;
    repoOrg?: string;
    repoName?: string;
  };
}

/** ~/.postplan/credentials.json */
export interface Credentials {
  token?: string;
  apiUrl?: string;
}

/** ~/.postplan/drafts.json — maps an absolute file path to the Draft it publishes to. */
export interface DraftsState {
  files: Record<string, { draftId: DraftId; publicUrl: string; updatedAt: string }>;
}

/** The result of the HTML safety policy walk. */
export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  title: string | null;
  externalImageHosts?: string[];
}

/** CLI flags, after arg parsing. */
export interface CliOptions {
  new?: boolean;
  json?: boolean;
  yes?: boolean;
  apiUrl?: string;
  draft?: string;
  description?: string;
  version?: string;
  port?: string;
}
