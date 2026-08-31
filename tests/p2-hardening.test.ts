import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function withEnv(key: string, value: string | undefined): () => void {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  return () => {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  };
}

describe("tool-output dump permissions", () => {
  it("saveFullOutput writes dumps mode 0600 (bash output can contain secrets)", async () => {
    const restore = withEnv(
      "FORGE_HOME",
      fs.mkdtempSync(path.join(os.tmpdir(), "forge-tout-mode-")),
    );
    try {
      const { saveFullOutput } = await import("../src/agent/tools/truncate.js");
      const body = "AKIA_EXAMPLE_SECRET\n" + "x".repeat(100);
      const file = await saveFullOutput(body);
      const st = fs.statSync(file);
      assert.equal(st.mode & 0o777, 0o600);
      assert.equal(fs.readFileSync(file, "utf8"), body);
    } finally {
      restore();
    }
  });
});

describe("grep js-fallback size guard", () => {
  it("skips files over 4MB instead of reading them whole (no-rg machines)", async () => {
    // Force the JS fallback: findRg() scans PATH (cached per process — keep
    // this the first grep call in this test file).
    const restorePath = withEnv("PATH", "");
    const restoreHome = withEnv(
      "FORGE_HOME",
      fs.mkdtempSync(path.join(os.tmpdir(), "forge-grep-home-")),
    );
    try {
      const { toolGrep } = await import("../src/agent/tools/grep.js");
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-grep-cap-"));
      fs.writeFileSync(path.join(dir, "small.txt"), "forge-needle here\n");
      fs.writeFileSync(
        path.join(dir, "huge.log"),
        "forge-needle\n" + "x".repeat(4 * 1024 * 1024 + 16),
      );
      const r = await toolGrep(
        { pattern: "forge-needle", path: ".", head_limit: 10 },
        { workspace: dir } as never,
      );
      assert.notEqual(r.isError, true);
      assert.match(r.output, /\[grep:js-fallback\]/);
      assert.match(r.output, /small\.txt:1:forge-needle here/);
      assert.match(r.output, /skipped 1 file\(s\) over 4MB/);
      assert.ok(
        !r.output.includes("huge.log"),
        "oversized file must be skipped, not read",
      );
    } finally {
      restoreHome();
      restorePath();
    }
  });
});

describe("web_search decodeHtml", () => {
  it("never throws on hostile/out-of-range entities (mirrors web-fetch guard)", async () => {
    const { decodeHtml } = await import("../src/agent/tools/web-search.js");
    // &#x110000; previously threw RangeError via String.fromCodePoint and
    // failed the whole search; invalid entities now keep their original text.
    assert.equal(decodeHtml("&#x110000;"), "&#x110000;");
    assert.equal(decodeHtml("&#xD800;"), "&#xD800;"); // surrogate half
    assert.equal(decodeHtml("&#99999999;"), "&#99999999;");
    // Valid entities still decode.
    assert.equal(decodeHtml("&#x41; &#65; &amp;"), "A A &");
    assert.equal(decodeHtml("a&lt;b&gt;&quot;c&quot;&#39;"), 'a<b>"c"\'');
  });
});

describe("web_search snippet slice is UTF-16 safe", () => {
  it("does not split an emoji at the 240-char cap", async () => {
    const { parseDdgHtml } = await import("../src/agent/tools/web-search.js");
    const fire = "🔥";
    const snippet = "x".repeat(239) + fire + " tail";
    const html = `
      <a rel="nofollow" class="result__a" href="https://example.com/pet">Pet</a>
      <span class="result__snippet">${snippet}</span>
    `;
    const hits = parseDdgHtml(html, 1);
    assert.equal(hits.length, 1);
    const s = hits[0]!.snippet || "";
    assert.equal(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
        s,
      ),
      false,
    );
    // Cap drops the split pair rather than keeping \uD83D
    assert.ok(s.length <= 239);
    assert.equal(s.endsWith("x"), true);
    assert.equal(s.includes(fire), false);
  });
});

describe("permission always-grant display", () => {
  it("shows the exact persisted pattern, e.g. Bash(rm *) from rm -rf /tmp/x", async () => {
    const { alwaysGrantLabel } = await import("../src/agent/permissions.js");
    const { alwaysPatternFromCommand } = await import(
      "../src/agent/shell-arity.js"
    );
    // Premise: [a]lways on `rm -rf /tmp/x` persists a blind arity-1 rule;
    // the prompt must display that exact grant (label parity with
    // savedAsAllowRules).
    const pattern = alwaysPatternFromCommand("rm -rf /tmp/x");
    assert.equal(pattern, "rm *");
    // The exported function IS the prompt's persisted-rule pipeline
    // (segment-aware: env/wrapper peeling, first executable segment only) —
    // the old naive whitespace-split twin would fail both of these.
    assert.equal(alwaysPatternFromCommand("FOO=1 npm test"), "npm test *");
    assert.equal(
      alwaysPatternFromCommand("npm test && rm -rf /tmp/x"),
      "npm test *",
    );
    assert.equal(alwaysGrantLabel("bash", pattern), "Bash(rm *)");
    assert.equal(alwaysGrantLabel("write_file", "*"), "Write(*)");
    assert.equal(alwaysGrantLabel("search_replace", "*"), "Edit(*)");
    assert.equal(
      alwaysGrantLabel("external_directory", "/tmp/x/*"),
      "external_directory(/tmp/x/*)",
    );
  });
});

describe("permission prompt serialization", () => {
  it("enqueuePrompt runs concurrent prompts one at a time, in order", async () => {
    const { enqueuePrompt } = await import("../src/agent/permissions.js");
    let active = 0;
    let maxActive = 0;
    const started: number[] = [];
    const tasks = Array.from({ length: 8 }, (_, i) =>
      enqueuePrompt(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        started.push(i);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
        return i;
      }),
    );
    const results = await Promise.all(tasks);
    assert.equal(maxActive, 1, "prompts must never overlap on stdin");
    assert.deepEqual(started, [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(results, [0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("chain survives a rejected prompt", async () => {
    const { enqueuePrompt } = await import("../src/agent/permissions.js");
    await assert.rejects(
      enqueuePrompt(async () => {
        throw new Error("boom");
      }),
      /boom/,
    );
    const ok = await enqueuePrompt(async () => 42);
    assert.equal(ok, 42);
  });
});
