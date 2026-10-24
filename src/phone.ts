/**
 * phone.ts — attribution of Pairlet (phone-driven) sessions.
 *
 * Source of truth: ~/.cc-pocket/spawned-sessions.tsv — tab-separated rows:
 *   <absolute project path>\t<sessionId>
 * The Pairlet daemon writes one row per session it spawns. READ-ONLY: we never
 * write this file; we only read it. A missing/unreadable file is treated as
 * "no phone sessions" — this module never throws.
 *
 * No vscode import on purpose: pure Node so scripts/check-phone.mjs can test
 * the compiled output directly.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface PhoneSessionsInfo {
  /** Session IDs the Pairlet daemon spawned (phone-driven conversations). */
  sessionIds: Set<string>;
  /** Exact project path per session ID (first row wins on duplicates). */
  projectBySession: Map<string, string>;
}

export function emptyPhoneSessions(): PhoneSessionsInfo {
  return { sessionIds: new Set(), projectBySession: new Map() };
}

/** Absolute path of the daemon's spawned-sessions TSV. */
export function phoneSessionsFile(): string {
  return path.join(os.homedir(), ".cc-pocket", "spawned-sessions.tsv");
}

/** Parse TSV text. Tolerant: blank lines, missing tabs, extra columns. */
export function parsePhoneSessionsTsv(text: string): PhoneSessionsInfo {
  const sessionIds = new Set<string>();
  const projectBySession = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const tab = line.indexOf("\t");
    if (tab <= 0) {
      continue; // no project path or no separator
    }
    const projectPath = line.slice(0, tab).trim();
    // First column after the tab is the session id; tolerate extra columns.
    const sessionId = line.slice(tab + 1).split("\t")[0].trim();
    if (!projectPath || !sessionId) {
      continue;
    }
    sessionIds.add(sessionId);
    if (!projectBySession.has(sessionId)) {
      projectBySession.set(sessionId, projectPath);
    }
  }
  return { sessionIds, projectBySession };
}

/** Load and parse the TSV at `filePath`; missing/unreadable -> empty, never throws. */
export function loadPhoneSessions(filePath: string): PhoneSessionsInfo {
  try {
    return parsePhoneSessionsTsv(fs.readFileSync(filePath, "utf8"));
  } catch {
    return emptyPhoneSessions();
  }
}

/**
 * Session IDs that are phone-driven AND already have content on disk, mapped
 * to their mtime. A TSV row can be written before the transcript exists (or
 * before its first visible message), so those must not count yet.
 */
export function phoneSessionMtimesWithContent(
  sessions: ReadonlyArray<{
    sessionId: string;
    phone: boolean;
    size: number;
    mtimeMs: number;
    messageCount?: number;
  }>
): Map<string, number> {
  const mtimes = new Map<string, number>();
  for (const s of sessions) {
    // messageCount 0 = file exists but has no visible messages yet; -1 = too
    // large to count (assume it has content).
    if (s.phone && s.size > 0 && s.messageCount !== 0) {
      mtimes.set(s.sessionId, s.mtimeMs);
    }
  }
  return mtimes;
}

/** IDs present now but absent from the previous snapshot, in stable order. */
export function diffNewPhoneSessions(
  current: ReadonlyMap<string, number>,
  seen: ReadonlySet<string>
): string[] {
  return [...current.keys()].filter((id) => !seen.has(id));
}

/** Existing IDs whose transcript grew since the previous snapshot. */
export function activePhoneSessions(
  current: ReadonlyMap<string, number>,
  previous: ReadonlyMap<string, number>
): string[] {
  const ids: string[] = [];
  for (const [id, mtimeMs] of current) {
    const prev = previous.get(id);
    if (prev !== undefined && mtimeMs > prev) {
      ids.push(id);
    }
  }
  return ids;
}
