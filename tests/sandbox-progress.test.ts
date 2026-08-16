import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractLastNonemptyLine,
  execCommandSandboxed,
} from "../src/agent/sandbox.js";

describe("extractLastNonemptyLine", () => {
  it("returns the last nonempty line and strips ANSI", () => {
    assert.equal(extractLastNonemptyLine(""), "");
    assert.equal(extractLastNonemptyLine("a\nb\n"), "b");
    assert.equal(extractLastNonemptyLine("\x1b[32m✔ pass 12\x1b[0m\n"), "✔ pass 12");
    const long = "x".repeat(80);
    assert.equal(extractLastNonemptyLine(long).endsWith("…"), true);
    assert.ok(extractLastNonemptyLine(long).length <= 48);
  });
});

describe("sandbox onChunk", () => {
  it("emits a last-line progress callback for foreground bash", async () => {
    const seen: string[] = [];
    const r = await execCommandSandboxed({
      command: "printf 'line-one\\nline-two\\n'",
      cwd: process.cwd(),
      timeoutMs: 5000,
      profile: "off",
      onChunk: (line) => seen.push(line),
    });
    assert.equal(r.code, 0);
    assert.ok(seen.some((l) => /line-/.test(l)), `chunks=${JSON.stringify(seen)}`);
  });
});
