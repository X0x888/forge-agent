/**
 * Multi-suggestion ranking + doctor project rules/commands counts.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { suggestNames } from "../src/util/suggest.js";
import { executeTool } from "../src/agent/tools/index.js";
import { runDoctorCheck } from "../src/commands/slash.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";

describe("suggestNames", () => {
  it("returns ranked multi tips", () => {
    const tips = suggestNames(
      "read_fil",
      ["bash", "read_file", "write_file", "list_dir"],
      { minLength: 2, minScore: 30, requirePrefix3: false, limit: 3 },
    );
    assert.ok(tips.includes("read_file"));
    assert.ok(tips.length >= 1 && tips.length <= 3);
  });

  it("unknown tool surfaces multi Did you mean", async () => {
    const r = await executeTool("read_fil", "{}", {
      workspace: process.cwd(),
    });
    assert.equal(r.isError, true);
    assert.match(r.output, /Unknown tool: read_fil/);
    assert.match(r.output, /Did you mean:.*read_file/i);
  });
});

describe("doctor projectRulesCount / projectCommandsCount", () => {
  let tmp: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-doc-counts-"));
    prevHome = process.env.FORGE_HOME;
    process.env.FORGE_HOME = path.join(tmp, "home");
    fs.mkdirSync(process.env.FORGE_HOME, { recursive: true });
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prevHome;
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  it("counts AGENTS.md and custom commands", async () => {
    const ws = path.join(tmp, "ws");
    fs.mkdirSync(path.join(ws, ".forge", "commands"), { recursive: true });
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "rules");
    fs.writeFileSync(path.join(ws, ".forge", "commands", "ship.md"), "Ship $ARGUMENTS\n");
    const check = await runDoctorCheck({
      ...DEFAULT_CONFIG,
      workspace: ws,
    });
    assert.ok((check.projectRulesCount ?? 0) >= 1);
    assert.ok((check.projectCommandsCount ?? 0) >= 1);
    assert.equal(typeof check.sessionsWithLastError, "number");
  });

  it("counts sessions with lastError", async () => {
    const ws = path.join(tmp, "ws-err");
    fs.mkdirSync(ws, { recursive: true });
    const { createSession, saveSession, setSessionLastError } = await import(
      "../src/session/session.js"
    );
    const s = createSession({ cwd: ws, provider: "xai", model: "m" });
    setSessionLastError(s, {
      code: "rate_limited",
      message: "429",
      tips: ["switch"],
    });
    saveSession(s);
    const check = await runDoctorCheck({
      ...DEFAULT_CONFIG,
      workspace: ws,
    });
    assert.ok((check.sessionsWithLastError ?? 0) >= 1);
    assert.match(check.report, /lastError/i);
  });

  it("doctor notes model default context window", async () => {
    const ws = path.join(tmp, "ws-win");
    fs.mkdirSync(ws, { recursive: true });
    const check = await runDoctorCheck({
      ...DEFAULT_CONFIG,
      workspace: ws,
      model: "grok-4.5",
      contextWindow: 50_000,
      contextWindowExplicit: true,
    });
    assert.match(check.report, /context_window=50000|model default window|50%/i);
    assert.equal(check.modelDefaultContextWindow, 500_000);
    assert.ok((check.contextWindowRatio ?? 1) < 0.5);
  });

});
