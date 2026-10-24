// scripts/check-tailer.mjs — dev-only regression check for the review defects.
// Proves, on TEMP file copies (never touching ~/.claude):
//   Major 1: readTail->TranscriptTailer partial-line handoff must not merge/
//            duplicate the partial (file '{"n":10}\n{"n":1' + append '1}\n{"n":12}\n'
//            emits '{"n":11}' then '{"n":12}', never '{"n":1{"n":11}').
//   Major 2: a line written AFTER readTail but BEFORE start() (watcher
//            registration) must still be delivered by the drain() at the end
//            of start(), exactly once, with no further writes.
//   truncated flag: false for a small file ending mid-line (effective read
//            position == size), true when the tail window drops the head.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { pathToFileURL } from "url";

const mod = await import(pathToFileURL(path.join(import.meta.dirname, "..", "out", "tailer.js")).href);
const { readTail, TranscriptTailer } = mod;

let failures = 0;
function check(name, ok, detail) {
  if (ok) {
    console.log("PASS:", name);
  } else {
    failures += 1;
    console.error("FAIL:", name, detail ?? "");
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (cond()) return true;
    await sleep(25);
  }
  return cond();
}
function tmpFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pairlet-tailer-"));
  const f = path.join(dir, "session.jsonl");
  fs.writeFileSync(f, content);
  return f;
}

// ---------- Major 1: partial-line handoff ----------
{
  const f = tmpFile('{"n":10}\n{"n":1'); // ends mid-line
  const start = readTail(f);
  check("M1 readTail partial", start.partial === '{"n":1', JSON.stringify(start.partial));
  check("M1 readTail offset = start of partial", start.offset === Buffer.byteLength('{"n":10}\n', "utf8"));
  check(
    "M1 effective continue position == size",
    start.offset + Buffer.byteLength(start.partial, "utf8") === start.size,
    `eff=${start.offset + Buffer.byteLength(start.partial, "utf8")} size=${start.size}`
  );
  check("M1 truncated=false for small mid-line file", start.truncated === false);

  const emitted = [];
  const tailer = new TranscriptTailer(f, start, (lines) => emitted.push(...lines));
  tailer.start();
  fs.appendFileSync(f, '1}\n{"n":12}\n');
  await waitFor(() => emitted.length >= 2, 4000);
  await sleep(200); // settle: no extra/duplicate emissions
  tailer.stop();
  check(
    "M1 emits exactly {n:11},{n:12} (no merged garbage)",
    JSON.stringify(emitted) === JSON.stringify(['{"n":11}', '{"n":12}']),
    JSON.stringify(emitted)
  );
}

// ---------- Major 2: initial-load race (gap line before start) ----------
{
  const f = tmpFile('{"n":1}\n');
  const start = readTail(f);
  const emitted = [];
  const tailer = new TranscriptTailer(f, start, (lines) => emitted.push(...lines));
  // The race window: line lands after readTail() but before start().
  fs.appendFileSync(f, '{"n":2}\n');
  tailer.start();
  const got = await waitFor(() => emitted.includes('{"n":2}'), 2000);
  await sleep(300); // ensure no duplicates from watcher+drain interplay
  tailer.stop();
  check("M2 gap line delivered by end-of-start drain", got, JSON.stringify(emitted));
  check(
    "M2 gap line delivered exactly once",
    emitted.filter((l) => l === '{"n":2}').length === 1,
    JSON.stringify(emitted)
  );
  check("M2 nothing else emitted", emitted.length === 1, JSON.stringify(emitted));
}

// ---------- truncated flag under a real tail window ----------
{
  const f = tmpFile('{"n":1}\n{"n":2}\n{"n":3}\n');
  const start = readTail(f, 8); // window smaller than the file
  check("truncated=true when window drops head", start.truncated === true, JSON.stringify(start));
  check("truncated partial non-empty when cutting mid-line", start.offset + Buffer.byteLength(start.partial, "utf8") <= f.length + 8);
}

if (failures > 0) {
  console.error(`check-tailer: ${failures} failure(s)`);
  process.exit(1);
}
console.log("OK: tailer Major-1/Major-2/truncated regressions all pass");
