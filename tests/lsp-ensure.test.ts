/**
 * LSP detect + ensure plan (no real network installs in CI).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  detectProjectLanguages,
  languagesToEnsure,
} from "../src/lsp/detect.js";
import {
  buildEnsurePlan,
  ensureLspServers,
  formatEnsurePlan,
  lspAutoEnsureEnabled,
} from "../src/lsp/ensure.js";
import {
  isLspToolName,
  lspActionInstalls,
} from "../src/lsp/tools.js";

let tmp: string;
const prevAuto = process.env.FORGE_LSP_AUTO;
const prevInstall = process.env.FORGE_LSP_AUTO_INSTALL;

before(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "forge-lsp-ensure-"));
});

after(async () => {
  if (prevAuto === undefined) delete process.env.FORGE_LSP_AUTO;
  else process.env.FORGE_LSP_AUTO = prevAuto;
  if (prevInstall === undefined) delete process.env.FORGE_LSP_AUTO_INSTALL;
  else process.env.FORGE_LSP_AUTO_INSTALL = prevInstall;
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe("detectProjectLanguages", () => {
  it("always recommends typescript + python default pack", () => {
    const empty = path.join(tmp, "empty");
    fs.mkdirSync(empty, { recursive: true });
    const d = detectProjectLanguages(empty);
    const ids = d.map((x) => x.languageId);
    assert.ok(ids.includes("typescript"));
    assert.ok(ids.includes("python"));
    assert.equal(
      d.find((x) => x.languageId === "typescript")?.tier,
      "default",
    );
  });

  it("detects rust/go from markers as project tier", () => {
    const rs = path.join(tmp, "rust-proj");
    fs.mkdirSync(rs, { recursive: true });
    fs.writeFileSync(path.join(rs, "Cargo.toml"), "[package]\nname='x'\n");
    fs.writeFileSync(path.join(rs, "go.mod"), "module example.com/x\n");
    const d = detectProjectLanguages(rs);
    assert.ok(d.some((x) => x.languageId === "rust" && x.tier === "project"));
    assert.ok(d.some((x) => x.languageId === "go" && x.tier === "project"));
    const ensure = languagesToEnsure(d);
    assert.ok(ensure.includes("typescript"));
    assert.ok(ensure.includes("python"));
    assert.ok(ensure.includes("rust"));
    assert.ok(ensure.includes("go"));
  });

  it("detects package.json typescript deps", () => {
    const p = path.join(tmp, "node-proj");
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(
      path.join(p, "package.json"),
      JSON.stringify({
        devDependencies: { typescript: "^5", tsx: "^4" },
      }),
    );
    const d = detectProjectLanguages(p);
    const ts = d.find((x) => x.languageId === "typescript");
    assert.ok(ts);
    assert.ok(ts!.reasons.some((r) => /TypeScript|package\.json/i.test(r)));
  });
});

describe("buildEnsurePlan", () => {
  it("plans default pack and shell tip", () => {
    const empty = path.join(tmp, "plan-empty");
    fs.mkdirSync(empty, { recursive: true });
    const plan = buildEnsurePlan(empty);
    assert.ok(plan.items.some((i) => i.languageId === "typescript"));
    assert.ok(plan.items.some((i) => i.languageId === "python"));
    assert.ok(plan.items.some((i) => i.languageId === "shell" && i.manualOnly));
    const text = formatEnsurePlan(plan);
    assert.match(text, /forge lsp ensure/i);
  });

  it("dry-run ensure does not install", async () => {
    process.env.FORGE_LSP_AUTO_INSTALL = "0";
    const empty = path.join(tmp, "dry");
    fs.mkdirSync(empty, { recursive: true });
    const result = await ensureLspServers({
      workspace: empty,
      dryRun: true,
      forceInstall: false,
    });
    assert.equal(result.installed.length, 0);
    assert.ok(result.dryRun);
    delete process.env.FORGE_LSP_AUTO_INSTALL;
  });
});

describe("env gates", () => {
  it("FORGE_LSP_AUTO=0 disables soft ensure", () => {
    process.env.FORGE_LSP_AUTO = "0";
    assert.equal(lspAutoEnsureEnabled(), false);
    delete process.env.FORGE_LSP_AUTO;
    assert.equal(lspAutoEnsureEnabled(), true);
  });
});

describe("lspActionInstalls", () => {
  it("treats ensure as an install and dry-run / other actions as not", () => {
    assert.equal(isLspToolName("lsp"), true);
    assert.equal(isLspToolName("LSP"), true);
    assert.equal(isLspToolName("bash"), false);
    assert.equal(lspActionInstalls({ action: "ensure" }), true);
    assert.equal(lspActionInstalls({ method: "ensure" }), true);
    assert.equal(lspActionInstalls({ action: "ensure", dry_run: true }), false);
    assert.equal(lspActionInstalls({ action: "ensure", mode: "dry" }), false);
    assert.equal(lspActionInstalls({ action: "status" }), false);
    assert.equal(lspActionInstalls({ action: "install" }), false);
    assert.equal(lspActionInstalls({ action: "diagnostics" }), false);
  });
});
