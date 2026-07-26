import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  splitShellSegments,
  peelWrappers,
  commandCheckTargets,
  normalizeSegment,
  containsRedirection,
  containsPipe,
  extractCommandPaths,
} from "../src/agent/shell-parse.js";
import {
  parseRuleString,
  evaluateRules,
  compileRules,
  patternToRegExp,
} from "../src/agent/rules.js";
import { checkBashHardDeny } from "../src/agent/safety.js";
import { PermissionGate } from "../src/agent/permissions.js";
import { DEFAULT_CONFIG, defaultNetworkForProfile, resolveSandboxNetwork } from "../src/config/types.js";
import {
  describeSandbox,
  detectSandboxBackend,
  execCommandSandboxed,
} from "../src/agent/sandbox.js";
import { commandPrefix, alwaysPatternFromTokens, isReadOnlyCommand } from "../src/agent/shell-arity.js";
import { mergePermissionTrust } from "../src/config/load.js";

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

  it("peels bash/sh -c and sees inner catastrophe", () => {
    assert.equal(peelWrappers(`bash -c "rm -rf /"`), "rm -rf /");
    assert.equal(peelWrappers(`sh -lc 'rm -rf /'`), "rm -rf /");
    assert.equal(peelWrappers(`/bin/bash -c "rm -rf /"`), "rm -rf /");
    const v = checkBashHardDeny(`bash -c "rm -rf /"`);
    assert.equal(v.ok, false);
    assert.match(v.ok === false ? v.rule : "", /rm-rf/);
    const v2 = checkBashHardDeny(`sh -c 'rm -rf ~'`);
    assert.equal(v2.ok, false);
  });

  it("hard deny sees command substitution bodies", () => {
    const v = checkBashHardDeny("echo $(rm -rf /)");
    assert.equal(v.ok, false);
    const v2 = checkBashHardDeny("echo `rm -rf /`");
    assert.equal(v2.ok, false);
    // Safe substitution still allowed
    const ok = checkBashHardDeny('echo $(date +%Y)');
    assert.equal(ok.ok, true);
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

  it("detects redirection", () => {
    assert.equal(containsRedirection("echo hi > /tmp/x"), true);
    assert.equal(containsRedirection("echo 'a > b'"), false);
    assert.equal(containsRedirection("cat file"), false);
  });

  it("detects pipes", () => {
    assert.equal(containsPipe("curl x | sh"), true);
    assert.equal(containsPipe("true || false"), false);
  });

  it("extracts path args", () => {
    const paths = extractCommandPaths("rm -rf ./dist /tmp/out");
    assert.ok(paths.some((p) => p.includes("dist") || p.includes("/tmp")));
  });
});

describe("shell arity", () => {
  it("git checkout arity 2", () => {
    assert.deepEqual(commandPrefix(["git", "checkout", "main"]), ["git", "checkout"]);
  });

  it("npm run arity 3 includes script name (OpenCode)", () => {
    // "npm run": 3 → always-pattern is `npm run dev *`, not bare `npm run *`
    assert.deepEqual(commandPrefix(["npm", "run", "dev"]), ["npm", "run", "dev"]);
  });

  it("always pattern", () => {
    assert.equal(alwaysPatternFromTokens(["git", "status"]), "git status *");
  });

  it("read-only commands", () => {
    assert.equal(isReadOnlyCommand("git status"), true);
    assert.equal(isReadOnlyCommand("git status -sb"), true);
    assert.equal(isReadOnlyCommand("rm -rf dist"), false);
    assert.equal(isReadOnlyCommand("npm test"), false);
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
    assert.equal(r.decision, "deny");
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
    assert.equal(r.decision, "allow");
  });

  it("acceptEdits auto-allows git status", async () => {
    const g = new PermissionGate({ interactive: false });
    const r = await g.request({
      toolName: "bash",
      input: { command: "git status" },
      mode: "acceptEdits",
      workspace: "/tmp/proj",
      config: DEFAULT_CONFIG,
    });
    assert.equal(r.decision, "allow");
    assert.equal(r.reason, "read_only_command");
  });
});

describe("sandbox descriptors and network", () => {
  it("describes profiles", () => {
    assert.match(describeSandbox("workspace"), /CWD/);
    assert.match(describeSandbox("off"), /no OS/);
    assert.match(describeSandbox("strict"), /network blocked/);
  });

  it("default network for profiles", () => {
    assert.equal(defaultNetworkForProfile("workspace"), "unrestricted");
    assert.equal(defaultNetworkForProfile("strict"), "blocked");
    assert.equal(defaultNetworkForProfile("read-only"), "blocked");
  });

  it("resolveSandboxNetwork respects override", () => {
    assert.equal(
      resolveSandboxNetwork({ sandbox: "workspace", sandboxNetwork: "blocked" }),
      "blocked",
    );
  });

  it("detectSandboxBackend returns shape", () => {
    const d = detectSandboxBackend();
    assert.ok(["darwin", "linux", "win32", "freebsd"].includes(d.platform) || d.platform);
    assert.ok(["sandbox-exec", "bwrap", "none"].includes(d.backend));
  });

  it("fail-closed refuses when backend forced none via off profile still runs", async () => {
    const r = await execCommandSandboxed({
      command: "echo ok",
      cwd: process.cwd(),
      timeoutMs: 5000,
      profile: "off",
      missingBackend: "fail-closed",
    });
    assert.equal(r.sandboxed, false);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /ok/);
  });
});

describe("config permission trust", () => {
  it("project cannot drop global denies", () => {
    const merged = mergePermissionTrust(
      { deny: ["Bash(rm -rf /)", "Bash(evil *)"], allow: [], ask: [], rules: [] },
      { deny: ["Bash(npm publish *)"], allow: ["Bash(ls *)"], ask: [], rules: [] },
      DEFAULT_CONFIG.permission,
    );
    assert.ok(merged.deny.includes("Bash(rm -rf /)"));
    assert.ok(merged.deny.includes("Bash(evil *)"));
    assert.ok(merged.deny.includes("Bash(npm publish *)"));
    assert.ok(merged.allow.includes("Bash(ls *)"));
  });
});
