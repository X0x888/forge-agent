import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildChatRequest } from "../src/agent/loop.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";
import { loadConfig } from "../src/config/load.js";
import {
  parseCursorModelId,
  resolveCursorModelAlias,
  resolveCursorRunModel,
} from "../src/config/cursor-model.js";
import {
  defaultEffortForModel,
  modelSupportsReasoningEffort,
  resolveReasoningEffort,
} from "../src/config/reasoning.js";
import { modelContextWindow } from "../src/config/model-info.js";
import {
  decodeFields,
  encodeAgentRunRequest,
  encodeConversationActionUser,
  encodeConversationState,
  encodeModelDetails,
  encodeRequestedModel,
  fieldStr,
  fieldVarint,
} from "../src/providers/cursor-proto.js";

describe("parseCursorModelId", () => {
  it("leaves a bare id alone with thinking off", () => {
    const p = parseCursorModelId("claude-fable-5");
    assert.equal(p.baseId, "claude-fable-5");
    assert.equal(p.thinking, false);
    assert.equal(p.fast, false);
    assert.equal(p.effort, undefined);
  });

  it("strips thinking / effort / fast suffixes longest-first", () => {
    const p = parseCursorModelId("claude-fable-5-thinking-high");
    assert.equal(p.baseId, "claude-fable-5");
    assert.equal(p.thinking, true);
    assert.equal(p.effort, "high");
    const g = parseCursorModelId("grok-4.6-xhigh-fast");
    assert.equal(g.baseId, "grok-4.6");
    assert.equal(g.effort, "xhigh");
    assert.equal(g.fast, true);
    assert.equal(g.thinking, false);
  });

  it("does not eat -xhigh as -high", () => {
    assert.equal(parseCursorModelId("grok-4.6-xhigh").effort, "xhigh");
  });
});

describe("resolveCursorModelAlias", () => {
  it("maps fable / grok shorthands to live catalog variant ids", () => {
    assert.equal(resolveCursorModelAlias("fable"), "claude-fable-5-max");
    assert.equal(resolveCursorModelAlias("fabel"), "claude-fable-5-max");
    assert.equal(resolveCursorModelAlias("grok-4.6"), "cursor-grok-4.6-xhigh-fast");
    assert.equal(
      resolveCursorModelAlias("grok-4.6-high-fast"),
      "cursor-grok-4.6-high-fast",
    );
  });
});

describe("resolveCursorRunModel — class mapping", () => {
  it("Fable default: thinking off, max_mode at 1M, variant -max", () => {
    const r = resolveCursorRunModel({
      model: "claude-fable-5",
      reasoningEffort: "max",
      contextWindow: 1_000_000,
    });
    assert.equal(r.serverId, "claude-fable-5-max");
    assert.equal(r.thinking, false);
    assert.equal(r.maxMode, true);
    assert.equal(r.isVariantString, true);
  });

  it("pins below 1M turn Max Mode off", () => {
    const r = resolveCursorRunModel({
      model: "claude-fable-5",
      contextWindow: 300_000,
    });
    assert.equal(r.maxMode, false);
  });

  it("thinking + effort rebuild a catalog variant id", () => {
    const r = resolveCursorRunModel({
      model: "claude-fable-5-thinking-high",
      reasoningEffort: "max",
      contextWindow: 1_000_000,
    });
    assert.equal(r.thinking, true);
    assert.equal(r.serverId, "claude-fable-5-thinking-max");
  });

  it("xhigh + fast on grok-4.6 is cursor-grok-4.6-xhigh-fast", () => {
    const r = resolveCursorRunModel({
      model: "grok-4.6",
      reasoningEffort: "xhigh",
    });
    assert.equal(r.serverId, "cursor-grok-4.6-xhigh-fast");
  });

  it("Cursor default grok-4.6 is xhigh + Fast, thinking off", () => {
    const r = resolveCursorRunModel({
      model: "grok-4.6",
      reasoningEffort: defaultEffortForModel("cursor-grok-4.6-xhigh-fast"),
    });
    assert.equal(r.serverId, "cursor-grok-4.6-xhigh-fast");
    assert.equal(r.thinking, false);
    assert.equal(r.fast, true);
  });

  it("explicit High Fast id stays High + Fast", () => {
    const r = resolveCursorRunModel({
      model: "grok-4.6-high-fast",
      reasoningEffort: defaultEffortForModel("grok-4.6-high-fast"),
    });
    assert.equal(r.serverId, "cursor-grok-4.6-high-fast");
    assert.equal(r.thinking, false);
    assert.equal(r.fast, true);
  });
});

describe("Cursor default grok-4.6-xhigh-fast effort", () => {
  it("id suffix xhigh is the Cursor grok-4.6 default; High Fast stays high", () => {
    assert.equal(defaultEffortForModel("cursor-grok-4.6-xhigh-fast"), "xhigh");
    assert.equal(defaultEffortForModel("grok-4.6-high-fast"), "high");
    assert.equal(defaultEffortForModel("cursor-grok-4.6-high-fast"), "high");
    assert.equal(defaultEffortForModel("grok-4.6"), "xhigh");
    assert.equal(
      resolveReasoningEffort("cursor-grok-4.6-xhigh-fast", undefined),
      "xhigh",
    );
    assert.equal(
      resolveReasoningEffort("cursor-grok-4.6-high-fast", undefined),
      "high",
    );
    assert.equal(resolveReasoningEffort("grok-4.6", undefined), "xhigh");
  });

  it("unpinned High Fast does not rebuild to xhigh-fast", () => {
    const r = resolveCursorRunModel({
      model: "cursor-grok-4.6-high-fast",
      reasoningEffort: resolveReasoningEffort(
        "cursor-grok-4.6-high-fast",
        undefined,
      ),
    });
    assert.equal(r.serverId, "cursor-grok-4.6-high-fast");
  });

  it("explicit xhigh overlay rewrites the catalog variant", () => {
    const r = resolveCursorRunModel({
      model: "cursor-grok-4.6-high-fast",
      reasoningEffort: "xhigh",
    });
    assert.equal(r.serverId, "cursor-grok-4.6-xhigh-fast");
  });
});

describe("Fable in the Forge model class", () => {
  it("1M context and max effort", () => {
    assert.equal(modelContextWindow("claude-fable-5"), 1_000_000);
    assert.equal(modelSupportsReasoningEffort("claude-fable-5"), true);
    assert.equal(defaultEffortForModel("claude-fable-5"), "max");
  });

  it("buildChatRequest carries effort + context_window for Cursor mapping", () => {
    const req = buildChatRequest(
      {
        ...DEFAULT_CONFIG,
        provider: "cursor",
        model: "claude-fable-5",
        contextWindow: 1_000_000,
        reasoningEffort: undefined,
      },
      [{ role: "user", content: "hi" }],
    );
    assert.equal(req.reasoning_effort, "max");
    assert.equal(req.context_window, 1_000_000);
  });

  it("buildChatRequest keeps High Fast at high, not grok xhigh", () => {
    const req = buildChatRequest(
      {
        ...DEFAULT_CONFIG,
        provider: "cursor",
        model: "cursor-grok-4.6-high-fast",
        reasoningEffort: undefined,
      },
      [{ role: "user", content: "hi" }],
    );
    assert.equal(req.reasoning_effort, "high");
  });

  it("buildChatRequest for Cursor grok-4.6 default is xhigh", () => {
    const req = buildChatRequest(
      {
        ...DEFAULT_CONFIG,
        provider: "cursor",
        model: "cursor-grok-4.6-xhigh-fast",
        reasoningEffort: undefined,
        workspace: "/Users/s./code/hobby/forge-agent",
      },
      [{ role: "user", content: "hi" }],
    );
    assert.equal(req.reasoning_effort, "xhigh");
    assert.equal(req.workspace, "/Users/s./code/hobby/forge-agent");
  });
});

describe("Cursor proto ModelDetails + RequestedModel", () => {
  it("omits thinking_details when thinking is off; sets max_mode", () => {
    const buf = encodeModelDetails("claude-fable-5", {
      thinking: false,
      maxMode: true,
    });
    const fields = decodeFields(buf);
    assert.equal(fieldStr(fields, 1), "claude-fable-5");
    assert.equal(fields.some((f) => f.field === 2), false);
    assert.equal(fieldVarint(fields, 7), 1);
  });

  it("emits empty thinking_details when thinking is on", () => {
    const buf = encodeModelDetails("claude-fable-5", { thinking: true });
    const fields = decodeFields(buf);
    const t = fields.find((f) => f.field === 2);
    assert.ok(t);
    assert.equal(t!.wire, 2);
    assert.equal(t!.bytes.length, 0);
  });

  it("RequestedModel carries parameters and max_mode", () => {
    const buf = encodeRequestedModel({
      modelId: "claude-fable-5",
      maxMode: true,
      parameters: [
        { id: "thinking", value: "false" },
        { id: "effort", value: "max" },
      ],
    });
    const fields = decodeFields(buf);
    assert.equal(fieldStr(fields, 1), "claude-fable-5");
    assert.equal(fieldVarint(fields, 2), 1);
    const params = fields.filter((f) => f.field === 3);
    assert.equal(params.length, 2);
  });

  it("AgentRunRequest sends model_details and conversation_id, not requested_model", () => {
    const run = encodeAgentRunRequest({
      conversationState: encodeConversationState({ turns: [] }),
      action: encodeConversationActionUser("hi", "m1"),
      modelId: "cursor-grok-4.6-high-fast",
      conversationId: "c1",
      thinking: false,
      maxMode: false,
    });
    const fields = decodeFields(run);
    assert.ok(fields.some((f) => f.field === 3));
    assert.ok(fields.some((f) => f.field === 5));
    assert.equal(fields.some((f) => f.field === 9), false);
  });
});

describe("loadConfig Cursor aliases", () => {
  let tmp: string;
  let prevHome: string | undefined;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-cursor-load-"));
    prevHome = process.env.FORGE_HOME;
    process.env.FORGE_HOME = tmp;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prevHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("resolves grok-4.6 to the xhigh Fast catalog variant", () => {
    const cfg = loadConfig(
      { provider: "cursor", model: "grok-4.6" },
      tmp,
    );
    assert.equal(cfg.model, "cursor-grok-4.6-xhigh-fast");
  });
});
