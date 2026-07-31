/**
 * Regression: `forge run "/<readonly>" --continue` must never delete the
 * resumed session. Ephemeral discard is only for sessions created fresh by
 * the probe invocation itself.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const CLI = path.join(process.cwd(), "dist/cli.js");

function sessionIds(home: string): string[] {
  const root = path.join(home, "sessions");
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

describe("forge run readonly slash + --continue", () => {
  let tmp: string;
  let home: string;
  let proj: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    // realpath: macOS /var → /private/var — child process.cwd() is physical,
    // and same-cwd session matching compares resolved paths.
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "forge-hsl-cont-")));
    home = path.join(tmp, "home");
    proj = path.join(tmp, "proj");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(proj, { recursive: true });
    prevHome = process.env.FORGE_HOME;
    process.env.FORGE_HOME = home;
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

  it("readonly probe under --continue keeps the resumed session", async () => {
    const { createSession, saveSession, loadSession } = await import(
      "../src/session/session.js"
    );
    const s = createSession({ cwd: proj, provider: "xai", model: "m" });
    s.messages.push({ role: "user", content: "hi" });
    s.messages.push({ role: "assistant", content: "working" });
    saveSession(s);
    const sessionId = s.meta.id;

    const r = spawnSync(
      process.execPath,
      [CLI, "run", "/commands", "--continue", "--json"],
      {
        cwd: proj,
        env: { ...process.env, FORGE_HOME: home },
        encoding: "utf8",
        timeout: 15000,
      },
    );
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const j = JSON.parse(r.stdout);
    assert.equal(j.ok, true);
    assert.equal(j.reason, "slash");
    assert.equal(j.ephemeral, false);
    assert.equal(j.sessionId, sessionId);
    // The resumed session must still exist on disk.
    assert.ok(loadSession(sessionId), "resumed session was deleted");
  });

  it("fresh readonly probe still discards its throwaway session", () => {
    const r = spawnSync(
      process.execPath,
      [CLI, "run", "/commands", "--json"],
      {
        cwd: proj,
        env: { ...process.env, FORGE_HOME: home },
        encoding: "utf8",
        timeout: 15000,
      },
    );
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const j = JSON.parse(r.stdout);
    assert.equal(j.ok, true);
    assert.equal(j.reason, "slash");
    assert.equal(j.ephemeral, true);
    assert.equal(j.sessionId, null);
    assert.deepEqual(sessionIds(home), []);
  });
});
