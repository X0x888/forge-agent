import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import {
  formatAskUserCard,
  formatAskUserPrompt,
  matchAskUserAnswer,
  toolAskUser,
} from "../src/agent/tools/ask-user.js";
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

  it("card is question + numbered choices, not a lecture", () => {
    const card = formatAskUserCard("Ship it?", ["yes", "no"], "destructive");
    assert.match(card, /Ship it\?/);
    assert.match(card, /1\) yes/);
    assert.match(card, /2\) no/);
    assert.match(card, /destructive/);
    assert.doesNotMatch(card, /Agent question/);
    assert.doesNotMatch(card, /Reply with/);
    assert.ok(!card.startsWith("\n"), "no leading blank-line sandwich");
    // Short choice lists stay one row so the card doesn't eat the transcript.
    const rows = card.split("\n");
    assert.equal(rows.length, 3, "question + context + one choice row");
    assert.match(rows[2]!, /1\) yes/);
    assert.match(rows[2]!, /2\) no/);
  });

  it("stacks long choice lists so keys stay visible", () => {
    const card = formatAskUserCard(
      "Which path?",
      [
        "keep the current worktree and continue",
        "discard the isolated branch",
        "open a pull request against main",
      ],
      "",
    );
    const rows = card.split("\n");
    assert.ok(rows.length >= 4, "long choices stack");
    assert.match(card, /1\) keep the current worktree/);
    assert.match(card, /3\) open a pull request/);
  });

  it("matches unique prefix and first letter", () => {
    const yn = ["yes", "no"];
    assert.deepEqual(matchAskUserAnswer("y", yn), { kind: "choice", index: 0 });
    assert.deepEqual(matchAskUserAnswer("n", yn), { kind: "choice", index: 1 });
    assert.deepEqual(matchAskUserAnswer("ye", yn), { kind: "choice", index: 0 });
    assert.deepEqual(matchAskUserAnswer("2", yn), { kind: "choice", index: 1 });
    assert.deepEqual(matchAskUserAnswer("skip", yn), { kind: "skip" });
    assert.deepEqual(matchAskUserAnswer("maybe later", yn), {
      kind: "text",
      value: "maybe later",
    });
    // Ambiguous first letter stays free text (keep vs kill).
    assert.deepEqual(matchAskUserAnswer("k", ["keep", "kill"]), {
      kind: "text",
      value: "k",
    });
  });

  it("prompt advertises letter and prefix answers", () => {
    const card = formatAskUserCard("Ship it?", ["yes", "no"]);
    const prompt = formatAskUserPrompt(["yes", "no"]);
    assert.match(card, /1\) yes/);
    assert.match(prompt, /letter \/ unique prefix/i);
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
