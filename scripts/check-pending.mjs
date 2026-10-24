// scripts/check-pending.mjs — dev-only checks for TRACK 3 (⏸ waiting-for-
// confirmation). Temp-dir files only (never touches ~/.claude or ~/.cc-pocket).
// Proves: unresolved tool_use + idle >= 20s + newest item is unresolved
// tool_use => pending; resolved/mid-stream/active cases => not pending;
// tail-based detection tolerates partial edge lines and missing files;
// transition/re-arm tracker semantics; notifyWaiting gating helper.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { pathToFileURL } from "url";

const pendMod = await import(pathToFileURL(path.join(import.meta.dirname, "..", "out", "pending.js")).href);
const trMod = await import(pathToFileURL(path.join(import.meta.dirname, "..", "out", "transcript.js")).href);
const { computePending, readPendingFromTail, PendingAlertTracker, capToolNames, gateNotifications, PENDING_IDLE_MS } = pendMod;
const { parseLines } = trMod;

let failures = 0;
function check(name, ok, detail) {
  if (ok) {
    console.log("PASS:", name);
  } else {
    failures += 1;
    console.error("FAIL:", name, detail ?? "");
  }
}
function tmpJsonl(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pairlet-pending-"));
  const f = path.join(dir, "session.jsonl");
  fs.writeFileSync(f, lines.join("\n") + "\n");
  return f;
}
const use = (id, name = "Bash") => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input: { command: "ls" } }] } });
const result = (id) => JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });
const text = (t) => JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: t }] } });

// ---------- computePending core cases ----------
{
  const idle = PENDING_IDLE_MS + 1000;
  // Unresolved tool_use, idle, newest is the tool_use -> pending.
  let s = computePending(parseLines([use("u1"), text("working"), use("u2", "Read")]), idle);
  check("unresolved+idle+newest-use -> pending", s.pending === true, JSON.stringify(s));
  check("unresolvedCount counts all unresolved", s.unresolvedCount === 2, JSON.stringify(s));
  check("toolNames captured", JSON.stringify(s.toolNames) === JSON.stringify(["Bash", "Read"]), JSON.stringify(s.toolNames));

  // Matching result arrives -> not pending (re-armed).
  s = computePending(parseLines([use("u1"), result("u1")]), idle);
  check("resolved use -> not pending", s.pending === false && s.unresolvedCount === 0, JSON.stringify(s));

  // Newest is assistant text (mid-stream) -> not pending even if a use is stuck.
  s = computePending(parseLines([use("u1"), text("still working")]), idle);
  check("mid-stream text -> not pending", s.pending === false, JSON.stringify(s));

  // Newest is a tool RESULT -> not pending.
  s = computePending(parseLines([use("u1"), use("u2"), result("u1")]), idle);
  check("newest is result -> not pending", s.pending === false && s.unresolvedCount === 1, JSON.stringify(s));

  // Active file (idle < 20s) -> never pending.
  s = computePending(parseLines([use("u1")]), PENDING_IDLE_MS - 1);
  check("active file -> not pending", s.pending === false, JSON.stringify(s));
  s = computePending(parseLines([use("u1")]), 0);
  check("just-written file -> not pending", s.pending === false);

  // Tool use without id: unmatchable -> unresolved; still needs idle+newest.
  s = computePending(parseLines([JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: {} }] } })]), idle);
  check("id-less use treated unresolved + pending", s.pending === true && s.unresolvedCount === 1, JSON.stringify(s));

  // Empty stream -> not pending, no throw.
  s = computePending([], idle);
  check("empty stream -> not pending", s.pending === false);
  s = computePending(undefined, idle);
  check("undefined items tolerated", s.pending === false);

  // Result for a LATER use resolving an EARLIER id, plus a stuck newer use.
  s = computePending(parseLines([use("u1"), use("u2"), result("u1")]), idle);
  check("partial resolution keeps stuck use pending-eligible", s.unresolvedCount === 1 && s.pending === false, JSON.stringify(s));
}

// ---------- tail-based detection (file + mtime) ----------
{
  const idle = PENDING_IDLE_MS + 5000;
  const now = Date.now();
  const f = tmpJsonl([text("hello"), use("t1"), result("t1"), use("t2", "Grep")]);
  // Fresh mtime -> not pending regardless of content.
  let s = readPendingFromTail(f, now, now);
  check("tail: fresh mtime -> not pending", s.pending === false);
  // Simulate idle by passing an old mtime.
  s = readPendingFromTail(f, now - idle, now);
  check("tail: idle + stuck use -> pending", s.pending === true && s.toolNames.includes("Grep"), JSON.stringify(s));

  // Partial garbage line at the tail window head tolerated.
  const dir = path.dirname(f);
  const f2 = path.join(dir, "partial.jsonl");
  fs.writeFileSync(f2, 'PARTIAL-GARBAGE-NOT-JSON\n' + text("hi") + "\n" + use("t3") + "\n");
  s = readPendingFromTail(f2, now - idle, now);
  check("tail: partial head line tolerated", s.pending === true, JSON.stringify(s));

  // Trailing partial line (incomplete JSON at EOF) tolerated -> last COMPLETE
  // item is the tool_use; still pending, never throws.
  const f3 = path.join(dir, "trailing-partial.jsonl");
  fs.writeFileSync(f3, use("t4") + "\n" + '{"type":"assistant","mess');
  s = readPendingFromTail(f3, now - idle, now);
  check("tail: trailing partial tolerated, no throw", s.pending === true, JSON.stringify(s));

  // Fully unparsable file -> not pending.
  const f4 = path.join(dir, "garbage.jsonl");
  fs.writeFileSync(f4, "not json at all\nneither is this\n");
  s = readPendingFromTail(f4, now - idle, now);
  check("tail: unparsable -> not pending", s.pending === false, JSON.stringify(s));

  // Missing file -> not pending, no throw.
  let threw = false;
  try {
    s = readPendingFromTail(path.join(dir, "no-such.jsonl"), now - idle, now);
  } catch {
    threw = true;
  }
  check("tail: missing file -> not pending, no throw", !threw && s.pending === false);

  // Resolved use at tail -> not pending.
  const f5 = path.join(dir, "resolved.jsonl");
  fs.writeFileSync(f5, use("t5") + "\n" + result("t5") + "\n");
  s = readPendingFromTail(f5, now - idle, now);
  check("tail: resolved at tail -> not pending", s.pending === false, JSON.stringify(s));
}

// ---------- transition / re-arm tracker ----------
{
  const t = new PendingAlertTracker();
  // Present ids derived from a plain {id: pending} description object; the
  // pending flags are handed to update() as a real Map.
  const ids = (desc) => new Set(Object.keys(desc));
  const pm = (desc) => new Map(Object.entries(desc));
  // idle -> pending: one transition.
  let tr = t.update(ids({ s1: true }), pm({ s1: true }));
  check("tracker: first pending transitions", JSON.stringify(tr) === JSON.stringify(["s1"]), JSON.stringify(tr));
  // Still pending: never repeats.
  tr = t.update(ids({ s1: true }), pm({ s1: true }));
  check("tracker: no repeat while still pending", tr.length === 0, JSON.stringify(tr));
  tr = t.update(ids({ s1: true }), pm({ s1: true }));
  check("tracker: still no repeat", tr.length === 0);
  // Result arrives -> pending clears (re-arm). No transition on clear.
  tr = t.update(ids({ s1: true }), pm({ s1: false }));
  check("tracker: clear produces no transition", tr.length === 0 && t.isPending("s1") === false);
  // Stuck again -> transitions again (re-armed).
  tr = t.update(ids({ s1: true }), pm({ s1: true }));
  check("tracker: re-armed after clear", JSON.stringify(tr) === JSON.stringify(["s1"]), JSON.stringify(tr));
  // Disappears from the list while pending -> state dropped (re-arm).
  tr = t.update(ids({}), pm({}));
  check("tracker: disappearance clears state", tr.length === 0 && t.isPending("s1") === false);
  // Reappears still pending -> notifies again (spec: re-arm on disappearance).
  tr = t.update(ids({ s1: true }), pm({ s1: true }));
  check("tracker: reappearance pending -> transition again", JSON.stringify(tr) === JSON.stringify(["s1"]), JSON.stringify(tr));
  // Multiple sessions, mixed states.
  tr = t.update(ids({ s1: true, s2: true, s3: true }), pm({ s1: true, s2: false, s3: true }));
  check("tracker: only idle->pending ids returned", JSON.stringify(tr) === JSON.stringify(["s3"]), JSON.stringify(tr));
  t.clear();
  check("tracker: clear() empties", t.isPending("s1") === false);
}

// ---------- notifyWaiting gating + name capping ----------
{
  check("gate: enabled passes ids", JSON.stringify(gateNotifications(true, ["a", "b"])) === JSON.stringify(["a", "b"]));
  check("gate: disabled drops all", gateNotifications(false, ["a", "b"]).length === 0);
  check("gate: empty list", gateNotifications(true, []).length === 0);
  check("cap: unique names", capToolNames(["Bash", "Read", "Bash"]) === "Bash, Read");
  check("cap: capped with marker", capToolNames(["A", "B", "C", "D", "E"]) === "A, B, C 等", capToolNames(["A", "B", "C", "D", "E"]));
  check("cap: empty", capToolNames([]) === "");
  check("cap: tolerates undefined", capToolNames(undefined) === "");
  check("cap: custom cap", capToolNames(["A", "B"], 1) === "A 等");
}

if (failures > 0) {
  console.error(`check-pending: ${failures} failure(s)`);
  process.exit(1);
}
console.log("OK: pending detection + transition/re-arm + notify gating pass");
