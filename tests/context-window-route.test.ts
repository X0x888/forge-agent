import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyModelContextWindow,
  contextWindowCaps,
  contextWindowRouteNote,
  contextWindowWarnings,
  cursorRequestsMaxMode,
  CURSOR_GROK_CONTEXT_WINDOW,
  formatContextWindowPosture,
  modelContextWindow,
  nativeContextWindow,
} from "../src/config/model-info.js";
import { resolveCursorRunModel } from "../src/config/cursor-model.js";
import { postureHead, postureWarnings } from "../src/tui/posture.js";
import { collectStatusIssues } from "../src/tui/status-card.js";
import { productionWarningsForRun } from "../src/util/production-warnings.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";
import type { ForgeConfig } from "../src/config/types.js";
import { createSession } from "../src/session/session.js";
import { handleContextWindowSlash } from "../src/commands/slash.js";
import { renderBottomStatusLine } from "../src/tui/bottom-status.js";
import type { ResolvedAuth } from "../src/auth/types.js";

function cfg(over: Partial<ForgeConfig>): ForgeConfig {
  return { ...DEFAULT_CONFIG, ...over };
}

describe("route-aware context windows", () => {
  it("xAI grok-4.6 stays 500k; Cursor Grok 4.5+ is 256k", () => {
    assert.equal(modelContextWindow("grok-4.6"), 500_000);
    assert.equal(modelContextWindow("grok-4.6", "xai"), 500_000);
    assert.equal(nativeContextWindow("cursor-grok-4.6-high-fast"), 500_000);
    assert.equal(
      modelContextWindow("cursor-grok-4.6-high-fast"),
      CURSOR_GROK_CONTEXT_WINDOW,
    );
    assert.equal(
      modelContextWindow("cursor-grok-4.6-xhigh-fast", "cursor"),
      256_000,
    );
    assert.equal(modelContextWindow("grok-4.6", "cursor"), 256_000);
    assert.equal(modelContextWindow("grok-4.5", "cursor"), 256_000);
    assert.equal(modelContextWindow("cursor-grok-4.5-high"), 256_000);
    assert.equal(modelContextWindow("grok-4.7", "cursor"), 256_000);
    assert.equal(modelContextWindow("grok-4", "cursor"), 256_000);
  });

  it("caps expose native vs hosted so UI can tell them apart", () => {
    const xai = contextWindowCaps("grok-4.6", "xai");
    assert.equal(xai?.window, 500_000);
    assert.equal(xai?.native, 500_000);
    assert.equal(xai?.source, "model");

    const cur = contextWindowCaps("cursor-grok-4.6-high-fast", "cursor");
    assert.equal(cur?.window, 256_000);
    assert.equal(cur?.native, 500_000);
    assert.equal(cur?.extended, 500_000);
    assert.equal(cur?.source, "cursor");
    assert.match(
      contextWindowRouteNote("cursor-grok-4.6-high-fast", "cursor") || "",
      /256.*500/,
    );
  });

  it("auto-apply uses the hosted default on Cursor, native on xAI", () => {
    const cursor = {
      model: "cursor-grok-4.6-high-fast",
      provider: "cursor",
      contextWindow: 500_000,
      contextWindowExplicit: false as boolean | undefined,
    };
    const r = applyModelContextWindow(cursor);
    assert.equal(r.changed, true);
    assert.equal(r.source, "cursor");
    assert.equal(cursor.contextWindow, 256_000);

    const xai = {
      model: "grok-4.6",
      provider: "xai",
      contextWindow: 256_000,
      contextWindowExplicit: false as boolean | undefined,
    };
    applyModelContextWindow(xai);
    assert.equal(xai.contextWindow, 500_000);
  });

  it("explicit pin is kept but overflow/unused warn", () => {
    const over = cfg({
      provider: "cursor",
      model: "cursor-grok-4.6-high-fast",
      contextWindow: 500_000,
      contextWindowExplicit: true,
    });
    const overW = contextWindowWarnings(over);
    assert.equal(overW.length, 1);
    assert.match(overW[0]!, /exceeds Cursor Grok's 256000/);
    assert.match(overW[0]!, /Max Mode/);

    const huge = cfg({
      provider: "cursor",
      model: "cursor-grok-4.6-high-fast",
      contextWindow: 1_000_000,
      contextWindowExplicit: true,
    });
    assert.match(contextWindowWarnings(huge)[0]!, /native 500000/);

    const under = cfg({
      provider: "cursor",
      model: "cursor-grok-4.6-high-fast",
      contextWindow: 128_000,
      contextWindowExplicit: true,
    });
    assert.match(contextWindowWarnings(under)[0]!, /paid capacity unused/);
    assert.match(contextWindowWarnings(under)[0]!, /256000/);

    const auto = cfg({
      provider: "cursor",
      model: "cursor-grok-4.6-high-fast",
      contextWindow: 256_000,
    });
    assert.deepEqual(contextWindowWarnings(auto), []);
  });

  it("Cursor Max Mode is off at the 256k default and on when requesting native", () => {
    assert.equal(cursorRequestsMaxMode("cursor-grok-4.6-high-fast", 256_000), false);
    assert.equal(cursorRequestsMaxMode("cursor-grok-4.6-high-fast", 500_000), true);
    assert.equal(cursorRequestsMaxMode("claude-fable-5", 1_000_000), true);
    assert.equal(cursorRequestsMaxMode("claude-fable-5", 300_000), false);
    assert.equal(
      resolveCursorRunModel({
        model: "cursor-grok-4.6-high-fast",
        contextWindow: 256_000,
      }).maxMode,
      false,
    );
    assert.equal(
      resolveCursorRunModel({
        model: "cursor-grok-4.6-high-fast",
        contextWindow: 500_000,
      }).maxMode,
      true,
    );
  });
});

describe("context window UI", () => {
  let tmp: string;
  let prevHome: string | undefined;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ctx-route-"));
    prevHome = process.env.FORGE_HOME;
    process.env.FORGE_HOME = tmp;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prevHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("posture names cursor vs native on the auto default and stays quiet", () => {
    const c = cfg({
      provider: "cursor",
      model: "cursor-grok-4.6-high-fast",
      contextWindow: 256_000,
    });
    const head = postureHead(c);
    assert.match(head, /ctx .*cursor.*native/);
    assert.ok(!postureWarnings(c).some((w) => /context_window/.test(w)));
  });

  it("posture warns when a leftover 500k pin sits on Cursor Grok", () => {
    const c = cfg({
      provider: "cursor",
      model: "cursor-grok-4.6-high-fast",
      contextWindow: 500_000,
      contextWindowExplicit: true,
    });
    assert.match(postureHead(c), /pinned/);
    assert.ok(postureWarnings(c).some((w) => /exceeds Cursor Grok/.test(w)));
  });

  it("xAI pin below 500k still warns unused vs native, not 256k", () => {
    const c = cfg({
      provider: "xai",
      model: "grok-4.6",
      contextWindow: 256_000,
      contextWindowExplicit: true,
    });
    const w = postureWarnings(c);
    assert.equal(w.length, 1);
    assert.match(w[0]!, /500000/);
    assert.doesNotMatch(w[0]!, /Cursor/);
  });

  it("/status flags a pin above the hosted default", () => {
    const session = createSession({
      cwd: process.cwd(),
      provider: "cursor",
      model: "cursor-grok-4.6-high-fast",
    });
    const issues = collectStatusIssues({
      config: cfg({
        provider: "cursor",
        model: "cursor-grok-4.6-high-fast",
        contextWindow: 500_000,
        contextWindowExplicit: true,
      }),
      session,
      usedTokens: 1_000,
    });
    const ctx = issues.find((i) => i.kind === "ctx");
    assert.ok(ctx);
    assert.match(ctx!.line, /pin/);
    assert.equal(ctx!.next, "/context-window auto");
  });

  it("production warnings include overflow pins", () => {
    const w = productionWarningsForRun(
      cfg({
        provider: "cursor",
        model: "cursor-grok-4.6-high-fast",
        contextWindow: 500_000,
        contextWindowExplicit: true,
      }),
      { _testDirtyFiles: 0, _testSessionCount: 0, _testPinnedCount: 0 },
    );
    assert.ok(w.some((x) => /exceeds Cursor Grok/.test(x)));
  });

  it("/context-window auto on Cursor Grok lands on 256k and names the host", () => {
    const session = createSession({
      cwd: process.cwd(),
      provider: "cursor",
      model: "cursor-grok-4.6-high-fast",
    });
    const opts = {
      config: cfg({
        provider: "cursor",
        model: "cursor-grok-4.6-high-fast",
        contextWindow: 500_000,
        contextWindowExplicit: true,
      }),
      session,
    };
    const r = handleContextWindowSlash("auto", opts as never);
    assert.equal(opts.config.contextWindow, 256_000);
    assert.equal(opts.config.contextWindowExplicit, false);
    assert.match(r.output || "", /256/);
    assert.match(r.output || "", /Cursor hosted/i);
  });

  it("dock marks auto Cursor Grok as cursor and flags an oversized pin", () => {
    const session = createSession({
      cwd: process.cwd(),
      provider: "cursor",
      model: "cursor-grok-4.6-high-fast",
    });
    const auth: ResolvedAuth = {
      provider: "cursor",
      method: "subscription",
      token: "t",
    };
    const auto = renderBottomStatusLine(
      {
        config: cfg({
          provider: "cursor",
          model: "cursor-grok-4.6-high-fast",
          contextWindow: 256_000,
        }),
        session,
        auth,
      },
      undefined,
      { width: 160, plain: true },
    );
    assert.match(auto, /ctx /);
    assert.match(auto, /\/256(?:\.0)?k cursor/);

    const pin = renderBottomStatusLine(
      {
        config: cfg({
          provider: "cursor",
          model: "cursor-grok-4.6-high-fast",
          contextWindow: 500_000,
          contextWindowExplicit: true,
        }),
        session,
        auth,
      },
      undefined,
      { width: 200, plain: true },
    );
    assert.match(pin, />cursor/);
  });

  it("formatContextWindowPosture is quiet on xAI and explicit on a Cursor mismatch", () => {
    assert.equal(
      formatContextWindowPosture({
        model: "grok-4.6",
        provider: "xai",
        contextWindow: 500_000,
      }).includes("native"),
      false,
    );
    const pin = formatContextWindowPosture({
      model: "cursor-grok-4.6-high-fast",
      provider: "cursor",
      contextWindow: 500_000,
      contextWindowExplicit: true,
    });
    assert.match(pin, /pinned/);
    assert.match(pin, /cursor/);
    assert.match(pin, /native/);
  });
});
