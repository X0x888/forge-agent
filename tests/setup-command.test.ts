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
    assert.match(String(r.output), /\/max-waves/);
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

  it("/setup budget 5 sets session cap", async () => {
    const s = session();
    const r = await handleSlash("/setup budget 5", {
      session: s,
      config: { ...DEFAULT_CONFIG, workspace: cwd },
      hooks: new HookRunner(DEFAULT_CONFIG, cwd),
    });
    assert.match(String(r.output), /\$5/);
    assert.equal(s.meta.maxCostUsd, 5);
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
