/**
 * `/help` first-day is a numbered 1–6 card, not a catalog wall.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleSlash } from "../src/commands/slash.js";
import { helpFor } from "../src/commands/help-text.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";
import { HookRunner } from "../src/harness/hooks.js";
import { createSession } from "../src/session/session.js";
import {
  formatHelpStartCard,
  formatHelpStartItem,
  parseHelpStartKey,
} from "../src/tui/help-card.js";

describe("/help start card", () => {
  it("numbers 1–6 with Next /setup", () => {
    assert.equal(parseHelpStartKey(""), null);
    assert.equal(parseHelpStartKey("1"), 1);
    assert.equal(parseHelpStartKey("7"), null);
    const card = formatHelpStartCard();
    assert.match(card, /^help  ·  start$/m);
    assert.match(card, /Type a task in English/);
    assert.match(card, /  1  \/setup/);
    assert.match(card, /  6  \/help all/);
    assert.match(card, /Next  \/setup/);
    assert.doesNotMatch(card, /Getting started/);
    assert.doesNotMatch(card, /\/max-waves/);
    const one = formatHelpStartItem(1)!;
    assert.match(one, /help  ·  1/);
    assert.match(one, /\/setup/);
    assert.match(one, /Next  \/setup/);
  });

  it("helpFor empty is the card; /help 1 points at /setup", () => {
    const start = helpFor("");
    assert.equal(start.topic, "start");
    assert.match(start.text, /help  ·  start/);
    const one = helpFor("1");
    assert.equal(one.topic, "start");
    assert.match(one.text, /help  ·  1/);
    assert.match(one.text, /Next  \/setup/);
  });
});

describe("/help slash", () => {
  let tmp: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-help-card-"));
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

  it("empty /help is the numbered card", async () => {
    const s = createSession({ cwd: tmp, provider: "xai", model: "grok-4.6" });
    const config = { ...DEFAULT_CONFIG, workspace: tmp };
    const r = await handleSlash("/help", {
      session: s,
      config,
      hooks: new HookRunner(config, tmp),
    });
    const out = String(r.output || "");
    assert.match(out, /help  ·  start/);
    assert.match(out, /  1  \/setup/);
    assert.match(out, /Next  \/setup/);
    assert.doesNotMatch(out, /Getting started/);
  });

  it("/help 1 Nexts /setup", async () => {
    const s = createSession({ cwd: tmp, provider: "xai", model: "grok-4.6" });
    const config = { ...DEFAULT_CONFIG, workspace: tmp };
    const r = await handleSlash("/help 1", {
      session: s,
      config,
      hooks: new HookRunner(config, tmp),
    });
    const out = String(r.output || "");
    assert.match(out, /help  ·  1/);
    assert.match(out, /Next  \/setup/);
  });
});
