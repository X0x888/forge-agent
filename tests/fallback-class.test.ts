/**
 * Fallback class siblings: ULW no longer warns when fallback is off + lastHop share card.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG } from "../src/config/types.js";
import { productionWarningsForRun } from "../src/util/production-warnings.js";
import {
  createSession,
  formatResumeOrientation,
  formatSessionShareCard,
  loadSession,
  saveSessionMetaSidecar,
} from "../src/session/session.js";

describe("ULW + fallback off", () => {
  it("does not flag ULW when model fallback is off (the default)", () => {
    const w = productionWarningsForRun(
      { ...DEFAULT_CONFIG, fallbackModels: [], maxCostUsd: 5 },
      {
        ultrawork: true,
        _testDirtyFiles: 0,
        _testSessionCount: 0,
        _testPinnedCount: 0,
      },
    );
    assert.ok(!w.some((x) => /fallback off/i.test(x)));
  });

  it("does not flag ULW when fallback is unset", () => {
    const w = productionWarningsForRun(
      { ...DEFAULT_CONFIG, maxCostUsd: 5 },
      {
        ultrawork: true,
        _testDirtyFiles: 0,
        _testSessionCount: 0,
        _testPinnedCount: 0,
      },
    );
    assert.ok(!w.some((x) => /fallback off/i.test(x)));
  });
});

describe("lastModelFallback share card", () => {
  it("shows lastHop after a model fallback", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-fallback-hop-"));
    const prev = process.env.FORGE_HOME;
    process.env.FORGE_HOME = tmp;
    try {
      const s = createSession({ cwd: tmp, provider: "xai", model: "grok-4.6" });
      s.meta.lastModelFallback = {
        from: "grok-4.6",
        to: "grok-4.5",
        at: new Date().toISOString(),
      };
      const card = formatSessionShareCard(s);
      assert.match(card, /fallback:/);
      assert.match(card, /lastHop:\s+grok-4\.6 → grok-4\.5/);
      assert.match(
        formatResumeOrientation(s),
        /Last model hop: grok-4\.6 → grok-4\.5/,
      );
      saveSessionMetaSidecar(s);
      const reloaded = loadSession(s.meta.id);
      assert.equal(reloaded?.meta.lastModelFallback?.from, "grok-4.6");
      assert.equal(reloaded?.meta.lastModelFallback?.to, "grok-4.5");
    } finally {
      if (prev === undefined) delete process.env.FORGE_HOME;
      else process.env.FORGE_HOME = prev;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
