import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG } from "../src/config/types.js";
import { createSession } from "../src/session/session.js";
import { HookRunner } from "../src/harness/hooks.js";

describe("format-on-write", () => {
  let home: string;
  let prevHome: string | undefined;
  let prevEnv: string | undefined;

  before(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-fow-"));
    prevHome = process.env.FORGE_HOME;
    prevEnv = process.env.FORGE_FORMAT_ON_WRITE;
    process.env.FORGE_HOME = home;
  });

  after(() => {
    if (prevHome === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prevHome;
    if (prevEnv === undefined) delete process.env.FORGE_FORMAT_ON_WRITE;
    else process.env.FORGE_FORMAT_ON_WRITE = prevEnv;
  });

  it("isFormatOnWriteEnabled respects env override", async () => {
    const { isFormatOnWriteEnabled } = await import(
      "../src/agent/tools/format-on-write.js"
    );
    process.env.FORGE_FORMAT_ON_WRITE = "1";
    assert.equal(isFormatOnWriteEnabled(), true);
    process.env.FORGE_FORMAT_ON_WRITE = "0";
    assert.equal(isFormatOnWriteEnabled(), false);
    delete process.env.FORGE_FORMAT_ON_WRITE;
    assert.equal(isFormatOnWriteEnabled(), false);
  });

  it("maybeFormatAfterWrite no-ops when disabled", async () => {
    const { maybeFormatAfterWrite } = await import(
      "../src/agent/tools/format-on-write.js"
    );
    process.env.FORGE_FORMAT_ON_WRITE = "0";
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "forge-fow-ws-"));
    const f = path.join(ws, "a.ts");
    fs.writeFileSync(f, "const x=1");
    assert.equal(maybeFormatAfterWrite(f, ws), null);
  });

  it("maybeFormatAfterWrite never throws without formatter", async () => {
    const { maybeFormatAfterWrite } = await import(
      "../src/agent/tools/format-on-write.js"
    );
    process.env.FORGE_FORMAT_ON_WRITE = "1";
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "forge-fow-ws-"));
    // No package.json / no prettier — should return null (no formatter)
    const f = path.join(ws, "a.ts");
    fs.writeFileSync(f, "const x=1");
    const r = maybeFormatAfterWrite(f, ws);
    assert.equal(r, null);
  });

  it("formatNoteSuffix shapes messages", async () => {
    const { formatNoteSuffix } = await import(
      "../src/agent/tools/format-on-write.js"
    );
    assert.equal(formatNoteSuffix(null), "");
    assert.equal(
      formatNoteSuffix({ formatter: "prettier", ok: true }),
      " (formatted with prettier)",
    );
    assert.match(
      formatNoteSuffix({
        formatter: "biome",
        ok: false,
        detail: "boom",
      }),
      /format biome skipped/,
    );
  });

  it("/format slash toggles preference", async () => {
    delete process.env.FORGE_FORMAT_ON_WRITE;
    const { handleSlash } = await import("../src/commands/slash.js");
    const session = createSession({
      cwd: home,
      provider: "xai",
      model: "m",
    });
    const cfg = { ...DEFAULT_CONFIG, workspace: home };
    const hooks = new HookRunner(cfg, home);
    const off = await handleSlash("/format off", {
      session,
      config: cfg,
      hooks,
    });
    assert.equal(off.handled, true);
    assert.match(String(off.output || ""), /OFF/i);
    const on = await handleSlash("/format on", {
      session,
      config: cfg,
      hooks,
    });
    assert.equal(on.handled, true);
    assert.match(String(on.output || ""), /ON/i);
    const st = await handleSlash("/format", {
      session,
      config: cfg,
      hooks,
    });
    assert.equal(st.handled, true);
    assert.match(String(st.output || ""), /on/i);
    // env override wins
    process.env.FORGE_FORMAT_ON_WRITE = "0";
    const st2 = await handleSlash("/format status", {
      session,
      config: cfg,
      hooks,
    });
    assert.match(String(st2.output || ""), /off/i);
  });
});
