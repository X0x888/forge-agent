import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mergeStreamedToolName } from "../src/providers/openai-compat.js";
import { normalizeToolName } from "../src/agent/tools/index.js";

describe("mergeStreamedToolName", () => {
  it("does not double a full name re-sent each chunk (xAI pattern)", () => {
    let name = "";
    name = mergeStreamedToolName(name, "bash");
    name = mergeStreamedToolName(name, "bash");
    name = mergeStreamedToolName(name, "bash");
    assert.equal(name, "bash");
  });

  it("accepts growing prefixes", () => {
    let name = "";
    name = mergeStreamedToolName(name, "ba");
    name = mergeStreamedToolName(name, "bas");
    name = mergeStreamedToolName(name, "bash");
    assert.equal(name, "bash");
  });

  it("appends true fragments", () => {
    let name = "";
    name = mergeStreamedToolName(name, "to");
    name = mergeStreamedToolName(name, "do_");
    name = mergeStreamedToolName(name, "write");
    assert.equal(name, "todo_write");
  });

  it("keeps current when a shorter re-send arrives", () => {
    assert.equal(mergeStreamedToolName("todo_write", "todo"), "todo_write");
  });
});

describe("normalizeToolName", () => {
  it("recovers doubled stream names", () => {
    assert.equal(normalizeToolName("bashbash"), "bash");
    assert.equal(normalizeToolName("todo_writetodo_write"), "todo_write");
    assert.equal(normalizeToolName("list_dirlist_dir"), "list_dir");
    assert.equal(normalizeToolName("read_fileread_file"), "read_file");
    assert.equal(normalizeToolName("globglob"), "glob");
  });

  it("leaves normal names alone", () => {
    assert.equal(normalizeToolName("bash"), "bash");
    assert.equal(normalizeToolName("search_replace"), "search_replace");
  });
});
