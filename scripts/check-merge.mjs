// scripts/check-merge.mjs — merged-project stream (out/merge.js).
// Proves: shared history copied by --resume (same uuid) appears ONCE; branch-
// only entries survive; the merged timeline is chronological; one JSONL entry
// that yields several RenderItems keeps ALL its blocks; missing timestamps
// inherit their session's previous timestamp; the item cap keeps the newest
// entries and flags truncation; seenUuids covers every input.
import * as path from "path";
import { pathToFileURL } from "url";

const mergeMod = await import(pathToFileURL(path.join(import.meta.dirname, "..", "out", "merge.js")).href);
const { mergeSessionItems } = mergeMod;

let failures = 0;
function check(name, ok, detail) {
  if (ok) {
    console.log("PASS:", name);
  } else {
    failures += 1;
    console.error("FAIL:", name, detail ?? "");
  }
}

const ts = (min) => `2026-10-24T12:${String(min).padStart(2, "0")}:00.000Z`;
function item(uuid, min, text, extra) {
  return { kind: "user", uuid, timestamp: min === undefined ? undefined : ts(min), text, ...(extra || {}) };
}
function session(sessionId, birthtimeMs, items, extra) {
  return {
    sessionId,
    filePath: `/tmp/${sessionId}.jsonl`,
    phone: false,
    birthtimeMs,
    mtimeMs: birthtimeMs,
    truncated: false,
    items,
    ...(extra || {})
  };
}

// ---------- shared history dedup + branch-only tail ----------
{
  const base = session("base", 1000, [item("u1", 1, "hello"), item("u2", 2, "reply")]);
  const branch = session("branch", 2000, [
    item("u1", 1, "hello"),
    item("u2", 2, "reply"),
    item("u3", 3, "branch only")
  ], { phone: true });
  // Deliberately pass newest first: birthtime ordering must still make the
  // oldest session the survivor.
  const m = mergeSessionItems([branch, base]);
  check("merge: shared history appears once (3 items)", m.items.length === 3, JSON.stringify(m.items.map((i) => i.text)));
  check("merge: texts in order", JSON.stringify(m.items.map((i) => i.text)) === JSON.stringify(["hello", "reply", "branch only"]));
  check("merge: branch-only entry kept", m.items.some((i) => i.text === "branch only"));
  check("merge: survivor items tagged with base session", m.items[0].sessionId === "base" && m.items[1].sessionId === "base");
  check("merge: branch item tagged with branch session", m.items[2].sessionId === "branch");
  check("merge: seenUuids covers every input", m.seenUuids.size === 3 && m.seenUuids.has("u1") && m.seenUuids.has("u3"));
  check("merge: sessionCount", m.sessionCount === 2);
}

// ---------- one entry -> several blocks: ALL blocks survive ----------
{
  const base = session("base", 1000, [
    item("u1", 1, "first"),
    { kind: "thinking", uuid: "u2", timestamp: ts(2), text: "hmm" },
    { kind: "assistant", uuid: "u2", timestamp: ts(2), text: "answer" },
    { kind: "tool", uuid: "u2", timestamp: ts(2), toolName: "Read", brief: "x" }
  ]);
  const m = mergeSessionItems([base]);
  check("blocks: all three blocks of one uuid kept", m.items.length === 4, `n=${m.items.length}`);
  check("blocks: text block kept", m.items.some((i) => i.kind === "assistant" && i.text === "answer"));
  check("blocks: tool block kept", m.items.some((i) => i.kind === "tool" && i.toolName === "Read"));
}

// ---------- chronological interleave across sessions ----------
{
  const a = session("a", 1000, [item("a1", 1, "a1"), item("a2", 4, "a4")]);
  const b = session("b", 2000, [item("b1", 2, "b2"), item("b2", 3, "b3")]);
  const m = mergeSessionItems([a, b]);
  check(
    "merge: interleaved chronologically",
    JSON.stringify(m.items.map((i) => i.text)) === JSON.stringify(["a1", "b2", "b3", "a4"]),
    JSON.stringify(m.items.map((i) => i.text))
  );
}

// ---------- missing timestamp inherits the session's previous timestamp ----------
{
  const a = session("a", 1000, [
    item("a1", 10, "ten"),
    { kind: "assistant", uuid: "a2", text: "no timestamp" },
    item("a3", 20, "twenty")
  ]);
  const b = session("b", 2000, [item("b1", 15, "fifteen")]);
  const m = mergeSessionItems([a, b]);
  check(
    "merge: timestamp-less item inherits previous (stays between 10 and 20)",
    JSON.stringify(m.items.map((i) => i.text)) === JSON.stringify(["ten", "no timestamp", "fifteen", "twenty"]),
    JSON.stringify(m.items.map((i) => i.text))
  );
}

// ---------- cap keeps the newest entries and flags truncation ----------
{
  const a = session("a", 1000, [
    item("a1", 1, "one"),
    item("a2", 2, "two"),
    item("a3", 3, "three")
  ]);
  const m = mergeSessionItems([a], 2);
  check("cap: keeps last N", JSON.stringify(m.items.map((i) => i.text)) === JSON.stringify(["two", "three"]));
  check("cap: truncated flag", m.truncated === true);
  check("cap: seenUuids still covers dropped entries", m.seenUuids.has("a1"));
}

// ---------- truncated input propagates ----------
{
  const a = session("a", 1000, [item("a1", 1, "one")], { truncated: true });
  const m = mergeSessionItems([a]);
  check("truncated input -> truncated result", m.truncated === true);
}

// ---------- robustness ----------
{
  const m = mergeSessionItems([]);
  check("empty input -> empty stream", m.items.length === 0 && m.sessionCount === 0 && m.truncated === false);
  const m2 = mergeSessionItems(undefined);
  check("non-array input tolerated", m2.items.length === 0);
  const a = session("a", 1000, [item("x", 1, "x")]);
  const m3 = mergeSessionItems([a], 0);
  check("non-positive cap falls back to default (item kept)", m3.items.length === 1);
}

if (failures > 0) {
  console.error(`check-merge: ${failures} failure(s)`);
  process.exit(1);
}
console.log("OK: merged-project dedup/order/cap passes");
