/**
 * Parallel read-only tool batching name normalize.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isReadOnlyToolName } from "../src/agent/loop.js";

describe("isReadOnlyToolName", () => {
  it("recognizes canonical and alias names", () => {
    assert.equal(isReadOnlyToolName("read_file"), true);
    assert.equal(isReadOnlyToolName("Read"), true);
    assert.equal(isReadOnlyToolName("read"), true);
    assert.equal(isReadOnlyToolName("grep"), true);
    assert.equal(isReadOnlyToolName("web_search"), true);
    assert.equal(isReadOnlyToolName("web_fetch"), true);
    assert.equal(isReadOnlyToolName("get_task_output"), true);
    assert.equal(isReadOnlyToolName("todo_write"), false);
  });

  it("rejects mutations", () => {
    assert.equal(isReadOnlyToolName("write_file"), false);
    assert.equal(isReadOnlyToolName("bash"), false);
    assert.equal(isReadOnlyToolName("search_replace"), false);
    assert.equal(isReadOnlyToolName("apply_patch"), false);
    assert.equal(isReadOnlyToolName("kill_task"), false);
  });

  it("handles doubled stream-bug names via normalize", () => {
    assert.equal(isReadOnlyToolName("read_fileread_file"), true);
    assert.equal(isReadOnlyToolName("ReadRead"), true);
  });
});
