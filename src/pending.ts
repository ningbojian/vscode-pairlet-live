/**
 * pending.ts — ⏸ "waiting for confirmation" detection (READ-ONLY).
 *
 * A session is pending when:
 *   - unresolvedCount >= 1  (tool_use ids with no matching tool_result yet), AND
 *   - the transcript file has been idle >= PENDING_IDLE_MS since last append, AND
 *   - the newest parsed item is an unresolved tool_use (not mid-stream text).
 *
 * Missing / unparsable tails NEVER throw — every entry point fails closed to
 * "not pending". No vscode import on purpose: pure Node so
 * scripts/check-pending.mjs can test the compiled output directly.
 */

import { RenderItem, parseLines } from "./transcript";
import { readTail } from "./tailer";

/** Idle time after the last append before a stuck tool_use counts as pending. */
export const PENDING_IDLE_MS = 20_000;
/** Tail window for best-effort list-badge detection. */
export const PENDING_TAIL_BYTES = 16 * 1024;
/** Cap for tool names shown in the strip / badge / notification. */
export const PENDING_TOOL_NAME_CAP = 3;

export interface PendingStatus {
  pending: boolean;
  /** Number of tool_use ids with no matching tool_result yet. */
  unresolvedCount: number;
  /** Unique names of unresolved tools (insertion order, uncapped). */
  toolNames: string[];
}

const NOT_PENDING: PendingStatus = { pending: false, unresolvedCount: 0, toolNames: [] };

/** Join tool names for display, unique, capped; "等" marks truncation. */
export function capToolNames(names: string[], cap = PENDING_TOOL_NAME_CAP): string {
  const uniq: string[] = [];
  const seen = new Set<string>();
  for (const n of names || []) {
    if (n && !seen.has(n)) {
      seen.add(n);
      uniq.push(n);
    }
  }
  const shown = uniq.slice(0, Math.max(0, cap));
  const suffix = uniq.length > cap ? " 等" : "";
  return shown.join(", ") + suffix;
}

/**
 * Compute pending status from an already-parsed item stream.
 * `idleMs` = ms since the transcript file's last append (mtime).
 * Never throws.
 */
export function computePending(items: RenderItem[], idleMs: number): PendingStatus {
  try {
    const resolved = new Set<string>();
    const unresolved = new Map<string, string>(); // tool_use id -> tool name
    let anonUses = 0;
    for (const it of items || []) {
      if (!it || it.kind !== "tool") {
        continue;
      }
      if (it.isResult) {
        if (it.toolUseId) {
          resolved.add(it.toolUseId);
          unresolved.delete(it.toolUseId);
        }
        // Results without tool_use_id cannot be matched — ignore.
      } else {
        const id = it.toolId;
        if (id) {
          if (resolved.has(id)) {
            continue; // duplicate use of an already-resolved id — ignore
          }
          unresolved.set(id, it.toolName || "tool");
        } else {
          // No id: unmatchable by definition — treat as unresolved.
          anonUses += 1;
          unresolved.set(`anon:${anonUses}`, it.toolName || "tool");
        }
      }
    }
    const unresolvedCount = unresolved.size;
    if (unresolvedCount < 1 || idleMs < PENDING_IDLE_MS) {
      return { pending: false, unresolvedCount, toolNames: [...unresolved.values()] };
    }
    // Newest item must itself be an unresolved tool_use (not mid-stream text).
    const list = items || [];
    const newest = list.length > 0 ? list[list.length - 1] : undefined;
    const newestIsUnresolvedToolUse =
      !!newest &&
      newest.kind === "tool" &&
      newest.isResult !== true &&
      (!newest.toolId || unresolved.has(newest.toolId));
    return {
      pending: newestIsUnresolvedToolUse,
      unresolvedCount,
      toolNames: [...unresolved.values()]
    };
  } catch {
    return NOT_PENDING;
  }
}

/**
 * Best-effort pending detection from the file TAIL only (session-list badge).
 * Tolerates partial lines at the window edge (readTail drops them). A missing
 * or unreadable file returns not-pending instead of throwing.
 */
export function readPendingFromTail(filePath: string, mtimeMs: number, nowMs = Date.now()): PendingStatus {
  try {
    const idleMs = nowMs - mtimeMs;
    if (idleMs < PENDING_IDLE_MS) {
      return NOT_PENDING; // actively appending — never pending
    }
    const start = readTail(filePath, PENDING_TAIL_BYTES);
    return computePending(parseLines(start.lines), idleMs);
  } catch {
    return NOT_PENDING;
  }
}

/**
 * One-shot alert state machine: notify only on the idle->pending TRANSITION;
 * re-arm only after pending clears or the session id disappears from the list.
 */
export class PendingAlertTracker {
  private readonly state = new Map<string, boolean>();

  /**
   * Feed the current known session ids + their pending flags. Returns ids that
   * transitioned to pending since the previous update (each id reported once
   * per pending episode).
   */
  update(presentIds: Iterable<string>, pendingById: Map<string, boolean>): string[] {
    const present = new Set(presentIds);
    for (const id of [...this.state.keys()]) {
      if (!present.has(id)) {
        this.state.delete(id); // disappeared from list -> re-arm
      }
    }
    const transitions: string[] = [];
    for (const id of present) {
      const now = pendingById.get(id) === true;
      const prev = this.state.get(id);
      if (now && prev !== true) {
        transitions.push(id);
      }
      this.state.set(id, now);
    }
    return transitions;
  }

  isPending(sessionId: string): boolean {
    return this.state.get(sessionId) === true;
  }

  clear(): void {
    this.state.clear();
  }
}

/**
 * Gate VS Code notifications by the pairletLive.notifyWaiting setting.
 * In-panel strip and list badge intentionally do NOT go through this.
 */
export function gateNotifications(enabled: boolean, ids: string[]): string[] {
  return enabled ? ids : [];
}
