/**
 * `/context` + `/compact` are sit-down keys — verdict + token delta, not a bar lecture.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleSlash } from "../src/commands/slash.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";
import { HookRunner } from "../src/harness/hooks.js";
import { createSession } from "../src/session/session.js";
import {
  compactKindFromDelta,
  contextKindFromPct,
  contextNextKeys,
  formatCompactCard,
  formatContextCard,
  formatContextVerdict,
} from "../src/tui/context-card.js";

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("/context card", () => {
  it("kind + Next from pct vs threshold", () => {
    assert.equal(contextKindFromPct(10, 80), "ok");
    assert.equal(contextKindFromPct(70, 80), "elevated");
    assert.equal(contextKindFromPct(85, 80), "compact");
    assert.equal(contextKindFromPct(95, 80), "hard");
    assert.deepEqual(contextNextKeys("ok"), []);
    assert.deepEqual(contextNextKeys("hard"), ["/compact"]);
    assert.deepEqual(contextNextKeys("compact"), ["/compact"]);
  });

  it("verdict-first, no unicode bar", () => {
    assert.match(
      formatContextVerdict("ok", { color: false }),
      /^context  ·  ok$/,
    );
    assert.match(
      formatContextVerdict("hard", { color: false }),
      /^context  ·  HARD$/,
    );
    const card = formatContextCard({
      kind: "hard",
      used: 460_000,
      window: 500_000,
      pct: 92,
      thresholdPct: 80,
      note: "Pressure: HARD (~92%)",
      color: false,
    });
    assert.match(card, /context  ·  HARD/);
    assert.match(card, /~460\.0k \/ 500\.0k  \(92%\)  autoCompact@80%/);
    assert.match(card, /Next  \/compact/);
    assert.doesNotMatch(card, /█|░/);
    assert.doesNotMatch(card, /Tip: \/compact/);
  });
});

describe("/compact card", () => {
  it("shows token delta and Next /context", () => {
    assert.equal(compactKindFromDelta(48, 12, 410_000, 80_000), "ok");
    assert.equal(compactKindFromDelta(12, 12, 4_000, 4_000), "noop");
    const card = formatCompactCard({
      beforeMsgs: 48,
      afterMsgs: 12,
      beforeTokens: 410_000,
      afterTokens: 80_000,
      color: false,
    });
    assert.match(card, /compact  ·  ok/);
    assert.match(card, /Compacted 48 → 12 messages/);
    assert.match(card, /~410\.0k → ~80\.0k/);
    assert.match(card, /Next  \/context/);
  });
});

describe("/context slash", () => {
  let tmp: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ctx-card-"));
    prevHome = process.env.FORGE_HOME;
    process.env.FORGE_HOME = path.join(tmp, "home");
    fs.mkdirSync(process.env.FORGE_HOME, { recursive: true });
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prevHome;
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  it("empty session peeks context  ·  ok", async () => {
    const s = createSession({ cwd: tmp, provider: "xai", model: "grok-4.6" });
    const config = {
      ...DEFAULT_CONFIG,
      workspace: tmp,
      contextWindow: 500_000,
      autoCompactThreshold: 0.8,
    };
    const r = await handleSlash("/context", {
      session: s,
      config,
      hooks: new HookRunner(config, tmp),
    });
    const out = strip(r.output || "");
    assert.equal(r.handled, true);
    assert.match(out, /context  ·  ok/);
    assert.match(out, /autoCompact@80%/);
    assert.match(out, /Next  \/context all/);
    assert.doesNotMatch(out, /█|░/);
    assert.doesNotMatch(out, /Next  \/compact/);
    assert.doesNotMatch(out, /By role:|Project stack:|Project rules:|Skills:/);
  });

  it("/context all keeps the stack lecture", async () => {
    const s = createSession({ cwd: tmp, provider: "xai", model: "grok-4.6" });
    const config = {
      ...DEFAULT_CONFIG,
      workspace: tmp,
      contextWindow: 500_000,
      autoCompactThreshold: 0.8,
    };
    const r = await handleSlash("/context all", {
      session: s,
      config,
      hooks: new HookRunner(config, tmp),
    });
    const out = strip(r.output || "");
    assert.match(out, /context  ·  ok/);
    assert.match(out, /Project stack:|Project rules:|Skills:/);
    assert.doesNotMatch(out, /Next  \/context all/);
  });

  it("HARD window peeks context  ·  HARD + Next /compact", async () => {
    const s = createSession({ cwd: tmp, provider: "xai", model: "grok-4.6" });
    s.messages.push({ role: "user", content: "x".repeat(20_000) });
    const config = {
      ...DEFAULT_CONFIG,
      workspace: tmp,
      contextWindow: 1000,
      autoCompactThreshold: 0.8,
    };
    const r = await handleSlash("/context", {
      session: s,
      config,
      hooks: new HookRunner(config, tmp),
    });
    const out = strip(r.output || "");
    assert.match(out, /context  ·  HARD/);
    assert.match(out, /Pressure: HARD/);
    assert.match(out, /Next  \/compact/);
    assert.doesNotMatch(out, /By role:|Project stack:|Project rules:|Skills:/);
  });

  it("/compact prints token delta", async () => {
    const s = createSession({ cwd: tmp, provider: "xai", model: "grok-4.6" });
    for (let i = 0; i < 10; i++) {
      s.messages.push({ role: "user", content: `u${i} `.repeat(80) });
      s.messages.push({ role: "assistant", content: `a${i} `.repeat(80) });
    }
    const before = s.messages.length;
    const config = { ...DEFAULT_CONFIG, workspace: tmp };
    const r = await handleSlash("/compact", {
      session: s,
      config,
      hooks: new HookRunner(config, tmp),
    });
    const out = strip(r.output || "");
    assert.match(out, /compact  ·  /);
    assert.match(out, /Compacted /);
    assert.match(out, /→/);
    assert.ok(s.messages.length <= before);
    assert.match(out, /~/);
  });
});
