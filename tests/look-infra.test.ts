import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyLookLimit,
  lookLimitReceipt,
} from "../src/util/look-infra.js";
import { lookPortForSession, LOOK_PORT_BASE, LOOK_PORT_SPAN } from "../src/util/look-port.js";
import { executeTool } from "../src/agent/tools/index.js";

describe("classifyLookLimit", () => {
  it("maps TCC -10004, LS 115, EPERM, display", () => {
    assert.equal(
      classifyLookLimit("System Events got an error: A privilege violation occurred. (-10004)"),
      "tcc",
    );
    assert.equal(
      classifyLookLimit("domain=LSApplicationWorkspaceErrorDomain, code=115"),
      "ls115",
    );
    assert.equal(classifyLookLimit("simctl privacy grant EPERM"), "eperm");
    assert.equal(classifyLookLimit("could not create image from window"), "display");
    assert.equal(classifyLookLimit("ok"), null);
  });

  it("receipts tell the mill not to retry osascript", () => {
    assert.match(lookLimitReceipt("tcc"), /limited/);
    assert.match(lookLimitReceipt("tcc"), /Do not retry osascript/);
    assert.match(lookLimitReceipt("ls115"), /LS 115/);
  });
});

describe("lookPortForSession", () => {
  it("is stable per session and in range", () => {
    const a = lookPortForSession("18747acb-886a-4792-a711-026398fd66d8");
    const b = lookPortForSession("c6178453-8170-4508-a5f1-ba8a2b02c016");
    assert.equal(a, lookPortForSession("18747acb-886a-4792-a711-026398fd66d8"));
    assert.notEqual(a, b);
    assert.ok(a >= LOOK_PORT_BASE && a < LOOK_PORT_BASE + LOOK_PORT_SPAN);
    assert.ok(b >= LOOK_PORT_BASE && b < LOOK_PORT_BASE + LOOK_PORT_SPAN);
  });
});

describe("look_native classify", () => {
  it("returns a limited receipt for TCC stderr", async () => {
    const r = await executeTool(
      "look_native",
      JSON.stringify({
        action: "classify",
        text: "execution error: System Events got an error: A privilege violation occurred. (-10004)",
      }),
      { workspace: process.cwd() },
    );
    assert.equal(r.isError, false);
    assert.match(r.output, /limited/);
    assert.match(r.output, /TCC -10004/);
  });

  it("click requires x,y; unknown action still screenshots on darwin only", async () => {
    const miss = await executeTool(
      "look_native",
      JSON.stringify({ action: "click" }),
      { workspace: process.cwd(), sessionId: "look-native-click" },
    );
    assert.equal(miss.isError, true);
    assert.match(miss.output, /x and y are required/);
  });
});
