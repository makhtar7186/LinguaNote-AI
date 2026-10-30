// Real-application smoke test: starts Electron on the BUILT pages (run `npm run build` first), lets it start its own
// Python service, drives both windows through the preload API and reports. Windows stay hidden; nothing is shown
// on screen and no global shortcut is registered. Exit code 0 only if every check passed.
//
// The speech model must already be in the local cache (no download happens). A microphone is not needed:
// the live session is opened and closed through IPC without audio.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startElectron } = require("./start-electron.cjs");

const appDir = path.join(__dirname, "..");
const timeoutMs = Number(process.env.LINGUANOTE_SMOKE_TIMEOUT_MS ?? 240_000);

if (!fs.existsSync(path.join(appDir, "dist", "index.html")) || !fs.existsSync(path.join(appDir, "dist", "bubble.html"))) {
  console.error("dist/ is missing: run `npm run build` first.");
  process.exit(2);
}

const outputFile = path.join(os.tmpdir(), `linguanote-smoke-${process.pid}.json`);

const child = startElectron({
  stdio: ["ignore", "ignore", "pipe"],
  extraEnv: {
    LINGUANOTE_SMOKE_TEST: "1",
    LINGUANOTE_SMOKE_OUTPUT: outputFile,
    HF_HUB_OFFLINE: process.env.LINGUANOTE_SMOKE_ALLOW_DOWNLOAD === "1" ? "" : "1",
  },
});

let stderr = "";
child.stderr.on("data", (chunk) => { stderr += String(chunk); });
const timer = setTimeout(() => {
  console.error(`Smoke test timed out after ${timeoutMs / 1000} s.`);
  child.kill();
}, timeoutMs);

child.on("exit", (code) => {
  clearTimeout(timer);
  let report = null;
  try {
    report = JSON.parse(fs.readFileSync(outputFile, "utf8"));
  } catch {
    // No report: the application did not get as far as writing one.
  } finally {
    fs.rmSync(outputFile, { force: true });
  }

  if (!report) {
    console.error(`No smoke report (Electron exit code ${code}).`);
    if (stderr.trim()) console.error(stderr.trim().split("\n").slice(-15).join("\n"));
    process.exit(1);
  }
  for (const item of report.checks ?? []) {
    console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}${item.ok || !item.detail ? "" : `  ->  ${item.detail}`}`);
  }
  if (report.error) console.error(report.error);
  const failed = (report.checks ?? []).filter((item) => !item.ok).length;
  console.log(`\n${report.ok ? "SMOKE TEST PASSED" : `SMOKE TEST FAILED (${failed} failing)`}`);
  process.exit(report.ok ? 0 : 1);
});
