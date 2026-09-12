/**
 * node:test reporter: print per-file duration (ms) and the slowest tests.
 * Usage: tsx --test --test-reporter ./scripts/test-duration-reporter.mjs tests/*.test.ts
 */
const files = new Map();
const tests = [];
let start = Date.now();

function fileOf(name, nesting) {
  if (typeof name === "string" && name.endsWith(".ts")) return name;
  if (Array.isArray(nesting) && nesting.length) {
    const last = nesting[nesting.length - 1];
    if (typeof last === "string" && last.endsWith(".ts")) return last;
  }
  return "(unknown)";
}

export default async function* reporter(source) {
  for await (const event of source) {
    const { type, data } = event;
    if (type === "test:start" && data?.file) {
      const f = data.file;
      if (!files.has(f)) files.set(f, { file: f, duration: 0, tests: 0, fail: 0 });
    }
    if (type === "test:pass" || type === "test:fail") {
      const f = data.file || fileOf(data.name, data.nesting);
      const rec = files.get(f) || { file: f, duration: 0, tests: 0, fail: 0 };
      rec.tests += 1;
      rec.duration += data.details?.duration_ms ?? 0;
      if (type === "test:fail") rec.fail += 1;
      files.set(f, rec);
      tests.push({
        name: data.name,
        file: f,
        ms: data.details?.duration_ms ?? 0,
        fail: type === "test:fail",
      });
    }
    if (type === "test:fail") {
      yield `FAIL ${data.file} :: ${data.name}\n`;
      if (data.details?.error) {
        yield `  ${data.details.error.message}\n`;
      }
    }
  }
  const wall = Date.now() - start;
  const rows = [...files.values()].sort((a, b) => b.duration - a.duration);
  yield `\n=== files by summed test duration (top 40) ===\n`;
  for (const r of rows.slice(0, 40)) {
    const rel = r.file.replace(process.cwd() + "/", "");
    yield `${String(Math.round(r.duration)).padStart(7)}ms  ${String(r.tests).padStart(4)} tests  ${r.fail ? r.fail + " FAIL " : ""}${rel}\n`;
  }
  tests.sort((a, b) => b.ms - a.ms);
  yield `\n=== slowest 30 tests ===\n`;
  for (const t of tests.slice(0, 30)) {
    const rel = String(t.file).replace(process.cwd() + "/", "");
    yield `${String(Math.round(t.ms)).padStart(7)}ms  ${t.fail ? "FAIL " : ""}${rel} :: ${t.name}\n`;
  }
  const n = tests.length;
  const fails = tests.filter((t) => t.fail).length;
  yield `\n=== summary ===\n`;
  yield `tests=${n} fail=${fails} wall_ms=${wall} summed_ms=${Math.round(rows.reduce((s, r) => s + r.duration, 0))}\n`;
}
