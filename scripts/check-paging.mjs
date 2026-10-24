// scripts/check-paging.mjs — dev-only checks for TRACK 1 (scroll-up history).
// Temp-dir files only (never touches ~/.claude). Proves:
//   Chunk math: readOlderChunk covers [end-offset-CHUNK, end-offset) and a
//   record straddling the newer boundary is completed by FORWARD EXTENSION
//   regardless of size (no fixed-overlap assumption: 1KB / 300KB / 900KB /
//   1.3MB boundary-crossing records at multiple alignments must ALL survive —
//   zero loss, no double-emit), drops a record straddling its own start
//   (covered by the next older chunk), reports done at offset 0, tolerates a
//   rotated/stale endOffset.
//   State machine: media/paging.js refuses a second request while one is in
//   flight and once done (no double-load).
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { pathToFileURL } from "url";
import * as vm from "vm";

const mod = await import(pathToFileURL(path.join(import.meta.dirname, "..", "out", "tailer.js")).href);
const { readTail, readOlderChunk } = mod;

let failures = 0;
function check(name, ok, detail) {
  if (ok) {
    console.log("PASS:", name);
  } else {
    failures += 1;
    console.error("FAIL:", name, detail ?? "");
  }
}
function tmpFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pairlet-paging-"));
  const f = path.join(dir, "session.jsonl");
  fs.writeFileSync(f, content);
  return f;
}
/** Offsets where each line starts, plus full line texts (for expectations). */
function lineIndex(content) {
  const starts = [];
  const lines = [];
  let pos = 0;
  for (const part of content.split("\n")) {
    if (part === "") break;
    starts.push(pos);
    lines.push(part);
    pos += Buffer.byteLength(part, "utf8") + 1;
  }
  return { starts, lines };
}
/** JSON record of EXACT byte length (excluding the trailing newline). */
function mkRec(tag, byteLen) {
  const prefix = `{"n":"${tag}","pad":"`;
  const suffix = '"}';
  const pad = byteLen - Buffer.byteLength(prefix + suffix, "utf8");
  if (pad < 0) throw new Error(`mkRec: byteLen ${byteLen} too small for tag ${tag}`);
  return prefix + "x".repeat(pad) + suffix;
}

// ---------- chunk math: large boundary-crossing records, ZERO loss ----------
// M4 regression: the old fixed 256KB overlap silently dropped any record whose
// body extended >256KB past its chunk boundary (always for records >768KB).
// Real transcripts here contain lines up to 1.3MB -> visible gaps. The sweep
// must deliver EVERY record intact at multiple alignments.
{
  const CH = 512 * 1024;
  // Fillers of coprime-ish lengths shift each big record to a different
  // offset modulo the chunk size (multiple alignments without hand-tuning).
  const fillerLens = [19, 37, 101, 999, 65536, 12345];
  const bigSpecs = [
    [1000, "1KB"], // crosses a boundary when misaligned by <1KB
    [300 * 1024, "300KB"], // extends up to 300KB past its boundary
    [900 * 1024, "900KB"], // > chunk: always crosses; overshoot > old overlap
    [1300 * 1024, "1.3MB"] // overshoot up to ~800KB past the far boundary
  ];
  const records = [];
  let fi = 0;
  for (const [len, tag] of bigSpecs) {
    records.push(mkRec(tag, len));
    records.push(mkRec(`f${fi}`, fillerLens[fi % fillerLens.length]));
    fi += 1;
  }
  // Tail region: small records + one 400KB record so the initial tail window
  // itself often cuts through a big record.
  records.push(mkRec("tailbig", 400 * 1024));
  for (let i = 0; i < 20; i++) {
    records.push(mkRec(`t${i}`, 20 + ((i * 37) % 200)));
  }
  const content = records.join("\n") + "\n";
  const f = tmpFile(content);
  const { starts, lines: allLines } = lineIndex(content);

  const tail = readTail(f, CH);
  check("sweep: initial window truncated", tail.truncated === true);
  check("sweep: windowStart recorded", tail.windowStart === Math.max(0, Buffer.byteLength(content, "utf8") - CH), `ws=${tail.windowStart}`);

  const collected = [...tail.lines];
  let offset = tail.windowStart;
  let guard = 0;
  let done = false;
  while (!done && guard++ < 500) {
    const chunk = readOlderChunk(f, offset, CH);
    collected.unshift(...chunk.lines);
    offset = chunk.newStartOffset;
    done = chunk.done;
  }
  check("sweep: terminates done at offset 0", done && offset === 0, JSON.stringify({ done, offset }));
  const missing = allLines.filter((l) => !collected.includes(l));
  check("sweep: ZERO loss — every record delivered at every alignment", missing.length === 0, JSON.stringify({ missingCount: missing.length, samples: missing.map((l) => l.slice(0, 24)) }));
  check("sweep: no line emitted twice", new Set(collected).size === collected.length, `got=${collected.length} unique=${new Set(collected).size}`);
  check(
    "sweep: collected order preserved (older first)",
    collected.every((l, i) => i === 0 || allLines.indexOf(collected[i - 1]) < allLines.indexOf(l)),
    "order broken"
  );
  // Every big record survived INTACT (full JSON, full pad length).
  for (const [len, tag] of bigSpecs.concat([[400 * 1024, "tailbig"]])) {
    const hits = collected.filter((l) => l.startsWith(`{"n":"${tag}","pad":"`));
    const expectedPad = len - Buffer.byteLength(`{"n":"${tag}","pad":"`, "utf8") - 2;
    let intact = hits.length === 1;
    if (intact) {
      try {
        intact = JSON.parse(hits[0]).pad.length === expectedPad;
      } catch {
        intact = false;
      }
    }
    check(`sweep: ${tag} record intact exactly once`, intact, `hits=${hits.length}`);
  }
}

// ---------- M4: single-chunk call, boundary cuts a 1.3MB record 10 bytes in ----------
{
  const CH = 512 * 1024;
  const filler = [];
  for (let i = 0; i < 80; i++) {
    filler.push(`{"n":"p${i}"}`);
  }
  const big = mkRec("big", 1300 * 1024);
  const after = ['{"n":"after1"}', '{"n":"after2"}'];
  const content = filler.join("\n") + "\n" + big + "\n" + after.join("\n") + "\n";
  const f = tmpFile(content);
  const { starts, lines: allLines } = lineIndex(content);
  const bigIdx = allLines.findIndex((l) => l.startsWith('{"n":"big"'));
  const bigStart = starts[bigIdx];
  const bigNewline = bigStart + Buffer.byteLength(big, "utf8"); // \n position
  const endOffset = bigStart + 10; // boundary cuts the big record 10 bytes in
  const overshoot = bigNewline - endOffset;
  check("m4: overshoot past boundary exceeds old 256KB overlap", overshoot > 256 * 1024, `overshoot=${overshoot}`);
  const chunk = readOlderChunk(f, endOffset, CH);
  const bigHits = chunk.lines.filter((l) => l.startsWith('{"n":"big"'));
  check("m4: straddling 1.3MB record delivered exactly once", bigHits.length === 1, `hits=${bigHits.length}`);
  let intact = false;
  try {
    intact = bigHits.length === 1 && JSON.parse(bigHits[0]).pad.length === JSON.parse(big).pad.length;
  } catch {
    intact = false;
  }
  check("m4: record complete (not clipped)", intact);
  check("m4: newer-side records (start >= boundary) excluded", !chunk.lines.some((l) => l.startsWith('{"n":"after')), JSON.stringify(chunk.lines.map((l) => l.slice(0, 20))));
  // Everything starting in [start, endOffset) is present, in order.
  const start = Math.max(0, endOffset - CH);
  const expected = allLines.filter((l, i) => starts[i] >= start && starts[i] < endOffset);
  check(
    "m4: full [start, boundary) window delivered in order",
    JSON.stringify(chunk.lines) === JSON.stringify(expected),
    JSON.stringify({ got: chunk.lines.length, expected: expected.length })
  );
}

// ---------- M4: record starting EXACTLY at the chunk boundary, huge ----------
{
  const CH = 512 * 1024;
  const filler = [];
  for (let i = 0; i < 80; i++) {
    filler.push(`{"n":"q${i}"}`);
  }
  const big = mkRec("edgebig", 1300 * 1024);
  const content = filler.join("\n") + "\n" + big + "\n" + '{"n":"last"}\n';
  const f = tmpFile(content);
  const { starts, lines: allLines } = lineIndex(content);
  const bigStart = starts[allLines.findIndex((l) => l.startsWith('{"n":"edgebig"'))];
  // endOffset chosen so that endOffset - CH === bigStart exactly: the huge
  // record starts ON the chunk boundary (byte before is '\n' -> aligned) and
  // extends ~800KB past endOffset — this chunk must still deliver it whole.
  const endOffset = bigStart + CH;
  const chunk = readOlderChunk(f, endOffset, CH);
  check("m4-aligned: chunk start lands exactly on record start", chunk.newStartOffset === bigStart, `ns=${chunk.newStartOffset} bigStart=${bigStart}`);
  const bigHits = chunk.lines.filter((l) => l.startsWith('{"n":"edgebig"'));
  let intact = false;
  try {
    intact = bigHits.length === 1 && JSON.parse(bigHits[0]).pad.length === JSON.parse(big).pad.length;
  } catch {
    intact = false;
  }
  check("m4-aligned: boundary-started 1.3MB record delivered intact", intact, `hits=${bigHits.length}`);
  check("m4-aligned: no records past the boundary", !chunk.lines.some((l) => l.startsWith('{"n":"last"}')), JSON.stringify(chunk.lines.map((l) => l.slice(0, 20))));
}

// ---------- straddling record at the newer boundary: completed once ----------
{
  const a = '{"n":1}\n{"n":2}\n';
  const b = '{"n":3,"pad":"' + "y".repeat(50) + '"}\n{"n":4}\n';
  const content = a + b;
  const f = tmpFile(content);
  const endOffset = Buffer.byteLength(a, "utf8") + 5; // mid-record-3
  const chunk = readOlderChunk(f, endOffset, 1024);
  const n3 = chunk.lines.filter((l) => l.includes('"n":3'));
  const n4 = chunk.lines.filter((l) => l.includes('"n":4'));
  check("straddle-newer: record completed via forward extension", n3.length === 1, JSON.stringify(chunk.lines));
  check("straddle-newer: fully parsed JSON (not clipped)", n3.length === 1 && JSON.parse(n3[0]).n === 3);
  check("straddle-newer: records at/after endOffset excluded", n4.length === 0, JSON.stringify(chunk.lines));
}

// ---------- record straddling THIS chunk's start: dropped here ----------
{
  const recA = '{"n":1,"pad":"' + "z".repeat(40) + '"}';
  const content = recA + '\n{"n":2}\n{"n":3}\n';
  const f = tmpFile(content);
  const startApprox = 10; // chunk start lands mid-record-1
  // chunkBytes chosen so endOffset - chunkBytes === startApprox.
  const chunk2 = readOlderChunk(f, content.length, content.length - startApprox);
  check("straddle-start: first (partial) segment dropped", !chunk2.lines.some((l) => l.startsWith('{"n":1,"pa')), JSON.stringify(chunk2.lines));
  check("straddle-start: later records kept", chunk2.lines.some((l) => l.includes('"n":2')) && chunk2.lines.some((l) => l.includes('"n":3')), JSON.stringify(chunk2.lines));
}

// ---------- exact boundary alignment: one record dropped, never doubled ----------
{
  const content = '{"n":1}\n{"n":2}\n{"n":3}\n';
  const f = tmpFile(content);
  const { starts } = lineIndex(content);
  const endOffset = starts[2]; // exactly where record 3 begins
  const chunk = readOlderChunk(f, endOffset, 1024 * 1024); // whole prefix
  check("aligned: records before boundary present", chunk.lines.includes('{"n":1}') && chunk.lines.includes('{"n":2}'), JSON.stringify(chunk.lines));
  check("aligned: record AT boundary excluded (belongs to newer chunk)", !chunk.lines.includes('{"n":3}'), JSON.stringify(chunk.lines));
}

// ---------- edge cases ----------
{
  const f = tmpFile('{"n":1}\n{"n":2}\n');
  const zero = readOlderChunk(f, 0);
  check("edge: endOffset 0 -> done, empty", zero.done === true && zero.lines.length === 0 && zero.newStartOffset === 0);
  const stale = readOlderChunk(f, 10 * 1024 * 1024); // beyond EOF (rotated file)
  check("edge: stale endOffset beyond EOF -> done, no throw", stale.done === true && stale.lines.length === 0);
  const neg = readOlderChunk(f, -5);
  check("edge: negative endOffset -> done, no throw", neg.done === true);
}

// ---------- state machine (media/paging.js in a Node vm) ----------
{
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(import.meta.dirname, "..", "media", "paging.js"), "utf8"), sandbox);
  const P = sandbox.window.PairletPaging;
  check("paging.js exposes PairletPaging", !!P && typeof P.requestOlder === "function");

  // Non-truncated session: never loads.
  let st = P.start(P.initialState(), false, 0);
  check("machine: non-truncated -> done, no load", st.done === true && st.canLoad === false);
  check("machine: non-truncated refuses request", P.requestOlder(st)[1] === false);

  // Truncated with remaining history.
  st = P.start(P.initialState(), true, 4096);
  check("machine: truncated -> canLoad, not done", st.canLoad === true && st.done === false && st.startOffset === 4096);

  // At top: first request fires; second while in flight does NOT (no double-load).
  let r = P.requestOlder(st);
  check("machine: first top-reach requests", r[1] === true && r[0].loading === true);
  st = r[0];
  r = P.requestOlder(st);
  check("machine: in-flight request refused (no double-load)", r[1] === false, JSON.stringify(r[0]));

  // Chunk arrives, more history remains.
  st = P.receiveOlder(st, { newStartOffset: 2048, done: false });
  check("machine: chunk applied, loading cleared", st.loading === false && st.canLoad === true && st.startOffset === 2048);
  r = P.requestOlder(st);
  check("machine: second chunk request allowed", r[1] === true);
  st = r[0];

  // Final chunk (offset 0 -> done): all further requests refused.
  st = P.receiveOlder(st, { newStartOffset: 0, done: true });
  check("machine: done at offset 0", st.done === true && st.canLoad === false);
  check("machine: done refuses further requests", P.requestOlder(st)[1] === false);
  check("machine: done refuses even after another scroll event", P.requestOlder(st)[1] === false);

  // Host-reported done with nonzero offset still stops.
  st = P.receiveOlder(P.start(P.initialState(), true, 100), { newStartOffset: 50, done: true });
  check("machine: host done flag wins", st.done === true && P.requestOlder(st)[1] === false);

  // Malformed message -> treated as done, never throws.
  st = P.receiveOlder(P.start(P.initialState(), true, 100), undefined);
  check("machine: malformed olderChunk -> done, no throw", st.done === true);
}

if (failures > 0) {
  console.error(`check-paging: ${failures} failure(s)`);
  process.exit(1);
}
console.log("OK: pagination chunk math + no-double-load state machine pass");
