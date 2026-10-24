// scripts/check-transcript.mjs — dev-only self-check.
// Runs the compiled transcript parser over a REAL ~/.claude/projects jsonl
// and prints parsed message counts + shape summary (NO transcript content).
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { pathToFileURL } from "url";

const root = path.join(os.homedir(), ".claude", "projects");
const projectDirs = fs
  .readdirSync(root, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => path.join(root, d.name));

let best = null;
for (const dir of projectDirs) {
  let files = [];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => path.join(dir, f))
      .map((f) => ({ f, st: fs.statSync(f) }))
      .filter((x) => x.st.isFile());
  } catch {
    continue;
  }
  for (const x of files) {
    if (!best || x.st.mtimeMs > best.st.mtimeMs) {
      best = x;
    }
  }
}

if (!best) {
  console.error("No jsonl found under", root);
  process.exit(1);
}

const mod = await import(pathToFileURL(path.join(import.meta.dirname, "..", "out", "transcript.js")).href);
const { parseLine, statsFromLines } = mod;

const text = fs.readFileSync(best.f, "utf8");
const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");

const stats = statsFromLines(lines);
const byKind = { user: 0, assistant: 0, tool: 0, thinking: 0, system: 0, unknown: 0 };
let toolUses = 0;
let toolResults = 0;
for (const line of lines) {
  let items;
  try {
    items = parseLine(line);
  } catch (e) {
    console.error("parseLine threw:", e.message);
    process.exit(1);
  }
  for (const it of items) {
    byKind[it.kind] = (byKind[it.kind] || 0) + 1;
    if (it.kind === "tool") {
      if (it.isResult) toolResults++;
      else toolUses++;
    }
  }
}

console.log("file:", path.join(path.basename(path.dirname(best.f)), path.basename(best.f)));
console.log("sizeBytes:", best.st.size);
console.log("totalLines:", lines.length);
console.log("visibleMessages(stats):", stats.messages);
console.log("kindCounts:", JSON.stringify(byKind));
console.log("toolUses:", toolUses, "toolResults:", toolResults);
console.log("hasCwd:", Boolean(stats.cwd), "hasSessionId:", Boolean(stats.sessionId));
console.log("OK: parser ran on real data without errors");
