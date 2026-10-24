// scripts/check-grouping.mjs — dev-only checks for TRACK 2 (project-grouped
// session list). Loads media/grouping.js in a Node vm sandbox (fake window).
// Proves: groups ordered by most-recent-session activity desc; sessions inside
// each group sorted by recency desc; basename extraction for Windows/POSIX
// paths; hostile project-label strings pass through verbatim (rendering is
// textContent-only in media/main.js — see also the security grep).
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

const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(import.meta.dirname, "..", "media", "grouping.js"), "utf8"), sandbox);
const G = sandbox.window.PairletListGrouping;
check("grouping.js exposes PairletListGrouping", !!G && typeof G.groupSessions === "function");

// ---------- order: groups by latest activity desc, sessions by recency desc ----------
{
  const sessions = [
    { sessionId: "a1", projectLabel: "C:\\proj\\alpha", mtimeMs: 100 },
    { sessionId: "a2", projectLabel: "C:\\proj\\alpha", mtimeMs: 500 },
    { sessionId: "b1", projectLabel: "C:\\proj\\beta", mtimeMs: 900 },
    { sessionId: "b2", projectLabel: "C:\\proj\\beta", mtimeMs: 700 },
    { sessionId: "c1", projectLabel: "C:\\proj\\gamma", mtimeMs: 300 }
  ];
  const groups = G.groupSessions(sessions);
  check("group count", groups.length === 3, JSON.stringify(groups.map((g) => g.label)));
  check("groups ordered by most-recent activity desc", JSON.stringify(groups.map((g) => g.label)) === JSON.stringify(["C:\\proj\\beta", "C:\\proj\\alpha", "C:\\proj\\gamma"]), JSON.stringify(groups.map((g) => [g.label, g.latest])));
  check("beta sessions sorted recency desc", JSON.stringify(groups[0].sessions.map((s) => s.sessionId)) === JSON.stringify(["b1", "b2"]));
  check("alpha sessions sorted recency desc (input was unsorted)", JSON.stringify(groups[1].sessions.map((s) => s.sessionId)) === JSON.stringify(["a2", "a1"]));
  check("latest recorded per group", groups[0].latest === 900 && groups[1].latest === 500 && groups[2].latest === 300);
}

// ---------- basename extraction ----------
{
  check("win path basename", G.basename("C:\\Users\\Lenovo\\Desktop\\job\\repos\\vscode-pairlet-live") === "vscode-pairlet-live");
  check("posix path basename", G.basename("/home/u/projects/demo") === "demo");
  check("mixed separators", G.basename("C:/proj/demo\\sub") === "sub");
  check("trailing separator", G.basename("C:\\proj\\demo\\") === "demo");
  check("trailing separators plural", G.basename("/a/b///") === "b");
  check("bare name", G.basename("demo") === "demo");
  check("empty label", G.basename("") === "");
  check("non-string tolerated", G.basename(undefined) === "" && G.basename(null) === "");
  check("all-separator string returns raw", G.basename("///") === "///");
}

// ---------- injection safety: hostile labels pass through verbatim ----------
{
  const hostile = '"><img src=x onerror=alert(1)>';
  const hostile2 = "'; DROP TABLE sessions; --";
  const groups = G.groupSessions([
    { sessionId: "h1", projectLabel: hostile, mtimeMs: 10 },
    { sessionId: "h2", projectLabel: hostile2, mtimeMs: 20 }
  ]);
  check("hostile label 1 verbatim", groups.some((g) => g.label === hostile), JSON.stringify(groups.map((g) => g.label)));
  check("hostile label 2 verbatim", groups.some((g) => g.label === hostile2));
  const g1 = groups.find((g) => g.label === hostile);
  check("hostile basename is a substring of the label (no HTML parsing)", g1 && hostile.includes(g1.basename) && g1.basename !== "", g1 && g1.basename);
}

// ---------- robustness: missing labels, empty lists, non-array ----------
{
  const groups = G.groupSessions([
    { sessionId: "x", mtimeMs: 5, projectDir: "slug-dir" },
    { sessionId: "y", mtimeMs: 6 }, // no label, no dir -> ""
    null
  ]);
  check("falls back to projectDir", groups.some((g) => g.label === "slug-dir"));
  check("label-less sessions grouped under empty label", groups.some((g) => g.label === ""));
  check("null session tolerated", groups.every((g) => g.sessions.every((s) => s && s.sessionId)));
  check("empty input -> no groups", G.groupSessions([]).length === 0);
  check("non-array input tolerated", G.groupSessions(undefined).length === 0 && G.groupSessions("x").length === 0);
  const emptyGroup = G.groupSessions([{ sessionId: "z", projectLabel: "p", mtimeMs: NaN }]);
  check("NaN mtime tolerated", emptyGroup.length === 1 && emptyGroup[0].latest === 0);
}

if (failures > 0) {
  console.error(`check-grouping: ${failures} failure(s)`);
  process.exit(1);
}
console.log("OK: project grouping order/sort + basename + injection-safe pass-through pass");
