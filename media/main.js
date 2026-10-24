// media/main.js — Pairlet Live webview UI (plain DOM, no framework, no innerHTML for content)
"use strict";

/* global acquireVsCodeApi */
const vscode = acquireVsCodeApi();

const el = {
  banner: document.getElementById("banner"),
  header: document.getElementById("header"),
  title: document.getElementById("title"),
  streamLabel: document.getElementById("stream-label"),
  backBtn: document.getElementById("back-btn"),
  refreshBtn: document.getElementById("refresh-btn"),
  listView: document.getElementById("list-view"),
  sessionList: document.getElementById("session-list"),
  streamView: document.getElementById("stream-view"),
  messages: document.getElementById("messages"),
  pendingStrip: document.getElementById("pending-strip"),
  newChip: document.getElementById("new-msg-chip"),
  phoneAlert: document.getElementById("phone-alert")
};

const state = {
  sessions: [],
  openFile: undefined,
  atBottom: true,
  pendingNew: 0,
  // Scroll-up pagination (truncated sessions): see media/paging.js.
  paging: window.PairletPaging ? window.PairletPaging.initialState() : { canLoad: false, startOffset: 0, loading: false, done: true },
  olderDividerShown: false,
  startShown: false
};

// ---------- helpers ----------

function fmtTime(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtRelative(ms) {
  const diff = Date.now() - ms;
  if (diff < 60 * 1000) {
    return "刚刚";
  }
  if (diff < 60 * 60 * 1000) {
    return `${Math.floor(diff / (60 * 1000))} 分钟前`;
  }
  if (diff < 24 * 60 * 60 * 1000) {
    return `${Math.floor(diff / (60 * 60 * 1000))} 小时前`;
  }
  return `${Math.floor(diff / (24 * 60 * 60 * 1000))} 天前`;
}

function shortId(id) {
  return id.length > 12 ? id.slice(0, 8) : id;
}

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined && text !== null) {
    node.textContent = text;
  }
  return node;
}

// ---------- list view ----------

function renderList() {
  el.sessionList.textContent = "";
  if (state.sessions.length === 0) {
    const empty = make("div", "empty", "暂无活跃会话——手机上发起一条试试");
    el.sessionList.appendChild(empty);
    return;
  }
  // Group by project: header = basename (bold), full path as title attribute;
  // sessions inside a group by recency; groups by most-recent activity desc.
  // All labels render via textContent (inert even for hostile path strings).
  const grouping = window.PairletListGrouping;
  const groups = grouping
    ? grouping.groupSessions(state.sessions)
    : [{ label: "", basename: "", sessions: state.sessions }];
  for (const g of groups) {
    const group = make("div", "group");
    const head = make("div", "group-head");
    head.title = g.label;
    head.appendChild(make("span", "group-label", g.basename || g.label));
    group.appendChild(head);
    for (const s of g.sessions) {
      const row = make("button", "session-row");
      row.type = "button";
      row.dataset.filePath = s.filePath;

      const top = make("div", "row-top");
      top.appendChild(make("span", "session-id", shortId(s.sessionId)));
      if (s.phone) {
        top.appendChild(make("span", "badge-phone", "📱 手机"));
      }
      if (s.pending) {
        top.appendChild(make("span", "badge-pending", "⏸ 等待确认"));
      }
      if (s.active) {
        top.appendChild(make("span", "badge-active", "活跃"));
      } else if (s.recent) {
        top.appendChild(make("span", "badge-recent", "48 小时内"));
      }
      row.appendChild(top);

      const bottom = make("div", "row-bottom");
      bottom.appendChild(make("span", "row-time", fmtRelative(s.mtimeMs)));
      const count = s.messageCount >= 0 ? `${s.messageCount} 条消息` : "（过大，未统计）";
      bottom.appendChild(make("span", "row-count", count));
      row.appendChild(bottom);

      row.title = `${s.projectLabel}\n${s.filePath}\n最后更新: ${fmtTime(s.mtimeMs)}`;
      row.addEventListener("click", () => {
        state.openFile = s.filePath;
        showStream(s.projectLabel, shortId(s.sessionId));
        vscode.postMessage({ type: "open", filePath: s.filePath });
      });
      group.appendChild(row);
    }
    el.sessionList.appendChild(group);
  }
}

function showList() {
  state.openFile = undefined;
  el.streamLabel.textContent = "";
  el.listView.classList.remove("hidden");
  el.streamView.classList.add("hidden");
  el.backBtn.classList.add("hidden");
  el.title.textContent = "Pairlet Live";
  el.messages.textContent = "";
  hideChip();
  hidePendingStrip();
  state.paging = window.PairletPaging ? window.PairletPaging.initialState() : state.paging;
  state.olderDividerShown = false;
  state.startShown = false;
  renderList();
}

function showStream(projectLabel, short) {
  el.listView.classList.add("hidden");
  el.streamView.classList.remove("hidden");
  el.backBtn.classList.remove("hidden");
  el.title.textContent = "直播中";
  el.streamLabel.textContent = `${projectLabel} · ${short}`;
  el.messages.textContent = "";
  state.atBottom = true;
  state.pendingNew = 0;
  hideChip();
  hidePendingStrip();
}

// ---------- new phone-session alert ----------

function hidePhoneAlert() {
  el.phoneAlert.classList.add("hidden");
  el.phoneAlert.textContent = "";
  el.phoneAlert.title = "";
  delete el.phoneAlert.dataset.filePath;
  delete el.phoneAlert.dataset.projectLabel;
  delete el.phoneAlert.dataset.sessionId;
}

function showPhoneAlert(msg) {
  const label = typeof msg.projectLabel === "string" && msg.projectLabel ? msg.projectLabel : "未知项目";
  const sid = typeof msg.sessionId === "string" ? shortId(msg.sessionId) : "";
  const prefix = msg.reason === "activity" ? "手机会话有新消息" : "新的手机会话";
  el.phoneAlert.textContent = `📱 ${prefix}：${label}${sid ? ` · ${sid}` : ""} — 点击查看`;
  el.phoneAlert.title = typeof msg.filePath === "string" ? msg.filePath : "";
  el.phoneAlert.dataset.filePath = typeof msg.filePath === "string" ? msg.filePath : "";
  el.phoneAlert.dataset.projectLabel = label;
  el.phoneAlert.dataset.sessionId = typeof msg.sessionId === "string" ? msg.sessionId : "";
  el.phoneAlert.classList.remove("hidden");
}

el.phoneAlert.addEventListener("click", () => {
  const filePath = el.phoneAlert.dataset.filePath;
  if (!filePath) {
    return;
  }
  const label = el.phoneAlert.dataset.projectLabel || "";
  const sessionId = el.phoneAlert.dataset.sessionId || "";
  hidePhoneAlert();
  state.openFile = filePath;
  showStream(label, sessionId ? shortId(sessionId) : "");
  vscode.postMessage({ type: "open", filePath });
});

// ---------- stream rendering ----------

/**
 * Append message text with clickable file-path spans. Non-matching runs are
 * plain text nodes (textContent only); matching runs become
 * <span class="fileLink" data-path data-line> with the label set via
 * textContent — never innerHTML/insertAdjacentHTML (CSP discipline).
 */
function appendRichText(container, text) {
  const splitter = window.PairletPathLinks && window.PairletPathLinks.splitFilePaths;
  if (!splitter) {
    container.textContent = text || "";
    return;
  }
  for (const part of splitter(text || "")) {
    if (part.path) {
      const span = make("span", "fileLink");
      span.textContent = part.text;
      span.dataset.path = part.path;
      if (part.line) {
        span.dataset.line = String(part.line);
      }
      container.appendChild(span);
    } else {
      container.appendChild(document.createTextNode(part.text));
    }
  }
}

/**
 * Render one item into a detached node; returns the node or null if it does
 * not render. thinking/unknown items are skipped (hidden), so the 「新消息」
 * chip must count only rendered items — never items.length.
 */
function renderItem(item) {
  if (!item || item.kind === "thinking" || item.kind === "unknown") {
    return null; // thinking blocks hidden; unknown fallbacks hidden too
  }
  let node;
  if (item.kind === "user") {
    node = make("div", "msg msg-user");
    const role = make("div", "msg-role", "用户输入");
    const body = make("div", "msg-text");
    appendRichText(body, item.text || "");
    node.appendChild(role);
    node.appendChild(body);
  } else if (item.kind === "assistant") {
    node = make("div", "msg msg-assistant");
    const body = make("div", "msg-text");
    appendRichText(body, item.text || "");
    node.appendChild(body);
  } else if (item.kind === "tool") {
    // Rows normally live inside a collapsible tool-run group (newToolGroup).
    // The brief IS the row content — no second hidden toggle under it.
    node = make("div", "msg msg-tool");
    const label = item.isResult ? "↩ 结果" : `⚙ ${item.toolName || "tool"}`;
    const line = make("div", "tool-line", item.brief ? `${label}: ${item.brief}` : label);
    node.appendChild(line);
  } else if (item.kind === "system") {
    node = make("div", "msg msg-system");
    const label = item.fallbackType ? `[系统:${item.fallbackType}]` : "[系统]";
    const body = item.text ? `${label} ${item.text}` : label;
    node.textContent = body;
  } else {
    return null;
  }
  if (item.timestamp) {
    // Date.parse never throws — it returns NaN on failure, so check explicitly.
    const t = Date.parse(item.timestamp);
    if (!Number.isNaN(t)) {
      node.title = fmtTime(t);
    }
  }
  return node;
}

/** Append one item to the bottom of the message list; true if rendered. */
function appendItem(item) {
  const node = renderItem(item);
  if (!node) {
    return false;
  }
  el.messages.appendChild(node);
  return true;
}

// ---------- collapsed tool runs ----------

/** Tool names for a group head: unique, first 3, " 等" marks truncation. */
function formatToolNames(names) {
  const shown = (names || []).slice(0, 3);
  return shown.join(", ") + ((names || []).length > 3 ? " 等" : "");
}

function toolHeadText(count, names) {
  const base = `⚙ 工具活动 · ${count} 项`;
  return names && names.length > 0 ? `${base}：${formatToolNames(names)}` : base;
}

/**
 * Append tool rows into an existing group and refresh its head. Returns the
 * number of rows rendered. `_count` / `_names` are plain JS props on the
 * element — the group head is rebuilt from them on every merge.
 */
function pushToolRows(group, toolItems) {
  let rendered = 0;
  for (const it of toolItems || []) {
    const node = renderItem(it);
    if (!node) {
      continue;
    }
    group.appendChild(node);
    group._count += 1;
    if (!it.isResult && it.toolName && it.toolName !== "结果" && group._names.indexOf(it.toolName) === -1) {
      group._names.push(it.toolName);
    }
    rendered += 1;
  }
  // <details> without `open` renders collapsed: the whole run costs ONE line.
  group.firstChild.textContent = toolHeadText(group._count, group._names);
  return rendered;
}

/**
 * One collapsible block per consecutive run of tool_use / tool_result items.
 * Collapsed by default so mid-stream command noise never buries the assistant
 * text around it; expanding shows the individual rows (label + brief).
 */
function newToolGroup(toolItems) {
  const group = make("details", "tool-group");
  group._count = 0;
  group._names = [];
  group.appendChild(make("summary", "tool-group-head"));
  pushToolRows(group, toolItems);
  return group;
}

/** The group at the very bottom, if the last message IS a tool run (else null). */
function lastToolGroup() {
  const last = el.messages.lastChild;
  return last && last.classList && last.classList.contains("tool-group") ? last : null;
}

function appendItems(items) {
  const before = state.atBottom;
  let rendered = 0;
  let pendingTools = null;
  // Tools accumulate until a non-tool message arrives, then flush as ONE group.
  // A run that continues across appends MERGES into the group already at the
  // bottom (collapsed groups do not change height, so no viewport jump).
  const flushTools = () => {
    if (!pendingTools || pendingTools.length === 0) {
      return;
    }
    const rows = pendingTools;
    pendingTools = null;
    const group = lastToolGroup();
    if (group) {
      rendered += pushToolRows(group, rows);
    } else {
      const fresh = newToolGroup(rows);
      el.messages.appendChild(fresh);
      rendered += fresh._count;
    }
  };
  for (const it of items || []) {
    if (it && it.kind === "tool") {
      if (!pendingTools) {
        pendingTools = [];
      }
      pendingTools.push(it);
      continue;
    }
    flushTools();
    if (appendItem(it)) {
      rendered += 1;
    }
  }
  flushTools();
  if (before) {
    scrollToBottom();
  } else if (rendered > 0) {
    state.pendingNew += rendered;
    el.newChip.textContent = `新消息 (${state.pendingNew}) ↓`;
    el.newChip.classList.remove("hidden");
  }
}

function scrollToBottom() {
  state.atBottom = true;
  state.pendingNew = 0;
  hideChip();
  el.streamView.scrollTop = el.streamView.scrollHeight;
}

function hideChip() {
  el.newChip.classList.add("hidden");
}

function hidePendingStrip() {
  el.pendingStrip.textContent = "";
  el.pendingStrip.classList.add("hidden");
}

/**
 * Prepend one older chunk ABOVE a 「—— 更早记录 ——」 divider (textContent only),
 * keeping the viewport visually anchored: scrollTop is corrected by the height
 * added above it. Pathlink rendering is identical to append (same renderItem);
 * consecutive tool rows collapse into groups here too — but a chunk's tail run
 * never merges with content below the divider (they are separated on purpose).
 */
function prependOlderChunk(items) {
  const prevHeight = el.streamView.scrollHeight;
  const prevTop = el.streamView.scrollTop;
  const frag = document.createDocumentFragment();
  let rendered = 0;
  let pendingTools = [];
  const flushTools = () => {
    if (pendingTools.length === 0) {
      return;
    }
    const group = newToolGroup(pendingTools);
    pendingTools = [];
    frag.appendChild(group);
    rendered += group._count;
  };
  for (const it of items || []) {
    if (it && it.kind === "tool") {
      pendingTools.push(it);
      continue;
    }
    flushTools();
    const node = renderItem(it);
    if (node) {
      frag.appendChild(node);
      rendered += 1;
    }
  }
  flushTools();
  frag.appendChild(make("div", "older-divider", "—— 更早记录 ——"));
  state.olderDividerShown = true;
  el.messages.insertBefore(frag, el.messages.firstChild);
  el.streamView.scrollTop = prevTop + (el.streamView.scrollHeight - prevHeight);
  return rendered;
}

/** Show 「已到开头」 once at the very top when no more history exists. */
function showStartOfHistory() {
  if (state.startShown) {
    return;
  }
  state.startShown = true;
  el.messages.insertBefore(make("div", "older-divider", "已到开头"), el.messages.firstChild);
}

/** Ask the host for the previous history chunk (guarded by the paging state). */
function requestOlderIfAtTop() {
  if (!window.PairletPaging) {
    return;
  }
  const next = window.PairletPaging.requestOlder(state.paging);
  state.paging = next[0];
  if (next[1]) {
    vscode.postMessage({ type: "loadOlder" });
  }
}

el.streamView.addEventListener("scroll", () => {
  const dist = el.streamView.scrollHeight - el.streamView.scrollTop - el.streamView.clientHeight;
  state.atBottom = dist < 48;
  if (state.atBottom) {
    state.pendingNew = 0;
    hideChip();
  } else if (el.streamView.scrollTop <= 2) {
    // Scrolled to the very top of a truncated session -> lazy-load older chunk.
    requestOlderIfAtTop();
  }
});

el.newChip.addEventListener("click", () => {
  scrollToBottom();
});

// Clickable file paths inside message text -> open in editor (host validates).
el.messages.addEventListener("click", (e) => {
  const t = e.target;
  if (t && t.classList && t.classList.contains("fileLink") && t.dataset && t.dataset.path) {
    const msg = { type: "openPath", path: t.dataset.path };
    if (t.dataset.line) {
      const n = parseInt(t.dataset.line, 10);
      if (Number.isInteger(n) && n >= 1) {
        msg.line = n;
      }
    }
    vscode.postMessage(msg);
  }
});

el.refreshBtn.addEventListener("click", () => {
  vscode.postMessage({ type: "refresh" });
});

el.backBtn.addEventListener("click", () => {
  vscode.postMessage({ type: "back" });
  showList();
});

// ---------- messages from extension host ----------

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg || typeof msg.type !== "string") {
    return;
  }
  switch (msg.type) {
    case "sessions":
      state.sessions = Array.isArray(msg.sessions) ? msg.sessions : [];
      if (!state.openFile) {
        renderList();
      }
      break;
    case "streamStart": {
      if (typeof msg.filePath === "string") {
        state.openFile = msg.filePath;
        if (el.phoneAlert.dataset.filePath === msg.filePath) {
          hidePhoneAlert();
        }
      }
      el.messages.textContent = "";
      state.atBottom = true;
      state.pendingNew = 0;
      state.olderDividerShown = false;
      state.startShown = false;
      hideChip();
      hidePendingStrip();
      // Switch to the stream view even when the open was host-initiated
      // (e.g. the 「查看」 action on a phone waiting-for-confirmation alert).
      showStream(msg.projectLabel || "", msg.sessionId ? shortId(msg.sessionId) : "");
      // Pagination baseline: older chunks load only for truncated sessions
      // that still have history before the tail window.
      // PairletPaging.start(state, truncated, startOffset) takes THREE args —
      // the first (prior state) is the fresh initialState() baseline.
      if (window.PairletPaging) {
        state.paging = window.PairletPaging.start(
          window.PairletPaging.initialState(),
          !!msg.truncated,
          typeof msg.startOffset === "number" ? msg.startOffset : 0
        );
      }
      if (msg.truncated) {
        const noteText = state.paging && state.paging.canLoad
          ? "（仅显示文件末尾部分；向上滚动可加载更早记录）"
          : "（仅显示文件末尾部分）";
        el.messages.appendChild(make("div", "note", noteText));
      }
      appendItems(msg.items || []);
      scrollToBottom();
      break;
    }
    case "phoneSessionAlert":
      if (
        typeof msg.filePath === "string" &&
        msg.filePath !== state.openFile
      ) {
        showPhoneAlert(msg);
      }
      break;
    case "streamAppend":
      appendItems(msg.items || []);
      break;
    case "olderChunk": {
      if (!window.PairletPaging) {
        break;
      }
      state.paging = window.PairletPaging.receiveOlder(state.paging, msg);
      prependOlderChunk(msg.items || []);
      if (state.paging.done) {
        showStartOfHistory();
      }
      break;
    }
    case "pendingState": {
      // Host posts toolNames as a pre-joined string (capToolNames); tolerate
      // a raw tools array too. Never render names without the pending flag.
      let names = "";
      if (typeof msg.toolNames === "string" && msg.toolNames !== "") {
        names = msg.toolNames;
      } else if (Array.isArray(msg.tools)) {
        names = msg.tools.filter((t) => typeof t === "string" && t !== "").join(", ");
      }
      if (msg.pending && names !== "") {
        el.pendingStrip.textContent = `⏸ 等待确认：${names}`;
        el.pendingStrip.classList.remove("hidden");
      } else {
        hidePendingStrip();
      }
      break;
    }
    case "streamError": {
      el.messages.textContent = "";
      el.messages.appendChild(make("div", "empty", msg.message || "加载失败"));
      break;
    }
    default:
      break;
  }
});

// initial request
vscode.postMessage({ type: "ready" });
