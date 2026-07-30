/**
 * OpenCode-style project custom slash commands (.forge/commands/*.md).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadProjectCommands,
  findProjectCommand,
  expandProjectCommandTemplate,
  listProjectCommandSlashes,
  formatProjectCommandsHelp,
  isReservedSlashName,
} from "../src/commands/project-commands.js";
import {
  handleSlash,
  completeSlash,
  classifyLiveSlash,
  suggestSlashCommands,
} from "../src/commands/slash.js";
import { createSession } from "../src/session/session.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";
import { HookRunner } from "../src/harness/hooks.js";
import { forgeCompleter } from "../src/tui/complete.js";

describe("project custom commands", () => {
  let tmp: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-cmds-"));
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

  it("expands $ARGUMENTS and $1..$9", () => {
    assert.equal(
      expandProjectCommandTemplate("Review $ARGUMENTS carefully", "auth.ts"),
      "Review auth.ts carefully",
    );
    assert.equal(
      expandProjectCommandTemplate("A=$1 B=$2 C=$ARGUMENTS", "one two three"),
      "A=one B=two C=one two three",
    );
    assert.equal(expandProjectCommandTemplate("plain", ""), "plain");
  });

  it("loads project .forge/commands and skips reserved names", () => {
    const ws = path.join(tmp, "proj");
    const dir = path.join(ws, ".forge", "commands");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "pr.md"),
      "---\ndescription: Open a PR\n---\nCreate a PR for $ARGUMENTS\n",
    );
    fs.writeFileSync(
      path.join(dir, "help.md"),
      "should not load — reserved\n",
    );
    fs.writeFileSync(path.join(dir, "Bad Name.md"), "invalid name\n");

    const cmds = loadProjectCommands(ws);
    assert.equal(cmds.length, 1);
    assert.equal(cmds[0].name, "pr");
    assert.equal(cmds[0].description, "Open a PR");
    assert.equal(cmds[0].source, "project");
    assert.ok(isReservedSlashName("help"));
    assert.ok(isReservedSlashName("/plan"));
  });

  it("project commands win over user-global on name clash", () => {
    const ws = path.join(tmp, "clash");
    fs.mkdirSync(path.join(ws, ".forge", "commands"), { recursive: true });
    fs.mkdirSync(path.join(process.env.FORGE_HOME!, "commands"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(ws, ".forge", "commands", "ship.md"),
      "PROJECT_SHIP $ARGUMENTS\n",
    );
    fs.writeFileSync(
      path.join(process.env.FORGE_HOME!, "commands", "ship.md"),
      "USER_SHIP $ARGUMENTS\n",
    );
    fs.writeFileSync(
      path.join(process.env.FORGE_HOME!, "commands", "globalonly.md"),
      "GLOBAL_ONLY\n",
    );

    const ship = findProjectCommand(ws, "ship")!;
    assert.equal(ship.source, "project");
    assert.match(ship.template, /PROJECT_SHIP/);
    const g = findProjectCommand(ws, "globalonly")!;
    assert.equal(g.source, "user");
  });

  it("handleSlash forwards expanded custom command as a turn", async () => {
    const ws = path.join(tmp, "run");
    fs.mkdirSync(path.join(ws, ".forge", "commands"), { recursive: true });
    fs.writeFileSync(
      path.join(ws, ".forge", "commands", "fixit.md"),
      "---\ndescription: Fix the bug\n---\nFix this bug: $ARGUMENTS\n",
    );
    const session = createSession({ cwd: ws, provider: "xai", model: "m" });
    const hooks = new HookRunner(DEFAULT_CONFIG, ws);
    const r = await handleSlash("/fixit flaky test", {
      session,
      config: { ...DEFAULT_CONFIG, workspace: ws },
      hooks,
    });
    assert.equal(r.handled, true);
    assert.equal(r.forwardPrompt, "Fix this bug: flaky test");
    assert.match(String(r.output || ""), /fixit/);
  });

  it("/commands lists templates; classify is readonly", async () => {
    assert.equal(classifyLiveSlash("/commands"), "readonly");
    const ws = path.join(tmp, "list");
    fs.mkdirSync(path.join(ws, ".forge", "commands"), { recursive: true });
    fs.writeFileSync(
      path.join(ws, ".forge", "commands", "audit.md"),
      "Run security audit on $ARGUMENTS\n",
    );
    const session = createSession({ cwd: ws, provider: "xai", model: "m" });
    const hooks = new HookRunner(DEFAULT_CONFIG, ws);
    const r = await handleSlash("/commands", {
      session,
      config: { ...DEFAULT_CONFIG, workspace: ws },
      hooks,
    });
    assert.match(String(r.output || ""), /\/audit/);
    assert.match(formatProjectCommandsHelp(ws), /audit/);
  });

  it("tab-completes and suggests custom commands", () => {
    const ws = path.join(tmp, "tab");
    fs.mkdirSync(path.join(ws, ".forge", "commands"), { recursive: true });
    fs.writeFileSync(
      path.join(ws, ".forge", "commands", "deploy.md"),
      "Deploy $ARGUMENTS\n",
    );
    const hits = completeSlash("/dep", { workspace: ws });
    assert.ok(hits.some((h) => h === "/deploy"));
    const tips = suggestSlashCommands("/deply", 5, { workspace: ws });
    assert.ok(tips.some((t) => t === "/deploy"));
    const [comp] = forgeCompleter("/dep", {
      ...DEFAULT_CONFIG,
      workspace: ws,
    });
    assert.ok(comp.some((c) => c === "/deploy"));
    assert.ok(listProjectCommandSlashes(ws).includes("/deploy"));
  });
});
