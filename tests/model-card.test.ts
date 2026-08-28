/**
 * `/model` is the sit-down key — never a Provider: catalog dump.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyLiveSlash, handleSlash } from "../src/commands/slash.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";
import { HookRunner } from "../src/harness/hooks.js";
import { createSession } from "../src/session/session.js";
import {
  formatModelCard,
  formatModelVerdict,
  modelKindFromServed,
  modelNextKeys,
  peekModelCard,
} from "../src/tui/model-card.js";

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("/model card", () => {
  it("kind: ok vs drift vs unknown", () => {
    assert.equal(modelKindFromServed("grok-4.6"), "ok");
    assert.equal(modelKindFromServed("grok-4.6", []), "ok");
    assert.equal(modelKindFromServed("grok-4.6", ["grok-4.6"]), "ok");
    assert.equal(modelKindFromServed("grok-4.6", ["grok-4.5"]), "drift");
  });

  it("verdict + Next: ok / drift / unknown", () => {
    assert.match(
      formatModelVerdict("ok", "grok-4.6", { color: false }),
      /^model  ·  grok-4\.6$/,
    );
    assert.match(
      formatModelVerdict("drift", "grok-4.6", { color: false }),
      /^model  ·  drift$/,
    );
    assert.match(
      formatModelVerdict("unknown", "nope", { color: false }),
      /^model  ·  unknown$/,
    );
    assert.deepEqual(
      modelNextKeys({
        kind: "drift",
        model: "grok-4.6",
        served: ["grok-4.5"],
      }),
      ["/model grok-4.6", "/model grok-4.5"],
    );
    assert.deepEqual(
      modelNextKeys({
        kind: "ok",
        model: "grok-4.6",
        recentOther: "grok-4.5",
        effortWired: true,
      }),
      ["/model grok-4.5", "/effort"],
    );
    assert.deepEqual(
      modelNextKeys({ kind: "unknown", unknownTip: "grok-4.5" }),
      ["/model grok-4.5"],
    );
  });

  it("peek card is not a numbered catalog lecture", () => {
    const peek = formatModelCard({
      kind: "ok",
      model: "grok-4.6",
      provider: "xai",
      effort: "xhigh",
      ctx: "500k",
      next: ["/effort"],
      color: false,
    });
    assert.match(peek, /model  ·  grok-4\.6/);
    assert.match(peek, /xai  ·  effort xhigh  ·  ctx 500k/);
    assert.match(peek, /Next  \/effort/);
    assert.doesNotMatch(peek, /pick a value/);
    assert.doesNotMatch(peek, /Provider:/);
    assert.doesNotMatch(peek, /forge models/);
    const drift = formatModelCard({
      kind: "drift",
      model: "grok-4.6",
      provider: "xai",
      served: ["grok-4.5"],
      next: ["/model grok-4.6", "/model grok-4.5"],
      color: false,
    });
    assert.match(drift, /model  ·  drift/);
    assert.match(drift, /asked grok-4\.6  ·  served grok-4\.5/);
    assert.match(drift, /Next  \/model grok-4\.6/);
  });
});

describe("/model slash", () => {
  let tmp: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-model-card-"));
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

  function session(model = "grok-4.6") {
    return createSession({ cwd: tmp, provider: "xai", model });
  }

  function hooks(model = "grok-4.6") {
    return new HookRunner(
      { ...DEFAULT_CONFIG, workspace: tmp, provider: "xai", model },
      tmp,
    );
  }

  it("classifies empty /model as readonly", () => {
    assert.equal(classifyLiveSlash("/model"), "readonly");
    assert.equal(classifyLiveSlash("/model grok-4.5"), "control");
  });

  it("empty /model peeks a card, not a catalog", async () => {
    const s = session();
    const config = {
      ...DEFAULT_CONFIG,
      workspace: tmp,
      provider: "xai" as const,
      model: "grok-4.6",
    };
    const r = await handleSlash("/model", { session: s, config, hooks: hooks() });
    const out = strip(r.output || "");
    assert.equal(r.handled, true);
    assert.match(out, /model  ·  grok-4\.6/);
    assert.match(out, /xai/);
    assert.doesNotMatch(out, /pick a value/);
    assert.doesNotMatch(out, /Provider:/);
    assert.doesNotMatch(out, /forge models/);
    assert.doesNotMatch(out, /Last verify:/);
    const peek = strip(
      peekModelCard({ config, served: s.meta.servedModels, color: false }),
    );
    assert.match(peek, /model  ·  grok-4\.6/);
  });

  it("served-drift peeks model  ·  drift", async () => {
    const s = session("grok-4.6");
    s.meta.servedModels = ["grok-4.5"];
    const config = {
      ...DEFAULT_CONFIG,
      workspace: tmp,
      provider: "xai" as const,
      model: "grok-4.6",
    };
    const r = await handleSlash("/model", { session: s, config, hooks: hooks() });
    const out = strip(r.output || "");
    assert.match(out, /model  ·  drift/);
    assert.match(out, /asked grok-4\.6  ·  served grok-4\.5/);
    assert.match(out, /Next  \/model grok-4\.6/);
  });

  it("/model grok-4.5 sets and prints the card", async () => {
    const s = session("grok-4.6");
    s.meta.servedModels = ["grok-4.5"];
    const config = {
      ...DEFAULT_CONFIG,
      workspace: tmp,
      provider: "xai" as const,
      model: "grok-4.6",
    };
    const r = await handleSlash("/model grok-4.5", {
      session: s,
      config,
      hooks: hooks(),
    });
    const out = strip(r.output || "");
    assert.equal(config.model, "grok-4.5");
    assert.equal(s.meta.servedModels, undefined);
    assert.match(out, /model  ·  grok-4\.5/);
    assert.match(out, /set · live/);
    assert.doesNotMatch(out, /Model set to/);
    assert.doesNotMatch(out, /pick a value/);
  });

  it("unknown catalog typo is model  ·  unknown", async () => {
    const s = session();
    const config = {
      ...DEFAULT_CONFIG,
      workspace: tmp,
      provider: "xai" as const,
      model: "grok-4.6",
    };
    const r = await handleSlash("/model grok-45", {
      session: s,
      config,
      hooks: hooks(),
    });
    const out = strip(r.output || "");
    assert.equal(config.model, "grok-4.6");
    assert.equal(r.failed, true);
    assert.match(out, /model  ·  unknown/);
    assert.match(out, /Did you mean: grok-4\.5/);
    assert.match(out, /Next  \/model grok-4\.5/);
  });
});
