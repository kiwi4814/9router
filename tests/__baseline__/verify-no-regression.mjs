// Gate: so kết quả test hiện tại với baseline known-fails.
// PASS nếu KHÔNG có test nào pass(baseline) → fail(now). Test mới được phép.
// Usage: node tests/__baseline__/verify-no-regression.mjs <current-results.json>
import { readFileSync } from "fs";

const knownFails = new Set(
  readFileSync(new URL("./known-fails.txt", import.meta.url), "utf8")
    .split("\n").map(s => s.trim()).filter(Boolean)
);

const resultsPath = process.argv[2];
if (!resultsPath) { console.error("Missing results.json path"); process.exit(2); }

const r = JSON.parse(readFileSync(resultsPath, "utf8"));

// Baseline entries are repo-relative ("tests/unit/x.test.js :: case"). Vitest
// reports absolute paths that may sit anywhere (a checkout, a container at
// /app, a CI workspace), so anchor on the last "/tests/" segment instead of
// assuming one specific prefix — otherwise every failure looks like a
// regression and the gate can only ever pass on a zero-failure run.
function normalizeFile(fullPath) {
  const marker = "/tests/";
  const at = String(fullPath).lastIndexOf(marker);
  return at === -1
    ? String(fullPath).replace(/^\.\//, "")
    : `tests/${String(fullPath).slice(at + marker.length)}`;
}

const nowFails = r.testResults.flatMap(f =>
  f.assertionResults.filter(a => a.status === "failed")
    .map(a => normalizeFile(f.name) + " :: " + a.fullName)
);

// Regression = fail bây giờ NHƯNG không có trong baseline known-fails
const regressions = nowFails.filter(f => !knownFails.has(f));

if (regressions.length) {
  console.error(`\n❌ REGRESSION: ${regressions.length} test pass→fail:\n`);
  regressions.forEach(f => console.error("  - " + f));
  process.exit(1);
}
console.log(`✅ No regression. (now fails=${nowFails.length}, baseline known=${knownFails.size}, all known)`);
