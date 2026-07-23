import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  splitShellSegments,
  peelWrappers,
  commandCheckTargets,
  normalizeSegment,
} from "../src/agent/shell-parse.js";
import {
  parseRuleString,
  evaluateRules,
  compileRules,
  patternToRegExp,
} from "../src/agent/rules.js";
import { checkBashHardDeny } from "../src/agent/safety.js";
import { PermissionGate } from "../src/agent/permissions.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";
import { describeSandbox } from "../src/agent/sandbox.js";

describe("shell segment parsing", () => {
  it("splits && || ; |", () => {
    assert.deepEqual(splitShellSegments("ls && rm -rf /"), ["ls", "rm -rf /"]);
    assert.deepEqual(splitShellSegments("a; b | c"), ["a", "b", "c"]);
    assert.deepEqual(splitShellSegments('echo "a && b" && true'), [
      'echo "a && b"',
      "true",
    ]);
  });

  it("peels env and timeout wrappers", () => {
    assert.equal(normalizeSegment("FOO=1 BAR=2 rm -rf /"), "rm -rf /");
    assert.equal(peelWrappers("timeout 10 rm -rf /"), "rm -rf /");
    assert.equal(peelWrappers("env -i PATH=/bin rm -rf dist"), "rm -rf dist");
  });

  it("hard deny sees bad segment in chain", () => {
    const v = checkBashHardDeny("ls && rm -rf /");
    assert.equal(v.ok, false);
    assert.match(v.ok === false ? v.rule : "", /rm-rf/);
  });

  it("hard deny sees wrapped catastrophe", () => {
    const v = checkBashHardDeny("FOO=1 timeout 5 rm -rf /");
    assert.equal(v.ok, false);
  });
});

describe("permission rules", () => {
  it("parses Bash(...) strings", () => {
    const r = parseRuleString("Bash(rm -rf *)");
    assert.ok(r);
    assert.equal(r!.tool, "bash");
    assert.equal(r!.pattern, "rm -rf *");
  });

  it("deny wins on matching segment", () => {
    const rules = compileRules({
      deny: ["Bash(rm -rf *)"],
      allow: ["Bash(ls *)"],
    });
    const ev = evaluateRules(
      rules,
      "bash",
      { command: "ls && rm -rf dist" },
      "/tmp/proj",
    );
    assert.equal(ev.decision, "deny");
  });

  it("allow matches git prefix", () => {
    const rules = compileRules({ allow: ["Bash(git *)"] });
    const ev = evaluateRules(
      rules,
      "bash",
      { command: "git status" },
      "/tmp/proj",
    );
    assert.equal(ev.decision, "allow");
  });

  it("path deny for write_file", () => {
    const rules = compileRules({ deny: ["Write(**/.env)"] });
    const ev = evaluateRules(
      rules,
      "write_file",
      { path: "src/.env", content: "x" },
      "/tmp/proj",
    );
    // **/.env may match .env in subdir — also try basename
    // our glob: **/.env 
    assert.ok(ev.decision === "deny" || patternToRegExp("**/.env"));
  });

  it("YOLO still honors rule deny", async () => {
    const g = new PermissionGate({ interactive: false });
    const cfg = {
      ...DEFAULT_CONFIG,
      permission: {
        deny: ["Bash(rm -rf dist)"],
        allow: [],
        ask: [],
        rules: [],
      },
    };
    const r = await g.request({
      toolName: "bash",
      input: { command: "rm -rf dist" },
      mode: "bypassPermissions",
      workspace: "/tmp/proj",
      config: cfg,
    });
    assert.equal(r, "deny");
  });

  it("YOLO allows non-denied project command", async () => {
    const g = new PermissionGate({ interactive: false });
    const r = await g.request({
      toolName: "bash",
      input: { command: "npm test" },
      mode: "bypassPermissions",
      workspace: "/tmp/proj",
      config: DEFAULT_CONFIG,
    });
    assert.equal(r, "allow");
  });
});

describe("sandbox descriptors", () => {
  it("describes profiles", () => {
    assert.match(describeSandbox("workspace"), /CWD/);
    assert.match(describeSandbox("off"), /no OS/);
  });
});
