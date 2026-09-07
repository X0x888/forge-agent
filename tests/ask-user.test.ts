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

  it("fails closed while the ULW cycle driver is armed — the run is unattended, the root's arm covers every session under it, and a human /plan hands the keyboard back", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { armCycle, disarmCycle } = await import("../src/harness/cycle/index.js");
    const { mkGitRepo } = await import("./helpers/cycle-arm.js");
    const prevHome = process.env.FORGE_HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ask-ulw-home-"));
    process.env.FORGE_HOME = home;
    try {
      const cwd = mkGitRepo("forge-ask-ulw-");
      const sid = "ask-ulw-root";
      armCycle({ sessionId: sid, mandate: "add a widget", cwd });
      const asSession = (meta: Record<string, unknown>) => ({ session: { meta } as never });
      const root = await executeTool(
        "ask_user",
        JSON.stringify({ question: "Ship the migration now, or wait?", choices: ["ship now", "wait"] }),
        { workspace: cwd, ...asSession({ id: sid }) },
      );
      assert.equal(root.isError, true);
      assert.match(root.output, /^ask_user is off: the ULW cycle driver is armed \(an unattended run\)\. Nobody is at the keyboard\./);
      assert.match(root.output, /Decide it yourself and record the assumption in your closer/);
      assert.match(root.output, /write an Operator: line and continue/);
      assert.match(root.output, /Your choices were: 1\) ship now; 2\) wait\. Question was: Ship the migration now, or wait\?/);
      assert.doesNotMatch(root.output, /headless/);
      // A harness role (the Reviewer) is a child of the armed session.
      const child = await executeTool(
        "ask_user",
        JSON.stringify({ question: "Keep the old key?" }),
        { workspace: cwd, ...asSession({ id: "ask-ulw-child", subagent: { parentId: sid, type: "general-purpose", isolation: "none" } }) },
      );
      assert.match(child.output, /^ask_user is off: the ULW cycle driver is armed/);
      // The Planner's explore child is a grandchild: its parent is the Planner's
      // own session, which has no ulw.json. The walk follows the chain to the root.
      const { createSession, saveSession } = await import("../src/session/session.js");
      const planner = createSession({ cwd, provider: "xai", model: "grok-4", title: "cycle planner: test" });
      planner.meta.subagent = { parentId: sid, type: "general-purpose", isolation: "none" };
      saveSession(planner);
      const grandchild = await executeTool(
        "ask_user",
        JSON.stringify({ question: "Which module holds the export?" }),
        { workspace: cwd, ...asSession({ id: "ask-ulw-explore", subagent: { parentId: planner.meta.id, type: "explore", isolation: "none" } }) },
      );
      assert.match(grandchild.output, /^ask_user is off: the ULW cycle driver is armed/);
      // A chain that ends in an unarmed, unknown parent is not unattended.
      const orphan = await executeTool(
        "ask_user",
        JSON.stringify({ question: "Which module holds the export?" }),
        { workspace: cwd, ...asSession({ id: "ask-ulw-orphan", subagent: { parentId: "no-such-session", type: "explore", isolation: "none" } }) },
      );
      assert.match(orphan.output, /headless\/non-interactive/);
      // Human /plan: the user has taken planning over and holds the keyboard.
      const { setHumanPlan } = await import("../src/harness/cycle/index.js");
      setHumanPlan(sid, true);
      const humanPlan = await executeTool(
        "ask_user",
        JSON.stringify({ question: "Ship the migration now, or wait?" }),
        { workspace: cwd, ...asSession({ id: sid }) },
      );
      assert.match(humanPlan.output, /headless\/non-interactive/, "under /plan the ordinary path is back");
      setHumanPlan(sid, false);
      const armedAgain = await executeTool(
        "ask_user",
        JSON.stringify({ question: "Ship the migration now, or wait?" }),
        { workspace: cwd, ...asSession({ id: sid }) },
      );
      assert.match(armedAgain.output, /^ask_user is off: the ULW cycle driver is armed/, "/build hands it back");
      // Disarmed: the ordinary (headless here) path is back.
      disarmCycle(sid);
      const after = await executeTool(
        "ask_user",
        JSON.stringify({ question: "Keep the old key?" }),
        { workspace: cwd, ...asSession({ id: sid }) },
      );
      assert.match(after.output, /headless\/non-interactive/);
      // An unrelated session is untouched.
      const other = await executeTool(
        "ask_user",
        JSON.stringify({ question: "Keep the old key?" }),
        { workspace: cwd, ...asSession({ id: "ask-ulw-other" }) },
      );
      assert.match(other.output, /headless\/non-interactive/);
    } finally {
      if (prevHome === undefined) delete process.env.FORGE_HOME;
      else process.env.FORGE_HOME = prevHome;
    }
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

  it("prompt is Allow?-style keys, not a spec dump", () => {
    const card = formatAskUserCard("Ship it?", ["yes", "no"]);
    const prompt = formatAskUserPrompt(["yes", "no"]);
    assert.match(card, /1\) yes/);
    assert.match(prompt, /^Ask\? 1[–-]2/);
    assert.match(prompt, /letter/);
    assert.match(prompt, /↵ skip/);
    assert.doesNotMatch(prompt, /Your answer/);
    assert.doesNotMatch(prompt, /unique prefix/);
    const free = formatAskUserPrompt([]);
    assert.match(free, /^Ask\? text · ↵ skip/);
  });

  it("prompt wraps at · so keys stay visible on a narrow TTY", () => {
    const prompt = formatAskUserPrompt(["yes", "no"], { columns: 16 });
    const rows = prompt.split("\n");
    assert.ok(rows.length >= 2, "keys wrap");
    assert.match(rows[0]!, /^Ask\? 1[–-]2/);
    assert.match(prompt, /↵ skip/);
    assert.ok(prompt.endsWith(" "), "trailing space for readline");
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
