import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  browserLeaseFromCommand,
  defaultBrowserUdd,
  isReapableBrowserUdd,
  registerBrowserLease,
  reapSessionBrowsers,
  sessionBrowserOwnedPaths,
} from "../src/agent/browser-lease.js";
import { inspectSecureFile } from "../src/util/fs.js";

function withForgeHome(fn: (home: string) => void): void {
  const prevHome = process.env.FORGE_HOME;
  const prevMax = process.env.FORGE_BROWSER_LEASE_MAX;
  const prevMachine = process.env.FORGE_BROWSER_LEASE_MACHINE_MAX;
  const prevReap = process.env.FORGE_BROWSER_REAP;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-blease-"));
  process.env.FORGE_HOME = home;
  try {
    fn(home);
  } finally {
    if (prevHome === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prevHome;
    if (prevMax === undefined) delete process.env.FORGE_BROWSER_LEASE_MAX;
    else process.env.FORGE_BROWSER_LEASE_MAX = prevMax;
    if (prevMachine === undefined) delete process.env.FORGE_BROWSER_LEASE_MACHINE_MAX;
    else process.env.FORGE_BROWSER_LEASE_MACHINE_MAX = prevMachine;
    if (prevReap === undefined) delete process.env.FORGE_BROWSER_REAP;
    else process.env.FORGE_BROWSER_REAP = prevReap;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function readLeases(home: string, sessionId: string): Array<{ id: string; udd: string }> {
  const file = path.join(home, "sessions", sessionId, "browsers.json");
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
    leases?: Array<{ id: string; udd: string }>;
  };
  return Array.isArray(raw.leases) ? raw.leases : [];
}

describe("browser-lease", () => {
  it("parses Chrome for Testing spawn commands and ignores stock Chrome", () => {
    const parsed = browserLeaseFromCommand(
      'Google Chrome for Testing --user-data-dir=/tmp/hashpet-c17-profile-p9555 --remote-debugging-port=9555',
    );
    assert.ok(parsed);
    assert.equal(parsed.udd, "/tmp/hashpet-c17-profile-p9555");
    assert.equal(parsed.port, 9555);
    assert.equal(
      browserLeaseFromCommand(
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      ),
      undefined,
    );
  });

  it("defaultBrowserUdd sits under the session browsers/ dir", () => {
    withForgeHome((home) => {
      assert.equal(
        defaultBrowserUdd("abc", "lease1"),
        path.join(home, "sessions", "abc", "browsers", "lease1"),
      );
    });
  });

  it("refuses to reap $HOME, /, or stock Chrome profiles", () => {
    withForgeHome(() => {
      assert.equal(isReapableBrowserUdd(os.homedir()), false);
      assert.equal(isReapableBrowserUdd("/"), false);
      assert.equal(isReapableBrowserUdd("/tmp"), false);
      assert.equal(
        isReapableBrowserUdd(
          path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome"),
        ),
        false,
      );
    });
  });

  it("registers a lease, reuses the same UDD, and owns that path", () => {
    withForgeHome((home) => {
      const udd = defaultBrowserUdd("sess1", "a");
      fs.mkdirSync(udd, { recursive: true });
      const a = registerBrowserLease({
        sessionId: "sess1",
        udd,
        pid: 4242,
        cmd: `/Chromium --user-data-dir=${udd}`,
      });
      const again = registerBrowserLease({
        sessionId: "sess1",
        udd,
        pid: 4343,
      });
      assert.equal(again.id, a.id);
      assert.equal(again.pid, 4343);
      assert.equal(readLeases(home, "sess1").length, 1);
      const owned = sessionBrowserOwnedPaths("sess1");
      assert.ok(owned.some((p) => path.resolve(p) === path.resolve(udd)));
      const file = path.join(home, "sessions", "sess1", "browsers.json");
      const mode = inspectSecureFile(file);
      assert.equal(mode.exists, true);
      if (process.platform !== "win32") assert.equal(mode.modeOk, true);
    });
  });

  it("third register with max 2 reaps the oldest extra", () => {
    withForgeHome((home) => {
      process.env.FORGE_BROWSER_LEASE_MAX = "2";
      process.env.FORGE_BROWSER_LEASE_MACHINE_MAX = "20";
      const sid = "cap2";
      const u1 = defaultBrowserUdd(sid, "one");
      const u2 = defaultBrowserUdd(sid, "two");
      const u3 = defaultBrowserUdd(sid, "three");
      for (const d of [u1, u2, u3]) fs.mkdirSync(d, { recursive: true });
      registerBrowserLease({ sessionId: sid, udd: u1 });
      registerBrowserLease({ sessionId: sid, udd: u2 });
      registerBrowserLease({ sessionId: sid, udd: u3 });
      const leases = readLeases(home, sid);
      assert.equal(leases.length, 2);
      assert.equal(
        leases.some((l) => path.resolve(l.udd) === path.resolve(u1)),
        false,
      );
      assert.equal(fs.existsSync(u1), false);
      assert.equal(fs.existsSync(u2), true);
      assert.equal(fs.existsSync(u3), true);
    });
  });

  it("reapSessionBrowsers removes the recorded UDD under forge home", () => {
    withForgeHome(() => {
      const sid = "reap1";
      const udd = defaultBrowserUdd(sid, "gone");
      fs.mkdirSync(udd, { recursive: true });
      fs.writeFileSync(path.join(udd, "Local State"), "{}\n");
      registerBrowserLease({ sessionId: sid, udd });
      const r = reapSessionBrowsers(sid);
      assert.ok(r.removed.some((p) => path.resolve(p) === path.resolve(udd)));
      assert.equal(fs.existsSync(udd), false);
      assert.equal(sessionBrowserOwnedPaths(sid).includes(udd), false);
    });
  });

  it("invalid session id still registers under anon", () => {
    withForgeHome((home) => {
      const udd = defaultBrowserUdd("anon", "x");
      fs.mkdirSync(udd, { recursive: true });
      registerBrowserLease({ sessionId: "../../etc", udd });
      const file = path.join(home, "sessions", "anon", "browsers.json");
      assert.equal(fs.existsSync(file), true);
      assert.equal(readLeases(home, "anon").length, 1);
    });
  });
});
