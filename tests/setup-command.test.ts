import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleSlash, classifyLiveSlash, completeSlash } from "../src/commands/slash.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";
import { HookRunner } from "../src/harness/hooks.js";
import { createSession } from "../src/session/session.js";
import {
  loadPreferences,
  savePreferences,
} from "../src/config/preferences.js";
import {
  persistSetupBudget,
  markProviderModelConfirmed,
  resolveSetupBudgetAmount,
} from "../src/commands/setup.js";
import { formatUnknownSlash } from "../src/commands/slash.js";
import { runForgeInit } from "../src/commands/init-scaffold.js";

describe("/setup slash", () => {
  let home: string;
  let prevHome: string | undefined;
  let cwd: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-setup-"));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "forge-setup-ws-"));
    prevHome = process.env.FORGE_HOME;
    process.env.FORGE_HOME = home;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prevHome;
  });

  function session() {
    return createSession({ cwd, provider: "xai", model: "grok-4.6" });
  }

  it("/help default is getting started", async () => {
    const r = await handleSlash("/help", {
      session: session(),
      config: { ...DEFAULT_CONFIG, workspace: cwd },
      hooks: new HookRunner(DEFAULT_CONFIG, cwd),
    });
    assert.equal(r.handled, true);
    assert.match(String(r.output), /Getting started|Type a task in English/);
    assert.match(String(r.output), /\/setup/);
  });

  it("/help all lists the catalog", async () => {
    const r = await handleSlash("/help all", {
      session: session(),
      config: { ...DEFAULT_CONFIG, workspace: cwd },
      hooks: new HookRunner(DEFAULT_CONFIG, cwd),
    });
    assert.match(String(r.output), /\/max-cycles/);
    assert.match(String(r.output), /\/setup/);
  });

  it("/setup prints the card (live-safe)", async () => {
    assert.equal(classifyLiveSlash("/setup"), "readonly");
    assert.equal(classifyLiveSlash("/setup json"), "readonly");
    assert.equal(classifyLiveSlash("/setup skip"), "control");
    assert.equal(classifyLiveSlash("/setup 3"), "idle-only");
    assert.equal(classifyLiveSlash("/setup init"), "idle-only");
    const r = await handleSlash("/setup", {
      session: session(),
      config: { ...DEFAULT_CONFIG, workspace: cwd },
      hooks: new HookRunner(DEFAULT_CONFIG, cwd),
    });
    assert.equal(r.handled, true);
    assert.match(String(r.output), /Setup  \d\/6 ready/);
    assert.equal(loadPreferences().seenSetup, true);
  });

  it("/setup skip persists", async () => {
    const r = await handleSlash("/setup skip", {
      session: session(),
      config: { ...DEFAULT_CONFIG, workspace: cwd },
      hooks: new HookRunner(DEFAULT_CONFIG, cwd),
    });
    assert.match(String(r.output), /hidden/i);
    assert.equal(loadPreferences().setupSkipped, true);
  });

  it("/setup model confirms provider", async () => {
    const r = await handleSlash("/setup model", {
      session: session(),
      config: { ...DEFAULT_CONFIG, workspace: cwd, model: "grok-4.6" },
      hooks: new HookRunner(DEFAULT_CONFIG, cwd),
    });
    assert.match(String(r.output), /confirmed/);
    assert.equal(loadPreferences().seenProviderModelConfirm, true);
  });

  it("/setup budget 5 sets session cap and persists sticky cap", async () => {
    const s = session();
    const r = await handleSlash("/setup budget 5", {
      session: s,
      config: { ...DEFAULT_CONFIG, workspace: cwd },
      hooks: new HookRunner(DEFAULT_CONFIG, cwd),
    });
    assert.match(String(r.output), /\$5/);
    assert.equal(s.meta.maxCostUsd, 5);
    assert.equal(loadPreferences().maxCostUsd, 5);
  });

  it("persistSetupBudget is seen by loadConfig as a finite cap", async () => {
    persistSetupBudget(5);
    assert.equal(loadPreferences().maxCostUsd, 5);
    const { loadConfig } = await import("../src/config/load.js");
    const cfg = loadConfig();
    assert.equal(cfg.maxCostUsd, 5);
  });

  it("bare /setup budget peeks without writing $5", async () => {
    const s = session();
    const r = await handleSlash("/setup budget", {
      session: s,
      config: { ...DEFAULT_CONFIG, workspace: cwd },
      hooks: new HookRunner(DEFAULT_CONFIG, cwd),
    });
    assert.equal(r.failed, undefined);
    assert.equal(loadPreferences().maxCostUsd, undefined);
    assert.equal(s.meta.maxCostUsd, undefined);
    const empty = resolveSetupBudgetAmount("");
    assert.equal(empty.ok, true);
    assert.equal(empty.ok && empty.peek, true);
    const five = resolveSetupBudgetAmount("5");
    assert.equal(five.ok, true);
    assert.equal(five.ok && !five.peek && five.amount, 5);
  });

  it("persistSetupBudget fails closed when preferences cannot be written", () => {
    const bad = path.join(home, "not-a-dir");
    fs.writeFileSync(bad, "x");
    process.env.FORGE_HOME = bad;
    assert.throws(() => persistSetupBudget(5));
    assert.throws(() => markProviderModelConfirmed());
    process.env.FORGE_HOME = home;
  });

  it("/setup budget 5 fails closed when preferences cannot be written", async () => {
    const s = session();
    const bad = path.join(home, "not-a-dir");
    fs.writeFileSync(bad, "x");
    process.env.FORGE_HOME = bad;
    const r = await handleSlash("/setup budget 5", {
      session: s,
      config: { ...DEFAULT_CONFIG, workspace: cwd },
      hooks: new HookRunner(DEFAULT_CONFIG, cwd),
    });
    assert.equal(r.failed, true);
    assert.doesNotMatch(String(r.output), /persisted/i);
    assert.match(String(r.output), /Could not persist spend cap/);
    process.env.FORGE_HOME = home;
    assert.equal(loadPreferences().maxCostUsd, undefined);
  });

  it("/setup model fails closed when preferences cannot be written", async () => {
    const s = session();
    const bad = path.join(home, "not-a-dir");
    fs.writeFileSync(bad, "x");
    process.env.FORGE_HOME = bad;
    const r = await handleSlash("/setup model", {
      session: s,
      config: { ...DEFAULT_CONFIG, workspace: cwd, model: "grok-4.6" },
      hooks: new HookRunner(DEFAULT_CONFIG, cwd),
    });
    assert.equal(r.failed, true);
    assert.doesNotMatch(String(r.output), /confirmed/);
    process.env.FORGE_HOME = home;
    assert.equal(loadPreferences().seenProviderModelConfirm, undefined);
  });

  it("/setup model then the card drops (not confirmed)", async () => {
    await handleSlash("/setup model", {
      session: session(),
      config: { ...DEFAULT_CONFIG, workspace: cwd, model: "grok-4.6" },
      hooks: new HookRunner(DEFAULT_CONFIG, cwd),
    });
    const r = await handleSlash("/setup", {
      session: session(),
      config: { ...DEFAULT_CONFIG, workspace: cwd, model: "grok-4.6" },
      hooks: new HookRunner(DEFAULT_CONFIG, cwd),
    });
    assert.doesNotMatch(String(r.output), /not confirmed/);
  });

  it("/setup init forwards AGENTS.md prompt", async () => {
    const r = await handleSlash("/setup init", {
      session: session(),
      config: { ...DEFAULT_CONFIG, workspace: cwd },
      hooks: new HookRunner(DEFAULT_CONFIG, cwd),
    });
    assert.ok(r.forwardPrompt);
    assert.match(r.forwardPrompt!, /AGENTS\.md/);
  });

  it("/setup json is structured", async () => {
    const r = await handleSlash("/setup json", {
      session: session(),
      config: { ...DEFAULT_CONFIG, workspace: cwd },
      hooks: new HookRunner(DEFAULT_CONFIG, cwd),
    });
    const j = JSON.parse(String(r.output));
    assert.equal(j.ok, true);
    assert.equal(j.total, 6);
    assert.ok(Array.isArray(j.items));
  });

  it("tab-complete lists /setup", () => {
    assert.ok(completeSlash("/set").some((c) => c === "/setup"));
    assert.ok(completeSlash("/setup ").some((c) => c.includes("budget")));
    assert.ok(completeSlash("/help ").some((c) => c.includes("start")));
  });

  it("ask_user is explained, not a slash", () => {
    assert.match(formatUnknownSlash("/ask_user"), /model tool/);
  });

  it("preferences persist new setup keys", () => {
    savePreferences({
      seenSetup: true,
      setupSkipped: true,
      seenProviderModelConfirm: true,
      dismissedHints: ["no_budget"],
    });
    const p = loadPreferences();
    assert.equal(p.seenSetup, true);
    assert.equal(p.setupSkipped, true);
    assert.equal(p.seenProviderModelConfirm, true);
    assert.deepEqual(p.dismissedHints, ["no_budget"]);
  });

  it("runForgeInit writes config + AGENTS stub once", async () => {
    const r1 = await runForgeInit({ cwd, quiet: true });
    assert.ok(r1.wrote.some((p) => p.endsWith("config.toml")));
    assert.ok(r1.wrote.some((p) => p.endsWith("AGENTS.md")));
    assert.ok(fs.existsSync(path.join(home, "config.toml")));
    const r2 = await runForgeInit({ cwd, quiet: true });
    assert.ok(r2.existed.some((p) => p.endsWith("config.toml")));
    assert.ok(r2.existed.some((p) => p.endsWith("AGENTS.md")));
  });
});
