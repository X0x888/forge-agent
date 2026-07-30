/**
 * OpenCode-style multi-source project instruction loading.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadProjectRules,
  listProjectRulePaths,
  buildBaselineSystemPrompt,
} from "../src/agent/system-prompt.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";
import { handleSlash } from "../src/commands/slash.js";
import { createSession } from "../src/session/session.js";
import { HookRunner } from "../src/harness/hooks.js";

describe("project rules discovery", () => {
  let tmp: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-rules-"));
    prevHome = process.env.FORGE_HOME;
    process.env.FORGE_HOME = path.join(tmp, "forge-home");
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

  it("loads AGENTS.md + CLAUDE.md + copilot + cursorrules", () => {
    const ws = path.join(tmp, "proj");
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "# agents\nuse npm test");
    fs.writeFileSync(path.join(ws, "CLAUDE.md"), "# claude\nprefer small PRs");
    fs.mkdirSync(path.join(ws, ".github"), { recursive: true });
    fs.writeFileSync(
      path.join(ws, ".github/copilot-instructions.md"),
      "copilot: no force push",
    );
    fs.writeFileSync(path.join(ws, ".cursorrules"), "cursor: tabs=2");

    const body = loadProjectRules(ws);
    assert.match(body, /From AGENTS\.md/);
    assert.match(body, /use npm test/);
    assert.match(body, /From CLAUDE\.md/);
    assert.match(body, /prefer small PRs/);
    assert.match(body, /copilot-instructions/);
    assert.match(body, /no force push/);
    assert.match(body, /\.cursorrules/);
    assert.match(body, /tabs=2/);

    const paths = listProjectRulePaths(ws);
    assert.ok(paths.some((p) => p.endsWith("AGENTS.md")));
    assert.ok(paths.some((p) => p.endsWith("CLAUDE.md")));
  });

  it("loads .cursor/rules/*.md and nested AGENTS shadows parent", () => {
    const root = path.join(tmp, "mono");
    const pkg = path.join(root, "packages", "app");
    fs.mkdirSync(pkg, { recursive: true });
    // Fake git root so walk-up stays inside the fixture monorepo
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    fs.writeFileSync(path.join(root, "AGENTS.md"), "ROOT_AGENTS_ONLY");
    fs.writeFileSync(path.join(pkg, "AGENTS.md"), "NESTED_AGENTS_WINS");
    fs.mkdirSync(path.join(pkg, ".cursor", "rules"), { recursive: true });
    fs.writeFileSync(
      path.join(pkg, ".cursor", "rules", "style.md"),
      "use prettier",
    );

    const body = loadProjectRules(pkg);
    assert.match(body, /NESTED_AGENTS_WINS/);
    assert.doesNotMatch(body, /ROOT_AGENTS_ONLY/);
    assert.match(body, /\.cursor\/rules\/style\.md|style\.md/);
    assert.match(body, /use prettier/);
  });

  it("loads ~/.forge/AGENTS.md only when project has none", () => {
    // Isolate from host git: create a private tree with its own .git ceiling
    // so walk-up cannot reach the Forge repo AGENTS.md via TMPDIR nesting.
    const island = path.join(tmp, "island");
    const ws = path.join(island, "empty-proj");
    fs.mkdirSync(ws, { recursive: true });
    fs.mkdirSync(path.join(island, ".git"), { recursive: true });
    fs.writeFileSync(
      path.join(process.env.FORGE_HOME!, "AGENTS.md"),
      "GLOBAL_USER_RULES",
    );
    const body = loadProjectRules(ws);
    assert.match(body, /GLOBAL_USER_RULES/);
    assert.doesNotMatch(body, /blockingStopHooks/);

    fs.writeFileSync(path.join(ws, "AGENTS.md"), "PROJECT_RULES");
    const body2 = loadProjectRules(ws);
    assert.match(body2, /PROJECT_RULES/);
    assert.doesNotMatch(body2, /GLOBAL_USER_RULES/);
  });

  it("baseline system prompt includes project rules", () => {
    const ws = path.join(tmp, "base");
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "ALWAYS run typecheck");
    const text = buildBaselineSystemPrompt({
      config: DEFAULT_CONFIG,
      workspace: ws,
    });
    assert.match(text, /ALWAYS run typecheck/);
    assert.match(text, /From AGENTS\.md/);
  });

  it("/context lists project rule sources", async () => {
    const ws = path.join(tmp, "ctx");
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "ctx rules");
    const session = createSession({ cwd: ws, provider: "xai", model: "m" });
    const hooks = new HookRunner(DEFAULT_CONFIG, ws);
    const r = await handleSlash("/context", {
      session,
      config: { ...DEFAULT_CONFIG, workspace: ws },
      hooks,
    });
    assert.equal(r.handled, true);
    assert.match(String(r.output || ""), /Project rules/);
    assert.match(String(r.output || ""), /AGENTS\.md/);
  });
});
