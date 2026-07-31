import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  evaluateTodoGateAtStop,
  clearTodoGateState,
  getTodoGateFires,
} from "../src/harness/todo-gate.js";

describe("TodoGate advisory release", () => {
  let prevHome: string | undefined;
  let tmp: string;
  beforeEach(() => {
    prevHome = process.env.FORGE_HOME;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-todo-adv-"));
    process.env.FORGE_HOME = tmp;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prevHome;
  });

  it("blocks open todos under ULW for normal work answers", () => {
    clearTodoGateState("tg-work");
    const r = evaluateTodoGateAtStop({
      sessionId: "tg-work",
      ulwEnabled: true,
      ultraworkFlag: true,
      openTodoCount: 2,
      lastAssistantMessage: "I updated the files and will continue.",
    });
    assert.equal(r.block, true);
  });

  it("releases when last user message is advisory Q&A", () => {
    clearTodoGateState("tg-adv-user");
    const r = evaluateTodoGateAtStop({
      sessionId: "tg-adv-user",
      ulwEnabled: true,
      ultraworkFlag: true,
      openTodoCount: 2,
      lastAssistantMessage: "Here is my take on the design tradeoffs.",
      lastUserMessage: "what do you think about the landing page?",
    });
    assert.equal(r.block, false);
  });

  it("releases when assistant message itself is a pure question", () => {
    clearTodoGateState("tg-adv-as");
    const r = evaluateTodoGateAtStop({
      sessionId: "tg-adv-as",
      ulwEnabled: true,
      ultraworkFlag: true,
      openTodoCount: 2,
      lastAssistantMessage: "Should we use postgres or sqlite?",
    });
    assert.equal(r.block, false);
  });

  it("maybeTodoNudge skips when last user message is advisory", async () => {
    const {
      maybeTodoNudge,
      noteAssistantTurn,
      resetTodoNudgeForPrompt,
      clearTodoGateState,
    } = await import("../src/harness/todo-gate.js");
    const sid = "tg-nudge-adv";
    clearTodoGateState(sid);
    resetTodoNudgeForPrompt(sid);
    // Become eligible: enough assistant turns without todo_write
    for (let i = 0; i < 5; i++) noteAssistantTurn(sid);
    const work = maybeTodoNudge({
      sessionId: sid,
      harnessActive: true,
      openTodoCount: 2,
      lastUserMessage: "please implement the remaining todos",
    });
    assert.ok(work && /todo/i.test(work), "expected work-order nudge");

    clearTodoGateState(sid);
    resetTodoNudgeForPrompt(sid);
    for (let i = 0; i < 5; i++) noteAssistantTurn(sid);
    const adv = maybeTodoNudge({
      sessionId: sid,
      harnessActive: true,
      openTodoCount: 2,
      lastUserMessage: "what do you think about the landing page?",
    });
    assert.equal(adv, null);
  });

  it("advisory release clears soft TodoGate fire count", () => {
    const sid = "tg-soft-clear";
    clearTodoGateState(sid);
    // Fire soft gate once outside ULW
    const r1 = evaluateTodoGateAtStop({
      sessionId: sid,
      ulwEnabled: false,
      ultraworkFlag: false,
      openTodoCount: 2,
      lastAssistantMessage: "Stopping with open todos.",
    });
    assert.equal(r1.block, true);
    assert.ok(getTodoGateFires(sid) >= 1);
    // Advisory Q&A should release and clear soft fires
    const r2 = evaluateTodoGateAtStop({
      sessionId: sid,
      ulwEnabled: false,
      ultraworkFlag: false,
      openTodoCount: 2,
      lastAssistantMessage: "Here is my analysis.",
      lastUserMessage: "what do you think about the design?",
    });
    assert.equal(r2.block, false);
    assert.equal(getTodoGateFires(sid), 0);
    // Soft gate can fire again on next work stop
    const r3 = evaluateTodoGateAtStop({
      sessionId: sid,
      ulwEnabled: false,
      ultraworkFlag: false,
      openTodoCount: 2,
      lastAssistantMessage: "Stopping again with open todos.",
    });
    assert.equal(r3.block, true);
  });
});
