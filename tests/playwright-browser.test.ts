/**
 * Playwright MCP must never drive the user's Chrome.app on macOS: a headless
 * copy registers as com.google.Chrome and swallows Dock launches. No browser
 * boots — installs are fake executables under a temp ms-playwright root.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServerConfig } from "../src/mcp/types.js";
import { managedBrowserArgs, managedChromiumExecutable } from "../src/mcp/playwright-browser.js";
import {
  decoratePlaywrightServer,
  defaultMcpServers,
} from "../src/mcp/defaults.js";

const CFT = "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const SHELL = "chrome-headless-shell-mac-arm64/chrome-headless-shell";
const roots: string[] = [];

after(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

function mkRoot(): string {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), "forge-pw-browsers-"));
  roots.push(r);
  return r;
}

/** A fake Playwright install: an executable at <root>/<dir>/<rel>. */
function install(root: string, dir: string, rel: string, complete = true): string {
  const exe = path.join(root, dir, rel);
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, "#!/bin/sh\n");
  fs.chmodSync(exe, 0o755);
  if (complete) fs.writeFileSync(path.join(root, dir, "INSTALLATION_COMPLETE"), "");
  return exe;
}

function pw(args: string[], env?: Record<string, string>): McpServerConfig {
  const cfg: McpServerConfig = {
    name: "playwright",
    command: "npx",
    args: ["-y", "@playwright/mcp@0.0.41", ...args],
  };
  if (env) cfg.env = env;
  return cfg;
}

/** Hermetic macOS arm64: the process env is not consulted. */
function mac(browsersRoot?: string, env: Record<string, string> = {}) {
  return {
    platform: "darwin" as const,
    arch: "arm64",
    env,
    ...(browsersRoot ? { browsersRoot } : {}),
  };
}

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("Playwright MCP browser on macOS", () => {
  it("picks the newest complete Chrome for Testing over the headless shell", () => {
    const root = mkRoot();
    install(root, "chromium-1228", `chrome-mac-arm64/${CFT}`);
    const newest = install(root, "chromium-1234", `chrome-mac-arm64/${CFT}`);
    install(root, "chromium-1240", `chrome-mac-arm64/${CFT}`, false); // download in flight
    install(root, "chromium_headless_shell-1250", SHELL);
    assert.deepEqual(managedBrowserArgs(pw(["--headless"]), mac(root)), [
      "--executable-path",
      newest,
    ]);
    assert.equal(
      managedChromiumExecutable({ ...mac(root), headless: true }),
      newest,
    );
  });

  it("finds the older chrome-mac/Chromium.app layout", () => {
    const root = mkRoot();
    const exe = install(root, "chromium-1117", "chrome-mac/Chromium.app/Contents/MacOS/Chromium");
    assert.deepEqual(managedBrowserArgs(pw(["--headless"]), mac(root)), [
      "--executable-path",
      exe,
    ]);
  });

  it("only a headless look may use chrome-headless-shell", () => {
    const root = mkRoot();
    const shell = install(root, "chromium_headless_shell-1234", SHELL);
    assert.deepEqual(managedBrowserArgs(pw(["--headless"]), mac(root)), [
      "--executable-path",
      shell,
    ]);
    assert.deepEqual(
      managedBrowserArgs(pw([], { PLAYWRIGHT_MCP_HEADLESS: "1" }), mac(root)),
      ["--executable-path", shell],
    );
    assert.deepEqual(managedBrowserArgs(pw([]), mac(root)), ["--browser", "chromium"]);
  });

  it("nothing installed is Playwright's chromium channel, never Chrome.app", () => {
    assert.deepEqual(managedBrowserArgs(pw(["--headless"]), mac(mkRoot())), [
      "--browser",
      "chromium",
    ]);
  });

  it("PLAYWRIGHT_BROWSERS_PATH moves the root; 0 keeps browsers in the package", () => {
    const root = mkRoot();
    const exe = install(root, "chromium-1234", `chrome-mac-arm64/${CFT}`);
    assert.deepEqual(
      managedBrowserArgs(pw(["--headless"]), mac(undefined, { PLAYWRIGHT_BROWSERS_PATH: root })),
      ["--executable-path", exe],
    );
    assert.deepEqual(
      managedBrowserArgs(pw(["--headless"]), mac(undefined, { PLAYWRIGHT_BROWSERS_PATH: "0" })),
      ["--browser", "chromium"],
    );
  });

  it("an entry that already picks a browser is left alone", () => {
    const root = mkRoot();
    install(root, "chromium-1234", `chrome-mac-arm64/${CFT}`);
    const chosen = [
      ["--browser", "msedge"],
      ["--browser=firefox"],
      ["--executable-path", "/opt/chrome"],
      ["--cdp-endpoint", "http://127.0.0.1:9222"],
      ["--extension"],
      ["--config", "/tmp/pw.json"],
    ];
    for (const args of chosen) {
      assert.deepEqual(managedBrowserArgs(pw(["--headless", ...args]), mac(root)), [], args.join(" "));
    }
    assert.deepEqual(
      managedBrowserArgs(pw(["--headless"], { PLAYWRIGHT_MCP_EXECUTABLE_PATH: "${env:PW_EXE}" }), mac(root)),
      [],
    );
    assert.deepEqual(
      managedBrowserArgs(pw(["--headless"]), mac(root, { PLAYWRIGHT_MCP_BROWSER: "chrome" })),
      [],
    );
  });

  it("other platforms, other servers and the kill switch keep their args", () => {
    const root = mkRoot();
    install(root, "chromium-1234", `chrome-mac-arm64/${CFT}`);
    assert.deepEqual(managedBrowserArgs(pw(["--headless"]), { ...mac(root), platform: "linux" }), []);
    assert.deepEqual(
      managedBrowserArgs(
        { name: "playwright", command: "npx", args: ["-y", "@executeautomation/playwright-mcp-server"] },
        mac(root),
      ),
      [],
    );
    assert.deepEqual(
      managedBrowserArgs(pw(["--headless"]), mac(root, { FORGE_PLAYWRIGHT_MANAGED_BROWSER: "0" })),
      [],
    );
  });

  it(
    "decorate points built-in and forge-init entries at the managed build",
    { skip: process.platform !== "darwin" && "macOS only" },
    () => {
      const root = mkRoot();
      const dir = process.arch === "arm64" ? "chrome-mac-arm64" : "chrome-mac-x64";
      const cft = install(root, "chromium-1234", `${dir}/${CFT}`);
      const clean = {
        PLAYWRIGHT_BROWSERS_PATH: root,
        FORGE_PLAYWRIGHT_MANAGED_BROWSER: undefined,
        FORGE_PLAYWRIGHT_ISOLATED: undefined,
        PLAYWRIGHT_MCP_BROWSER: undefined,
        PLAYWRIGHT_MCP_EXECUTABLE_PATH: undefined,
        PLAYWRIGHT_MCP_CDP_ENDPOINT: undefined,
        PLAYWRIGHT_MCP_CONFIG: undefined,
      };
      withEnv(clean, () => {
        const entries: McpServerConfig[] = [
          defaultMcpServers().playwright,
          { command: "npx", args: ["-y", "@playwright/mcp@latest", "--isolated"] },
        ];
        for (const cfg of entries) {
          const args = decoratePlaywrightServer("playwright", cfg).args ?? [];
          assert.equal(args[args.indexOf("--executable-path") + 1], cft, args.join(" "));
          assert.ok(!args.includes("--browser"), args.join(" "));
        }
        const edge = decoratePlaywrightServer("playwright", pw(["--browser", "msedge"])).args ?? [];
        assert.ok(!edge.includes("--executable-path"), edge.join(" "));
        withEnv({ FORGE_PLAYWRIGHT_ISOLATED: "0" }, () => {
          const raw = decoratePlaywrightServer("playwright", pw(["--headless"])).args ?? [];
          assert.equal(raw[raw.indexOf("--executable-path") + 1], cft, raw.join(" "));
        });
      });
    },
  );
});
