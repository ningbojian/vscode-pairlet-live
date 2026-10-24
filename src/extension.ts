/**
 * extension.ts — Pairlet Live (READ-ONLY live view of phone-driven Claude Code sessions)
 *
 * Hard scope:
 *  - READ-ONLY: never writes transcripts, never spawns claude, never injects input.
 *  - No network calls, no telemetry, no runtime deps beyond the vscode API.
 *  - Phone-session attribution comes from ~/.cc-pocket/spawned-sessions.tsv
 *    (read-only; a missing file is treated as "no phone sessions").
 */

import * as vscode from "vscode";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { TranscriptTailer, readTail, readOlderChunk, TailStart, CHUNK_BYTES } from "./tailer";
import { parseLines, statsFromLines, RenderItem } from "./transcript";
import {
  loadPhoneSessions,
  phoneSessionsFile,
  phoneSessionMtimesWithContent,
  diffNewPhoneSessions,
  activePhoneSessions,
  PhoneSessionsInfo
} from "./phone";
import {
  PendingAlertTracker,
  PendingStatus,
  capToolNames,
  computePending,
  gateNotifications,
  readPendingFromTail
} from "./pending";

const VIEW_ID = "pairletLive.view";
/** Activity-bar container id from package.json contributions.viewsContainers. */
const VIEW_CONTAINER_ID = "pairlet";
const SESSION_CAP = 30;
const RECENT_MS = 48 * 60 * 60 * 1000; // 48h
const ACTIVITY_MS = 60 * 1000; // "活跃" threshold
const REFRESH_MS = 10 * 1000;
/** Phone-session TSV poll cadence; folded into the refresh loop below. */
const PHONE_POLL_MS = 2500;
/** Skip full message-count parse for very large transcripts (avoids repeated
 *  multi-second re-reads of huge, actively-growing files on each 10s refresh). */
const MAX_COUNT_BYTES = 8 * 1024 * 1024;

interface SessionInfo {
  filePath: string;
  sessionId: string;
  projectDir: string; // slug dir name
  projectLabel: string; // readable path
  mtimeMs: number;
  size: number;
  messageCount: number; // -1 = not counted (too large)
  phone: boolean; // spawned by the Pairlet daemon (phone-driven)
  /** Best-effort tail-based "waiting for confirmation" (⏸) flag. */
  pending: boolean;
  /** Unresolved tool names when pending (for badge/notification text). */
  waitingTools: string[];
}

interface MetaCacheEntry {
  mtimeMs: number;
  size: number;
  projectLabel: string;
  messageCount: number;
}

function projectsRoot(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

/**
 * Best-effort decode of a Claude projects slug dir name back to a readable path.
 * Real encoding (verified on this machine): non-alphanumerics in the absolute
 * path are flattened to '-', e.g.
 *   C:\Users\Lenovo\Desktop\job\repos\GitHub Trending Agent
 *   -> c--Users-Lenovo-Desktop-job-repos-GitHub-Trending-Agent
 * Decoding is inherently lossy ('-' may have been space, '\', '/', ':' etc.).
 * We prefer the exact `cwd` field from the transcript itself when available.
 */
export function decodeSlugDir(dirName: string): string {
  const drive = /^([A-Za-z])--(.*)$/.exec(dirName);
  if (drive) {
    return `${drive[1]}:\\${drive[2].replace(/-/g, "\\")}`;
  }
  return dirName.replace(/-/g, "/");
}

/** Case-insensitive Windows containment: is `child` inside (or equal to) `parent`? */
export function isPathInside(child: string, parent: string): boolean {
  const c = path.resolve(child).toLowerCase();
  const p = path.resolve(parent).toLowerCase();
  if (c === p) {
    return true;
  }
  const prefix = p.endsWith(path.sep) ? p : p + path.sep;
  return c.startsWith(prefix);
}

export class PairletLiveProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private tailer: TranscriptTailer | undefined;
  private openFile: string | undefined;
  /** cwd recorded in the open session's transcript (for openPath resolution). */
  private openCwd: string | undefined;
  /** Session already auto-revealed; repeated appends must not re-reveal it. */
  private revealedSessionId: string | undefined;
  /** Byte offset where the open session's displayed window starts (pagination). */
  private chunkStart = 0;
  /** Host-side copy of the open session's parsed items (pending detection). */
  private openItems: RenderItem[] | undefined;
  /** ms timestamp of the open session's last append (idle clock). */
  private openLastAppendMs = 0;
  /** One-shot phone pending-alert tracker (idle->pending transitions). */
  private readonly pendingAlerts = new PendingAlertTracker();
  private sessions: SessionInfo[] = [];
  private refreshTimer: NodeJS.Timeout | undefined;
  private refreshTick = 0;
  private phoneInfo: PhoneSessionsInfo = { sessionIds: new Set(), projectBySession: new Map() };
  /** Phone sessions with content on the previous scan; undefined until baseline. */
  private knownPhoneMtimes: Map<string, number> | undefined;
  /** Phone sessions already auto-opened/announced during this provider lifetime. */
  private readonly announcedPhoneSessions = new Set<string>();
  private readonly metaCache = new Map<string, MetaCacheEntry>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    const { webview } = webviewView;
    const nonce = makeNonce();

    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, "media"))]
    };
    webview.html = getHtml(webview, nonce, this.context.extensionPath);

    webview.onDidReceiveMessage((msg: unknown) => {
      const m = msg as { type?: string; filePath?: string; path?: string; line?: number };
      if (!m || typeof m.type !== "string") {
        return;
      }
      switch (m.type) {
        case "ready":
          this.postSessions();
          break;
        case "refresh":
          this.postSessions();
          break;
        case "open":
          if (typeof m.filePath === "string") {
            this.openSession(m.filePath);
          }
          break;
        case "back":
          this.closeTail();
          this.openFile = undefined;
          this.openCwd = undefined;
          this.revealedSessionId = undefined;
          this.chunkStart = 0;
          this.openItems = undefined;
          break;
        case "loadOlder":
          this.serveOlderChunk();
          break;
        case "openPath":
          // Untrusted webview input: validated in openPathInEditor.
          if (typeof m.path === "string") {
            this.openPathInEditor(
              m.path,
              typeof m.line === "number" && Number.isInteger(m.line) && m.line >= 1 ? m.line : undefined
            );
          }
          break;
        default:
          break;
      }
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        // The timer keeps running while the view exists (so auto-reveal and
        // phone waiting-alerts work when the panel is hidden); refresh on
        // re-show so the list is immediately current.
        this.startRefreshTimer();
        this.postSessions();
      }
    });

    webviewView.onDidDispose(() => {
      // View removed: stop the tailer + timer so nothing posts into a future
      // webview, and clear per-view state so a re-resolve starts fresh.
      this.stopRefreshTimer();
      this.closeTail();
      this.view = undefined;
      this.openFile = undefined;
      this.openCwd = undefined;
      this.revealedSessionId = undefined;
      this.chunkStart = 0;
      this.openItems = undefined;
    });

    this.postSessions();
    this.startRefreshTimer();
  }

  dispose(): void {
    this.stopRefreshTimer();
    this.closeTail();
    this.view = undefined;
  }

  // ---------- session discovery ----------

  private startRefreshTimer(): void {
    if (this.refreshTimer) {
      return;
    }
    this.refreshTimer = setInterval(() => {
      this.refreshTick += 1;
      // Phone attribution polled every tick (~2.5s).
      this.refreshPhoneSessions();
      // Full session scan + pending evaluation every REFRESH_MS — runs even
      // while the view is hidden so phone waiting-alerts still fire.
      if (this.refreshTick % Math.max(1, Math.round(REFRESH_MS / PHONE_POLL_MS)) === 0) {
        this.postSessions();
      }
    }, PHONE_POLL_MS);
  }

  private stopRefreshTimer(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  private refreshPhoneSessions(): void {
    this.phoneInfo = loadPhoneSessions(phoneSessionsFile());
  }

  /**
   * Sessions are discovered across ALL of ~/.claude/projects — a superset of
   * (open workspace folders ∪ TSV project paths), so phone sessions living in
   * projects not open in this window are included too. Phone sessions (by ID)
   * get an exact project label from the TSV when available.
   */
  private scanSessions(): SessionInfo[] {
    const root = projectsRoot();
    const out: SessionInfo[] = [];
    let projectDirs: fs.Dirent[];
    try {
      projectDirs = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const d of projectDirs) {
      if (!d.isDirectory()) {
        continue;
      }
      const projectDir = path.join(root, d.name);
      let files: string[];
      try {
        files = fs.readdirSync(projectDir).filter((f) => f.endsWith(".jsonl"));
      } catch {
        continue;
      }
      for (const f of files) {
        const filePath = path.join(projectDir, f);
        let st: fs.Stats;
        try {
          st = fs.statSync(filePath);
        } catch {
          continue;
        }
        if (!st.isFile()) {
          continue;
        }
        const sessionId = f.replace(/\.jsonl$/, "");
        const phone = this.phoneInfo.sessionIds.has(sessionId);
        const meta = this.metaFor(filePath, st.mtimeMs, st.size);
        // Best-effort ⏸ detection from the file tail only (never throws).
        const pend: PendingStatus = readPendingFromTail(filePath, st.mtimeMs);
        out.push({
          filePath,
          sessionId,
          projectDir: d.name,
          // Exact TSV path beats lossy slug decoding for phone sessions.
          projectLabel: (phone ? this.phoneInfo.projectBySession.get(sessionId) : undefined) ?? meta.projectLabel,
          mtimeMs: st.mtimeMs,
          size: st.size,
          messageCount: meta.messageCount,
          phone,
          pending: pend.pending,
          waitingTools: pend.toolNames
        });
      }
    }
    out.sort((a, b) => b.mtimeMs - a.mtimeMs);
    // 48h-recent first, then by mtime; cap at SESSION_CAP.
    out.sort((a, b) => {
      const ra = a.mtimeMs >= Date.now() - RECENT_MS ? 0 : 1;
      const rb = b.mtimeMs >= Date.now() - RECENT_MS ? 0 : 1;
      if (ra !== rb) {
        return ra - rb;
      }
      return b.mtimeMs - a.mtimeMs;
    });
    return out.slice(0, SESSION_CAP);
  }

  private metaFor(filePath: string, mtimeMs: number, size: number): MetaCacheEntry {
    const cached = this.metaCache.get(filePath);
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
      return cached;
    }
    const slugDir = path.basename(path.dirname(filePath));
    let projectLabel = decodeSlugDir(slugDir);
    let messageCount = -1;
    if (size <= MAX_COUNT_BYTES) {
      try {
        const text = fs.readFileSync(filePath, "utf8");
        const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
        const stats = statsFromLines(lines);
        messageCount = stats.messages;
        // Prefer the exact cwd recorded in the transcript over slug decoding.
        if (stats.cwd && /[\\/]/.test(stats.cwd)) {
          projectLabel = stats.cwd;
        }
      } catch {
        /* unreadable: keep slug label, count -1 */
      }
    }
    const entry: MetaCacheEntry = { mtimeMs, size, projectLabel, messageCount };
    this.metaCache.set(filePath, entry);
    return entry;
  }

  private postSessions(): void {
    this.refreshPhoneSessions();
    this.sessions = this.scanSessions();
    // A brand-new phone conversation — or new output in one that is not open —
    // must not stay invisible just because a different session is open.
    this.noticePhoneActivity();
    // Phone waiting-alerts: one-shot on idle->pending transitions.
    this.checkPhoneWaitingAlerts();
    // In-panel ⏸ strip for the open session (re-evaluated every refresh).
    this.postOpenPendingState();
    if (!this.view) {
      return;
    }
    const now = Date.now();
    const payload = this.sessions.map((s) => ({
      filePath: s.filePath,
      sessionId: s.sessionId,
      projectDir: s.projectDir,
      projectLabel: s.projectLabel,
      mtimeMs: s.mtimeMs,
      size: s.size,
      messageCount: s.messageCount,
      phone: s.phone,
      active: now - s.mtimeMs < ACTIVITY_MS,
      recent: s.mtimeMs >= now - RECENT_MS,
      pending: s.pending
    }));
    void this.view.webview.postMessage({ type: "sessions", sessions: payload });
  }

  /**
   * Phone activity that happens while the user is watching a different
   * session must not stay invisible:
   *  - a phone session that was absent on the previous scan (new conversation):
   *    autoOpenNewPhoneSession -> switch the live view to it, else show a bar;
   *  - an existing phone session whose transcript grew (phone continued it):
   *    show a one-click bar (never yank the view away from the current session).
   * The first scan only establishes a baseline, so opening the panel never
   * hijacks the view for conversations that already existed.
   */
  private noticePhoneActivity(): void {
    const current = phoneSessionMtimesWithContent(this.sessions);
    if (this.knownPhoneMtimes === undefined) {
      this.knownPhoneMtimes = current;
      return;
    }
    const fresh = diffNewPhoneSessions(current, new Set(this.knownPhoneMtimes.keys()));
    const active = activePhoneSessions(current, this.knownPhoneMtimes);
    this.knownPhoneMtimes = current;
    // List view already re-renders with the new row; a disposed view has no UI.
    if (!this.view || !this.openFile) {
      return;
    }
    const byId = new Map(this.sessions.map((s) => [s.sessionId, s]));
    const freshCandidates = fresh
      .map((id) => byId.get(id))
      .filter((s): s is SessionInfo => !!s)
      .filter((s) => s.filePath !== this.openFile && !this.announcedPhoneSessions.has(s.sessionId))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    const cfg = vscode.workspace.getConfiguration("pairletLive");
    const autoReveal = cfg.get<boolean>("autoReveal", true);
    const autoOpen = autoReveal && cfg.get<boolean>("autoOpenNewPhoneSession", true);
    if (autoOpen && freshCandidates.length > 0) {
      const target = freshCandidates.shift()!;
      this.openSession(target.filePath);
      void vscode.commands.executeCommand(`workbench.view.extension.${VIEW_CONTAINER_ID}`);
    }
    for (const s of freshCandidates) {
      this.announcedPhoneSessions.add(s.sessionId);
      void this.view.webview.postMessage({
        type: "phoneSessionAlert",
        reason: "new",
        sessionId: s.sessionId,
        filePath: s.filePath,
        projectLabel: s.projectLabel
      });
    }
    for (const id of active) {
      const s = byId.get(id);
      if (
        !s ||
        s.filePath === this.openFile ||
        this.announcedPhoneSessions.has(s.sessionId)
      ) {
        continue;
      }
      this.announcedPhoneSessions.add(s.sessionId);
      void this.view.webview.postMessage({
        type: "phoneSessionAlert",
        reason: "activity",
        sessionId: s.sessionId,
        filePath: s.filePath,
        projectLabel: s.projectLabel
      });
    }
  }

  /**
   * One-shot VS Code notification on PHONE-session idle->pending transitions.
   * Guard rails: notifyWaiting setting gates this only (strip/badge ignore it);
   * the tracker re-arms after pending clears or the id leaves the list.
   */
  private checkPhoneWaitingAlerts(): void {
    const present = new Set<string>();
    const pendingById = new Map<string, boolean>();
    const byId = new Map<string, SessionInfo>();
    for (const s of this.sessions) {
      present.add(s.sessionId);
      pendingById.set(s.sessionId, s.pending);
      byId.set(s.sessionId, s);
    }
    const transitions = this.pendingAlerts.update(present, pendingById);
    if (transitions.length === 0) {
      return;
    }
    const enabled = vscode.workspace.getConfiguration("pairletLive").get<boolean>("notifyWaiting", true);
    for (const id of gateNotifications(enabled, transitions)) {
      const s = byId.get(id);
      if (!s || !s.phone) {
        continue; // only phone sessions alert (tracker still tracks all ids)
      }
      const tools = capToolNames(s.waitingTools);
      const base = path.basename(s.projectLabel) || s.projectDir;
      const filePath = s.filePath;
      void vscode.window
        .showWarningMessage(`手机会话等待确认：${base} — ${tools}`, "查看")
        .then((sel) => {
          if (sel === "查看") {
            this.revealAndOpen(filePath);
          }
        });
    }
  }

  /** Reveal the Pairlet Live panel and switch it to the given session. */
  private revealAndOpen(filePath: string): void {
    void vscode.commands.executeCommand(`workbench.view.extension.${VIEW_CONTAINER_ID}`);
    try {
      this.view?.show(false); // focus the webview itself
    } catch {
      /* view may not be resolvable — openSession still streams */
    }
    this.openSession(filePath);
  }

  /** Post the ⏸ waiting strip state for the currently open session. */
  private postOpenPendingState(): void {
    if (!this.openFile || !this.openItems) {
      return;
    }
    const idleMs = Date.now() - this.openLastAppendMs;
    const status = computePending(this.openItems, idleMs);
    void this.view?.webview.postMessage({
      type: "pendingState",
      pending: status.pending,
      toolNames: capToolNames(status.toolNames)
    });
  }

  /**
   * Serve one lazy older-chunk read for the open (truncated) session.
   * Independent read — never touches the tailer's offset state.
   */
  private serveOlderChunk(): void {
    if (!this.openFile || this.chunkStart <= 0) {
      void this.view?.webview.postMessage({ type: "olderChunk", items: [], newStartOffset: 0, done: true });
      return;
    }
    try {
      const chunk = readOlderChunk(this.openFile, this.chunkStart, CHUNK_BYTES);
      this.chunkStart = chunk.newStartOffset;
      void this.view?.webview.postMessage({
        type: "olderChunk",
        items: parseLines(chunk.lines),
        newStartOffset: chunk.newStartOffset,
        done: chunk.done || chunk.newStartOffset <= 0
      });
    } catch {
      // Unreadable: report done so the webview stops asking; never throw.
      this.chunkStart = 0;
      void this.view?.webview.postMessage({ type: "olderChunk", items: [], newStartOffset: 0, done: true });
    }
  }

  // ---------- live stream ----------

  private openSession(filePath: string): void {
    // Safety: only allow reading .jsonl under ~/.claude/projects.
    const root = path.resolve(projectsRoot());
    const resolved = path.resolve(filePath);
    if (!resolved.toLowerCase().endsWith(".jsonl") || !resolved.toLowerCase().startsWith(root.toLowerCase() + path.sep)) {
      void vscode.window.showWarningMessage("Pairlet Live 仅允许只读打开 ~/.claude/projects 下的会话文件。");
      return;
    }
    this.closeTail();
    this.openFile = resolved;
    this.revealedSessionId = undefined; // newly opened session may re-reveal

    let start: TailStart;
    try {
      start = readTail(resolved);
    } catch (e) {
      void this.view?.webview.postMessage({
        type: "streamError",
        message: `无法读取会话文件：${(e as Error).message}`
      });
      return;
    }
    const items = parseLines(start.lines);
    const session = this.sessions.find((s) => s.filePath === resolved);
    const sessionId = session?.sessionId ?? path.basename(resolved, ".jsonl");
    // Re-arm activity alerts for this session: once the user has looked at it,
    // a later phone message should be able to raise the bar again.
    this.announcedPhoneSessions.delete(sessionId);
    // Transcript cwd of the open session — resolution base for relative paths.
    const tailStats = statsFromLines(start.lines);
    this.openCwd = tailStats.cwd && /[\\/]/.test(tailStats.cwd) ? tailStats.cwd : undefined;
    // Pagination: older chunks are read below windowStart (0 => fully shown).
    this.chunkStart = start.windowStart;
    // Host-side item copy for ⏸ pending detection on every refresh.
    this.openItems = items.slice();
    try {
      this.openLastAppendMs = fs.statSync(resolved).mtimeMs;
    } catch {
      this.openLastAppendMs = Date.now();
    }
    void this.view?.webview.postMessage({
      type: "streamStart",
      filePath: resolved,
      sessionId,
      projectLabel: session?.projectLabel ?? decodeSlugDir(path.basename(path.dirname(resolved))),
      truncated: start.truncated,
      startOffset: start.windowStart,
      items
    });

    this.tailer = new TranscriptTailer(resolved, start, (lines) => {
      const newItems = parseLines(lines);
      if (newItems.length > 0 && this.view) {
        this.openLastAppendMs = Date.now();
        if (this.openItems) {
          for (const it of newItems) {
            this.openItems.push(it);
          }
        }
        void this.view.webview.postMessage({ type: "streamAppend", items: newItems });
        this.maybeAutoReveal(sessionId);
      }
      // Activity refresh shortly after new data lands.
      setTimeout(() => this.postSessions(), 500);
    });
    this.tailer.start();
  }

  /**
   * Auto-reveal contract: the OPEN session got appended lines AND its ID is in
   * the phone set AND pairletLive.autoReveal is on -> reveal the panel once
   * (subsequent appends do not re-reveal while it stays displayed). Desktop /
   * extension-driven sessions (not in the phone set) NEVER reveal anything.
   * A new TSV row alone (new phone session) does NOT auto-open anything.
   */
  private maybeAutoReveal(sessionId: string): void {
    if (this.revealedSessionId === sessionId) {
      return; // already revealed for this session
    }
    this.refreshPhoneSessions();
    if (!this.phoneInfo.sessionIds.has(sessionId)) {
      return; // not a phone session — stay silent
    }
    const autoReveal = vscode.workspace.getConfiguration("pairletLive").get<boolean>("autoReveal", true);
    if (!autoReveal) {
      return;
    }
    this.revealedSessionId = sessionId;
    void vscode.commands.executeCommand(`workbench.view.extension.${VIEW_CONTAINER_ID}`);
  }

  /**
   * Open a file path reported by the webview (clickable path in a message).
   * The path is UNTRUSTED: relative paths resolve against the open session's
   * transcript cwd (fallback: first workspace folder); after resolution the
   * file must lie inside that cwd OR inside any open workspace folder
   * (Windows case-insensitive), else we refuse with an info message.
   */
  private openPathInEditor(rawPath: string, line?: number): void {
    void (async () => {
      try {
        const workspaces = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
        const looksAbsolute = path.isAbsolute(rawPath) || /^[A-Za-z]:[\\/]/.test(rawPath);
        let resolved: string;
        if (looksAbsolute) {
          resolved = path.resolve(rawPath);
        } else {
          const base = this.openCwd ?? workspaces[0];
          if (!base) {
            void vscode.window.showInformationMessage("Pairlet Live：无法解析相对路径（会话无 cwd，且未打开工作区）。");
            return;
          }
          resolved = path.resolve(base, rawPath);
        }
        const allowedRoots: string[] = [];
        if (this.openCwd) {
          allowedRoots.push(this.openCwd);
        }
        allowedRoots.push(...workspaces);
        const allowed = allowedRoots.some((root) => isPathInside(resolved, root));
        if (!allowed) {
          void vscode.window.showInformationMessage(
            "Pairlet Live：出于安全考虑，仅允许打开会话目录或当前工作区内的文件。"
          );
          return;
        }
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
          void vscode.window.showInformationMessage(`Pairlet Live：文件不存在：${resolved}`);
          return;
        }
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(resolved));
        if (line !== undefined && line - 1 < doc.lineCount) {
          const pos = new vscode.Position(Math.max(0, line - 1), 0);
          await vscode.window.showTextDocument(doc, { selection: new vscode.Selection(pos, pos) });
        } else {
          await vscode.window.showTextDocument(doc);
        }
      } catch (e) {
        void vscode.window.showInformationMessage(`Pairlet Live：无法打开文件：${(e as Error).message}`);
      }
    })();
  }

  private closeTail(): void {
    if (this.tailer) {
      this.tailer.stop();
      this.tailer = undefined;
    }
  }
}

function makeNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 32; i++) {
    s += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return s;
}

function getHtml(webview: vscode.Webview, nonce: string, extensionPath: string): string {
  const pathlinksJs = webview.asWebviewUri(vscode.Uri.file(path.join(extensionPath, "media", "pathlinks.js")));
  const pagingJs = webview.asWebviewUri(vscode.Uri.file(path.join(extensionPath, "media", "paging.js")));
  const groupingJs = webview.asWebviewUri(vscode.Uri.file(path.join(extensionPath, "media", "grouping.js")));
  const mainJs = webview.asWebviewUri(vscode.Uri.file(path.join(extensionPath, "media", "main.js")));
  const styleCss = webview.asWebviewUri(vscode.Uri.file(path.join(extensionPath, "media", "style.css")));
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'nonce-${nonce}'`,
    `script-src ${webview.cspSource} 'nonce-${nonce}'`,
    `img-src ${webview.cspSource} data:`
  ].join("; ");
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <link nonce="${nonce}" rel="stylesheet" href="${styleCss}" />
  <title>Pairlet Live</title>
</head>
<body>
  <div id="banner">只读直播 · 输入请在手机 App 或 VS Code 原生扩展中进行</div>
  <div id="header">
    <button id="back-btn" class="hidden" title="返回会话列表">← 返回列表</button>
    <span id="title">Pairlet Live</span>
    <span id="stream-label"></span>
    <button id="refresh-btn" title="刷新会话列表">↻ 刷新</button>
  </div>
  <button id="phone-alert" class="hidden" type="button"></button>
  <div id="list-view">
    <div id="session-list"></div>
  </div>
  <div id="stream-view" class="hidden">
    <div id="messages"></div>
    <div id="pending-strip" class="hidden"></div>
    <button id="new-msg-chip" class="hidden">新消息 ↓</button>
  </div>
  <script nonce="${nonce}" src="${pathlinksJs}"></script>
  <script nonce="${nonce}" src="${pagingJs}"></script>
  <script nonce="${nonce}" src="${groupingJs}"></script>
  <script nonce="${nonce}" src="${mainJs}"></script>
</body>
</html>`;
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new PairletLiveProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    { dispose: () => provider.dispose() }
  );
}

export function deactivate(): void {
  /* disposed via subscriptions */
}
