// Line-coverage gate over the project's own ClojureScript namespaces.
// Reads c8's coverage/coverage-summary.json (paths are source-mapped to
// .../cljs-runtime/proxx/**.cljs) and ignores test namespaces, the Clojure core
// library and shadow-cljs internals.
import { readFileSync } from "node:fs";

const threshold = Number(process.argv[2] ?? 80);
const summary = JSON.parse(readFileSync("coverage/coverage-summary.json", "utf8"));
const own = Object.entries(summary).filter(
  ([file]) => /\/cljs-runtime\/proxx\//.test(file) && !/_test\.cljs$/.test(file),
);
const { total, covered } = own.reduce(
  (acc, [, { lines }]) => ({ total: acc.total + lines.total, covered: acc.covered + lines.covered }),
  { total: 0, covered: 0 },
);
const pct = total === 0 ? 0 : (100 * covered) / total;
const ok = pct >= threshold;
console.log(`${ok ? "✅" : "❌"} Line coverage ${pct.toFixed(2)}% over ${own.length} proxx files (threshold ${threshold}%)`);
process.exit(ok ? 0 : 1);
