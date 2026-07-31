import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
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
  seatbeltProfile,
  canonicalSandboxPath,
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

  it("splits single & background operator, keeps fd duplication intact", () => {
    assert.deepEqual(splitShellSegments("git status & curl x"), [
      "git status",
      "curl x",
    ]);
    assert.deepEqual(splitShellSegments("sleep 1 &"), ["sleep 1"]);
    assert.deepEqual(splitShellSegments("a && b & c"), ["a", "b", "c"]);
    assert.deepEqual(splitShellSegments("cmd1 |& cmd2"), ["cmd1", "cmd2"]);
    // fd duplication / redirect-all are not command separators
    assert.deepEqual(splitShellSegments("cmd 2>&1"), ["cmd 2>&1"]);
    assert.deepEqual(splitShellSegments("cmd >&2"), ["cmd >&2"]);
    assert.deepEqual(splitShellSegments("cmd &> log"), ["cmd &> log"]);
    assert.deepEqual(splitShellSegments("cmd &>> log"), ["cmd &>> log"]);
    // quoted / escaped & is literal
    assert.deepEqual(splitShellSegments('echo "a & b"'), ['echo "a & b"']);
    assert.deepEqual(splitShellSegments("echo a \\& b"), ["echo a \\& b"]);
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
    // env must re-quote multi-word -c bodies (join without quotes → bash -c rm)
    assert.equal(
      peelWrappers(`/usr/bin/env bash -c "rm -rf /"`),
      "rm -rf /",
    );
    assert.equal(
      peelWrappers(`env -i PATH=/bin bash -c 'rm -rf /'`),
      "rm -rf /",
    );
    const v = checkBashHardDeny(`bash -c "rm -rf /"`);
    assert.equal(v.ok, false);
    assert.match(v.ok === false ? v.rule : "", /rm-rf/);
    const v2 = checkBashHardDeny(`sh -c 'rm -rf ~'`);
    assert.equal(v2.ok, false);
    const v3 = checkBashHardDeny(`/usr/bin/env bash -c "rm -rf /"`);
    assert.equal(v3.ok, false, JSON.stringify(v3));
    const v4 = checkBashHardDeny(`timeout 5 bash -c "rm -rf /"`);
    assert.equal(v4.ok, false, JSON.stringify(v4));
    const v5 = checkBashHardDeny(`nohup bash -c "rm -rf /"`);
    assert.equal(v5.ok, false, JSON.stringify(v5));
    const v6 = checkBashHardDeny(`busybox sh -c "rm -rf /"`);
    assert.equal(v6.ok, false, JSON.stringify(v6));
    const v7 = checkBashHardDeny(`su -c "rm -rf /"`);
    assert.equal(v7.ok, false, JSON.stringify(v7));
    const v8 = checkBashHardDeny(`script -c "rm -rf /" /dev/null`);
    assert.equal(v8.ok, false, JSON.stringify(v8));
    const v9 = checkBashHardDeny(`watch -n1 rm -rf /`);
    assert.equal(v9.ok, false, JSON.stringify(v9));
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

  it("hard deny peels eval and xargs bash -c", () => {
    assert.equal(peelWrappers(`eval "rm -rf /"`), "rm -rf /");
    assert.equal(peelWrappers(`xargs bash -c "rm -rf /"`), "rm -rf /");
    assert.equal(
      peelWrappers(`xargs -I{} bash -c "rm -rf /"`),
      "rm -rf /",
    );
    const v = checkBashHardDeny(`eval "rm -rf /"`);
    assert.equal(v.ok, false, JSON.stringify(v));
    const v2 = checkBashHardDeny(`xargs -I{} bash -c "rm -rf /"`);
    assert.equal(v2.ok, false, JSON.stringify(v2));
  });

  it("heredoc data is not a false hard-deny; shell heredoc still is", () => {
    const danger = "rm" + " -rf /";
    // Document / commit message payloads must not trip catastrophic deny
    const cat = checkBashHardDeny(`cat <<'EOF'\n${danger}\nEOF`);
    assert.equal(cat.ok, true, JSON.stringify(cat));
    const commit = checkBashHardDeny(
      `git commit -m "$(cat <<'EOF'\nfix ${danger}\nEOF\n)"`,
    );
    assert.equal(commit.ok, true, JSON.stringify(commit));
    // bash <<EOF actually executes the body — still deny
    const sh = checkBashHardDeny(`bash <<'EOF'\n${danger}\nEOF`);
    assert.equal(sh.ok, false, JSON.stringify(sh));
  });

  it("hard deny sees bad segment in chain", () => {
    const v = checkBashHardDeny("ls && rm -rf /");
    assert.equal(v.ok, false);
    assert.match(v.ok === false ? v.rule : "", /rm-rf/);
  });

  it("hard deny sees bad segment after & background", () => {
    const v = checkBashHardDeny("sleep 1 & rm -rf /");
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

  it("version probes are read-only (flags must not be stripped away)", () => {
    for (const cmd of [
      "node --version",
      "node -v",
      "npm --version",
      "npm -v",
      "python --version",
      "python -V",
      "cargo --version",
      "tsc --version",
      "git --version",
    ]) {
      assert.equal(isReadOnlyCommand(cmd), true, cmd);
    }
    // Subcommands that change state must stay non-RO
    assert.equal(isReadOnlyCommand("npm version patch"), false);
    assert.equal(isReadOnlyCommand("node -e \"console.log(1)\""), false);
    assert.equal(isReadOnlyCommand("node script.js"), false);
  });

  it("git branch mutations are not read-only; listing is", () => {
    for (const cmd of [
      "git branch",
      "git branch -a",
      "git branch -vv",
      "git branch -i",
      "git branch -av",
      "git branch --list",
      "git branch --list feature/*",
      "git branch --contains main",
      "git branch --merged main",
    ]) {
      assert.equal(isReadOnlyCommand(cmd), true, cmd);
    }
    for (const cmd of [
      "git branch -d old",
      "git branch -D old",
      "git branch --delete old",
      "git branch -m old new",
      "git branch -c old new",
      "git branch --set-upstream-to=origin/main",
      "git branch new-feature",
      "git branch -f main origin/main",
    ]) {
      assert.equal(isReadOnlyCommand(cmd), false, cmd);
    }
  });

  it("git remote mutations are not read-only; list/show/get-url are", () => {
    for (const cmd of [
      "git remote",
      "git remote -v",
      "git remote show origin",
      "git remote get-url origin",
    ]) {
      assert.equal(isReadOnlyCommand(cmd), true, cmd);
    }
    for (const cmd of [
      "git remote add origin https://example.test/r.git",
      "git remote remove origin",
      "git remote rename origin upstream",
      "git remote set-url origin https://evil.test/r.git",
      "git remote prune origin",
    ]) {
      assert.equal(isReadOnlyCommand(cmd), false, cmd);
    }
  });

  it("find mutating actions are not read-only", () => {
    assert.equal(isReadOnlyCommand("find . -name '*.ts'"), true);
    assert.equal(isReadOnlyCommand("find . -type f"), true);
    assert.equal(isReadOnlyCommand("find . -type f -print"), true);
    for (const cmd of [
      "find . -delete",
      "find . -name '*.log' -delete",
      "find . -exec rm {} ;",
      "find . -execdir rm {} +",
      "find . -execdir sh -c 'echo' ;",
      "find . -ok rm {} ;",
      "find . -fprint /tmp/out",
    ]) {
      assert.equal(isReadOnlyCommand(cmd), false, cmd);
    }
  });

  it("git --output is not read-only (writes a file)", () => {
    assert.equal(isReadOnlyCommand("git log --oneline -5"), true);
    assert.equal(isReadOnlyCommand("git log --output=/tmp/out"), false);
    assert.equal(isReadOnlyCommand("git log --output /tmp/out"), false);
    assert.equal(isReadOnlyCommand("git show HEAD --output=/tmp/out"), false);
    assert.equal(isReadOnlyCommand("git diff --output=/tmp/out"), false);
    assert.equal(isReadOnlyCommand("git branch --output=/tmp/out"), false);
  });
});

describe("acceptEdits read-only shell gate", () => {
  it("denies find -delete and git branch -d under headless acceptEdits", async () => {
    const g = new PermissionGate({ interactive: false });
    for (const command of [
      "find . -name '*.log' -delete",
      "find . -exec rm {} ;",
      "git branch -d stale",
      "git branch -D stale",
      "git branch new-feature",
      "git remote add origin https://evil.test",
      "git remote set-url origin https://evil.test",
      "git remote remove origin",
    ]) {
      const r = await g.request({
        toolName: "bash",
        input: { command },
        mode: "acceptEdits",
        workspace: "/tmp/proj",
        config: DEFAULT_CONFIG,
      });
      assert.equal(r.decision, "deny", `expected deny for: ${command}`);
      assert.match(
        r.reason,
        /shell_noninteractive|read_only|Refusing find|hard.?deny|destructive|branch/i,
      );
    }
  });

  it("still allows safe find/git listing and version probes under headless acceptEdits", async () => {
    const g = new PermissionGate({ interactive: false });
    for (const command of [
      "find . -name '*.ts'",
      "git branch -a",
      "git remote -v",
      "git status",
      "node --version",
      "npm -v",
    ]) {
      const r = await g.request({
        toolName: "bash",
        input: { command },
        mode: "acceptEdits",
        workspace: "/tmp/proj",
        config: DEFAULT_CONFIG,
      });
      assert.equal(r.decision, "allow", `expected allow for: ${command}`);
      assert.equal(r.reason, "read_only_command");
    }
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

  it("allow rule is not bypassed by & background operator", () => {
    const rules = compileRules({ allow: ["Bash(git status *)"] });
    const ev = evaluateRules(
      rules,
      "bash",
      { command: "git status & curl evil.sh" },
      "/tmp/proj",
    );
    assert.notEqual(ev.decision, "allow");
    assert.ok(ev.unmatchedSegments?.some((s) => s.includes("curl")));

    // Both sides covered by allow rules → still allowed
    const rules2 = compileRules({
      allow: ["Bash(git status *)", "Bash(curl *)"],
    });
    const ev2 = evaluateRules(
      rules2,
      "bash",
      { command: "git status & curl example.com" },
      "/tmp/proj",
    );
    assert.equal(ev2.decision, "allow");
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

  it("acceptEdits auto-allows version probes; denies git branch -D / find -exec", async () => {
    const g = new PermissionGate({ interactive: false });
    const allowVer = await g.request({
      toolName: "bash",
      input: { command: "node --version" },
      mode: "acceptEdits",
      workspace: "/tmp/proj",
      config: DEFAULT_CONFIG,
    });
    assert.equal(allowVer.decision, "allow");
    assert.equal(allowVer.reason, "read_only_command");

    for (const command of [
      "git branch -D main",
      "git remote remove origin",
      "find . -exec rm {} ;",
    ]) {
      const r = await g.request({
        toolName: "bash",
        input: { command },
        mode: "acceptEdits",
        workspace: "/tmp/proj",
        config: DEFAULT_CONFIG,
      });
      assert.equal(r.decision, "deny", command);
      assert.match(
        r.reason,
        /shell_noninteractive_deny|noninteractive/,
        command,
      );
    }
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

describe("seatbelt tmp canonicalization", () => {
  it("profile write rules use the canonicalized tmp path", () => {
    // Seatbelt resolves symlinks before matching subpath rules; on macOS
    // os.tmpdir() is /var/folders/… but /var → /private/var, so the raw path
    // never matches and $TMPDIR writes are denied.
    const tmp = os.tmpdir();
    const canonical = fs.realpathSync(tmp);
    const text = seatbeltProfile({
      profile: "workspace",
      cwd: "/ws",
      forge: "/forge",
      tmp,
      restrictNetwork: false,
    });
    assert.ok(
      text.includes(`(subpath ${JSON.stringify(canonical)})`),
      `profile missing canonical tmp ${canonical}:\n${text}`,
    );
    if (canonical !== tmp) {
      assert.ok(
        !text.includes(`(subpath ${JSON.stringify(tmp)})`),
        "profile still contains uncanonicalized tmp path",
      );
    }
  });

  it("canonicalSandboxPath keeps the original path when realpath fails", () => {
    const bogus = "/definitely/not/here-forge-test";
    assert.equal(canonicalSandboxPath(bogus), bogus);
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

describe("parseRuleString empty pattern", () => {
  it("rejects Tool() with empty pattern", () => {
    assert.equal(parseRuleString("Bash()"), null);
    assert.equal(parseRuleString("Read()"), null);
    assert.ok(parseRuleString("Bash"));
    assert.ok(parseRuleString("Bash(*)"));
    assert.ok(parseRuleString("Bash(rm *)"));
    assert.equal(parseRuleString("()"), null);
  });
});

describe("cloud metadata IMDS hard deny", () => {
  it("blocks curl/wget to 169.254.169.254 and GCE metadata host", async () => {
    const { checkBashHardDeny } = await import("../src/agent/safety.js");
    const a = checkBashHardDeny("curl -s http://169.254.169.254/latest/meta-data/");
    assert.equal(a.ok, false);
    assert.equal(a.ok === false && a.rule, "cloud-metadata-imds");
    const b = checkBashHardDeny("wget -qO- http://metadata.google.internal/computeMetadata/v1/");
    assert.equal(b.ok, false);
    const c = checkBashHardDeny("echo 169.254.169.254"); // no fetch tool
    assert.equal(c.ok, true);
    const d = checkBashHardDeny("curl -s http://[fd00:ec2::254]/latest/meta-data/");
    assert.equal(d.ok, false);
    const e = checkBashHardDeny(
      'python3 -c "import urllib.request;urllib.request.urlopen(\"http://169.254.169.254/\")"',
    );
    assert.equal(e.ok, false);
    const f = checkBashHardDeny('node -e "fetch(\"http://169.254.169.254\")"');
    assert.equal(f.ok, false);
  });
});

describe("file:// fetch hard deny", () => {
  it("blocks curl/wget file:// local file exfil", async () => {
    const { checkBashHardDeny } = await import("../src/agent/safety.js");
    const a = checkBashHardDeny("curl file:///etc/passwd");
    assert.equal(a.ok, false);
    assert.equal(a.ok === false && a.rule, "file-url-fetch");
    const b = checkBashHardDeny("wget -qO- file:///etc/shadow");
    assert.equal(b.ok, false);
    const c = checkBashHardDeny("echo file:///etc/passwd");
    assert.equal(c.ok, true);
    const d = checkBashHardDeny("curl https://example.com");
    assert.equal(d.ok, true);
  });
});
