// http-body.ts — a bounded request-body reader (issue #7).
//
// The old upload handler measured JSON transport bytes and called
// `req.destroy()` the moment they exceeded the cap, which reset the connection
// before any error response could be delivered — the client saw a network
// failure instead of a 413. This reader:
//
//   * enforces a wire-body cap even when Content-Length lies or is absent;
//   * stops retaining bytes the instant the cap is crossed, so memory bounds
//     hold while the client keeps streaming;
//   * decodes UTF-8 fatally with one streaming TextDecoder, preserving
//     multibyte characters split across chunk boundaries;
//   * settles exactly once and releases listeners/timers.
//
// It does not write a response. The route owns the response so it can choose
// the status, and can answer a `too-large` result without waiting for a body
// that will never fit.

import type { IncomingMessage } from "node:http";
import { TextDecoder } from "node:util";

export type ReadBodyResult =
  | { ok: true; text: string }
  | { ok: false; reason: "too-large" | "invalid-utf8" | "aborted" };

export interface ReadBodyOptions {
  /** Maximum number of incoming body bytes to retain. */
  limit: number;
  /** Absolute ceiling on how long to wait before treating the request as aborted. */
  timeoutMs?: number;
}

export function readBody(req: IncomingMessage, { limit, timeoutMs = 30_000 }: ReadBodyOptions): Promise<ReadBodyResult> {
  return new Promise<ReadBodyResult>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (result: ReadBodyResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAbort);
      resolve(result);
    };

    // Discard anything still arriving without buffering it. Backpressure means
    // the client's continued streaming cannot grow our memory.
    const discard = (): void => {
      req.resume();
    };

    // A usable Content-Length lets us reject before reading a single body byte.
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) {
      finish({ ok: false, reason: "too-large" });
      discard();
      return;
    }

    const decoder = new TextDecoder("utf-8", { fatal: true });
    const parts: string[] = [];
    let received = 0;
    let invalidUtf8 = false;

    function onData(chunk: Buffer): void {
      received += chunk.length;
      if (received > limit) {
        finish({ ok: false, reason: "too-large" });
        discard();
        return;
      }
      if (invalidUtf8) return;
      try {
        parts.push(decoder.decode(chunk, { stream: true }));
      } catch {
        invalidUtf8 = true;
      }
    }

    function onEnd(): void {
      if (invalidUtf8) return finish({ ok: false, reason: "invalid-utf8" });
      try {
        parts.push(decoder.decode());
      } catch {
        return finish({ ok: false, reason: "invalid-utf8" });
      }
      finish({ ok: true, text: parts.join("") });
    }

    function onError(): void {
      finish({ ok: false, reason: "aborted" });
    }

    function onAbort(): void {
      finish({ ok: false, reason: "aborted" });
    }

    timer = setTimeout(() => {
      finish({ ok: false, reason: "aborted" });
      req.destroy();
    }, timeoutMs);

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("aborted", onAbort);
  });
}
