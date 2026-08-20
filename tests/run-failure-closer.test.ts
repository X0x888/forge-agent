/**
 * Run-failure closer — code-specific Next line (same grammar as /status).
 * Job: a run died — see the next move. Clean Stop stays silent.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  ProviderApiError,
  formatProviderErrorText,
  formatRunFailureCloser,
  runFailureNextKeys,
} from "../src/providers/errors.js";
import { formatRunStopReason } from "../src/tui/turn-summary.js";

describe("runFailureNextKeys", () => {
  it("empty code is a designed silent edge", () => {
    assert.deepEqual(runFailureNextKeys(""), []);
    assert.equal(formatRunFailureCloser(""), "");
    assert.equal(formatRunStopReason({}), null);
  });

  it("rate_limited / auth / overflow / network are job-specific", () => {
    assert.deepEqual(runFailureNextKeys("rate_limited"), [
      "/accounts",
      "/retry",
    ]);
    assert.deepEqual(runFailureNextKeys("auth_expired"), ["/auth", "/retry"]);
    assert.deepEqual(runFailureNextKeys("context_overflow"), [
      "/compact",
      "/retry",
    ]);
    assert.ok(runFailureNextKeys("network").includes("/retry"));
    assert.ok(runFailureNextKeys("protocol_error").includes("/retry"));
    assert.ok(runFailureNextKeys("protocol_error").includes("/compact"));
    assert.ok(
      runFailureNextKeys("rate_limited", { surface: "run" }).includes(
        "forge run --continue",
      ),
    );
    assert.deepEqual(runFailureNextKeys("rate_limited", { surface: "run" }), [
      "wait",
      "forge accounts switch",
      "forge run --continue",
    ]);
  });

  it("aliases http_429 and continue_cap_*", () => {
    assert.deepEqual(runFailureNextKeys("http_429"), runFailureNextKeys("rate_limited"));
    assert.deepEqual(runFailureNextKeys("continue_cap_stop"), ["/retry"]);
    assert.ok(
      runFailureNextKeys("continue_cap_stop", { surface: "run" }).includes(
        "narrow the task",
      ),
    );
  });

  it("unknown code gets a designed default, not silence", () => {
    const repl = runFailureNextKeys("mystery");
    assert.ok(repl.includes("/retry"));
    const run = runFailureNextKeys("mystery", { surface: "run" });
    assert.ok(run.includes("forge run --continue"));
  });
});

describe("formatRunFailureCloser", () => {
  it("opens on Next, not Error?", () => {
    const line = formatRunFailureCloser("quota_exhausted", { columns: 80 });
    assert.match(line, /^Next  \/accounts/);
    assert.doesNotMatch(line, /Error\?/);
    assert.doesNotMatch(line, /✓/);
  });

  it("wraps at · on a narrow TTY", () => {
    const line = formatRunFailureCloser("rate_limited", { columns: 20 });
    assert.match(line, /Next  /);
    assert.match(line, /\n  ·  /);
  });
});

describe("formatProviderErrorText closer", () => {
  it("REPL 429 closer is a slash key, not a CLI dump", () => {
    const err = new ProviderApiError({
      provider: "xai",
      status: 429,
      body: "rate limit exceeded",
      retryAfterMs: 8_000,
    });
    const text = formatProviderErrorText(err, { columns: 80, repl: true });
    const closer = text.split("\n").at(-1)!;
    assert.match(closer, /Next  \/accounts/);
    assert.doesNotMatch(text, /Next  .*forge accounts switch/);
  });

  it("headless 429 card ends on Next, not a tip lecture", () => {
    const err = new ProviderApiError({
      provider: "xai",
      status: 429,
      body: "rate limit exceeded",
      retryAfterMs: 8_000,
    });
    const text = formatProviderErrorText(err, { columns: 80 });
    const lines = text.split("\n");
    assert.match(lines[0]!, /✖ /);
    assert.match(lines.at(-1)!, /Next  /);
    assert.match(lines.at(-1)!, /forge accounts switch|forge run --continue/);
    assert.doesNotMatch(text, /Error\?/);
  });
});

describe("formatRunStopReason provider hole", () => {
  it("speaks for codes that used to return null", () => {
    for (const code of [
      "rate_limited",
      "quota_exhausted",
      "context_overflow",
      "network",
      "doom_loop",
      "error_streak",
      "content_filter",
    ]) {
      const line = formatRunStopReason({ lastErrorCode: code });
      assert.ok(line, code);
      assert.match(line!, /Next  /, code);
    }
  });

  it("safety-valve stop: lines still win over Next", () => {
    assert.match(
      formatRunStopReason({ hitCostCap: true, lastErrorCode: "rate_limited" }) ??
        "",
      /cost cap/,
    );
    assert.doesNotMatch(
      formatRunStopReason({ hitCostCap: true, lastErrorCode: "rate_limited" }) ??
        "",
      /Next  /,
    );
  });
});

describe("cli fail JSON wires next", () => {
  it("forge run --json fail payload includes next keys", () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), "src/cli.ts"),
      "utf8",
    );
    assert.match(src, /nextKeys = runFailureNextKeys/);
    assert.match(src, /next: nextKeys/);
  });
});
