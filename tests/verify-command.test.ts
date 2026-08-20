import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveVerifyCommand,
  formatVerifyVerdict,
  formatVerifyCard,
  runVerify,
} from "../src/tui/verify-card.js";
import { collectStatusIssues } from "../src/tui/status-card.js";
import { createSession } from "../src/session/session.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";
import { classifyLiveSlash, handleSlash } from "../src/commands/slash.js";
import { resolveHeadlessSlashPrompt } from "../src/commands/headless-slash.js";
import { HookRunner } from "../src/harness/hooks.js";
import { searchHelpCatalog } from "../src/commands/help-text.js";

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("/verify", () => {
  let tmp: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-verify-"));
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

  function sess() {
    const session = createSession({ cwd: tmp, provider: "xai", model: "grok-4" });
    const config = { ...DEFAULT_CONFIG, workspace: tmp };
    return { session, config };
  }

  it("designed empty is nothing to run — not verify · ok", () => {
    const { session, config } = sess();
    const r = resolveVerifyCommand(session, config);
    assert.equal(r.reason, "empty");
    assert.equal(r.command, "");
    const card = strip(
      formatVerifyCard({
        kind: "empty",
        note: "No last check · no project check",
        next: ["/help verify"],
        color: false,
      }),
    );
    assert.match(card, /^verify  ·  nothing to run/);
    assert.doesNotMatch(card, /verify\s+·\s+ok/);
    assert.doesNotMatch(card, /✓/);
  });

  it("refuses a non-check arg", () => {
    const { session, config } = sess();
    const r = resolveVerifyCommand(session, config, "rm -rf /");
    assert.equal(r.reason, "refused");
    assert.equal(r.command, "");
    const card = strip(
      formatVerifyVerdict("refused", { color: false }),
    );
    assert.equal(card, "verify  ·  refused");
  });

  it("prefers lastVerificationCommand, then an explicit check", () => {
    const { session, config } = sess();
    session.meta.lastVerificationCommand = "npm test";
    assert.equal(resolveVerifyCommand(session, config).command, "npm test");
    assert.equal(resolveVerifyCommand(session, config).reason, "last");
    const arg = resolveVerifyCommand(session, config, "npx tsc --noEmit");
    assert.equal(arg.command, "npx tsc --noEmit");
    assert.equal(arg.reason, "arg");
  });

  it("status Next for a missing trail is /verify", () => {
    const { session, config } = sess();
    session.meta.editCount = 2;
    const issues = collectStatusIssues({ config, session });
    const v = issues.find((i) => i.kind === "verify");
    assert.ok(v);
    assert.equal(v!.next, "/verify");
  });

  it("is idle-only mid-run", () => {
    assert.equal(classifyLiveSlash("/verify"), "idle-only");
    assert.equal(classifyLiveSlash("/verify npm test"), "idle-only");
  });

  it("help search finds the command", () => {
    const hits = searchHelpCatalog("verify");
    assert.equal(hits[0]?.command, "/verify");
  });

  it("slash empty is designed empty and not failed", async () => {
    const { session, config } = sess();
    const hooks = new HookRunner(config, tmp);
    const r = await handleSlash("/verify", { session, config, hooks });
    assert.equal(r.handled, true);
    assert.equal(r.failed, false);
    const out = strip(String(r.output || ""));
    assert.match(out, /^verify  ·  nothing to run/);
    assert.match(out, /Next  \/help verify/);
  });

  it("slash refuses rm and fails closed", async () => {
    const { session, config } = sess();
    const hooks = new HookRunner(config, tmp);
    const r = await handleSlash("/verify rm -rf /", { session, config, hooks });
    assert.equal(r.handled, true);
    assert.equal(r.failed, true);
    const out = strip(String(r.output || ""));
    assert.match(out, /^verify  ·  refused/);
    assert.match(out, /not a project check/);
    assert.equal(session.meta.lastVerificationCommand, undefined);
  });

  it("runs last check, stamps green, opens verify · ok", async () => {
    const { session, config } = sess();
    const script = path.join(tmp, "ok.test.mjs");
    fs.writeFileSync(
      script,
      'import { it } from "node:test";\nit("ok", () => {});\n',
    );
    const cmd = `node --test ${script}`;
    session.meta.lastVerificationCommand = cmd;
    session.meta.editCount = 1;
    const result = await runVerify({
      session,
      config,
      persist: false,
      color: false,
    });
    assert.equal(result.failed, false);
    assert.equal(result.command, cmd);
    const out = strip(result.output);
    assert.match(out, /^verify  ·  ok/);
    assert.match(out, /Next  \/last/);
    assert.equal(session.meta.lastVerificationOk, true);
    assert.equal(session.meta.lastVerificationCommand, cmd);
  });

  it("red check stamps the trail and exits failed", async () => {
    const { session, config } = sess();
    // Local package.json so `npm test` cannot walk up into this repo's suite.
    fs.writeFileSync(
      path.join(tmp, "package.json"),
      JSON.stringify({
        name: "forge-verify-red",
        scripts: { test: "node -e \"process.exit(1)\"" },
      }),
    );
    const cmd = "npm test";
    const result = await runVerify({
      session,
      config,
      arg: cmd,
      persist: false,
      color: false,
    });
    assert.equal(result.failed, true);
    const out = strip(result.output);
    assert.match(out, /^verify  ·  ✗/);
    assert.match(out, /Next  \/verify/);
    assert.equal(session.meta.lastVerificationOk, false);
    assert.equal(session.meta.lastVerificationCommand, cmd);
  });

  it("headless forge run /verify fails closed on refuse", async () => {
    const { session, config } = sess();
    const hooks = new HookRunner(config, tmp);
    const r = await resolveHeadlessSlashPrompt({
      prompt: "/verify rm -rf /tmp/x",
      session,
      config,
      hooks,
    });
    assert.equal(r.kind, "done");
    if (r.kind === "done") {
      assert.equal(r.failed, true);
      assert.match(strip(r.output), /verify  ·  refused/);
    }
  });
});
