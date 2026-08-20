import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  collectStatusIssues,
  formatStatusVerdict,
  formatStatusCloser,
  assembleStatusReport,
} from "../src/tui/status-card.js";
import { createSession, setSessionLastError } from "../src/session/session.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

function tmpHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-status-card-"));
  process.env.FORGE_HOME = dir;
  return dir;
}

function base() {
  const tmp = tmpHome();
  const session = createSession({ cwd: tmp, provider: "xai", model: "grok-4" });
  const config = {
    ...DEFAULT_CONFIG,
    workspace: tmp,
    provider: "xai" as const,
    model: "grok-4",
    contextWindow: 500_000,
  };
  return { tmp, session, config };
}

describe("collectStatusIssues", () => {
  it("is empty when nothing is wrong", () => {
    const { session, config } = base();
    assert.deepEqual(collectStatusIssues({ config, session }), []);
  });

  it("ranks lastErr ahead of no-verify", () => {
    const { session, config } = base();
    session.meta.editCount = 3;
    setSessionLastError(session, {
      code: "rate_limited",
      message: "xai HTTP 429: rate limit",
      tips: ["forge accounts switch"],
    });
    const issues = collectStatusIssues({
      config,
      session,
      checkCommand: "npm test",
    });
    assert.equal(issues[0]?.kind, "lastErr");
    assert.match(issues[0]!.line, /rate_limited/);
    assert.equal(issues[0]!.next, "forge accounts switch");
    assert.ok(issues.some((i) => i.kind === "verify"));
  });

  it("flags stale last-verify", () => {
    const { session, config } = base();
    session.meta.editCount = 1;
    session.meta.lastVerificationCommand = "npm test";
    session.meta.lastVerificationAt = "2026-04-10T12:00:00.000Z";
    session.meta.lastEditAt = "2026-04-10T12:10:00.000Z";
    const issues = collectStatusIssues({ config, session });
    assert.equal(issues[0]?.kind, "verify");
    assert.match(issues[0]!.line, /stale/);
    assert.equal(issues[0]!.next, "npm test");
  });

  it("flags budget HIT", () => {
    const { session, config } = base();
    session.meta.maxCostUsd = 0.0001;
    session.meta.totalPromptTokens = 1_000_000;
    session.meta.totalCompletionTokens = 1_000_000;
    const issues = collectStatusIssues({ config, session });
    assert.ok(issues.some((i) => i.kind === "budget" && /HIT/.test(i.line)));
  });

  it("flags ctx HARD from usedTokens override", () => {
    const { session, config } = base();
    const issues = collectStatusIssues({
      config,
      session,
      usedTokens: 460_000,
    });
    assert.equal(issues[0]?.kind, "ctx");
    assert.match(issues[0]!.line, /HARD/);
    assert.equal(issues[0]!.next, "/compact");
  });

  it("caps at 3 issues", () => {
    const { session, config } = base();
    session.meta.editCount = 2;
    session.meta.servedModels = ["other-tier"];
    session.meta.maxCostUsd = 0.0001;
    session.meta.totalPromptTokens = 1_000_000;
    session.meta.totalCompletionTokens = 1_000_000;
    setSessionLastError(session, {
      code: "rate_limited",
      message: "429",
    });
    const issues = collectStatusIssues({
      config,
      session,
      usedTokens: 460_000,
      checkCommand: "npm test",
    });
    assert.equal(issues.length, 3);
    assert.equal(issues[0]?.kind, "lastErr");
  });
});

describe("formatStatusVerdict / closer", () => {
  it("ok is a designed empty edge — not a checkmark parade", () => {
    const v = strip(formatStatusVerdict([], { color: false }));
    assert.equal(v, "status  ·  ok");
    assert.doesNotMatch(v, /✓/);
    assert.equal(formatStatusCloser([]), "");
  });

  it("leads with the problem and a Next closer", () => {
    const issues = collectStatusIssues({
      ...base(),
      checkCommand: "npm test",
      session: (() => {
        const { session } = base();
        session.meta.editCount = 2;
        setSessionLastError(session, {
          code: "rate_limited",
          message: "xai HTTP 429: rate limit",
          tips: ["forge accounts switch"],
        });
        return session;
      })(),
    });
    const v = strip(formatStatusVerdict(issues, { color: false }));
    assert.match(v, /^status  ·  \d+ issues?/);
    assert.match(v, /⚠ lastErr  \[rate_limited\]/);
    const closer = formatStatusCloser(issues, { columns: 80 });
    assert.match(closer, /Next  forge accounts switch/);
    assert.match(closer, /npm test/);
  });
});

describe("assembleStatusReport", () => {
  it("puts the verdict above the HUD and the closer last", () => {
    const { session, config } = base();
    setSessionLastError(session, {
      code: "rate_limited",
      message: "xai HTTP 429",
      tips: ["forge accounts switch"],
    });
    const issues = collectStatusIssues({ config, session });
    const card = strip(
      assembleStatusReport({
        hud: "xai/grok-4  ctx 12%",
        detail: "session  abcd1234\nlastErr  [rate_limited] xai HTTP 429",
        issues,
        color: false,
        columns: 80,
      }),
    );
    const lines = card.split("\n");
    assert.match(lines[0]!, /^status  ·  1 issue/);
    assert.match(lines[1]!, /lastErr/);
    assert.match(card, /xai\/grok-4/);
    assert.match(card, /session  abcd1234/);
    assert.match(lines.at(-1)!, /Next  forge accounts switch/);
    assert.ok(card.indexOf("status  ·") < card.indexOf("xai/grok-4"));
    assert.ok(card.indexOf("xai/grok-4") < card.lastIndexOf("Next"));
  });
});

describe("/status slash wiring", () => {
  it("opens on the verdict, not the identity HUD", async () => {
    const { tmp, session, config } = base();
    setSessionLastError(session, {
      code: "rate_limited",
      message: "xai HTTP 429: rate limit",
      tips: ["forge accounts switch"],
    });
    const { handleSlash } = await import("../src/commands/slash.js");
    const { HookRunner } = await import("../src/harness/hooks.js");
    const r = await handleSlash("/status", {
      session,
      config,
      hooks: new HookRunner(config, tmp),
      auth: {
        provider: "xai",
        method: "api_key",
        apiKey: "t",
      } as any,
    });
    assert.equal(r.handled, true);
    const out = strip(String(r.output || ""));
    assert.match(out, /^status\s+·\s+1 issue/);
    assert.match(out, /lastErr  \[rate_limited\]/);
    assert.match(out, /Next  forge accounts switch/);
  });
});
