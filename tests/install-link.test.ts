import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BIN_NAMES,
  canReplaceForgeBin,
  cliPath,
  formatLinkReport,
  launcherPointsAtRepo,
  launcherSource,
  linkForge,
  listForgeOnPath,
  looksLikeForgeAgentBin,
  shQuote,
  writeLauncher,
} from "../scripts/link-forge.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function fakeRepo(): string {
  const root = tmp("forge-il-repo-");
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "dist", "cli.js"),
    "#!/usr/bin/env node\nconsole.log('forge-il-ok');\n",
    { mode: 0o755 },
  );
  return root;
}

function isolatedLink(
  root: string,
  extra: Record<string, unknown> = {},
): ReturnType<typeof linkForge> {
  const binDir = tmp("forge-il-bin-");
  const home = tmp("forge-il-home-");
  const r = linkForge({
    root,
    home,
    skipNpm: true,
    skipNpmBin: true,
    skipUserBin: true,
    binDirs: [binDir],
    pathEnv: binDir,
    nodePath: process.execPath,
    ...extra,
  });
  return Object.assign(r, { binDir, home });
}

describe("install link (bash install.sh)", () => {
  it("shQuote wraps spaces and nested quotes", () => {
    assert.equal(shQuote("/tmp/foo"), "'/tmp/foo'");
    assert.equal(shQuote("/tmp/a b/cli.js"), "'/tmp/a b/cli.js'");
    assert.equal(shQuote("it's"), `'it'\\''s'`);
  });

  it("launcher pins node and execs this clone's dist/cli.js", () => {
    const root = "/tmp/forge-agent clone";
    const src = launcherSource(root, "/opt/node bin/node");
    assert.match(src, /^#!/);
    assert.match(src, /Forge launcher/);
    assert.match(src, /exec "\$NODE"/);
    assert.ok(src.includes(shQuote("/opt/node bin/node")));
    assert.ok(src.includes(shQuote(cliPath(root))));
  });

  it("writeLauncher replaces a symlink instead of clobbering its target", () => {
    const dir = tmp("forge-il-sym-");
    const victim = path.join(dir, "victim.txt");
    fs.writeFileSync(victim, "keep me\n");
    const dest = path.join(dir, "forge");
    fs.symlinkSync(victim, dest);
    writeLauncher(dest, "/tmp/some-clone", process.execPath);
    assert.equal(fs.readFileSync(victim, "utf8"), "keep me\n");
    assert.match(fs.readFileSync(dest, "utf8"), /Forge launcher/);
    assert.equal(fs.lstatSync(dest).isSymbolicLink(), false);
  });

  it("looksLikeForgeAgentBin is true for launchers and false for native binaries", () => {
    const dir = tmp("forge-il-look-");
    const ours = path.join(dir, "forge");
    writeLauncher(ours, "/tmp/clone", process.execPath);
    assert.equal(looksLikeForgeAgentBin(ours), true);

    const foundry = path.join(dir, "foundry");
    fs.writeFileSync(
      foundry,
      Buffer.concat([Buffer.from("foundry-forge"), Buffer.from([0]), Buffer.from("x")]),
    );
    assert.equal(looksLikeForgeAgentBin(foundry), false);

    const symlink = path.join(dir, "link");
    fs.symlinkSync(path.join("/tmp", "other", "forge-agent", "dist", "cli.js"), symlink);
    assert.equal(looksLikeForgeAgentBin(symlink), true);
  });

  it("canReplaceForgeBin leaves a foreign binary and allows a missing path", () => {
    const dir = tmp("forge-il-rep-");
    const root = fakeRepo();
    const missing = path.join(dir, "forge");
    assert.equal(canReplaceForgeBin(missing, root), true);

    const foundry = path.join(dir, "foundry-forge");
    fs.writeFileSync(foundry, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2]));
    assert.equal(canReplaceForgeBin(foundry, root), false);
    assert.equal(launcherPointsAtRepo(foundry, root), false);
  });

  it("linkForge fails closed when dist/cli.js is missing", () => {
    const root = tmp("forge-il-empty-");
    const r = linkForge({
      root,
      skipNpm: true,
      skipNpmBin: true,
      skipUserBin: true,
      binDirs: [path.join(root, "bin")],
      pathEnv: "",
    });
    assert.equal(r.ok, false);
    assert.match(r.notes.join("\n"), /Missing .*dist[/\\]cli\.js/);
    assert.equal(r.launchers.length, 0);
  });

  it("linkForge writes forge and forge-agent launchers that point at this clone", () => {
    const root = fakeRepo();
    const r = isolatedLink(root);
    assert.equal(r.ok, true);
    assert.ok(r.launchers.some((p: string) => p.endsWith(`${path.sep}forge`)));
    assert.ok(r.launchers.some((p: string) => p.endsWith(`${path.sep}forge-agent`)));
    for (const p of r.launchers) {
      assert.equal(launcherPointsAtRepo(p, root), true);
      assert.match(fs.readFileSync(p, "utf8"), /Forge launcher/);
    }
    assert.equal(r.pathPointsHere, true);
    assert.equal(r.bestBin, r.forgeOnPath);
    const report = formatLinkReport(r);
    assert.match(report, /^FORGE_BIN=/m);
    assert.match(report, /this clone/);
  });

  it("linkForge replaces a stale PATH forge-agent bin and leaves Foundry alone", () => {
    const root = fakeRepo();
    const destDir = tmp("forge-il-dest-");
    const staleDir = tmp("forge-il-stale-");
    const stale = path.join(staleDir, "forge");
    fs.writeFileSync(
      stale,
      "#!/usr/bin/env bash\n# Forge launcher\nexec node '/other/clone/forge-agent/dist/cli.js' \"$@\"\n",
      { mode: 0o755 },
    );
    const staleRun = isolatedLink(root, {
      pathEnv: staleDir,
      binDirs: [destDir],
    });
    assert.equal(staleRun.ok, true);
    assert.equal(launcherPointsAtRepo(stale, root), true);
    assert.ok(staleRun.notes.some((n: string) => /Replaced stale PATH forge/.test(n)));

    const foundryDir = tmp("forge-il-foundry-");
    const foundry = path.join(foundryDir, "forge");
    fs.writeFileSync(foundry, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2]));
    fs.chmodSync(foundry, 0o755);
    const otherBin = tmp("forge-il-other-");
    const foundryRun = isolatedLink(root, {
      pathEnv: foundryDir,
      binDirs: [otherBin],
    });
    assert.equal(foundryRun.ok, true);
    assert.equal(canReplaceForgeBin(foundry, root), false);
    assert.deepEqual(
      fs.readFileSync(foundry).subarray(0, 4),
      Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
    );
    assert.ok(
      foundryRun.notes.some((n: string) => /PATH's forge is/.test(n) && /not this clone/.test(n)),
    );
    assert.equal(foundryRun.pathPointsHere, false);
    assert.ok(foundryRun.bestBin && foundryRun.bestBin.startsWith(otherBin));
  });

  it("linkForge notes export PATH when the launcher dir is not on PATH", () => {
    const root = fakeRepo();
    const binDir = tmp("forge-il-offpath-");
    const r = linkForge({
      root,
      skipNpm: true,
      skipNpmBin: true,
      skipUserBin: true,
      binDirs: [binDir],
      pathEnv: path.join(tmp("forge-il-nopath-"), "no-bin"),
      nodePath: process.execPath,
    });
    assert.equal(r.ok, true);
    assert.equal(r.forgeOnPath, null);
    assert.ok(r.notes.some((n: string) => /export PATH=/.test(n)));
    assert.equal(listForgeOnPath(binDir).length, 1);
    assert.equal(BIN_NAMES.includes("forge-agent"), true);
  });

  it("install.sh is bash-3.2-safe and no longer dies on npm link", () => {
    const shPath = path.join(REPO, "install.sh");
    const sh = fs.readFileSync(shPath, "utf8");
    assert.match(sh, /scripts\/link-forge\.mjs/);
    assert.doesNotMatch(sh, /^\s*npm link\s*$/m);
    assert.match(sh, /hash -r/);
    assert.match(sh, /pwd -P/);
    assert.match(sh, /unset CDPATH/);
    assert.match(sh, /set \+eu/);
    assert.match(sh, /nvm\.sh/);
    assert.match(sh, /fnm env/);
    assert.match(sh, /volta/);
    assert.match(sh, /asdf\.sh/);
    assert.match(sh, /git pull && bash install\.sh/);
    assert.doesNotMatch(sh, /mapfile|readarray|declare -A|\|&/);
    const st = fs.statSync(shPath);
    assert.ok((st.mode & 0o111) !== 0, "install.sh must stay executable");
    const syntax = spawnSync("bash", ["-n", shPath], { encoding: "utf8" });
    assert.equal(syntax.status, 0, syntax.stderr || syntax.stdout);
  });
});
