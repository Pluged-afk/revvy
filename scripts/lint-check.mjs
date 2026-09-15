// Lint ceiling ("ratchet"): CI fails only when the ESLint error count rises
// ABOVE the accepted baseline, so a genuinely new error is caught while the
// known, pre-existing set does not block every push. Lower BASELINE as the
// backlog is cleared (it should only ever go down).
import { execSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASELINE = 18; // known-accepted ESLint errors as of 2026-09-15. Ratchet DOWN, never up.

// Write the JSON report to a file so parsing never depends on capturing stdout
// (eslint writes the -o file even when it exits non-zero because errors exist).
const reportPath = join(tmpdir(), `revyy-eslint-${process.pid}.json`);
try {
  execSync(`npx eslint . -f json -o "${reportPath}"`, { stdio: "ignore" });
} catch {
  // Non-zero exit is expected while there are any errors; the report is on disk.
}

let results;
try { results = JSON.parse(readFileSync(reportPath, "utf8")); }
catch { console.error("lint-check: could not read ESLint report at " + reportPath); process.exit(2); }
finally { try { rmSync(reportPath, { force: true }); } catch { /* ignore */ } }

const errors = results.reduce((n, r) => n + (r.errorCount || 0), 0);
const warnings = results.reduce((n, r) => n + (r.warningCount || 0), 0);

console.log(`ESLint: ${errors} error(s), ${warnings} warning(s) — baseline ${BASELINE}.`);

if (errors > BASELINE) {
  console.error(`✗ ${errors - BASELINE} new lint error(s) above the baseline of ${BASELINE}.`);
  console.error("  Fix them, or (only if truly intentional) adjust BASELINE in scripts/lint-check.mjs.");
  process.exit(1);
}
if (errors < BASELINE) {
  console.log(`✓ ${BASELINE - errors} fewer error(s) than baseline — lower BASELINE to ${errors} to lock it in.`);
} else {
  console.log("✓ Lint within baseline.");
}
