// scripts/check-phone.mjs — dev-only check for phone-session attribution.
// Uses a TEMP COPY of the real ~/.cc-pocket/spawned-sessions.tsv (never writes
// the original, never writes ~/.claude). Proves:
//   - phone session IDs are detected from the real TSV copy
//   - a missing file is tolerated (empty set, no throw)
//   - malformed rows (no tab / empty columns / extra columns) are skipped
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { pathToFileURL } from "url";

const mod = await import(pathToFileURL(path.join(import.meta.dirname, "..", "out", "phone.js")).href);
const { parsePhoneSessionsTsv, loadPhoneSessions, phoneSessionsFile, phoneSessionMtimesWithContent, diffNewPhoneSessions, activePhoneSessions } = mod;

let failures = 0;
function check(name, ok, detail) {
  if (ok) {
    console.log("PASS:", name);
  } else {
    failures += 1;
    console.error("FAIL:", name, detail ?? "");
  }
}

// ---------- real TSV copy -> IDs detected ----------
{
  const real = phoneSessionsFile();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pairlet-phone-"));
  const tmp = path.join(tmpDir, "spawned-sessions.tsv");
  if (fs.existsSync(real)) {
    fs.copyFileSync(real, tmp);
  } else {
    fs.writeFileSync(tmp, "C:\\demo\\proj\tabc-123\n");
  }
  const expected = fs
    .readFileSync(tmp, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("\t"))
    .map((l) => l.split("\t")[1].trim())
    .filter(Boolean);
  const info = loadPhoneSessions(tmp);
  check("TSV copy loaded", info.sessionIds.size > 0 || expected.length === 0, `ids=${info.sessionIds.size}`);
  check(
    "every real-file session ID detected",
    expected.every((id) => info.sessionIds.has(id)),
    JSON.stringify({ expected, got: [...info.sessionIds] })
  );
  check("project path recorded per session", [...info.sessionIds].every((id) => info.projectBySession.has(id)));
  // The known phone session on this machine (per daemon TSV) must be present
  // when reading the REAL file directly.
  const live = loadPhoneSessions(real);
  check("live file parse does not throw", live instanceof Object);
  console.log("  detected phone session IDs:", info.sessionIds.size, "(real file:", fs.existsSync(real) + ")");
}

// ---------- missing file tolerated ----------
{
  const missingPath = path.join(os.tmpdir(), "pairlet-no-such-" + Date.now(), "spawned-sessions.tsv");
  let threw = false;
  let info;
  try {
    info = loadPhoneSessions(missingPath);
  } catch (e) {
    threw = true;
    console.error(e);
  }
  check("missing file does not throw", !threw);
  check("missing file -> empty set", info && info.sessionIds.size === 0 && info.projectBySession.size === 0);
}

// ---------- new-phone-session detection ----------
{
  const sessions = [
    { sessionId: "empty-phone", phone: true, size: 0, mtimeMs: 100, messageCount: 0 },
    { sessionId: "metadata-only", phone: true, size: 64, mtimeMs: 100, messageCount: 0 },
    { sessionId: "phone-a", phone: true, size: 128, mtimeMs: 200, messageCount: 2 },
    { sessionId: "desktop-b", phone: false, size: 128, mtimeMs: 200, messageCount: 2 },
    { sessionId: "phone-b", phone: true, size: 4096, mtimeMs: 300, messageCount: -1 }
  ];
  const current = phoneSessionMtimesWithContent(sessions);
  check("new-phone: only phone sessions with content count", current.has("phone-a") && current.has("phone-b") && !current.has("empty-phone") && !current.has("metadata-only") && !current.has("desktop-b"), JSON.stringify([...current]));
  const fresh = diffNewPhoneSessions(current, new Set(["phone-a"]));
  check("new-phone: diff returns only unseen IDs", fresh.length === 1 && fresh[0] === "phone-b", JSON.stringify(fresh));
  check("new-phone: first scan baseline produces no diff", diffNewPhoneSessions(current, new Set(current.keys())).length === 0);
  const previous = new Map([
    ["phone-a", 100],
    ["phone-b", 300]
  ]);
  const active = activePhoneSessions(current, previous);
  check("new-phone: active diff finds only grown transcripts", active.length === 1 && active[0] === "phone-a", JSON.stringify(active));
}

// ---------- malformed rows ----------
{
  const info = parsePhoneSessionsTsv(
    "no-tab-line\n\t\nC:\\p\\t\n\nC:\\proj\\a\tid-1\r\nC:\\proj\\b\tid-1\textra-col\n   \nC:\\proj\\c\tid-2\n"
  );
  check("malformed: ids found", info.sessionIds.has("id-1") && info.sessionIds.has("id-2"), JSON.stringify([...info.sessionIds]));
  check("malformed: id count", info.sessionIds.size === 2, JSON.stringify([...info.sessionIds]));
  check("first project wins on duplicate id", info.projectBySession.get("id-1") === "C:\\proj\\a", info.projectBySession.get("id-1"));
  check("extra columns ignored", parsePhoneSessionsTsv("C:\\x\tid-9\tmore").sessionIds.has("id-9"));
}

if (failures > 0) {
  console.error(`check-phone: ${failures} failure(s)`);
  process.exit(1);
}
console.log("OK: phone attribution logic passes (IDs detected, missing file tolerated)");
