import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { suggestTopLevelCommand } from "../src/cli/suggest-command.js";

describe("suggestTopLevelCommand", () => {
  it("hello is a task, not help", () => {
    assert.equal(suggestTopLevelCommand("hello"), null);
    assert.equal(suggestTopLevelCommand("Hello"), null);
  });

  it("helpp recovers to help", () => {
    assert.equal(suggestTopLevelCommand("helpp"), "help");
  });

  it("multi-word English is a run", () => {
    assert.equal(suggestTopLevelCommand("hello world"), null);
    assert.equal(suggestTopLevelCommand("fix the tests"), null);
  });

  it("sesions recovers to sessions", () => {
    assert.equal(suggestTopLevelCommand("sesions"), "sessions");
  });

  it("short tokens and exact commands are not typos", () => {
    assert.equal(suggestTopLevelCommand("hi"), null);
    assert.equal(suggestTopLevelCommand("ok"), null);
    assert.equal(suggestTopLevelCommand("fix"), null);
    assert.equal(suggestTopLevelCommand("help"), null);
    assert.equal(suggestTopLevelCommand("cfg"), "config");
  });
});
