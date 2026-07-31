import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { toolAskUser } from "../src/agent/tools/ask-user.js";
import { executeTool } from "../src/agent/tools/index.js";
import { TOOL_DEFINITIONS } from "../src/agent/tools/definitions.js";

describe("ask_user", () => {
  let prevHeadless: string | undefined;

  before(() => {
    prevHeadless = process.env.FORGE_HEADLESS;
    process.env.FORGE_HEADLESS = "1";
  });

  after(() => {
    if (prevHeadless === undefined) delete process.env.FORGE_HEADLESS;
    else process.env.FORGE_HEADLESS = prevHeadless;
  });

  it("is in TOOL_DEFINITIONS", () => {
    assert.ok(
      TOOL_DEFINITIONS.some(
        (d) => d.type === "function" && d.function.name === "ask_user",
      ),
    );
  });

  it("fails closed in headless", async () => {
    const r = await toolAskUser({
      question: "Ship it?",
      choices: ["yes", "no"],
    });
    assert.equal(r.isError, true);
    assert.match(r.output, /headless|non-interactive/i);
    assert.match(r.output, /yes/);
  });

  it("rejects empty question", async () => {
    const r = await toolAskUser({ question: "  " });
    assert.equal(r.isError, true);
    assert.match(r.output, /non-empty/i);
  });

  it("executeTool dispatches ask_user + aliases", async () => {
    const ctx = { workspace: process.cwd() };
    for (const name of ["ask_user", "AskUser", "question"]) {
      const r = await executeTool(
        name,
        JSON.stringify({ question: "ok?" }),
        ctx,
      );
      assert.equal(r.isError, true);
      assert.match(r.output, /headless|non-interactive|unavailable/i);
    }
  });
});

describe("dontAsk visibility", () => {
  it("productionWarnings flags dontAsk mode", async () => {
    // Import via doctor path which is public
    const { runDoctorCheck } = await import("../src/commands/slash.js");
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const doc = await runDoctorCheck({
      ...DEFAULT_CONFIG,
      permissionMode: "dontAsk",
      workspace: process.cwd(),
    });
    assert.match(doc.report, /dontAsk/i);
    assert.match(doc.report, /ask_user/i);
  });

  it("rejects empty question with recovery example", async () => {
    for (const question of ["", "   "]) {
      const r = await toolAskUser({ question });
      assert.equal(r.isError, true);
      assert.match(String(r.output || ""), /question is required/i);
      assert.match(String(r.output || ""), /Example:/i);
      assert.match(String(r.output || ""), /Whitespace-only questions fail closed/i);
    }
  });
});
