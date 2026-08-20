import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../src/config/types.js";
import { buildBaselineSystemPrompt } from "../src/agent/system-prompt.js";
import {
  decodeFields,
  encodeBytes,
  encodeMessage,
  encodeString,
  encodeUint32,
  fieldStr,
  fieldVarint,
  parseReadArgs,
  parseWriteArgs,
} from "../src/providers/cursor-proto.js";
import {
  mapCursorNativeExec,
  rawFileTextFromToolOutput,
  toolOutputLooksError,
} from "../src/providers/cursor-exec.js";
import {
  encodeWriteError,
  encodeWriteSuccess,
} from "../src/providers/cursor-proto.js";
import {
  isDisposableTestRelPath,
  isSensitiveRelPath,
} from "../src/util/git-auto-commit.js";

function concat(...parts: Uint8Array[]): Buffer {
  return Buffer.concat(parts);
}

describe("parseWriteArgs", () => {
  it("reads path + file_text (fields 1/2)", () => {
    const payload = concat(
      encodeString(1, "/tmp/a.ts"),
      encodeString(2, "export const x = 1;\n"),
      encodeString(3, "tc_1"),
    );
    const w = parseWriteArgs(payload);
    assert.equal(w.path, "/tmp/a.ts");
    assert.equal(w.content, "export const x = 1;\n");
    assert.equal(w.toolCallId, "tc_1");
    assert.equal(w.binary, false);
  });

  it("prefers file_bytes over file_text", () => {
    const payload = concat(
      encodeString(1, "b.ts"),
      encodeString(2, "ignored"),
      encodeBytes(5, Buffer.from("from-bytes", "utf8")),
    );
    const w = parseWriteArgs(payload);
    assert.equal(w.content, "from-bytes");
    assert.equal(w.binary, false);
  });

  it("marks NUL bytes as binary instead of corrupting text", () => {
    const payload = concat(
      encodeString(1, "x.bin"),
      encodeBytes(5, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00])),
    );
    const w = parseWriteArgs(payload);
    assert.equal(w.binary, true);
    assert.equal(w.content, undefined);
  });

  it("keeps empty file_text (truncate)", () => {
    const payload = concat(encodeString(1, "empty.ts"), encodeString(2, ""));
    const w = parseWriteArgs(payload);
    assert.equal(w.content, "");
    assert.equal(w.binary, false);
  });
});

describe("parseReadArgs", () => {
  it("omits protobuf-default offset/limit 0", () => {
    const payload = concat(
      encodeString(1, "src/cli.ts"),
      encodeString(2, "tc"),
      encodeUint32(4, 0),
      encodeUint32(5, 0),
    );
    const r = parseReadArgs(payload);
    assert.equal(r.path, "src/cli.ts");
    assert.equal(r.offset, undefined);
    assert.equal(r.limit, undefined);
  });
});

describe("mapCursorNativeExec", () => {
  it("maps writeArgs onto write_file", () => {
    const mapped = mapCursorNativeExec({
      execKind: "writeArgs",
      execId: "e1",
      payload: concat(
        encodeString(1, "src/cli.ts"),
        encodeString(2, "hi\n"),
      ),
    });
    assert.ok(mapped);
    assert.equal(mapped.toolName, "write_file");
    assert.equal(mapped.args.path, "src/cli.ts");
    assert.equal(mapped.args.content, "hi\n");
    assert.equal(mapped.resultKind, "write");
    assert.equal(mapped.resultField, 3);
  });

  it("maps unbounded readArgs with limit 0 (edit handshake)", () => {
    const mapped = mapCursorNativeExec({
      execKind: "readArgs",
      execId: "e1",
      payload: encodeString(1, "src/cli.ts"),
    });
    assert.ok(mapped);
    assert.equal(mapped.toolName, "read_file");
    assert.equal(mapped.args.limit, 0);
    assert.equal(mapped.resultKind, "read");
  });

  it("maps empty-pattern grep onto glob", () => {
    const mapped = mapCursorNativeExec({
      execKind: "grepArgs",
      execId: "e1",
      payload: concat(encodeString(1, ""), encodeString(3, "**/*.ts")),
    });
    assert.ok(mapped);
    assert.equal(mapped.toolName, "glob");
    assert.equal(mapped.args.pattern, "**/*.ts");
  });

  it("maps piEditArgs onto search_replace", () => {
    const edit = concat(encodeString(1, "old"), encodeString(2, "new"));
    const payload = concat(encodeString(1, "a.ts"), encodeMessage(2, edit));
    const mapped = mapCursorNativeExec({
      execKind: "piEditArgs",
      execId: "e1",
      payload,
    });
    assert.ok(mapped);
    assert.equal(mapped.toolName, "search_replace");
    assert.equal(mapped.args.old_string, "old");
    assert.equal(mapped.args.new_string, "new");
    assert.equal(mapped.resultField, 48);
  });

  it("refuses binary writeArgs so we do not map an empty write_file", () => {
    const mapped = mapCursorNativeExec({
      execKind: "writeArgs",
      execId: "e1",
      payload: concat(
        encodeString(1, "x.bin"),
        encodeBytes(5, Buffer.from([0, 1, 2])),
      ),
    });
    assert.equal(mapped, null);
  });
});

describe("typed write result", () => {
  it("encodes success as WriteResult field 1, error as field 5", () => {
    const ok = encodeWriteSuccess({
      path: "a.ts",
      linesCreated: 3,
      fileSize: 12,
    });
    const okFields = decodeFields(ok);
    assert.equal(okFields[0]!.field, 1);
    const inner = decodeFields(okFields[0]!.bytes);
    assert.equal(fieldStr(inner, 1), "a.ts");
    assert.equal(fieldVarint(inner, 2), 3);

    const err = encodeWriteError("a.ts", "nope");
    assert.equal(decodeFields(err)[0]!.field, 5);
  });
});

describe("rawFileTextFromToolOutput", () => {
  it("strips Forge N| prefixes so Cursor cannot echo them into writes", () => {
    const raw = rawFileTextFromToolOutput(
      "File: src/cli.ts (2 lines, showing 1-2)\n     1|import fs\n     2|import path\n",
    );
    assert.equal(raw.content, "import fs\nimport path\n");
    assert.equal(raw.truncated, false);
  });
});

describe("toolOutputLooksError", () => {
  it("detects write_file errors and nonzero bash", () => {
    assert.equal(
      toolOutputLooksError("write_file error: path is required", "write_file"),
      true,
    );
    assert.equal(toolOutputLooksError("ok\n[exit code 0]", "bash"), false);
    assert.equal(toolOutputLooksError("fail\n[exit code 1]", "bash"), true);
  });
});

describe("Cursor system prompt is provider-gated", () => {
  it("names Forge editors only on the Cursor path", () => {
    const cursor = buildBaselineSystemPrompt({
      config: { ...DEFAULT_CONFIG, provider: "cursor", model: "cursor-grok-4.6-xhigh-fast" },
      workspace: "/tmp",
      project: null,
      git: null,
    });
    assert.match(cursor, /Cursor provider/);
    assert.match(cursor, /write_file/);
    assert.match(cursor, /Path\.write_text/);
    assert.match(cursor, /search_mcp is only context7/);

    const xai = buildBaselineSystemPrompt({
      config: { ...DEFAULT_CONFIG, provider: "xai", model: "grok-4.6" },
      workspace: "/tmp",
      project: null,
      git: null,
    });
    assert.doesNotMatch(xai, /Cursor provider/);
    assert.doesNotMatch(xai, /Path\.write_text/);
    assert.match(xai, /search_mcp then call_mcp/);
  });
});

describe("auto-commit drops worktree-land fixtures", () => {
  it("names __wt_land_ files disposable, not secrets", () => {
    assert.equal(
      isDisposableTestRelPath(
        "src/agent/__wt_land_wt-landed-23589-mt0yhm70-temrip.md",
      ),
      true,
    );
    assert.equal(isDisposableTestRelPath("src/agent/worktree.ts"), false);
    assert.equal(
      isSensitiveRelPath("src/agent/__wt_land_wt-landed.md"),
      false,
    );
  });
});
