// scripts/check-webview-boot.mjs — dev-only regression net for the WEBVIEW GLUE
// (media/main.js) against media/paging.js + grouping.js + pathlinks.js.
// Boots the REAL scripts, in webview order, inside a Node vm with a minimal
// DOM shim and an acquireVsCodeApi mock that captures postMessage. Reads only
// the media sources; writes nothing; no network.
//
// Proves (the M1-M3 class that isolated module harnesses could not see):
//   (a) {type:'sessions'} renders WITHOUT throwing: ONE row per project (with
//       aggregated badges), so the list stays short (M1: renderList must touch
//       el.sessionList, not the nonexistent state.sessionList).
//   (a2) a project row click posts {type:'openProject'} with projectDir.
//   (b) {type:'streamStart', truncated:true, startOffset:4096} leaves
//       state.paging.canLoad === true (M2: PairletPaging.start takes THREE
//       args); simulating scrollTop=0 posts EXACTLY ONE {type:'loadOlder'};
//       after {type:'olderChunk', newStartOffset:0, done:true} the done
//       guard refuses further requests (no double-load, no request storm).
//   (c) the back button (showList path) does not throw (M3: state.streamLabel
//       must be el.streamLabel) and re-renders the project list.
//   (c2) a merged streamStart tags user messages with session provenance and
//       disables pagination.
//   (d) {type:'pendingState'} shows the waiting strip text.
//   (e) {type:'phoneSessionAlert'} shows the 「新的手机会话」/「有新消息」 bar
//       and its click posts {type:'open'} (or openProject when projectDir is known).
//   (f) consecutive tool rows collapse into ONE <details class="tool-group">
//       (collapsed by default); a run continuing across appends merges into
//       the bottom group, a non-tool message ends the run, an older chunk
//       groups its own tools above the divider, and tools from DIFFERENT
//       sessions never merge into one group.
import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";

let failures = 0;
function check(name, ok, detail) {
  if (ok) {
    console.log("PASS:", name);
  } else {
    failures += 1;
    console.error("FAIL:", name, detail ?? "");
  }
}

// ---------- minimal DOM shim (textContent discipline only) ----------

class ShimClassList {
  constructor(node) {
    this._node = node; // shares storage with className (real DOM keeps them in sync)
  }
  add(c) {
    this._node._classes.add(c);
  }
  remove(c) {
    this._node._classes.delete(c);
  }
  contains(c) {
    return this._node._classes.has(c);
  }
}

class ShimNode {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.parentElement = null;
    this._classes = new Set();
    this.classList = new ShimClassList(this);
    this.dataset = {};
    this.title = "";
    this.type = "";
    this._text = "";
    this.listeners = new Map();
    this.scrollTop = 0;
    this.clientHeight = 500;
    this._scrollHeightOverride = null;
  }
  get className() {
    return [...this._classes].join(" ");
  }
  set className(v) {
    this._classes = new Set(
      String(v === undefined || v === null ? "" : v)
        .split(/\s+/)
        .filter(Boolean)
    );
  }
  get scrollHeight() {
    if (this._scrollHeightOverride !== null) {
      return this._scrollHeightOverride;
    }
    return this.children.length * 100 + (this._text ? 20 : 0); // crude layout
  }
  set scrollHeight(v) {
    this._scrollHeightOverride = v;
  }
  get firstChild() {
    return this.children.length > 0 ? this.children[0] : null;
  }
  get lastChild() {
    return this.children.length > 0 ? this.children[this.children.length - 1] : null;
  }
  get textContent() {
    return this._text + this.children.map((c) => c.textContent || "").join("");
  }
  set textContent(v) {
    this._text = v === undefined || v === null ? "" : String(v);
    for (const c of this.children) {
      c.parentElement = null;
    }
    this.children = [];
  }
  _detach(node) {
    const i = this.children.indexOf(node);
    if (i >= 0) {
      this.children.splice(i, 1);
    }
  }
  appendChild(node) {
    if (node && node.__isFragment) {
      for (const c of [...node.children]) {
        this.appendChild(c);
      }
      node.children = [];
      return node;
    }
    if (node.parentElement) {
      node.parentElement._detach(node);
    }
    node.parentElement = this;
    this.children.push(node);
    return node;
  }
  insertBefore(node, ref) {
    if (node && node.__isFragment) {
      for (const c of [...node.children]) {
        this.insertBefore(c, ref);
      }
      node.children = [];
      return node;
    }
    if (node.parentElement) {
      node.parentElement._detach(node);
    }
    node.parentElement = this;
    const idx = ref ? this.children.indexOf(ref) : -1;
    if (idx >= 0) {
      this.children.splice(idx, 0, node);
    } else {
      this.children.push(node);
    }
    return node;
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, []);
    }
    this.listeners.get(type).push(fn);
  }
  /** Invoke listeners of `type` with `event` (test-only helper). */
  fire(type, event = {}) {
    for (const fn of this.listeners.get(type) || []) {
      fn(event);
    }
  }
}

function walk(node, fn) {
  fn(node);
  for (const c of node.children) {
    walk(c, fn);
  }
}
function countClass(root, cls) {
  let n = 0;
  walk(root, (x) => {
    if (x.classList && x.classList.contains(cls)) {
      n += 1;
    }
  });
  return n;
}
function collectText(root) {
  let s = "";
  walk(root, (x) => {
    s += (x.textContent || "") + "\n";
  });
  return s;
}

const IDS = [
  "banner",
  "header",
  "title",
  "stream-label",
  "back-btn",
  "refresh-btn",
  "list-view",
  "session-list",
  "stream-view",
  "messages",
  "pending-strip",
  "new-msg-chip",
  "phone-alert"
];
const byId = new Map();
for (const id of IDS) {
  byId.set(id, new ShimNode("div"));
}
// Mirror the REAL document hierarchy from extension.ts getHtml(): the scroll
// container's height depends on its children (messages/pending-strip/chip),
// and renderList() appends into #session-list inside #list-view.
byId.get("list-view").appendChild(byId.get("session-list"));
byId.get("stream-view").appendChild(byId.get("messages"));
byId.get("stream-view").appendChild(byId.get("pending-strip"));
byId.get("stream-view").appendChild(byId.get("new-msg-chip"));

const documentShim = {
  getElementById: (id) => (byId.has(id) ? byId.get(id) : null),
  createElement: (tag) => new ShimNode(tag),
  createTextNode: (text) => {
    const n = new ShimNode("#text");
    n._text = text === undefined || text === null ? "" : String(text);
    return n;
  },
  createDocumentFragment: () => {
    const f = new ShimNode("#fragment");
    f.__isFragment = true;
    return f;
  }
};

// window shim: message listener registry + Pairlet* namespaces (set by modules)
const windowListeners = new Map();
const windowShim = {
  addEventListener(type, fn) {
    if (!windowListeners.has(type)) {
      windowListeners.set(type, []);
    }
    windowListeners.get(type).push(fn);
  },
  fire(type, event) {
    for (const fn of windowListeners.get(type) || []) {
      fn(event);
    }
  }
};

const posted = [];
const sandbox = {
  window: windowShim,
  document: documentShim,
  acquireVsCodeApi: () => ({
    postMessage: (m) => {
      posted.push(m);
    }
  })
};
vm.createContext(sandbox);

// Boot the REAL scripts in webview load order (same context object for every
// script — they share globals exactly like <script> tags share a window).
const mediaDir = path.join(import.meta.dirname, "..", "media");
let bootError = null;
try {
  for (const f of ["pathlinks.js", "paging.js", "grouping.js", "main.js"]) {
    vm.runInContext(fs.readFileSync(path.join(mediaDir, f), "utf8"), sandbox, { filename: f });
  }
} catch (e) {
  bootError = e;
}
check("boot: all four media scripts load without throwing", bootError === null, bootError && bootError.stack);
check("boot: main.js posted {type:'ready'}", posted.some((m) => m && m.type === "ready"), JSON.stringify(posted));
check("boot: modules attached namespaces", !!sandbox.window.PairletPaging && !!sandbox.window.PairletListGrouping && !!sandbox.window.PairletPathLinks);

// main.js top-level `const state` / `const el` live in the context's shared
// global lexical environment — reachable from later runInContext snippets.
const state = vm.runInContext("state", sandbox);
const el = vm.runInContext("el", sandbox);

function dispatch(msg) {
  let threw = null;
  try {
    windowShim.fire("message", { data: msg });
  } catch (e) {
    threw = e;
  }
  return threw;
}

// ---------- (a) sessions render: ONE row per project + aggregated badges ----------
const now = Date.now();
const sessions = [
  { filePath: "C:\\x\\alpha\\a1.jsonl", sessionId: "sess-aaaaaaaaaaaa", projectDir: "proj-alpha", projectLabel: "C:\\proj\\alpha", mtimeMs: now - 5000, size: 100, messageCount: 3, phone: false, active: false, recent: true, pending: false },
  { filePath: "C:\\x\\alpha\\a2.jsonl", sessionId: "sess-bbbbbbbbbbbb", projectDir: "proj-alpha", projectLabel: "C:\\proj\\alpha", mtimeMs: now - 1000, size: 100, messageCount: 7, phone: false, active: false, recent: true, pending: true },
  { filePath: "C:\\y\\beta\\b1.jsonl", sessionId: "sess-cccccccccccc", projectDir: "proj-beta", projectLabel: "C:\\proj\\beta", mtimeMs: now - 2000, size: 100, messageCount: 12, phone: true, active: false, recent: true, pending: false }
];
{
  const err = dispatch({ type: "sessions", sessions });
  check("sessions: message handler does not throw (M1)", err === null, err && err.stack);
  const list = byId.get("session-list");
  check("sessions: one row per project", countClass(list, "session-row") === 2, `rows=${countClass(list, "session-row")}`);
  check("sessions: no per-session group headers", countClass(list, "group-head") === 0, `heads=${countClass(list, "group-head")}`);
  const text = collectText(list);
  check("sessions: project basenames rendered", text.includes("alpha") && text.includes("beta"), text.slice(0, 200));
  check("sessions: session counts rendered", text.includes("2 个会话") && text.includes("1 个会话"), text.slice(0, 300));
  check("sessions: phone badge present", text.includes("📱"), text.slice(0, 300));
  check("sessions: pending badge present", text.includes("等待确认"));
}

// ---------- (a2) project row click -> openProject ----------
{
  const row = byId.get("session-list").children[0];
  posted.length = 0;
  let err = null;
  try {
    row.fire("click", {});
  } catch (e) {
    err = e;
  }
  check("project row: click does not throw", err === null, err && err.stack);
  const msg = posted.find((m) => m && m.type === "openProject");
  check("project row: posts openProject", !!msg, JSON.stringify(posted));
  check("project row: message carries projectDir", msg && msg.projectDir === "proj-alpha", msg && msg.projectDir);
  check("project row: focus is the newest session", msg && msg.focusSessionId === "sess-bbbbbbbbbbbb", msg && msg.focusSessionId);
  check("project row: state marks the open project", state.openProjectDir === "proj-alpha", state.openProjectDir);
  // Return to the list for the following stream/paging tests.
  byId.get("back-btn").fire("click", {});
  check("project row: back returns to the list", !byId.get("list-view").classList.contains("hidden"));
}

// ---------- (b) paging glue: start arity + loadOlder + done guard (M2) ----------
{
  const err = dispatch({
    type: "streamStart",
    filePath: "C:\\y\\beta\\b1.jsonl",
    sessionId: "sess-cccccccccccc",
    projectLabel: "C:\\proj\\beta",
    truncated: true,
    startOffset: 4096,
    items: [
      { kind: "user", text: "hi src/extension.ts:10" },
      { kind: "assistant", text: "hello" }
    ]
  });
  check("streamStart: handler does not throw", err === null, err && err.stack);
  check("streamStart: state.openFile set for host-initiated open", state.openFile === "C:\\y\\beta\\b1.jsonl", state.openFile);
  check("streamStart: paging.canLoad true for truncated+offset (M2 arity)", state.paging.canLoad === true, JSON.stringify(state.paging));
  check("streamStart: paging not done, not loading", state.paging.done === false && state.paging.loading === false, JSON.stringify(state.paging));
  check("streamStart: startOffset kept", state.paging.startOffset === 4096, JSON.stringify(state.paging));

  const streamView = byId.get("stream-view");
  streamView.clientHeight = 100; // make "not at bottom" reachable
  posted.length = 0;
  streamView.scrollTop = 0;
  streamView.fire("scroll");
  const loads1 = posted.filter((m) => m && m.type === "loadOlder");
  check("scroll-top: exactly ONE loadOlder posted", loads1.length === 1, JSON.stringify(posted));
  check("scroll-top: paging.loading true while in flight", state.paging.loading === true, JSON.stringify(state.paging));

  posted.length = 0;
  streamView.scrollTop = 0;
  streamView.fire("scroll");
  check("in-flight: no duplicate loadOlder while loading", posted.filter((m) => m && m.type === "loadOlder").length === 0, JSON.stringify(posted));

  const err2 = dispatch({ type: "olderChunk", items: [], newStartOffset: 0, done: true });
  check("olderChunk: done message handled without throw", err2 === null, err2 && err2.stack);
  check("olderChunk: done state applied", state.paging.done === true && state.paging.canLoad === false, JSON.stringify(state.paging));

  posted.length = 0;
  streamView.scrollTop = 0;
  streamView.fire("scroll");
  check("done guard: NO further loadOlder after done", posted.filter((m) => m && m.type === "loadOlder").length === 0, JSON.stringify(posted));
}

// ---------- (c) back button -> showList without throwing (M3) ----------
{
  const backBtn = byId.get("back-btn");
  posted.length = 0;
  let clickErr = null;
  try {
    backBtn.fire("click", {});
  } catch (e) {
    clickErr = e;
  }
  check("back: click handler does not throw (M3)", clickErr === null, clickErr && clickErr.stack);
  check("back: {type:'back'} posted", posted.some((m) => m && m.type === "back"), JSON.stringify(posted));
  check("back: list view visible, stream hidden", !byId.get("list-view").classList.contains("hidden") && byId.get("stream-view").classList.contains("hidden"));
  check("back: session list re-rendered", countClass(byId.get("session-list"), "session-row") === 2);
  check("back: stream label cleared", el.streamLabel.textContent === "", el.streamLabel.textContent);
  check("back: paging reset to initial", state.paging.canLoad === false && state.paging.done === true, JSON.stringify(state.paging));
}

// ---------- (c2) merged stream: provenance tags + no pagination ----------
{
  posted.length = 0;
  const err = dispatch({
    type: "streamStart",
    filePath: "C:\\x\\merged\\m2.jsonl",
    sessionId: "sess-m22222222222",
    projectDir: "proj-merged",
    projectLabel: "C:\\proj\\merged",
    merged: true,
    focusSessionId: "sess-m22222222222",
    sessions: [
      { sessionId: "sess-m11111111111", phone: true, filePath: "C:\\x\\merged\\m1.jsonl" },
      { sessionId: "sess-m22222222222", phone: false, filePath: "C:\\x\\merged\\m2.jsonl" }
    ],
    truncated: true,
    startOffset: 0,
    items: [
      { kind: "user", sessionId: "sess-m11111111111", text: "from phone src/extension.ts:1" },
      { kind: "assistant", sessionId: "sess-m11111111111", text: "reply" },
      { kind: "user", sessionId: "sess-m22222222222", text: "from vscode" }
    ]
  });
  check("merged stream: handler does not throw", err === null, err && err.stack);
  check("merged stream: state.merged set", state.merged === true);
  check("merged stream: state.openProjectDir set", state.openProjectDir === "proj-merged", state.openProjectDir);
  check("merged stream: pagination disabled", state.paging.canLoad === false && state.paging.done === true, JSON.stringify(state.paging));
  const msgs = byId.get("messages");
  const text = collectText(msgs);
  check("merged stream: phone provenance tag", text.includes("📱 sess-m11"), text.slice(0, 400));
  check("merged stream: desktop provenance tag", text.includes("sess-m22"), text.slice(0, 400));
  check("merged stream: branch colour slots applied", countClass(msgs, "msg-session-0") >= 1 && countClass(msgs, "msg-session-1") >= 1, `s0=${countClass(msgs, "msg-session-0")} s1=${countClass(msgs, "msg-session-1")}`);
  check("merged stream: merged truncation note", text.includes("合并视图"), text.slice(0, 400));
  check("merged stream: assistant reply rendered", text.includes("reply"));

  posted.length = 0;
  byId.get("stream-view").scrollTop = 0;
  byId.get("stream-view").fire("scroll");
  check("merged stream: scroll-top never requests older chunks", posted.filter((m) => m && m.type === "loadOlder").length === 0, JSON.stringify(posted));
}

// ---------- (d) pendingState strip ----------
{
  const err = dispatch({ type: "pendingState", pending: true, tools: ["Edit"] });
  check("pendingState: tools-array message does not throw", err === null, err && err.stack);
  const strip = byId.get("pending-strip");
  check("pendingState: strip unhidden", !strip.classList.contains("hidden"));
  const stripText = strip.textContent || "";
  check("pendingState: strip text shows waiting + tools", stripText.includes("等待确认") && stripText.includes("Edit"), stripText);

  // Host's real shape: pre-joined toolNames string.
  dispatch({ type: "pendingState", pending: true, toolNames: "Bash, Read" });
  check("pendingState: toolNames string shape still renders", (strip.textContent || "").includes("Bash, Read"), strip.textContent);

  // Not pending -> hidden again.
  dispatch({ type: "pendingState", pending: false, toolNames: "Bash, Read" });
  check("pendingState: pending=false hides strip", strip.classList.contains("hidden"));
}

// ---------- (e) new phone-session alert ----------
{
  const alert = byId.get("phone-alert");
  const err = dispatch({
    type: "phoneSessionAlert",
    reason: "new",
    filePath: "C:\\x\\gamma\\c1.jsonl",
    projectDir: "proj-gamma",
    sessionId: "sess-dddddddddddd",
    projectLabel: "C:\\proj\\gamma"
  });
  check("phoneSessionAlert: handler does not throw", err === null, err && err.stack);
  check("phoneSessionAlert: bar unhidden", !alert.classList.contains("hidden"));
  const text = alert.textContent || "";
  check("phoneSessionAlert: text names the new phone session", text.includes("新的手机会话") && text.includes("gamma") && text.includes("sess-ddd"), text);

  posted.length = 0;
  alert.fire("click", {});
  const openMsg = posted.find((m) => m && m.type === "openProject");
  check("phoneSessionAlert: click posts openProject", !!openMsg && openMsg.projectDir === "proj-gamma", JSON.stringify(posted));
  check("phoneSessionAlert: click focuses the phone session", openMsg && openMsg.focusSessionId === "sess-dddddddddddd", openMsg && openMsg.focusSessionId);
  check("phoneSessionAlert: click sets state.openProjectDir", state.openProjectDir === "proj-gamma", state.openProjectDir);
  check("phoneSessionAlert: click hides the bar", alert.classList.contains("hidden"));

  // Existing phone session that just received more output.
  dispatch({
    type: "phoneSessionAlert",
    reason: "activity",
    filePath: "C:\\x\\delta\\d1.jsonl",
    projectDir: "proj-delta",
    sessionId: "sess-eeeeeeeeeeee",
    projectLabel: "C:\\proj\\delta"
  });
  check("phoneSessionAlert: activity text distinguishes new output", (alert.textContent || "").includes("有新消息") && (alert.textContent || "").includes("delta"), alert.textContent);

  posted.length = 0;
  alert.fire("click", {});
  check("phoneSessionAlert: activity click opens the active project", posted.some((m) => m && m.type === "openProject" && m.projectDir === "proj-delta"), JSON.stringify(posted));
  check("phoneSessionAlert: activity click updates state.openProjectDir", state.openProjectDir === "proj-delta", state.openProjectDir);
  check("phoneSessionAlert: activity click hides the bar", alert.classList.contains("hidden"));

  // Activity in the project already on screen must not raise the bar again.
  dispatch({
    type: "phoneSessionAlert",
    reason: "activity",
    filePath: "C:\\x\\delta\\d2.jsonl",
    projectDir: "proj-delta",
    sessionId: "sess-ffffffffffff",
    projectLabel: "C:\\proj\\delta"
  });
  check("phoneSessionAlert: duplicate alert for the open project suppressed", alert.classList.contains("hidden"));
}

// ---------- extras: stream messages keep flowing without throws ----------
{
  const err = dispatch({
    type: "streamAppend",
    items: [
      { kind: "user", text: "see C:\\Users\\Lenovo\\Desktop\\job\\repos\\vscode-pairlet-live\\src\\extension.ts:42" },
      { kind: "tool", toolName: "Bash", brief: "ls" },
      { kind: "thinking", text: "hidden" }
    ]
  });
  check("streamAppend: handled without throw", err === null, err && err.stack);
  const msgs = byId.get("messages");
  check("streamAppend: fileLink span rendered", countClass(msgs, "fileLink") === 1, `links=${countClass(msgs, "fileLink")}`);
  check("streamAppend: exactly user+tool rendered (thinking skipped)", countClass(msgs, "msg") === 2, `msgs=${countClass(msgs, "msg")}`);
  check("streamAppend: thinking text never lands in DOM", !(collectText(msgs).includes("hidden")));
}

// ---------- (f) tool runs collapse into one group ----------
// A consecutive run of tool_use/tool_result rows must render as ONE <details>
// (collapsed by default). A run continuing across appends MERGES into the
// group at the bottom; a non-tool message ends the run; an older chunk groups
// its own tools separately, ABOVE the divider.
{
  const msgs = byId.get("messages");
  // Baseline from the extras block above: [user, group{1 Bash row}].
  check("toolrun: baseline one group after extras", countClass(msgs, "tool-group") === 1, `groups=${countClass(msgs, "tool-group")}`);

  const err = dispatch({
    type: "streamAppend",
    items: [
      { kind: "tool", toolName: "Read", brief: "path=x.ts" },
      { kind: "tool", toolName: "Edit", brief: "old=a" },
      { kind: "assistant", text: "done editing" },
      { kind: "tool", toolName: "Edit", brief: "old=b" }
    ]
  });
  check("toolrun: continued run + new run handled without throw", err === null, err && err.stack);
  check("toolrun: continued run merges into the bottom group (2 groups total)", countClass(msgs, "tool-group") === 2, `groups=${countClass(msgs, "tool-group")}`);
  check("toolrun: four tool rows rendered inside groups", countClass(msgs, "msg-tool") === 4, `rows=${countClass(msgs, "msg-tool")}`);

  const groups = msgs.children.filter((c) => c.classList.contains("tool-group"));
  const head1 = groups[0].firstChild.textContent || "";
  check("toolrun: merged head shows count + tool names", head1.includes("3 项") && head1.includes("Bash, Read, Edit"), head1);
  check("toolrun: groups collapsed by default", !groups[0].open && !groups[1].open, `open=${groups[0].open}/${groups[1].open}`);
  const head2 = groups[1].firstChild.textContent || "";
  check("toolrun: non-tool message ends the run", head2.includes("1 项") && head2.includes("Edit"), head2);
  check("toolrun: assistant text stays outside groups", collectText(msgs).includes("done editing"));

  // Older chunk: tools group on their own above the divider (never merge
  // across the divider into the content below). done:false keeps
  // showStartOfHistory() from prepending its own marker on top.
  const err2 = dispatch({
    type: "olderChunk",
    items: [
      { kind: "tool", toolName: "Bash", brief: "ls" },
      { kind: "tool", toolName: "Bash", brief: "pwd" },
      { kind: "user", text: "earlier" }
    ],
    newStartOffset: 1024,
    done: false
  });
  check("toolrun: olderChunk grouping handled without throw", err2 === null, err2 && err2.stack);
  check("toolrun: chunk tools collapsed into their own group", countClass(msgs, "tool-group") === 3, `groups=${countClass(msgs, "tool-group")}`);
  check("toolrun: chunk group sits above the divider", msgs.children[0].classList.contains("tool-group") && msgs.children[2].classList.contains("older-divider"),
    `c0=${msgs.children[0].className} c2=${msgs.children[2].className}`);
  check("toolrun: chunk head shows 2 items", (msgs.children[0].firstChild.textContent || "").includes("2 项"), msgs.children[0].firstChild.textContent);
}

// ---------- (g) tool groups never merge across sessions ----------
{
  dispatch({
    type: "streamStart",
    projectDir: "proj-tools",
    projectLabel: "C:\\proj\\tools",
    merged: true,
    sessions: [
      { sessionId: "sess-t11111111111", phone: false, filePath: "C:\\x\\tools\\t1.jsonl" },
      { sessionId: "sess-t22222222222", phone: true, filePath: "C:\\x\\tools\\t2.jsonl" }
    ],
    truncated: false,
    startOffset: 0,
    items: []
  });
  const err = dispatch({
    type: "streamAppend",
    items: [
      { kind: "tool", sessionId: "sess-t11111111111", toolName: "Read", brief: "a" },
      { kind: "tool", sessionId: "sess-t22222222222", toolName: "Bash", brief: "b" }
    ]
  });
  check("toolrun: cross-session append handled without throw", err === null, err && err.stack);
  const msgs = byId.get("messages");
  check("toolrun: one group per session", countClass(msgs, "tool-group") === 2, `groups=${countClass(msgs, "tool-group")}`);
  check("toolrun: both tool rows rendered", countClass(msgs, "msg-tool") === 2, `rows=${countClass(msgs, "msg-tool")}`);
}

if (failures > 0) {
  console.error(`check-webview-boot: ${failures} failure(s)`);
  process.exit(1);
}
console.log("OK: webview boot glue (sessions/paging/back/pendingState/toolruns) passes");
