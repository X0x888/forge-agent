import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildChatRequest } from "../src/agent/loop.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";
import {
  parseCursorModelId,
  resolveCursorModelAlias,
  resolveCursorRunModel,
} from "../src/config/cursor-model.js";
import {
  defaultEffortForModel,
  modelSupportsReasoningEffort,
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
  it("maps fable / fabel typos to claude-fable-5", () => {
    assert.equal(resolveCursorModelAlias("fable"), "claude-fable-5");
    assert.equal(resolveCursorModelAlias("fabel"), "claude-fable-5");
    assert.equal(resolveCursorModelAlias("claude-fable"), "claude-fable-5");
  });
});

describe("resolveCursorRunModel — class mapping", () => {
  it("Fable default: thinking off, max_mode at 1M, effort max", () => {
    const r = resolveCursorRunModel({
      model: "claude-fable-5",
      reasoningEffort: "max",
      contextWindow: 1_000_000,
    });
    assert.equal(r.baseId, "claude-fable-5");
    assert.equal(r.thinking, false);
    assert.equal(r.maxMode, true);
    assert.deepEqual(
      r.parameters.find((p) => p.id === "thinking"),
      { id: "thinking", value: "false" },
    );
    assert.deepEqual(
      r.parameters.find((p) => p.id === "effort"),
      { id: "effort", value: "max" },
    );
  });

  it("pins below 1M turn Max Mode off", () => {
    const r = resolveCursorRunModel({
      model: "claude-fable-5",
      contextWindow: 300_000,
    });
    assert.equal(r.maxMode, false);
  });

  it("thinking comes from the id suffix, effort from ChatRequest", () => {
    const r = resolveCursorRunModel({
      model: "claude-fable-5-thinking-high",
      reasoningEffort: "max",
      contextWindow: 1_000_000,
    });
    assert.equal(r.thinking, true);
    assert.deepEqual(
      r.parameters.find((p) => p.id === "thinking"),
      { id: "thinking", value: "true" },
    );
    assert.deepEqual(
      r.parameters.find((p) => p.id === "effort"),
      { id: "effort", value: "max" },
    );
  });

  it("xhigh maps to Cursor reasoning extra-high", () => {
    const r = resolveCursorRunModel({
      model: "grok-4.6",
      reasoningEffort: "xhigh",
    });
    assert.deepEqual(
      r.parameters.find((p) => p.id === "reasoning"),
      { id: "reasoning", value: "extra-high" },
    );
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

  it("AgentRunRequest includes requested_model field 9", () => {
    const run = encodeAgentRunRequest({
      conversationState: encodeConversationState({ turns: [] }),
      action: encodeConversationActionUser("hi", "m1"),
      modelId: "claude-fable-5",
      conversationId: "c1",
      thinking: false,
      maxMode: true,
      parameters: [{ id: "effort", value: "max" }],
    });
    const fields = decodeFields(run);
    assert.ok(fields.some((f) => f.field === 3));
    assert.ok(fields.some((f) => f.field === 9));
  });
});
