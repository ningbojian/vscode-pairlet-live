/**
 * merge.ts — merge several session transcripts of ONE project into a single
 * chronological stream (READ-ONLY; pure functions, no fs / vscode imports).
 *
 * Why: `--resume` / SDK phone sessions copy the shared history into a new
 * session file. Those copied entries keep the SAME `uuid` as the original, so a
 * naive concatenation would show the common prefix once per branch. We
 * de-duplicate by `uuid`, processing sessions oldest-first so the original copy
 * survives and branch-only messages remain.
 *
 * Order is by entry timestamp. Items without a usable timestamp inherit the
 * previous timestamp within their own session (JSONL files are append-only).
 */

import { RenderItem } from "./transcript";

export interface MergeSessionInput {
  sessionId: string;
  filePath: string;
  phone: boolean;
  /** File creation time; orders sessions so the base session is processed first. */
  birthtimeMs: number;
  mtimeMs: number;
  /** True when this session's tail window dropped older lines. */
  truncated: boolean;
  /** Already parsed, in file order. */
  items: RenderItem[];
}

export interface MergedStream {
  /** Chronological, de-duplicated, each item annotated with `sessionId`. */
  items: RenderItem[];
  /**
   * Every uuid seen in every input (including duplicates that were dropped).
   * Live appends use this to avoid re-adding shared history.
   */
  seenUuids: Set<string>;
  /** Any input was truncated, or the item cap dropped older entries. */
  truncated: boolean;
  sessionCount: number;
}

/** Keep the webview responsive even for a project with long sessions. */
export const MAX_MERGED_ITEMS = 4000;

function birthOf(s: MergeSessionInput): number {
  if (Number.isFinite(s.birthtimeMs) && s.birthtimeMs > 0) {
    return s.birthtimeMs;
  }
  return Number.isFinite(s.mtimeMs) ? s.mtimeMs : 0;
}

/**
 * Merge sessions of one project.
 *
 * De-duplication is global by `uuid`; an entry (and all blocks parsed from it)
 * appears exactly once. Processing sessions by creation time makes the oldest
 * copy the survivor. Timestamps order the merged timeline; equal timestamps
 * keep session order then file order.
 */
export function mergeSessionItems(
  sessions: MergeSessionInput[],
  maxItems = MAX_MERGED_ITEMS
): MergedStream {
  const ordered = (Array.isArray(sessions) ? sessions : []).slice().sort((a, b) => {
    const byBirth = birthOf(a) - birthOf(b);
    if (byBirth !== 0) {
      return byBirth;
    }
    if (a.mtimeMs !== b.mtimeMs) {
      return a.mtimeMs - b.mtimeMs;
    }
    return a.sessionId.localeCompare(b.sessionId);
  });

  const seenUuids = new Set<string>();
  const entries: Array<{ item: RenderItem; ts: number; order: number }> = [];
  let order = 0;
  let truncated = false;

  for (const session of ordered) {
    let lastTs = birthOf(session);
    // One JSONL entry can produce several RenderItems (thinking + text +
    // tool_use) that all share the entry uuid. De-duplicate at ENTRY level:
    // keep every block of an entry, skip the whole entry only when an older
    // session already showed that uuid.
    let currentUuid: string | undefined;
    let skipCurrentEntry = false;
    for (const raw of session.items || []) {
      if (!raw) {
        continue;
      }
      const item: RenderItem = { ...raw, sessionId: session.sessionId };
      if (item.uuid) {
        if (item.uuid !== currentUuid) {
          currentUuid = item.uuid;
          skipCurrentEntry = seenUuids.has(item.uuid);
          if (!skipCurrentEntry) {
            seenUuids.add(item.uuid);
          }
        }
        if (skipCurrentEntry) {
          continue;
        }
      } else {
        currentUuid = undefined;
        skipCurrentEntry = false;
      }
      const parsed = item.timestamp ? Date.parse(item.timestamp) : NaN;
      if (!Number.isNaN(parsed)) {
        lastTs = parsed;
      }
      entries.push({ item, ts: lastTs, order: order++ });
    }
    if (session.truncated) {
      truncated = true;
    }
  }

  entries.sort((a, b) => a.ts - b.ts || a.order - b.order);
  const limit = Number.isFinite(maxItems) && maxItems > 0 ? Math.floor(maxItems) : MAX_MERGED_ITEMS;
  if (entries.length > limit) {
    entries.splice(0, entries.length - limit);
    truncated = true;
  }

  return {
    items: entries.map((e) => e.item),
    seenUuids,
    truncated,
    sessionCount: ordered.length
  };
}
