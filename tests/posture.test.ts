import { test } from "node:test";
import assert from "node:assert/strict";
import { postureHead, postureWarnings } from "../src/tui/posture.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";
import type { ForgeConfig } from "../src/config/types.js";

function cfg(over: Partial<ForgeConfig>): ForgeConfig {
  return { ...DEFAULT_CONFIG, ...over };
}

test("posture: defaults are quiet (no warnings, effort = model max, auto max_tokens)", () => {
  // grok-4.5 default: effort resolves to model max, nothing pinned → silent.
  const c = cfg({ model: "grok-4.5" });
  assert.deepEqual(postureWarnings(c), []);
  const head = postureHead(c);
  assert.match(head, /effort high \(model max\)/);
  assert.match(head, /max_tokens 65\.5k \(auto\)/);
  assert.match(head, /temp default/);
});

test("posture: pinned temperature on a reasoning model warns", () => {
  const c = cfg({ model: "grok-4.5", temperature: 0.2 });
  const w = postureWarnings(c);
  assert.equal(w.length, 1);
  assert.match(w[0], /temperature pinned/);
});

test("posture: pinned temperature on a NON-reasoning model stays quiet", () => {
  // grok-3 has no effort support — a temp pin there is a legitimate choice.
  const c = cfg({ model: "grok-3", temperature: 0.2 });
  assert.deepEqual(postureWarnings(c), []);
});

test("posture: max_tokens pinned below the auto reasoning budget warns", () => {
  const c = cfg({
    model: "deepseek/deepseek-v4-flash",
    maxTokens: 8192,
    maxTokensExplicit: true,
  });
  const w = postureWarnings(c);
  assert.equal(w.length, 1);
  assert.match(w[0], /below the auto reasoning budget 32768/);
});

test("posture: max_tokens pinned at/above auto stays quiet", () => {
  const c = cfg({
    model: "deepseek/deepseek-v4-flash",
    maxTokens: 65536,
    maxTokensExplicit: true,
  });
  assert.deepEqual(postureWarnings(c), []);
  assert.match(postureHead(c), /max_tokens 65\.5k \(pinned\)/);
});

test("posture: context_window pinned below model max warns (wasted capacity)", () => {
  const c = cfg({
    model: "grok-4.5",
    contextWindow: 128_000,
    contextWindowExplicit: true,
  });
  const w = postureWarnings(c);
  assert.equal(w.length, 1);
  assert.match(w[0], /paid capacity unused/);
});

test("posture: silently clamped effort is surfaced", () => {
  // grok-4.5 levels are low|medium|high — pinning max clamps to high.
  const c = cfg({ model: "grok-4.5", reasoningEffort: "max" });
  const w = postureWarnings(c);
  assert.equal(w.length, 1);
  assert.match(w[0], /clamped to "high"/);
});
