# Pairlet Live

🇨🇳 [中文](README.md) · 🇺🇸 [English](README.en.md)

A **read-only** VS Code sidebar extension that live-streams Claude Code sessions driven from your phone (Pairlet).

> Repository: [github.com/ningbojian/vscode-pairlet-live](https://github.com/ningbojian/vscode-pairlet-live)
>
> Download: [latest Release](https://github.com/ningbojian/vscode-pairlet-live/releases/latest)
> (`pairlet-live-0.1.0.vsix`)

> **Unofficial community project.** This project is not affiliated with, and is not endorsed by,
> [heypandax/pairlet](https://github.com/heypandax/pairlet); the Pairlet name and trademarks belong
> to its authors.
>
> Why it exists: upstream [issue #70](https://github.com/heypandax/pairlet/issues/70) explains that
> live phone-driven sessions are hidden from the Claude Code VS Code extension and from the
> `--resume` picker (`entrypoint:"sdk-cli"`), even though the transcript files have been sitting in
> the shared directory from the very first second. This extension does one thing: make those
> sessions visible inside the IDE, with zero configuration and read-only access.

It reads the shared transcript files from `~/.claude/projects/<project-slug>/<sessionId>.jsonl`
and renders them live in the **Pairlet Live** view in the activity bar; phone-session ownership
comes from `~/.cc-pocket/spawned-sessions.tsv`.

> Type your input in the phone app or in the native VS Code extension. This extension never writes
> transcripts, never launches claude, never injects input, and makes no network requests and no
> telemetry.

Installation details are in [INSTALL.md](INSTALL.md).

---

## Division of labour with the upstream desktop app

| Surface | Responsibility |
| --- | --- |
| Official Pairlet app / desktop | Full control plane: Watch / Approve / Continue / Inspect, diffs, notifications, cross-device pairing |
| This extension | **Zero-config, read-only, zero-network** live view inside VS Code; no input, no approvals, no transcript writes |

This extension is not a replacement for the official desktop app. If you need to approve, take over,
or inspect diffs, use the official app/desktop. The unique value here is IDE visibility while a
session is still alive and the native VS Code extension cannot yet see it.

---

## Features

### Session list

- Scans every session under `~/.claude/projects` (not limited to the current workspace).
- **One row per project**: project folder name (hover for the full path), session count and last
  activity time; badges aggregate across all sessions in the project (`📱 phone`, `⏸ waiting`,
  `active`, `within 48 hours`).
- Clicking a row opens that project's **merged live view**: all sessions of the project share one
  window, so you no longer have to guess which one to click.
- The host first takes the latest **30** sessions (48-hour-old ones first) and then merges them into
  project rows, so there are at most 30 rows; a project with a lot of sessions can push other
  projects out (see "Known limitations").
- "↻ Refresh" rescans manually; the list auto-updates every 10 seconds.

### Live view

- **All sessions of one project are merged into a single timeline**, ordered by entry timestamp;
  shared history copied over by `--resume` / new phone sessions is de-duplicated by JSONL `uuid`
  and shown once, while messages after the branch point are kept.
- **De-duplication works at JSONL-entry granularity**: the thinking / text / tool blocks parsed
  from one record all share that record's `uuid`, so the entry is either kept whole or dropped
  whole; every merged item is annotated with its source `sessionId`.
- Sessions are ordered by file creation time (`birthtime`, falling back to `mtime` when absent) so
  the oldest original copy is the survivor; items without a usable timestamp inherit the previous
  timestamp within their own session (JSONL files are append-only, so order is reliable).
- The merged result keeps at most **4000** items (`MAX_MERGED_ITEMS`); older entries are dropped
  past that point and flagged as truncated. Live appends use the merge's `seenUuids` set (every uuid
  ever seen, including dropped duplicates) to skip shared history that already appeared.
- User messages are labelled with their source: `Input · 📱 abc12345` (phone session) or
  `Input · abc12345`; four theme colours distinguish sessions so it stays clear who said what.
- User input (left colour bar marks the source session), assistant replies, tool activity, system
  notices.
- **Consecutive tool calls and results collapse into one row** — "⚙ Tool activity · N items:
  Bash, Read…" — collapsed by default; click to expand per-command/result summaries so tool spam
  does not bury the assistant text. Live-appended tools join the same group (keeping whatever
  collapsed/expanded state you last chose) but groups are **never merged across sessions**.
- Auto-scrolls to the bottom when the file is appended; while you scroll up a "New messages (n) ↓"
  chip appears.
- The merged view reads the last **2MB** of each session file and merges only the latest **8**
  sessions (the focused session is always included, so at most 9); the merged view has no
  scroll-back paging.
- When a project has **only one session**, chunked paging is kept: scrolling to the top loads older
  records 512KB at a time without moving the viewport, and "Beginning of file" appears at the start.
- File paths in messages (`src/extension.ts:42`, `C:\path\file.ts`, `./media/main.js`) are
  underlined and clickable to open in the editor at that line; for safety only files inside the
  session `cwd` or the current workspace may be opened.

### Phone session detection and auto-reveal

- The Pairlet daemon appends `<absolute project path>\t<session id>` to
  `%USERPROFILE%\.cc-pocket\spawned-sessions.tsv`; the extension only reads it, and treats a
  missing file as "no phone sessions".
- When a phone session writes a new line in the **project you are viewing**, the panel is revealed
  and focused once; desktop/extension-driven sessions never trigger it.
- If the phone produces output in **another project** while you are viewing a different one:
  - new phone session + `pairletLive.autoOpenNewPhoneSession` (default `true`) → switch the live
    view to that project's merged view and focus the panel;
  - new phone session + that setting off → show a top banner
    "📱 New phone session: <project> · <session id> — click to view";
  - existing phone session producing new output → show "📱 Phone session has new messages: … —
    click to view", without auto-switching, so your reading is not interrupted.
- If it is already inside the current project and merely outputting in another session, the
  messages appear directly in the merged view (no switching needed) — that is exactly what the
  merged view is for.
- The first time the panel opens it only establishes a baseline, so existing historical phone
  sessions do not steal the current view; nothing auto-switches while you are on the session list.
- Each session is announced only once; opening it re-arms, and further phone output after you leave
  notifies again.

### ⏸ Waiting for approval

Condition: a `tool_use` has no matching `tool_result`, the transcript file has been idle for ≥ 20
seconds, and the newest entry is exactly that pending `tool_use`.

- A "⏸ Waiting: <tool name>" status bar appears at the bottom of the panel; in the merged view the
  most recently written waiting session wins.
- Project rows in the list show a `⏸ waiting` badge (any session waiting is enough; this is a
  best-effort check that reads only the last 16KB of each session).
- When a **phone session** transitions from not-waiting to waiting, one VS Code notification is
  shown with a "View" button; it is not repeated during the same wait and re-arms after the wait
  clears.

### Settings

| Setting | Default | Description |
| --- | --- | --- |
| `pairletLive.autoReveal` | `true` | Reveal and focus the panel when a phone session has new messages; desktop sessions never trigger it. |
| `pairletLive.autoOpenNewPhoneSession` | `true` | When a new phone session appears in **another project**, switch the live view to that project's merged view; when off, show a top banner instead. New output from an existing phone session in the same project only shows the banner and never auto-switches. Only effective while `autoReveal` is on. |
| `pairletLive.notifyWaiting` | `true` | Show one notification when the phone side is waiting for approval; the panel status bar and list badges are unaffected. |

---

## Installation

### Option 1: download the VSIX (recommended for daily use)

1. Download `pairlet-live-0.1.0.vsix` from
   [Releases](https://github.com/ningbojian/vscode-pairlet-live/releases/latest).
2. Install it:

   ```bat
   code --install-extension .\pairlet-live-0.1.0.vsix
   ```

   Or use `...` → **Install from VSIX...** in the top-right of the VS Code Extensions view.
3. Reload the window and click the **Pairlet Live** icon in the activity bar.

> If you previously installed an older version by copying the folder, run
> `code --uninstall-extension ningbojian.pairlet-live` first, so the same extension does not exist
> twice (two copies fight over `pairletLive.view` and the extension shows up as invalid / fails to
> activate).

### Option 2: development build

```bat
npm install
npm run compile
```

Open this folder in VS Code, press `F5` to launch the Extension Development Host window, then click
**Pairlet Live** in the activity bar of the new window. After changing code, press `Ctrl+R` to
reload the debug window.

> The repo ships [.vscode/launch.json](.vscode/launch.json) and
> [.vscode/tasks.json](.vscode/tasks.json); `F5` runs `npm: compile` before launching the host.

### Option 3: copy into the extensions folder manually

```bat
npm install
npm run compile
xcopy /E /I "C:\Users\Lenovo\Desktop\job\repos\vscode-pairlet-live" "%USERPROFILE%\.vscode\extensions\ningbojian.pairlet-live-0.1.0"
```

The folder name must be `<publisher>.<name>-<version>` (`publisher: "ningbojian"` +
`name: "pairlet-live"` → `ningbojian.pairlet-live-0.1.0`). You can leave out `node_modules/`,
`src/`, `scripts/` and `*.map` — the runtime only needs `package.json`, `out/*.js` and `media/`.
This method writes no installation metadata, so prefer the VSIX when upgrading.

Then `Ctrl+Shift+P` → `Developer: Reload Window` and click the **Pairlet Live** icon in the activity
bar.

Uninstall: `code --uninstall-extension ningbojian.pairlet-live`, or delete
`%USERPROFILE%\.vscode\extensions\ningbojian.pairlet-live-*` and reload the window.

---

## How it works

```
~/.claude/projects/<slug>/*.jsonl        (up to 8 sessions per project)
        │  readTail(2MB) / readOlderChunk(512KB) / fs.watch
        ▼
src/tailer.ts ──► src/transcript.ts ──► src/merge.ts
        │              (JSONL → RenderItem)   (uuid de-dup + timeline merge)
        ▼
src/extension.ts (WebviewViewProvider, 10s scan, phone alerts)
        │  postMessage: sessions / streamStart / streamAppend / olderChunk / pendingState
        ▼
media/main.js + paging.js + grouping.js + pathlinks.js + style.css
```

| File | Responsibility |
| --- | --- |
| `src/extension.ts` | Extension entry; session scanning, per-project merged view, webview lifecycle, message protocol, path validation, notifications and auto-reveal. |
| `src/tailer.ts` | Read-only tail: initial end-of-file window, backwards chunk reads, `fs.watch` live increments (falls back to 2s polling). |
| `src/transcript.ts` | Fault-tolerant JSONL parsing into `RenderItem` (every block from one record carries that record's `uuid`, enabling entry-level de-duplication); message count / `cwd` / `sessionId` stats. |
| `src/merge.ts` | Merges several sessions of one project into one timeline: **entry-level** de-duplication by `uuid` (`--resume` shared history kept once), ordering by session creation time, timestamp inheritance, a 4000-item cap and a truncation flag; returns `seenUuids` and `sessionCount` for the host. |
| `src/pending.ts` | ⏸ waiting detection, one-shot state-transition tracking, notification gating. |
| `src/phone.ts` | Parses the phone-session TSV and degrades safely when it is missing or corrupt. |
| `media/main.js` | Webview UI: project list, merged timeline, scroll paging, new-message chip, path clicks. |
| `media/paging.js` / `grouping.js` / `pathlinks.js` | DOM-free pure-function modules shared by the webview and the Node self-checks. |
| `scripts/check-*.mjs` | Self-check scripts (see below). |

Two hard design constraints:

1. **Read-only**: no transcript writes, no spawned processes, no injected input.
2. **Zero runtime dependencies / zero network**: only the VS Code API plus Node built-ins; all
   webview content is rendered with `textContent`, the CSP carries a nonce, and `innerHTML` is
   never touched.

---

## Development and self-checks

```bat
npm run compile        :: TypeScript compile to out/
npm run watch          :: incremental compile
```

| Command | Coverage |
| --- | --- |
| `npm run check` | Runs the parser over real local transcripts and prints item counts (no content). |
| `npm run check:tailer` | Partial-line hand-off, initial-load race, truncation flag. |
| `npm run check:phone` | TSV parsing, real-file ownership, missing/corrupt degradation. |
| `npm run check:paths` | Synthetic cases for the path regex plus a count scan over real transcripts. |
| `npm run check:paging` | Chunk-boundary math (including 1KB–1.3MB large records), no duplicate requests, end-of-file state. |
| `npm run check:grouping` | Project-level grouping and ordering (one row per project, aggregated badges, label choice). |
| `npm run check:merge` | Merged timeline: entry-level uuid de-duplication of shared history, branch messages kept, cross-session interleaving by time, missing-timestamp inheritance, session ordering by creation time, item cap and truncation flag. |
| `npm run check:pending` | Pending-tool detection, policy transitions/re-arming, notification gating. |
| `npm run check:boot` | Boots the real `media/main.js` in a Node vm with a minimal DOM shim and verifies project list / merged live view / paging / back / status bar / tool collapsing. |
| `npm run check:ci` | Self-contained CI combination: tailer + paging + grouping + merge + pending + boot (no dependency on a real `~/.claude`). |

> `check:paths` scans the newest real transcripts and can be very slow on 110MB-class files (see
> "Known limitations"). For the real file format this depends on and upgrade impact, see
> [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md); for upstream contribution and release strategy,
> see [docs/UPSTREAM-STRATEGY.md](docs/UPSTREAM-STRATEGY.md).

---

## Known limitations and gaps

### P0 — affects everyday reading

1. **No Markdown rendering**: assistant replies are plain text, so `**bold**`, lists, tables and
   code fences appear verbatim, and code has no syntax highlighting. This is the biggest gap versus
   the native Claude Code panel.
2. **No complete tool input/output**: `tool_result` and `tool_use` keep only a 140-character
   summary, and expanding shows the same truncated text; full command output, diffs and file
   contents are unavailable.
3. **User messages are truncated at 4000 characters** with no "show full text"; `thinking` blocks
   are hidden entirely with no toggle.
4. **No alerts while the panel has never been opened**: the extension activates implicitly via
   `onView`, and the polling timer only starts in `resolveWebviewView`. In a fresh VS Code window
   where you never clicked the icon, phone approval waits are not notified. Suggested fix: add an
   `onStartupFinished` activation event and move the timer/notifications into the activation phase.

### P1 — feature gaps

5. **The list and merged view have limited reach**: the host takes the latest 30 **sessions**
   before merging into projects, so a session-heavy project can push other projects out of the list
   (there is no "show all projects"); no search or filtering; the merged view cannot be narrowed to
   a single session (no session filter), and there are no favourites, read markers or unread counts.
6. **No command palette / keybinding / status bar entry**: you cannot open the panel or jump to a
   session from a command.
7. **Notifications only cover phone-side "waiting for approval"**: desktop-session waits, task
   completion and errors are silent; there is no "notify for desktop sessions" setting either.
8. **Multiple windows notify in duplicate**: every VS Code window that has resolved the panel scans
   the same transcripts independently and notifies on its own, with no de-duplication.
9. **Auto-switching only covers "newly appeared phone sessions"**: when an existing phone session
   keeps producing output in **another project**, only the top banner appears and nothing switches
   automatically; you must click the banner or open it from the list. If it is in the currently
   opened project, the messages just show up in the merged view.
   `pairletLive.autoOpenNewPhoneSession` controls whether new sessions auto-switch.
10. **No "open in native Claude Code" entry**, so the read-only stance lacks a natural hand-off for
    continuing work.
11. **No in-message search, copy or export**; a conversation cannot be exported to Markdown.
12. **Images/attachments are not shown**: `attachment` entries are ignored outright.

### P2 — engineering and release

13. **GitHub Releases exist, but there is no Marketplace pipeline yet**: `@vscode/vsce` is already a
    devDependency and `v*` tags are packaged and released by GitHub Actions, but the 128×128
    Marketplace icon is still missing and no Marketplace publisher is registered. GitHub Releases
    is the current distribution channel.
14. **No standard test framework or CI**: self-checks are manual `npm run` scripts and some depend
    on real local `~/.claude` data; consider moving pure-function tests to Vitest and marking the
    real-data checks optional.
15. **`check:paths` is very slow on huge transcripts**: on a 110MB file it ran for over 5 minutes
    without finishing (suspected regex backtracking on large lines); sample instead, or cap line
    length before testing.
16. **No output channel or logging**: most file-read failures are swallowed silently, so debugging
    means reading the code. Consider an `OutputChannel` (`Pairlet Live`).
17. **No i18n**: the UI and notifications are hard-coded Chinese.
18. **Large-file performance**: opening the merged view synchronously reads the last 2MB of each
    session (up to 8 sessions plus the focused one, ~18MB) and keeps one watcher per session while
    the merged view is open; list refreshes fully read and JSON-parse sessions up to 8MB (every 10
    seconds, when mtime changes) and read 16KB from every `.jsonl` in the store for ⏸ detection.
    That is significant overhead with many sessions, and `metaCache` has no eviction.
19. **Platform coverage leans Windows**: slug reverse-mapping is lossy on POSIX paths, and there is
    no validation or documentation for Mac/Linux/Remote-SSH/WSL (the extension reads `~/.claude` of
    the machine hosting the extension host, so Remote-SSH requires installing it remotely).
20. **Paths and configuration are hard-coded**: `~/.claude/projects` and
    `~/.cc-pocket/spawned-sessions.tsv` are not configurable, and `SESSION_CAP`,
    `MERGED_SESSION_CAP`, `MERGED_TAIL_BYTES`, `MAX_MERGED_ITEMS`, `RECENT_MS` and `CHUNK_BYTES`
    are all constants (you cannot tune the merged view's session count, read window or the
    4000-item timeline cap from settings).
21. **Accessibility and theming**: some colours (blue user border, green badge, four session accent
    colours) are hard-coded or fall back to `--vscode-charts-*`, ARIA labelling is missing, and
    contrast may be insufficient in high-contrast themes.
22. **The merged view has a hard 4000-item cap**: beyond it, older entries never appear in the
    merged timeline — only a truncation flag — and there is no "load older merged history" entry
    point.

### Intentional "gaps"

These are design boundaries, not defects:

- no sending input, no interrupting/resuming tasks, no modifying sessions;
- no deleting or renaming session files;
- no launching `claude`, no network proxying, no telemetry.

---

## Security and privacy

- Transcripts under `~/.claude/projects/**/*.jsonl` are opened read-only; paths in `open` messages
  are validated to be inside that directory.
- Clicking a path inside a message only opens real files inside "session `cwd` ∪ current workspace",
  case-insensitively on Windows.
- The webview uses a nonce CSP and writes everything through `textContent`, never `innerHTML`.
- No network requests are made; no transcript content is uploaded.

## License

MIT, see [LICENSE](LICENSE).