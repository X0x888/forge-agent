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
import { PermissionGate } from "../src/agent/permissions.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";

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
  it("scrubs leftover call_mcp(*) grants on load", () => {
    withForgeHome((home) => {
      const ws = path.join(home, "proj");
      fs.mkdirSync(ws, { recursive: true });
      const storePath = path.join(home, "permissions.json");
      fs.writeFileSync(
        storePath,
        JSON.stringify({
          version: 1,
          allows: [
            {
              id: "pa_legacy",
              workspaceKey: workspaceKey(ws),
              tool: "call_mcp",
              pattern: "*",
              createdAt: new Date().toISOString(),
            },
            {
              id: "pa_ok",
              workspaceKey: workspaceKey(ws),
              tool: "call_mcp",
              pattern: "context7__query-docs",
              createdAt: new Date().toISOString(),
            },
          ],
        }),
        { mode: 0o600 },
      );
      const loaded = loadSavedAllows(ws);
      assert.equal(loaded.length, 1);
      assert.equal(loaded[0]?.pattern, "context7__query-docs");
      const disk = JSON.parse(fs.readFileSync(storePath, "utf8")) as {
        allows: { pattern: string }[];
      };
      assert.deepEqual(
        disk.allows.map((a) => a.pattern),
        ["context7__query-docs"],
      );
    });
  });

  it("refuses call_mcp(*) always-allow", () => {
    withForgeHome((home) => {
      const ws = path.join(home, "proj");
      fs.mkdirSync(ws, { recursive: true });
      assert.throws(
        () =>
          addSavedAllow({
            workspace: ws,
            tool: "call_mcp",
            pattern: "*",
          }),
        /server__tool/,
      );
      const ok = addSavedAllow({
        workspace: ws,
        tool: "call_mcp",
        pattern: "context7__query-docs",
      });
      assert.equal(ok.pattern, "context7__query-docs");
      assert.deepEqual(savedAsAllowRules(ws), [
        "call_mcp(context7__query-docs)",
      ]);
    });
  });

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

async function withForgeHomeAsync<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-perm-"));
  const prev = process.env.FORGE_HOME;
  process.env.FORGE_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (prev === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prev;
  }
}

describe("external_directory grants reach the checker", () => {
  it("honors a persisted external_directory allow under dontAsk", async () => {
    await withForgeHomeAsync(async (home) => {
      const ws = path.join(home, "proj");
      fs.mkdirSync(ws, { recursive: true });
      addSavedAllow({
        workspace: ws,
        tool: "external_directory",
        pattern: "/etc/*",
      });
      const g = new PermissionGate({ interactive: false });
      const r = await g.request({
        toolName: "read_file",
        input: { path: "/etc/hosts" },
        mode: "dontAsk",
        workspace: ws,
        config: DEFAULT_CONFIG, // readOutsideWorkspace: "ask"
      });
      assert.equal(r.decision, "allow");
    });
  });

  it("honors the session key promptUser stores for [a]lways", async () => {
    await withForgeHomeAsync(async (home) => {
      const ws = path.join(home, "proj");
      fs.mkdirSync(ws, { recursive: true });
      const g = new PermissionGate({ interactive: false });
      // The key the checker looks for — promptUser now stores [a]lways under
      // external_directory:<dir>/* instead of the real tool name.
      (
        g as unknown as { sessionPatterns: Set<string> }
      ).sessionPatterns.add("external_directory:/etc/*");
      const r = await g.request({
        toolName: "read_file",
        input: { path: "/etc/hosts" },
        mode: "dontAsk",
        workspace: ws,
        config: DEFAULT_CONFIG,
      });
      assert.equal(r.decision, "allow");
    });
  });

  it("still denies external reads with no grant (deny semantics intact)", async () => {
    await withForgeHomeAsync(async (home) => {
      const ws = path.join(home, "proj");
      fs.mkdirSync(ws, { recursive: true });
      const g = new PermissionGate({ interactive: false });
      const r = await g.request({
        toolName: "read_file",
        input: { path: "/etc/hosts" },
        mode: "dontAsk",
        workspace: ws,
        config: DEFAULT_CONFIG,
      });
      assert.equal(r.decision, "deny");
      assert.match(r.reason, /outside workspace/i);
    });
  });

  it("readOutsideWorkspace:deny still wins over a saved grant", async () => {
    await withForgeHomeAsync(async (home) => {
      const ws = path.join(home, "proj");
      fs.mkdirSync(ws, { recursive: true });
      addSavedAllow({
        workspace: ws,
        tool: "external_directory",
        pattern: "/etc/*",
      });
      const g = new PermissionGate({ interactive: false });
      const r = await g.request({
        toolName: "read_file",
        input: { path: "/etc/hosts" },
        mode: "dontAsk",
        workspace: ws,
        config: { ...DEFAULT_CONFIG, readOutsideWorkspace: "deny" },
      });
      assert.equal(r.decision, "deny");
      assert.match(r.reason, /outside workspace/i);
    });
  });
});
