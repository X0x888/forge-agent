import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  addSavedAllow,
  loadSavedAllows,
  removeSavedAllow,
  clearSavedAllows,
  savedAsAllowRules,
  workspaceKey,
} from "../src/agent/permission-saved.js";

function withForgeHome<T>(fn: (home: string) => T): T {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-perm-"));
  const prev = process.env.FORGE_HOME;
  process.env.FORGE_HOME = home;
  try {
    return fn(home);
  } finally {
    if (prev === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prev;
  }
}

describe("permission-saved", () => {
  it("workspaceKey is stable and path-normalized", () => {
    withForgeHome((home) => {
      const ws = path.join(home, "proj");
      fs.mkdirSync(ws, { recursive: true });
      const k1 = workspaceKey(ws);
      const k2 = workspaceKey(path.join(ws, "."));
      assert.equal(k1, k2);
      assert.notEqual(workspaceKey(ws), workspaceKey(path.join(home, "other")));
      assert.match(k1, /^[a-f0-9]{16}$/);
    });
  });

  it("persists always-allows scoped by workspace (mode 0600)", () => {
    withForgeHome((home) => {
      const wsA = path.join(home, "proj-a");
      const wsB = path.join(home, "proj-b");
      fs.mkdirSync(wsA, { recursive: true });
      fs.mkdirSync(wsB, { recursive: true });

      addSavedAllow({ workspace: wsA, tool: "bash", pattern: "git status *" });
      addSavedAllow({ workspace: wsA, tool: "bash", pattern: "git status *" }); // dedupe
      addSavedAllow({ workspace: wsB, tool: "bash", pattern: "npm test *" });
      addSavedAllow({
        workspace: wsA,
        tool: "bash",
        pattern: "ls *",
        global: true,
      });

      const a = loadSavedAllows(wsA);
      assert.ok(a.some((x) => x.pattern === "git status *"));
      assert.ok(a.some((x) => x.pattern === "ls *" && x.workspaceKey === "*"));
      assert.equal(a.filter((x) => x.pattern === "git status *").length, 1);

      const b = loadSavedAllows(wsB);
      assert.ok(b.some((x) => x.pattern === "npm test *"));
      assert.ok(b.some((x) => x.pattern === "ls *")); // global
      assert.ok(!b.some((x) => x.pattern === "git status *"));

      const storePath = path.join(home, "permissions.json");
      assert.ok(fs.existsSync(storePath));
      const mode = fs.statSync(storePath).mode & 0o777;
      assert.equal(mode, 0o600);

      const rules = savedAsAllowRules(wsA);
      assert.ok(rules.some((r) => r === "Bash(git status *)"));
      assert.ok(rules.some((r) => r === "Bash(ls *)"));
    });
  });

  it("maps tool names to Claude-style rule prefixes", () => {
    withForgeHome((home) => {
      const wsA = path.join(home, "proj-a");
      fs.mkdirSync(wsA, { recursive: true });
      addSavedAllow({ workspace: wsA, tool: "write_file", pattern: "src/**" });
      addSavedAllow({ workspace: wsA, tool: "search_replace", pattern: "*.ts" });
      addSavedAllow({ workspace: wsA, tool: "read_file", pattern: "README*" });
      addSavedAllow({
        workspace: wsA,
        tool: "external_directory",
        pattern: "/tmp/**",
      });
      const rules = savedAsAllowRules(wsA);
      assert.ok(rules.includes("Write(src/**)"));
      assert.ok(rules.includes("Edit(*.ts)"));
      assert.ok(rules.includes("Read(README*)"));
      assert.ok(rules.includes("external_directory(/tmp/**)"));
    });
  });

  it("removes and clears saved allows", () => {
    withForgeHome((home) => {
      const wsA = path.join(home, "proj-a");
      const wsB = path.join(home, "proj-b");
      fs.mkdirSync(wsA, { recursive: true });
      fs.mkdirSync(wsB, { recursive: true });

      const e = addSavedAllow({
        workspace: wsA,
        tool: "bash",
        pattern: "echo *",
      });
      assert.equal(loadSavedAllows(wsA).length, 1);
      assert.equal(removeSavedAllow(e.id), true);
      assert.equal(removeSavedAllow("nope"), false);
      assert.equal(loadSavedAllows(wsA).length, 0);

      addSavedAllow({ workspace: wsA, tool: "bash", pattern: "a *" });
      addSavedAllow({ workspace: wsB, tool: "bash", pattern: "b *" });
      const n = clearSavedAllows(wsA);
      assert.equal(n, 1);
      assert.equal(loadSavedAllows(wsA).length, 0);
      assert.equal(loadSavedAllows(wsB).length, 1);
      assert.equal(clearSavedAllows(), 1);
      assert.equal(loadSavedAllows(wsB).length, 0);
    });
  });
});
