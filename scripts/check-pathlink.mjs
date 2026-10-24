// scripts/check-pathlink.mjs — dev-only check for the clickable-path regex in
// media/pathlinks.js (the single source of truth; loaded here in a Node vm
// sandbox with a fake window). Runs synthetic precision/recall cases, then a
// COUNTS-ONLY scan over the most recent real ~/.claude/projects transcript
// (no transcript content is printed).
import * as fs from "fs";
import * as os from "os";
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

// ---------- load media/pathlinks.js in a sandbox ----------
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(import.meta.dirname, "..", "media", "pathlinks.js"), "utf8"), sandbox);
const { splitFilePaths } = sandbox.window.PairletPathLinks || {};
check("pathlinks.js exposes splitFilePaths", typeof splitFilePaths === "function");

function pathsIn(text) {
  return splitFilePaths(text).filter((p) => p.path).map((p) => ({ path: p.path, line: p.line }));
}
function rejoined(text) {
  return splitFilePaths(text)
    .map((p) => p.text)
    .join("");
}

// ---------- synthetic cases ----------
{
  const cases = [
    // [text, expected path or null, expected line or undefined]
    ["see src/extension.ts:42 for details", "src/extension.ts", 42],
    ["打开 C:\\Users\\Lenovo\\Desktop\\job\\repos\\vscode-pairlet-live\\src\\extension.ts:42 看看",
      "C:\\Users\\Lenovo\\Desktop\\job\\repos\\vscode-pairlet-live\\src\\extension.ts", 42],
    ["配置在 ./media/main.js 里", "./media/main.js", undefined],
    ["上一级 ../shared/util.ts:10:5", "../shared/util.ts", 10],
    ["绝对路径 /tmp/demo/file.md", "/tmp/demo/file.md", undefined],
    ["无行号 node_modules/foo/index.js", "node_modules/foo/index.js", undefined],
    ["中文包围 src/tailer.ts 结束", "src/tailer.ts", undefined],
    ["diff 路径 --- a/src/a.ts", "a/src/a.ts", undefined],
    // negatives — must NOT produce a path
    ["https://github.com/user/repo/blob/main/README.md", null, undefined],
    ["访问 http://example.com/a.ts 试试", null, undefined],
    ["版本 v1.2.3 发布", null, undefined],
    ["日期 2026-10-22 完成", null, undefined],
    ["时间 12:34 开始", null, undefined],
    ["裸文件名 package.json 无目录", null, undefined],
    ["纯文本没有路径", null, undefined]
  ];
  for (const [text, wantPath, wantLine] of cases) {
    const hits = pathsIn(text);
    if (wantPath === null) {
      check(`no-FP: ${JSON.stringify(text).slice(0, 48)}`, hits.length === 0, JSON.stringify(hits));
    } else {
      const hit = hits[0];
      check(
        `match: ${JSON.stringify(text).slice(0, 48)}`,
        hit && hit.path === wantPath && (wantLine === undefined || hit.line === wantLine),
        JSON.stringify(hits)
      );
    }
    check(`roundtrip: ${JSON.stringify(text).slice(0, 40)}`, rejoined(text) === text);
  }
}

// ---------- real transcript scan (counts only, no content) ----------
{
  const root = path.join(os.homedir(), ".claude", "projects");
  let best = null;
  try {
    for (const d of fs.readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const dir = path.join(root, d.name);
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith(".jsonl")) continue;
        const fp = path.join(dir, f);
        const st = fs.statSync(fp);
        if (st.isFile() && (!best || st.mtimeMs > best.st.mtimeMs)) best = { fp, st };
      }
    }
  } catch {
    /* no store — synthetic cases still ran */
  }
  if (best) {
    const text = fs.readFileSync(best.fp, "utf8");
    const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
    let totalMatches = 0;
    let linesWithMatches = 0;
    let absoluteExisting = 0;
    let absoluteTotal = 0;
    for (const line of lines) {
      let hits = [];
      try {
        hits = pathsIn(line);
      } catch (e) {
        check("splitFilePaths never throws on real data", false, e.message);
        break;
      }
      if (hits.length > 0) linesWithMatches += 1;
      totalMatches += hits.length;
      for (const h of hits) {
        if (/^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(h.path)) {
          absoluteTotal += 1;
          try {
            if (fs.existsSync(h.path)) absoluteExisting += 1;
          } catch {
            /* invalid path chars — ignore */
          }
        }
      }
    }
    console.log(
      "real-transcript scan (counts only):",
      JSON.stringify({
        lines: lines.length,
        linesWithMatches,
        totalMatches,
        absoluteTotal,
        absoluteExisting
      })
    );
    check("real scan completed without throw", true);
  } else {
    console.log("real scan: no transcript found (synthetic cases still pass)");
  }
}

if (failures > 0) {
  console.error(`check-pathlink: ${failures} failure(s)`);
  process.exit(1);
}
console.log("OK: pathlink regex passes synthetic + real-data checks");
