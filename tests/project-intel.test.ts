/**
 * Project intelligence — package manager + check command detection.
 */
import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  clearProjectIntelCache,
  detectPackageManager,
  detectProjectIntel,
  formatProjectIntelForPrompt,
  wrongPackageManagerTip,
  missingScriptTip,
  missingBinaryTip,
  missingNodeModulesTip,
  hasNodeModules,
  monorepoLayoutTip,
  nextCheckTip,
  packageManagerLockfileMismatch,
  multipleLockfiles,
  multipleLockfilesTip,
  permissionDeniedTip,
  verifyHintSuffix,
} from "../src/util/project-intel.js";
import { buildBaselineSystemPrompt } from "../src/agent/system-prompt.js";
import type { ForgeConfig } from "../src/config/types.js";

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(root: string, rel: string, body: string): void {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body, "utf8");
}

/** Mark a temp dir as a git root so monorepo walk-up is bounded correctly. */
function seedGit(root: string): void {
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
}

const baseConfig = {
  provider: "xai",
  model: "grok-4.5",
  permissionMode: "default",
  blockingStopHooks: true,
} as ForgeConfig;

describe("multipleLockfiles", () => {
  it("detects npm + yarn lockfiles together", () => {
    const d = tmpDir("forge-multi-lock-");
    write(d, "package.json", "{}");
    write(d, "package-lock.json", "{}");
    write(d, "yarn.lock", "# yarn\n");
    const multi = multipleLockfiles(d);
    assert.ok(multi.includes("package-lock.json"));
    assert.ok(multi.includes("yarn.lock"));
  });

  it("returns empty when only one lockfile family", () => {
    const d = tmpDir("forge-one-lock-");
    write(d, "package.json", "{}");
    write(d, "package-lock.json", "{}");
    assert.deepEqual(multipleLockfiles(d), []);
  });
});

describe("packageManagerLockfileMismatch", () => {
  it("flags packageManager field vs foreign lockfile", () => {
    const d = tmpDir("forge-pm-mismatch-");
    write(
      d,
      "package.json",
      JSON.stringify({ packageManager: "pnpm@9.0.0" }),
    );
    write(d, "package-lock.json", "{}");
    const m = packageManagerLockfileMismatch(d);
    assert.ok(m);
    assert.equal(m!.field, "pnpm");
    assert.equal(m!.lockfile, "npm");
    assert.match(m!.detail, /package-lock\.json/);
  });

  it("returns null when field matches lockfile", () => {
    const d = tmpDir("forge-pm-match-");
    write(d, "package.json", JSON.stringify({ packageManager: "npm@10" }));
    write(d, "package-lock.json", "{}");
    assert.equal(packageManagerLockfileMismatch(d), null);
  });
});

describe("detectPackageManager", () => {
  before(() => {
    clearProjectIntelCache();
  });

  it("prefers pnpm lockfile", () => {
    const d = tmpDir("forge-pm-pnpm-");
    write(d, "package.json", JSON.stringify({ name: "x" }));
    write(d, "pnpm-lock.yaml", "lockfileVersion: 9\n");
    write(d, "package-lock.json", "{}\n");
    assert.equal(detectPackageManager(d), "pnpm");
  });

  it("detects yarn, bun, npm lockfiles", () => {
    const yarn = tmpDir("forge-pm-yarn-");
    write(yarn, "package.json", "{}");
    write(yarn, "yarn.lock", "# yarn\n");
    assert.equal(detectPackageManager(yarn), "yarn");

    const bun = tmpDir("forge-pm-bun-");
    write(bun, "package.json", "{}");
    write(bun, "bun.lockb", "x");
    assert.equal(detectPackageManager(bun), "bun");

    const npm = tmpDir("forge-pm-npm-");
    write(npm, "package.json", "{}");
    write(npm, "package-lock.json", "{}");
    assert.equal(detectPackageManager(npm), "npm");
  });

  it("reads packageManager field when no lockfile", () => {
    const d = tmpDir("forge-pm-field-");
    write(
      d,
      "package.json",
      JSON.stringify({ packageManager: "pnpm@9.0.0" }),
    );
    assert.equal(detectPackageManager(d), "pnpm");
  });

  it("returns undefined without package.json", () => {
    const d = tmpDir("forge-pm-empty-");
    assert.equal(detectPackageManager(d), undefined);
  });
});

describe("detectProjectIntel", () => {
  beforeEach(() => {
    clearProjectIntelCache();
  });

  it("surfaces npm scripts as check commands (priority order)", () => {
    const d = tmpDir("forge-intel-node-");
    write(
      d,
      "package.json",
      JSON.stringify({
        name: "demo-app",
        version: "1.2.3",
        scripts: {
          build: "tsc",
          test: "node --test",
          typecheck: "tsc --noEmit",
          lint: "eslint .",
          unused: "echo hi",
        },
      }),
    );
    write(d, "package-lock.json", "{}");
    write(d, "tsconfig.json", "{}");
    const intel = detectProjectIntel(d);
    assert.equal(intel.packageManager, "npm");
    assert.equal(intel.packageName, "demo-app");
    assert.equal(intel.packageVersion, "1.2.3");
    assert.ok(intel.kinds.includes("node"));
    assert.ok(intel.kinds.includes("typescript"));
    assert.deepEqual(intel.checkCommands.slice(0, 4), [
      "npm run typecheck",
      "npm test",
      "npm run lint",
      "npm run build",
    ]);
    assert.match(intel.summary, /demo-app@1\.2\.3/);
    assert.match(intel.summary, /npm/);
  });

  it("uses pnpm run forms", () => {
    const d = tmpDir("forge-intel-pnpm-");
    write(
      d,
      "package.json",
      JSON.stringify({
        name: "p",
        scripts: { test: "vitest", typecheck: "tsc -b" },
      }),
    );
    write(d, "pnpm-lock.yaml", "lockfileVersion: 9\n");
    const intel = detectProjectIntel(d);
    assert.equal(intel.packageManager, "pnpm");
    assert.ok(intel.checkCommands.includes("pnpm run typecheck"));
    assert.ok(intel.checkCommands.includes("pnpm test"));
  });

  it("does not walk above git root for monorepo detection", () => {
    const outer = tmpDir("forge-intel-outer-mono-");
    write(
      outer,
      "package.json",
      JSON.stringify({ private: true, workspaces: ["apps/*"] }),
    );
    write(outer, "pnpm-workspace.yaml", "packages:\n  - apps/*\n");
    // Nested git repo (simulates unrelated monorepo parent outside git root).
    const inner = path.join(outer, "apps", "site");
    fs.mkdirSync(inner, { recursive: true });
    fs.mkdirSync(path.join(inner, ".git"), { recursive: true });
    write(inner, "package.json", JSON.stringify({ name: "site", scripts: { test: "x" } }));
    write(inner, "package-lock.json", "{}");
    clearProjectIntelCache();
    // From inside the git repo, outer monorepo must not leak in.
    const intel = detectProjectIntel(inner);
    assert.notEqual(intel.monorepoRoot, path.resolve(outer));
    assert.equal(detectPackageManager(inner), "npm");
  });

  it("inherits monorepo root package manager when nested package has no lockfile", () => {
    const d = tmpDir("forge-intel-nested-pm-");
    write(
      d,
      "package.json",
      JSON.stringify({
        name: "mono-pnpm",
        private: true,
        workspaces: ["packages/*"],
      }),
    );
    write(d, "pnpm-lock.yaml", "lockfileVersion: 9\n");
    write(d, "pnpm-workspace.yaml", "packages:\n  - packages/*\n");
    seedGit(d);
    fs.mkdirSync(path.join(d, "packages", "lib"), { recursive: true });
    write(
      d,
      "packages/lib/package.json",
      JSON.stringify({ name: "@mono/lib", scripts: { test: "node --test" } }),
    );
    clearProjectIntelCache();
    const nested = path.join(d, "packages", "lib");
    assert.equal(detectPackageManager(nested), "pnpm");
    const intel = detectProjectIntel(nested);
    assert.equal(intel.packageManager, "pnpm");
    assert.ok(intel.checkCommands.some((c) => c.startsWith("pnpm")));
  });

  it("walks up to monorepo root from a nested package cwd", () => {
    const d = tmpDir("forge-intel-nested-");
    write(
      d,
      "package.json",
      JSON.stringify({
        name: "mono-root",
        private: true,
        workspaces: ["packages/*"],
        scripts: { typecheck: "tsc -b", test: "echo root-test" },
      }),
    );
    write(d, "package-lock.json", "{}");
    write(d, "turbo.json", JSON.stringify({ pipeline: { test: {} } }));
    seedGit(d);
    fs.mkdirSync(path.join(d, "packages", "core"), { recursive: true });
    write(
      d,
      "packages/core/package.json",
      JSON.stringify({
        name: "@mono/core",
        version: "1.0.0",
        scripts: { test: "node --test" },
      }),
    );
    clearProjectIntelCache();
    const nested = path.join(d, "packages", "core");
    const intel = detectProjectIntel(nested);
    assert.equal(intel.packageName, "@mono/core");
    assert.equal(intel.monorepoRoot, path.resolve(d));
    assert.ok(intel.kinds.includes("monorepo"));
    assert.ok(intel.kinds.includes("turbo"));
    // Local package test first, then root/turbo checks.
    assert.ok(intel.checkCommands.some((c) => c === "npm test"));
    assert.ok(intel.checkCommands.some((c) => /turbo run test/.test(c)));
    assert.ok(intel.workspaces.length >= 1);
    const prompt = formatProjectIntelForPrompt(intel);
    assert.match(prompt, /Monorepo root:/);
    assert.match(prompt, /Workspaces:/);
  });

  it("detects turbo.json check commands", () => {
    const d = tmpDir("forge-intel-turbo-");
    write(d, "package.json", JSON.stringify({ name: "t", scripts: {} }));
    write(d, "package-lock.json", "{}");
    write(d, "turbo.json", JSON.stringify({ pipeline: { test: {} } }));
    clearProjectIntelCache();
    const intel = detectProjectIntel(d);
    assert.ok(intel.kinds.includes("turbo"));
    assert.ok(intel.kinds.includes("monorepo"));
    assert.ok(intel.checkCommands.some((c) => /turbo run test/.test(c)));
    assert.ok(intel.checkCommands.some((c) => /turbo run typecheck/.test(c)));
  });

  it("detects monorepo workspaces from package.json", () => {
    const d = tmpDir("forge-intel-ws-");
    write(
      d,
      "package.json",
      JSON.stringify({
        name: "mono",
        private: true,
        workspaces: ["packages/*"],
        scripts: { test: "echo root" },
      }),
    );
    write(d, "package-lock.json", "{}");
    seedGit(d);
    write(d, "packages/core/package.json", JSON.stringify({ name: "@mono/core" }));
    write(d, "packages/cli/package.json", JSON.stringify({ name: "@mono/cli" }));
    // ensure dirs exist
    fs.mkdirSync(path.join(d, "packages", "core"), { recursive: true });
    fs.mkdirSync(path.join(d, "packages", "cli"), { recursive: true });
    write(d, "packages/core/package.json", JSON.stringify({ name: "@mono/core" }));
    write(d, "packages/cli/package.json", JSON.stringify({ name: "@mono/cli" }));
    clearProjectIntelCache();
    const intel = detectProjectIntel(d);
    assert.ok(intel.kinds.includes("monorepo"));
    assert.ok(intel.workspaces.length >= 2);
    assert.ok(intel.workspaces.some((w) => /@mono\/core|packages\/core/.test(w)));
    const prompt = formatProjectIntelForPrompt(intel);
    assert.match(prompt, /Workspaces:/);
    assert.match(prompt, /Monorepo:/);
  });

  it("detects rust / go / python check commands", () => {
    const rust = tmpDir("forge-intel-rust-");
    write(rust, "Cargo.toml", '[package]\nname = "r"\nversion = "0.1.0"\n');
    const r = detectProjectIntel(rust);
    assert.ok(r.checkCommands.includes("cargo test"));
    assert.ok(r.kinds.includes("rust"));

    const go = tmpDir("forge-intel-go-");
    write(go, "go.mod", "module example.com/x\n\ngo 1.22\n");
    const g = detectProjectIntel(go);
    assert.ok(g.checkCommands.includes("go test ./..."));

    const py = tmpDir("forge-intel-py-");
    write(py, "pyproject.toml", "[project]\nname = 'p'\n");
    write(py, "pytest.ini", "[pytest]\n");
    const p = detectProjectIntel(py);
    assert.ok(p.checkCommands.includes("pytest"));
  });

  it("formatProjectIntelForPrompt is empty when blank", () => {
    assert.equal(
      formatProjectIntelForPrompt({
        kinds: [],
        checkCommands: [],
        workspaces: [],
        summary: "",
      }),
      "",
    );
  });

  it("formatProjectIntelForPrompt includes Commands line", () => {
    const text = formatProjectIntelForPrompt({
      kinds: ["node", "typescript"],
      packageManager: "npm",
      packageName: "forge",
      packageVersion: "0.9.0",
      checkCommands: ["npm test", "npm run typecheck"],
      workspaces: [],
      summary: "x",
    });
    assert.match(text, /Project: forge@0\.9\.0 · pm=npm · node\+typescript/);
    assert.match(text, /Commands: npm test {2}· {2}npm run typecheck/);
    assert.match(text, /Prefer these project commands/);
  });
});

describe("verifyHintSuffix", () => {
  it("suggests cheapest check command", () => {
    const d = tmpDir("forge-verify-hint-");
    write(
      d,
      "package.json",
      JSON.stringify({
        name: "v",
        scripts: { typecheck: "tsc -b", test: "node --test" },
      }),
    );
    write(d, "package-lock.json", "{}");
    const tip = verifyHintSuffix(d);
    assert.match(tip, /Tip: verify with `npm run typecheck`/);
  });

  it("honors FORGE_VERIFY_HINT=0", () => {
    const d = tmpDir("forge-verify-off-");
    write(d, "package.json", JSON.stringify({ scripts: { test: "x" } }));
    write(d, "package-lock.json", "{}");
    const prev = process.env.FORGE_VERIFY_HINT;
    process.env.FORGE_VERIFY_HINT = "0";
    try {
      assert.equal(verifyHintSuffix(d), "");
    } finally {
      if (prev === undefined) delete process.env.FORGE_VERIFY_HINT;
      else process.env.FORGE_VERIFY_HINT = prev;
    }
  });

  it("skips verify tip for pure documentation paths", () => {
    const d = tmpDir("forge-verify-md-");
    write(
      d,
      "package.json",
      JSON.stringify({ scripts: { test: "node --test" } }),
    );
    write(d, "package-lock.json", "{}");
    assert.equal(verifyHintSuffix(d, path.join(d, "README.md")), "");
    assert.equal(verifyHintSuffix(d, path.join(d, "docs/guide.txt")), "");
    assert.match(verifyHintSuffix(d, path.join(d, "src/x.ts")), /Tip: verify/);
  });
});

describe("missingNodeModulesTip", () => {
  it("tips install when module-not-found and no node_modules", () => {
    const d = tmpDir("forge-miss-nm-");
    write(d, "package.json", JSON.stringify({ name: "x" }));
    write(d, "pnpm-lock.yaml", "lockfileVersion: 9\n");
    const tip = missingNodeModulesTip(
      "Error: Cannot find module 'chalk'",
      d,
    );
    assert.ok(tip);
    assert.match(tip!, /pnpm install/);
  });

  it("returns null when node_modules exists", () => {
    const d = tmpDir("forge-miss-nm-ok-");
    write(d, "package.json", JSON.stringify({ name: "x" }));
    fs.mkdirSync(path.join(d, "node_modules"), { recursive: true });
    assert.equal(
      missingNodeModulesTip("Error: Cannot find module 'chalk'", d),
      null,
    );
  });

  it("treats hoisted monorepo root node_modules as present for nested cwd", () => {
    const d = tmpDir("forge-miss-nm-hoist-");
    write(
      d,
      "package.json",
      JSON.stringify({ private: true, workspaces: ["packages/*"] }),
    );
    write(d, "package-lock.json", "{}");
    seedGit(d);
    fs.mkdirSync(path.join(d, "node_modules"), { recursive: true });
    fs.mkdirSync(path.join(d, "packages", "lib"), { recursive: true });
    write(d, "packages/lib/package.json", JSON.stringify({ name: "@m/lib" }));
    clearProjectIntelCache();
    const nested = path.join(d, "packages", "lib");
    assert.equal(hasNodeModules(nested), true);
    assert.equal(
      missingNodeModulesTip("Error: Cannot find module 'chalk'", nested),
      null,
    );
  });
});

describe("monorepoLayoutTip", () => {
  it("points at monorepo root on workspace layout errors", () => {
    const d = tmpDir("forge-mono-layout-");
    write(
      d,
      "package.json",
      JSON.stringify({
        private: true,
        workspaces: ["packages/*"],
        scripts: { test: "echo t" },
      }),
    );
    write(d, "package-lock.json", "{}");
    seedGit(d);
    fs.mkdirSync(path.join(d, "packages", "a"), { recursive: true });
    write(d, "packages/a/package.json", JSON.stringify({ name: "a" }));
    clearProjectIntelCache();
    const tip = monorepoLayoutTip(
      "ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND: No package.json",
      path.join(d, "packages", "a"),
    );
    assert.ok(tip);
    assert.match(tip!, /Monorepo root:/);
  });

  it("returns null outside monorepos", () => {
    const d = tmpDir("forge-mono-layout-none-");
    write(d, "package.json", JSON.stringify({ scripts: { test: "x" } }));
    assert.equal(
      monorepoLayoutTip("ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND", d),
      null,
    );
  });
});

describe("nextCheckTip", () => {
  it("suggests the next preferred check after a failed one", () => {
    const d = tmpDir("forge-next-check-");
    write(
      d,
      "package.json",
      JSON.stringify({
        scripts: {
          typecheck: "tsc -b",
          test: "node --test",
          lint: "eslint .",
        },
      }),
    );
    write(d, "package-lock.json", "{}");
    const tip = nextCheckTip("npm run typecheck", d);
    assert.ok(tip);
    assert.match(tip!, /Next try: npm test/);
  });

  it("returns null for non-check commands", () => {
    const d = tmpDir("forge-next-none-");
    write(d, "package.json", JSON.stringify({ scripts: { test: "x" } }));
    write(d, "package-lock.json", "{}");
    assert.equal(nextCheckTip("ls -la", d), null);
    // Prose / git messages containing the word "test" must not tip.
    assert.equal(nextCheckTip('git commit -m "fix test"', d), null);
  });
});

describe("missingBinaryTip", () => {
  it("suggests project check when tsc is missing", () => {
    const d = tmpDir("forge-miss-bin-");
    write(
      d,
      "package.json",
      JSON.stringify({
        scripts: { typecheck: "tsc --noEmit", test: "node --test" },
      }),
    );
    write(d, "package-lock.json", "{}");
    const tip = missingBinaryTip(
      "tsc --noEmit",
      "bash: tsc: command not found",
      d,
    );
    assert.ok(tip);
    assert.match(tip!, /tsc.*not found/i);
    assert.match(tip!, /npm run typecheck|npx tsc/);
  });

  it("uses pnpm dlx when project is pnpm", () => {
    const d = tmpDir("forge-miss-bin-pnpm-");
    write(d, "package.json", JSON.stringify({ scripts: {} }));
    write(d, "pnpm-lock.yaml", "lockfileVersion: 9\n");
    const tip = missingBinaryTip(
      "eslint .",
      "eslint: command not found",
      d,
    );
    assert.ok(tip);
    assert.match(tip!, /pnpm dlx eslint/);
  });

  it("returns null for unrelated missing binaries", () => {
    const d = tmpDir("forge-miss-bin2-");
    write(d, "package.json", JSON.stringify({ scripts: { test: "x" } }));
    assert.equal(
      missingBinaryTip("ffmpeg -i a", "ffmpeg: command not found", d),
      null,
    );
  });
});

describe("missingScriptTip", () => {
  it("lists available scripts when npm reports Missing script", () => {
    const d = tmpDir("forge-miss-script-");
    write(
      d,
      "package.json",
      JSON.stringify({
        scripts: {
          typecheck: "tsc -b",
          test: "node --test",
          build: "tsc",
          lint: "eslint .",
        },
      }),
    );
    write(d, "package-lock.json", "{}");
    const tip = missingScriptTip(
      "npm run unit",
      'npm error Missing script: "unit"',
      d,
    );
    assert.ok(tip);
    assert.match(tip!, /Script "unit" is not defined/);
    assert.match(tip!, /npm run typecheck/);
    assert.match(tip!, /npm test/);
  });

  it("Did you mean for near-typo script names", () => {
    const d = tmpDir("forge-miss-script-typo-");
    write(
      d,
      "package.json",
      JSON.stringify({
        scripts: { typecheck: "tsc -b", test: "node --test" },
      }),
    );
    write(d, "package-lock.json", "{}");
    const tip = missingScriptTip(
      "npm run typechek",
      'npm error Missing script: "typechek"',
      d,
    );
    assert.ok(tip);
    assert.match(tip!, /Did you mean: npm run typecheck/);
  });

  it("returns null when body is unrelated", () => {
    const d = tmpDir("forge-miss-none-");
    write(d, "package.json", JSON.stringify({ scripts: { test: "x" } }));
    assert.equal(missingScriptTip("ls", "permission denied", d), null);
  });
});

describe("wrongPackageManagerTip", () => {
  it("suggests rewrite when command uses wrong PM", () => {
    const tip = wrongPackageManagerTip("pnpm test", "npm");
    assert.ok(tip);
    assert.match(tip!, /Project uses npm/);
    assert.match(tip!, /pnpm/);
    assert.match(tip!, /npm test/);
  });

  it("returns null when PM matches or no PM in command", () => {
    assert.equal(wrongPackageManagerTip("npm test", "npm"), null);
    assert.equal(wrongPackageManagerTip("cargo test", "npm"), null);
    assert.equal(wrongPackageManagerTip("pnpm test", undefined), null);
  });

  it("rewrites after &&", () => {
    const tip = wrongPackageManagerTip("cd pkg && yarn test", "pnpm");
    assert.ok(tip);
    assert.match(tip!, /pnpm test/);
  });

  it("parses Corepack stderr for required package manager", () => {
    const tip = wrongPackageManagerTip(
      "npm install",
      "npm",
      "This project is configured to use yarn because /app/package.json has a packageManager field",
    );
    assert.ok(tip);
    assert.match(tip!, /yarn/i);
    assert.match(tip!, /npm install|Retry with: yarn/i);
  });
});

describe("buildBaselineSystemPrompt project intel", () => {
  let dir: string;
  before(() => {
    dir = tmpDir("forge-prompt-intel-");
    write(
      dir,
      "package.json",
      JSON.stringify({
        name: "prompt-demo",
        version: "0.1.0",
        scripts: { test: "node --test", typecheck: "tsc --noEmit" },
      }),
    );
    write(dir, "package-lock.json", "{}");
  });
  after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  it("injects detected Commands into Workspace section", () => {
    const text = buildBaselineSystemPrompt({
      config: baseConfig,
      workspace: dir,
      git: null,
    });
    assert.match(text, /Project: prompt-demo@0\.1\.0 · pm=npm/);
    assert.match(text, /Commands: npm run typecheck {2}· {2}npm test/);
    assert.match(
      text,
      /After edits, run the cheapest project command from Workspace → Commands/,
    );
  });

  it("honors project: null to skip detection", () => {
    const text = buildBaselineSystemPrompt({
      config: baseConfig,
      workspace: dir,
      git: null,
      project: null,
    });
    assert.doesNotMatch(text, /Commands: npm/);
    assert.doesNotMatch(text, /prompt-demo/);
  });

  it("accepts precomputed project intel", () => {
    const text = buildBaselineSystemPrompt({
      config: baseConfig,
      workspace: dir,
      git: null,
      project: {
        kinds: ["rust"],
        checkCommands: ["cargo test"],
        workspaces: [],
        summary: "rust",
      },
    });
    assert.match(text, /Commands: cargo test/);
    assert.match(text, /Project: rust/);
  });
});

describe("doctor + config project intel knobs", () => {
  it("surfaces project-stack and edit-guard env", async () => {
    const d = tmpDir("forge-doc-intel-");
    write(
      d,
      "package.json",
      JSON.stringify({
        name: "doc-demo",
        scripts: { test: "node --test", typecheck: "tsc --noEmit" },
      }),
    );
    write(d, "package-lock.json", "{}");
    // Present node_modules so doctor does not fail solely on missing deps.
    fs.mkdirSync(path.join(d, "node_modules"), { recursive: true });
    const { runDoctorCheck, buildEffectiveConfigSnap, formatEffectiveConfig } =
      await import("../src/commands/slash.js");
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const cfg = { ...DEFAULT_CONFIG, workspace: d };
    const doc = await runDoctorCheck(cfg);
    assert.match(doc.report, /project-stack:/);
    assert.match(doc.report, /pm=npm|npm ·|doc-demo/);
    assert.match(doc.report, /edit-guard: file-read=on/);
    assert.match(doc.report, /verify-hint=on/);
    assert.equal(doc.packageManager, "npm");
    assert.ok(Array.isArray(doc.checkCommands));
    assert.ok(doc.checkCommands!.some((c) => /npm/.test(c)));
    assert.equal(doc.fileReadGuard, true);
    assert.equal(doc.verifyHint, true);
    assert.ok(!doc.issues.includes("file-read-guard-off"));
    assert.ok(!doc.issues.some((i) => /node_modules missing/.test(i)));
    assert.equal(doc.nodeModulesPresent, true);

    const prev = process.env.FORGE_FILE_READ_GUARD;
    process.env.FORGE_FILE_READ_GUARD = "0";
    try {
      const off = await runDoctorCheck(cfg);
      assert.equal(off.fileReadGuard, false);
      assert.ok(off.issues.includes("file-read-guard-off"));
      assert.equal(off.ok, false);
      assert.match(off.report, /file-read edit guard OFF/i);
    } finally {
      if (prev === undefined) delete process.env.FORGE_FILE_READ_GUARD;
      else process.env.FORGE_FILE_READ_GUARD = prev;
    }

    const prevHint = process.env.FORGE_VERIFY_HINT;
    process.env.FORGE_VERIFY_HINT = "0";
    try {
      const offHint = await runDoctorCheck(cfg);
      assert.equal(offHint.verifyHint, false);
      assert.ok(offHint.issues.includes("verify-hint-off"));
      assert.equal(offHint.ok, false);
      assert.match(offHint.report, /post-edit verify tip OFF|verify tip OFF/i);
    } finally {
      if (prevHint === undefined) delete process.env.FORGE_VERIFY_HINT;
      else process.env.FORGE_VERIFY_HINT = prevHint;
    }

    const snap = buildEffectiveConfigSnap(cfg);
    assert.equal(snap.env.FORGE_FILE_READ_GUARD, true);
    assert.equal(snap.env.FORGE_VERIFY_HINT, true);
    const text = formatEffectiveConfig(cfg);
    assert.match(text, /edit-guard:/);
    assert.match(text, /file-read=on/);
    assert.match(text, /project-stack:/);
    assert.equal(snap.packageManager, "npm");
    assert.ok(Array.isArray(snap.checkCommands));
    assert.ok(snap.checkCommands.length > 0);
    assert.equal(snap.packageManagerMismatch, null);
  });

  it("config snap surfaces packageManagerMismatch", async () => {
    const d = tmpDir("forge-cfg-pm-mm-");
    write(
      d,
      "package.json",
      JSON.stringify({ packageManager: "pnpm@9.0.0", scripts: { test: "x" } }),
    );
    write(d, "package-lock.json", "{}");
    fs.mkdirSync(path.join(d, "node_modules"), { recursive: true });
    const { buildEffectiveConfigSnap, formatEffectiveConfig } = await import(
      "../src/commands/slash.js"
    );
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const snap = buildEffectiveConfigSnap({
      ...DEFAULT_CONFIG,
      workspace: d,
    });
    assert.ok(snap.packageManagerMismatch);
    assert.equal(snap.packageManagerMismatch!.field, "pnpm");
    const text = formatEffectiveConfig({ ...DEFAULT_CONFIG, workspace: d });
    assert.match(text, /pm-mismatch:/);
  });

  it("flags missing node_modules with pm-native install tip", async () => {
    const d = tmpDir("forge-doc-nm-");
    write(
      d,
      "package.json",
      JSON.stringify({ name: "need-install", scripts: { test: "x" } }),
    );
    write(d, "pnpm-lock.yaml", "lockfileVersion: 9\n");
    const { runDoctorCheck } = await import("../src/commands/slash.js");
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const doc = await runDoctorCheck({ ...DEFAULT_CONFIG, workspace: d });
    assert.ok(doc.issues.some((i) => /node_modules missing/.test(i)));
    assert.match(doc.report, /node_modules missing/);
    assert.match(doc.report, /pnpm install/);
    assert.equal(doc.ok, false);
    assert.equal(doc.nodeModulesPresent, false);
  });

  it("surfaces packageManagerMismatch on doctor JSON", async () => {
    const d = tmpDir("forge-doc-pm-mm-");
    write(
      d,
      "package.json",
      JSON.stringify({ packageManager: "pnpm@9.0.0", scripts: { test: "x" } }),
    );
    write(d, "package-lock.json", "{}");
    fs.mkdirSync(path.join(d, "node_modules"), { recursive: true });
    const { runDoctorCheck } = await import("../src/commands/slash.js");
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const doc = await runDoctorCheck({ ...DEFAULT_CONFIG, workspace: d });
    assert.ok(doc.packageManagerMismatch);
    assert.equal(doc.packageManagerMismatch!.field, "pnpm");
    assert.equal(doc.packageManagerMismatch!.lockfile, "npm");
    assert.ok(doc.ok === false);
  });
});

describe("/context project stack", () => {
  it("lists package manager and checks", async () => {
    const d = tmpDir("forge-ctx-intel-");
    write(
      d,
      "package.json",
      JSON.stringify({
        name: "ctx-demo",
        version: "0.2.0",
        scripts: { test: "node --test", typecheck: "tsc --noEmit" },
      }),
    );
    write(d, "package-lock.json", "{}");
    const { handleSlash } = await import("../src/commands/slash.js");
    const { createSession, deleteSession } = await import(
      "../src/session/session.js"
    );
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const { HookRunner } = await import("../src/harness/hooks.js");
    const session = createSession({
      cwd: d,
      provider: "xai",
      model: "m",
    });
    const hooks = new HookRunner(DEFAULT_CONFIG, d);
    try {
      const r = await handleSlash("/context", {
        session,
        config: { ...DEFAULT_CONFIG, workspace: d },
        hooks,
      });
      assert.equal(r.handled, true);
      assert.match(String(r.output || ""), /Project stack:/);
      assert.match(String(r.output || ""), /pm=npm/);
      assert.match(String(r.output || ""), /npm run typecheck|npm test/);
    } finally {
      try {
        deleteSession(session.meta.id, { force: true });
      } catch {
        /* */
      }
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* */
      }
    }
  });
});


describe("buildInitAgentsPrompt project intel", () => {
  it("includes detected package manager and checks", async () => {
    const d = tmpDir("forge-init-intel-");
    write(
      d,
      "package.json",
      JSON.stringify({
        name: "init-demo",
        scripts: { typecheck: "tsc -b", test: "node --test" },
      }),
    );
    write(d, "package-lock.json", "{}");
    const { buildInitAgentsPrompt } = await import("../src/commands/slash.js");
    const prompt = buildInitAgentsPrompt("", d);
    assert.match(prompt, /Already detected by Forge/);
    assert.match(prompt, /Package manager: npm/);
    assert.match(prompt, /npm run typecheck|Preferred checks/);
  });
});


describe("buildReviewPrompt project intel", () => {
  it("includes preferred verification commands", async () => {
    const d = tmpDir("forge-review-intel-");
    write(
      d,
      "package.json",
      JSON.stringify({
        scripts: { typecheck: "tsc -b", test: "node --test" },
      }),
    );
    write(d, "package-lock.json", "{}");
    const { buildReviewPrompt } = await import("../src/commands/slash.js");
    const prompt = buildReviewPrompt("uncommitted", d);
    assert.match(prompt, /Preferred verification/);
    assert.match(prompt, /npm run typecheck|npm test/);
    assert.match(prompt, /Siblings & dependents/);
    const withLast = buildReviewPrompt("uncommitted", d, {
      lastVerificationCommand: "npm test",
    });
    assert.match(withLast, /Last verification this session: `npm test`/);
  });
});


describe("plan mode project checks", () => {
  it("lists preferred verification in plan-mode system prompt", () => {
    const d = tmpDir("forge-plan-intel-");
    write(
      d,
      "package.json",
      JSON.stringify({
        scripts: { typecheck: "tsc -b", test: "node --test" },
      }),
    );
    write(d, "package-lock.json", "{}");
    const text = buildBaselineSystemPrompt({
      config: { ...baseConfig, permissionMode: "plan" } as ForgeConfig,
      workspace: d,
      git: null,
    });
    assert.match(text, /PLAN MODE/);
    assert.match(text, /Preferred verification|npm run typecheck/);
  });
});


describe("/diff verify tip", () => {
  it("appends preferred checks when workspace has a dirty tree", async () => {
    const d = tmpDir("forge-diff-intel-");
    write(
      d,
      "package.json",
      JSON.stringify({ scripts: { typecheck: "tsc -b", test: "node --test" } }),
    );
    write(d, "package-lock.json", "{}");
    write(d, "x.ts", "export const n = 1;\n");
    // Make a git repo with a dirty file so /diff has content
    seedGit(d);
    const { execFileSync } = await import("node:child_process");
    try {
      execFileSync("git", ["init"], { cwd: d, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "t@t"], { cwd: d, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "t"], { cwd: d, stdio: "ignore" });
      execFileSync("git", ["add", "package.json"], { cwd: d, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "i", "--allow-empty"], {
        cwd: d,
        stdio: "ignore",
      });
    } catch {
      /* best-effort */
    }
    write(d, "x.ts", "export const n = 2;\n");
    const { handleSlash } = await import("../src/commands/slash.js");
    const { createSession, deleteSession } = await import(
      "../src/session/session.js"
    );
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const { HookRunner } = await import("../src/harness/hooks.js");
    const session = createSession({ cwd: d, provider: "xai", model: "m" });
    const hooks = new HookRunner(DEFAULT_CONFIG, d);
    try {
      const r = await handleSlash("/diff", {
        session,
        config: { ...DEFAULT_CONFIG, workspace: d },
        hooks,
      });
      assert.equal(r.handled, true);
      // verify tip when dirty or always when checks exist
      assert.match(String(r.output || ""), /verify:|npm run typecheck|status:/);
    } finally {
      try {
        deleteSession(session.meta.id, { force: true });
      } catch {
        /* */
      }
    }
  });
});


describe("/commit prompt", () => {
  it("buildCommitPrompt drafts without committing by default", async () => {
    const d = tmpDir("forge-commit-prompt-");
    write(
      d,
      "package.json",
      JSON.stringify({ scripts: { test: "node --test", typecheck: "tsc -b" } }),
    );
    write(d, "package-lock.json", "{}");
    const { buildCommitPrompt, handleSlash } = await import(
      "../src/commands/slash.js"
    );
    // Pure prompt builders (no git required)
    const draft = buildCommitPrompt({ workspace: d, doCommit: false });
    assert.match(draft, /Do not.*git commit/i);
    assert.match(draft, /Preferred project checks|npm test|npm run typecheck/);
    const doit = buildCommitPrompt({ workspace: d, doCommit: true });
    assert.match(doit, /Create a git commit/);
    assert.match(doit, /Never.*git push/i);
    const withLast = buildCommitPrompt({
      workspace: d,
      doCommit: true,
      lastVerificationCommand: "npm test",
    });
    assert.match(withLast, /Last verification this session: `npm test`/);

    const { createSession, deleteSession } = await import(
      "../src/session/session.js"
    );
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const { HookRunner } = await import("../src/harness/hooks.js");
    const session = createSession({ cwd: d, provider: "xai", model: "m" });
    const hooks = new HookRunner(DEFAULT_CONFIG, d);
    try {
      // Plan mode always refuses do (no git needed)
      const planDo = await handleSlash("/commit do", {
        session,
        config: { ...DEFAULT_CONFIG, workspace: d, permissionMode: "plan" },
        hooks,
      });
      assert.equal(planDo.forwardPrompt, undefined);
      assert.match(String(planDo.output || ""), /Plan mode cannot create commits/i);

      // Nested git may be blocked by sandbox chmod — best-effort integration.
      let gitOk = false;
      try {
        const { execFileSync } = await import("node:child_process");
        execFileSync("git", ["init"], { cwd: d, stdio: "ignore" });
        execFileSync("git", ["config", "user.email", "t@t"], {
          cwd: d,
          stdio: "ignore",
        });
        execFileSync("git", ["config", "user.name", "t"], {
          cwd: d,
          stdio: "ignore",
        });
        execFileSync("git", ["add", "package.json"], {
          cwd: d,
          stdio: "ignore",
        });
        execFileSync("git", ["commit", "-m", "i"], {
          cwd: d,
          stdio: "ignore",
        });
        write(d, "dirty.ts", "export const d = 1;\n");
        gitOk = true;
      } catch {
        gitOk = false;
      }

      if (gitOk) {
        const r = await handleSlash("/commit", {
          session,
          config: { ...DEFAULT_CONFIG, workspace: d },
          hooks,
        });
        assert.equal(r.handled, true);
        assert.ok(r.forwardPrompt);
        assert.match(String(r.forwardPrompt), /Draft a git commit message/);
        const r2 = await handleSlash("/commit do", {
          session,
          config: { ...DEFAULT_CONFIG, workspace: d },
          hooks,
        });
        assert.match(String(r2.forwardPrompt || ""), /Create a git commit/);

        // Clean tree
        const { execFileSync: ex2 } = await import("node:child_process");
        ex2("git", ["add", "dirty.ts"], { cwd: d, stdio: "ignore" });
        ex2("git", ["commit", "-m", "c"], { cwd: d, stdio: "ignore" });
        const cleanR = await handleSlash("/commit", {
          session,
          config: { ...DEFAULT_CONFIG, workspace: d },
          hooks,
        });
        assert.match(String(cleanR.output || ""), /Working tree clean/i);
        assert.equal(cleanR.forwardPrompt, undefined);
      }

      // Path that cannot be a git work tree
      const outside = path.join(d, "definitely-not-a-repo-subdir-missing");
      const noGit = await handleSlash("/commit", {
        session,
        config: { ...DEFAULT_CONFIG, workspace: outside },
        hooks,
      });
      assert.match(String(noGit.output || ""), /Not a git repository/i);
      assert.equal(noGit.forwardPrompt, undefined);
    } finally {
      try {
        deleteSession(session.meta.id, { force: true });
      } catch {
        /* */
      }
    }
  });
});


describe("resume orientation project checks", () => {
  it("includes Checks line from project intel", async () => {
    const d = tmpDir("forge-resume-checks-");
    write(
      d,
      "package.json",
      JSON.stringify({
        scripts: { typecheck: "tsc -b", test: "node --test" },
      }),
    );
    write(d, "package-lock.json", "{}");
    const { createSession, deleteSession, formatResumeOrientation, saveSession } =
      await import("../src/session/session.js");
    const session = createSession({ cwd: d, provider: "xai", model: "m" });
    try {
      const text = formatResumeOrientation(session);
      assert.match(text, /Checks:/);
      assert.match(text, /npm run typecheck|npm test/);
      session.meta.lastVerificationCommand = "npm test";
      session.meta.lastVerificationAt = "2026-01-01T12:00:00.000Z";
      saveSession(session);
      const text2 = formatResumeOrientation(session);
      assert.match(text2, /Last verify: npm test/);
    } finally {
      try {
        deleteSession(session.meta.id, { force: true });
      } catch {
        /* */
      }
    }
  });
});


describe("permissionDeniedTip", () => {
  it("tips on EACCES", () => {
    const tip = permissionDeniedTip(
      "chmod 000 secret.env",
      "chmod: secret.env: Permission denied",
    );
    assert.ok(tip);
    assert.match(tip!, /Permission denied/);
    assert.match(tip!, /ownership|plan mode|\/build/i);
  });

  it("skips sandbox policy denies", () => {
    assert.equal(
      permissionDeniedTip("curl 169.254.169.254", "denied by policy IMDS"),
      null,
    );
  });
});

describe("multipleLockfilesTip", () => {
  it("tips on install when multiple lockfiles exist", () => {
    const d = tmpDir("forge-multi-tip-");
    write(d, "package.json", "{}");
    write(d, "package-lock.json", "{}");
    write(d, "yarn.lock", "# yarn\n");
    const tip = multipleLockfilesTip("npm install", d);
    assert.ok(tip);
    assert.match(tip!, /Multiple lockfiles/);
    assert.match(tip!, /yarn\.lock|package-lock/);
  });

  it("returns null for non-install commands", () => {
    const d = tmpDir("forge-multi-tip2-");
    write(d, "package.json", "{}");
    write(d, "package-lock.json", "{}");
    write(d, "yarn.lock", "#\n");
    assert.equal(multipleLockfilesTip("npm test", d), null);
  });
});


describe("compact summary project checks", () => {
  it("includes Project checks and Last verify in structured summary", async () => {
    const d = tmpDir("forge-compact-intel-");
    write(
      d,
      "package.json",
      JSON.stringify({
        scripts: { typecheck: "tsc -b", test: "node --test" },
      }),
    );
    write(d, "package-lock.json", "{}");
    const { buildStructuredSummary } = await import(
      "../src/session/compaction.js"
    );
    const summary = buildStructuredSummary(
      [
        {
          role: "user",
          content: "please fix the tests",
        },
      ],
      {
        cwd: d,
        lastVerificationCommand: "npm test",
        lastVerificationAt: "2026-04-10T12:00:00.000Z",
        lastEditAt: "2026-04-10T12:10:00.000Z",
      },
    );
    assert.match(summary, /Project checks:/);
    assert.match(summary, /npm run typecheck|npm test/);
    assert.match(summary, /Last verify: npm test/);
    assert.match(summary, /stale \(edits after verify\)/);
    assert.match(summary, /pure questions are not work orders/i);
  });
});

describe("/status no last-verify tip", () => {
  it("warns when edits lack lastVerificationCommand", async () => {
    const d = tmpDir("forge-status-noverify-");
    write(
      d,
      "package.json",
      JSON.stringify({
        scripts: { typecheck: "tsc -b", test: "node --test" },
      }),
    );
    write(d, "package-lock.json", "{}");
    const { createSession } = await import("../src/session/session.js");
    const { handleSlash } = await import("../src/commands/slash.js");
    const { HookRunner } = await import("../src/harness/hooks.js");
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const session = createSession({ cwd: d, provider: "xai", model: "m" });
    session.meta.editCount = 4;
    delete session.meta.lastVerificationCommand;
    const hooks = new HookRunner(DEFAULT_CONFIG, d);
    const r = await handleSlash("/status", {
      session,
      config: { ...DEFAULT_CONFIG, workspace: d },
      hooks,
      auth: {
        provider: "xai",
        method: "api_key",
        apiKey: "test",
      } as any,
    });
    assert.equal(r.handled, true);
    const out = String(r.output || "").replace(/\x1b\[[0-9;]*m/g, "");
    assert.match(out, /no last-verify/i);
    assert.match(out, /4 edit/i);
  });
});

describe("/commit stale last-verify", () => {
  it("warns when last-verify is stale on /commit do", async () => {
    const d = tmpDir("forge-commit-stale-");
    write(
      d,
      "package.json",
      JSON.stringify({
        scripts: { typecheck: "tsc -b", test: "node --test" },
      }),
    );
    write(d, "package-lock.json", "{}");
    const { createSession } = await import("../src/session/session.js");
    const { handleSlash } = await import("../src/commands/slash.js");
    const { HookRunner } = await import("../src/harness/hooks.js");
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const session = createSession({ cwd: d, provider: "xai", model: "m" });
    session.meta.editCount = 2;
    session.meta.lastVerificationCommand = "npm test";
    session.meta.lastVerificationAt = "2026-04-10T12:00:00.000Z";
    session.meta.lastEditAt = "2026-04-10T12:10:00.000Z";
    const hooks = new HookRunner(DEFAULT_CONFIG, d);
    // Nested git may be blocked by sandbox — best-effort integration.
    let gitOk = false;
    try {
      const { execFileSync } = await import("node:child_process");
      execFileSync("git", ["init"], { cwd: d, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "t@t"], {
        cwd: d,
        stdio: "ignore",
      });
      execFileSync("git", ["config", "user.name", "t"], {
        cwd: d,
        stdio: "ignore",
      });
      write(d, "a.txt", "x\n");
      execFileSync("git", ["add", "a.txt"], { cwd: d, stdio: "ignore" });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "i"], {
        cwd: d,
        stdio: "ignore",
      });
      write(d, "a.txt", "y\n");
      gitOk = true;
    } catch {
      gitOk = false;
    }
    if (!gitOk) return; // environment cannot init git — skip
    const r = await handleSlash("/commit do", {
      session,
      config: { ...DEFAULT_CONFIG, workspace: d },
      hooks,
    });
    assert.equal(r.handled, true);
    assert.match(String(r.output || ""), /stale/i);
    assert.match(String(r.output || ""), /npm test/);
  });
});

describe("/model status orientation", () => {
  it("shows preferred checks + last-verify on bare /model", async () => {
    const d = tmpDir("forge-model-orient-");
    write(
      d,
      "package.json",
      JSON.stringify({
        scripts: { typecheck: "tsc -b", test: "node --test" },
      }),
    );
    write(d, "package-lock.json", "{}");
    const { createSession } = await import("../src/session/session.js");
    const { handleSlash } = await import("../src/commands/slash.js");
    const { HookRunner } = await import("../src/harness/hooks.js");
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const session = createSession({ cwd: d, provider: "xai", model: "grok-4" });
    session.meta.editCount = 2;
    session.meta.lastVerificationCommand = "npm test";
    session.meta.lastVerificationAt = "2026-04-10T12:00:00.000Z";
    session.meta.lastEditAt = "2026-04-10T12:10:00.000Z";
    const hooks = new HookRunner(DEFAULT_CONFIG, d);
    const r = await handleSlash("/model", {
      session,
      config: { ...DEFAULT_CONFIG, workspace: d, model: "grok-4", provider: "xai" },
      hooks,
    });
    assert.equal(r.handled, true);
    const out = String(r.output || "").replace(/\x1b\[[0-9;]*m/g, "");
    assert.match(out, /Preferred checks:/i);
    assert.match(out, /Last verify: npm test/i);
    assert.match(out, /stale/i);
  });
});

describe("/effort status orientation", () => {
  it("shows preferred checks + last-verify on bare /effort", async () => {
    const d = tmpDir("forge-effort-orient-");
    write(
      d,
      "package.json",
      JSON.stringify({
        scripts: { typecheck: "tsc -b", test: "node --test" },
      }),
    );
    write(d, "package-lock.json", "{}");
    const { createSession } = await import("../src/session/session.js");
    const { handleSlash } = await import("../src/commands/slash.js");
    const { HookRunner } = await import("../src/harness/hooks.js");
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const session = createSession({
      cwd: d,
      provider: "xai",
      model: "grok-4.5",
    });
    session.meta.editCount = 1;
    session.meta.lastVerificationCommand = "npm test";
    session.meta.lastVerificationAt = "2026-04-10T12:00:00.000Z";
    const hooks = new HookRunner(DEFAULT_CONFIG, d);
    const r = await handleSlash("/effort", {
      session,
      config: {
        ...DEFAULT_CONFIG,
        workspace: d,
        model: "grok-4.5",
        provider: "xai",
      },
      hooks,
    });
    assert.equal(r.handled, true);
    const out = String(r.output || "").replace(/\x1b\[[0-9;]*m/g, "");
    assert.match(out, /Preferred checks:/i);
    assert.match(out, /Last verify: npm test/i);
  });
});

describe("/permissions status orientation", () => {
  it("shows preferred checks + last-verify on bare /permissions", async () => {
    const d = tmpDir("forge-perm-orient-");
    write(
      d,
      "package.json",
      JSON.stringify({
        scripts: { typecheck: "tsc -b", test: "node --test" },
      }),
    );
    write(d, "package-lock.json", "{}");
    const { createSession } = await import("../src/session/session.js");
    const { handleSlash } = await import("../src/commands/slash.js");
    const { HookRunner } = await import("../src/harness/hooks.js");
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const session = createSession({ cwd: d, provider: "xai", model: "grok-4" });
    session.meta.editCount = 2;
    session.meta.lastVerificationCommand = "npm test";
    session.meta.lastVerificationAt = "2026-04-10T12:00:00.000Z";
    const hooks = new HookRunner(DEFAULT_CONFIG, d);
    const r = await handleSlash("/permissions", {
      session,
      config: { ...DEFAULT_CONFIG, workspace: d },
      hooks,
    });
    assert.equal(r.handled, true);
    const out = String(r.output || "").replace(/\x1b\[[0-9;]*m/g, "");
    assert.match(out, /Preferred checks:/i);
    assert.match(out, /Last verify: npm test/i);
  });
});

describe("/budget status orientation", () => {
  it("shows session edits + last-verify on bare /budget", async () => {
    const d = tmpDir("forge-budget-orient-");
    write(d, "package.json", JSON.stringify({ scripts: { test: "node --test" } }));
    write(d, "package-lock.json", "{}");
    const { createSession } = await import("../src/session/session.js");
    const { handleSlash } = await import("../src/commands/slash.js");
    const { HookRunner } = await import("../src/harness/hooks.js");
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const session = createSession({ cwd: d, provider: "xai", model: "grok-4" });
    session.meta.editCount = 3;
    session.meta.lastVerificationCommand = "npm test";
    session.meta.lastVerificationAt = "2026-04-10T12:00:00.000Z";
    session.meta.lastEditAt = "2026-04-10T12:10:00.000Z";
    const hooks = new HookRunner(DEFAULT_CONFIG, d);
    const r = await handleSlash("/budget", {
      session,
      config: { ...DEFAULT_CONFIG, workspace: d },
      hooks,
    });
    assert.equal(r.handled, true);
    const out = String(r.output || "");
    assert.match(out, /Session:.*edits=3|Session trail:.*edits=3/);
    assert.match(out, /last-verify stale \(npm test\)|last-verify: npm test|last-verify npm test/);
  });
});

describe("/todos empty tip", () => {
  it("empty board tips preferred check + todo_write", async () => {
    const d = tmpDir("forge-todos-empty-");
    write(
      d,
      "package.json",
      JSON.stringify({ scripts: { typecheck: "tsc -b", test: "node --test" } }),
    );
    write(d, "package-lock.json", "{}");
    const { createSession } = await import("../src/session/session.js");
    const { handleSlash } = await import("../src/commands/slash.js");
    const { HookRunner } = await import("../src/harness/hooks.js");
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const session = createSession({ cwd: d, provider: "xai", model: "m" });
    session.todos = [];
    const hooks = new HookRunner(DEFAULT_CONFIG, d);
    const r = await handleSlash("/todos", {
      session,
      config: { ...DEFAULT_CONFIG, workspace: d },
      hooks,
    });
    assert.equal(r.handled, true);
    assert.match(String(r.output || ""), /No todos/i);
    assert.match(String(r.output || ""), /todo_write/i);
    assert.match(String(r.output || ""), /npm run typecheck|npm test/);
  });
});

describe("/clear last-verify tip", () => {
  it("notes last-verify reset + preferred check", async () => {
    const d = tmpDir("forge-clear-verify-");
    write(
      d,
      "package.json",
      JSON.stringify({ scripts: { typecheck: "tsc -b", test: "node --test" } }),
    );
    write(d, "package-lock.json", "{}");
    const { createSession } = await import("../src/session/session.js");
    const { handleSlash } = await import("../src/commands/slash.js");
    const { HookRunner } = await import("../src/harness/hooks.js");
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const session = createSession({ cwd: d, provider: "xai", model: "m" });
    session.meta.lastVerificationCommand = "npm test";
    session.meta.editCount = 2;
    const hooks = new HookRunner(DEFAULT_CONFIG, d);
    const r = await handleSlash("/clear", {
      session,
      config: { ...DEFAULT_CONFIG, workspace: d },
      hooks,
    });
    assert.equal(r.handled, true);
    const out = String(r.output || "").replace(/\x1b\[[0-9;]*m/g, "");
    assert.match(out, /last-verify trail reset/i);
    assert.match(out, /npm run typecheck|npm test/);
    assert.equal(session.meta.lastVerificationCommand, undefined);
  });
});

describe("/new preferred check tip", () => {
  it("orients fresh session with preferred project check", async () => {
    const d = tmpDir("forge-new-check-");
    write(
      d,
      "package.json",
      JSON.stringify({ scripts: { typecheck: "tsc -b", test: "node --test" } }),
    );
    write(d, "package-lock.json", "{}");
    const { createSession } = await import("../src/session/session.js");
    const { handleSlash } = await import("../src/commands/slash.js");
    const { HookRunner } = await import("../src/harness/hooks.js");
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const session = createSession({ cwd: d, provider: "xai", model: "m" });
    const hooks = new HookRunner(DEFAULT_CONFIG, d);
    const r = await handleSlash("/new", {
      session,
      config: { ...DEFAULT_CONFIG, workspace: d },
      hooks,
    });
    assert.equal(r.handled, true);
    const out = String(r.output || "").replace(/\x1b\[[0-9;]*m/g, "");
    assert.match(out, /New session/i);
    assert.match(out, /Preferred check:/i);
    assert.match(out, /npm run typecheck|npm test/);
    assert.ok(r.replaceSession);
  });
});

describe("/fork orientation", () => {
  it("surfaces last-verify + preferred check on fork", async () => {
    const d = tmpDir("forge-fork-orient-");
    write(
      d,
      "package.json",
      JSON.stringify({ scripts: { typecheck: "tsc -b", test: "node --test" } }),
    );
    write(d, "package-lock.json", "{}");
    const { createSession } = await import("../src/session/session.js");
    const { handleSlash } = await import("../src/commands/slash.js");
    const { HookRunner } = await import("../src/harness/hooks.js");
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const session = createSession({ cwd: d, provider: "xai", model: "m" });
    session.meta.editCount = 2;
    session.meta.lastVerificationCommand = "npm test";
    session.meta.lastVerificationAt = "2026-04-10T12:00:00.000Z";
    session.meta.lastEditAt = "2026-04-10T12:10:00.000Z";
    const hooks = new HookRunner(DEFAULT_CONFIG, d);
    const r = await handleSlash("/fork", {
      session,
      config: { ...DEFAULT_CONFIG, workspace: d },
      hooks,
    });
    assert.equal(r.handled, true);
    const out = String(r.output || "").replace(/\x1b\[[0-9;]*m/g, "");
    assert.match(out, /Forked session/i);
    assert.match(out, /Last verify: npm test/i);
    assert.match(out, /stale/i);
    assert.match(out, /Preferred check:/i);
    assert.ok(r.replaceSession);
  });
});

describe("/fork-and-compact orientation", () => {
  it("surfaces last-verify + preferred check after compact fork", async () => {
    const d = tmpDir("forge-forkc-orient-");
    write(
      d,
      "package.json",
      JSON.stringify({ scripts: { typecheck: "tsc -b", test: "node --test" } }),
    );
    write(d, "package-lock.json", "{}");
    const { createSession } = await import("../src/session/session.js");
    const { handleSlash } = await import("../src/commands/slash.js");
    const { HookRunner } = await import("../src/harness/hooks.js");
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const session = createSession({ cwd: d, provider: "xai", model: "m" });
    session.messages.push({ role: "user", content: "hello" });
    session.messages.push({ role: "assistant", content: "hi" });
    session.meta.editCount = 1;
    session.meta.lastVerificationCommand = "npm test";
    session.meta.lastVerificationAt = "2026-04-10T12:00:00.000Z";
    const hooks = new HookRunner(DEFAULT_CONFIG, d);
    const r = await handleSlash("/fork-and-compact", {
      session,
      config: { ...DEFAULT_CONFIG, workspace: d },
      hooks,
    });
    assert.equal(r.handled, true);
    const out = String(r.output || "").replace(/\x1b\[[0-9;]*m/g, "");
    assert.match(out, /Forked/i);
    assert.match(out, /Last verify: npm test|Preferred check:/i);
    assert.ok(r.replaceSession);
  });
});

describe("/compact last-verify note", () => {
  it("notes last-verify trail after compact", async () => {
    const d = tmpDir("forge-compact-verify-");
    write(
      d,
      "package.json",
      JSON.stringify({ scripts: { typecheck: "tsc -b", test: "node --test" } }),
    );
    write(d, "package-lock.json", "{}");
    const { createSession } = await import("../src/session/session.js");
    const { handleSlash } = await import("../src/commands/slash.js");
    const { HookRunner } = await import("../src/harness/hooks.js");
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const session = createSession({ cwd: d, provider: "xai", model: "m" });
    session.messages.push({ role: "user", content: "a" });
    session.messages.push({ role: "assistant", content: "b" });
    session.meta.editCount = 2;
    session.meta.lastVerificationCommand = "npm test";
    session.meta.lastVerificationAt = "2026-04-10T12:00:00.000Z";
    session.meta.lastEditAt = "2026-04-10T12:10:00.000Z";
    const hooks = new HookRunner(DEFAULT_CONFIG, d);
    const r = await handleSlash("/compact", {
      session,
      config: { ...DEFAULT_CONFIG, workspace: d },
      hooks,
    });
    assert.equal(r.handled, true);
    const out = String(r.output || "");
    assert.match(out, /Compacted/i);
    assert.match(out, /Last verify stale: `npm test`|Last verify: `npm test`/);
  });
});

describe("/compact-and last-verify note", () => {
  it("notes last-verify when continuing after compact", async () => {
    const d = tmpDir("forge-compact-and-verify-");
    write(
      d,
      "package.json",
      JSON.stringify({ scripts: { test: "node --test" } }),
    );
    write(d, "package-lock.json", "{}");
    const { createSession } = await import("../src/session/session.js");
    const { handleSlash } = await import("../src/commands/slash.js");
    const { HookRunner } = await import("../src/harness/hooks.js");
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const session = createSession({ cwd: d, provider: "xai", model: "m" });
    session.messages.push({ role: "user", content: "a" });
    session.messages.push({ role: "assistant", content: "b" });
    session.meta.lastVerificationCommand = "npm test";
    session.meta.lastVerificationAt = "2026-04-10T12:00:00.000Z";
    const hooks = new HookRunner(DEFAULT_CONFIG, d);
    const r = await handleSlash("/compact-and keep going", {
      session,
      config: { ...DEFAULT_CONFIG, workspace: d },
      hooks,
    });
    assert.equal(r.handled, true);
    assert.ok(r.forwardPrompt);
    const out = String(r.output || "");
    assert.match(out, /Compacted/i);
    assert.match(out, /Last verify: `npm test`|Last verify stale: `npm test`/);
  });
});

describe("/export trail note", () => {
  it("notes last-verify when writing export file", async () => {
    const d = tmpDir("forge-export-trail-");
    write(d, "package.json", JSON.stringify({ scripts: { test: "node --test" } }));
    write(d, "package-lock.json", "{}");
    const { createSession } = await import("../src/session/session.js");
    const { handleSlash } = await import("../src/commands/slash.js");
    const { HookRunner } = await import("../src/harness/hooks.js");
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const session = createSession({ cwd: d, provider: "xai", model: "m" });
    session.meta.editCount = 2;
    session.meta.lastVerificationCommand = "npm test";
    session.meta.lastVerificationAt = "2026-04-10T12:00:00.000Z";
    session.meta.lastEditAt = "2026-04-10T12:10:00.000Z";
    const hooks = new HookRunner(DEFAULT_CONFIG, d);
    const outPath = path.join(d, "session.md");
    const r = await handleSlash(`/export ${outPath}`, {
      session,
      config: { ...DEFAULT_CONFIG, workspace: d },
      hooks,
    });
    assert.equal(r.handled, true);
    assert.match(String(r.output || ""), /Exported markdown/i);
    assert.match(
      String(r.output || ""),
      /last-verify stale: npm test|last-verify: npm test/,
    );
    assert.ok(fs.existsSync(outPath));
  });
});

describe("/notify trail orientation", () => {
  it("status shows session last-verify trail", async () => {
    const d = tmpDir("forge-notify-trail-");
    write(d, "package.json", JSON.stringify({ scripts: { test: "node --test" } }));
    write(d, "package-lock.json", "{}");
    const { createSession } = await import("../src/session/session.js");
    const { handleSlash } = await import("../src/commands/slash.js");
    const { HookRunner } = await import("../src/harness/hooks.js");
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const session = createSession({ cwd: d, provider: "xai", model: "m" });
    session.meta.editCount = 2;
    session.meta.lastVerificationCommand = "npm test";
    session.meta.lastVerificationAt = "2026-04-10T12:00:00.000Z";
    session.meta.lastEditAt = "2026-04-10T12:10:00.000Z";
    const hooks = new HookRunner(DEFAULT_CONFIG, d);
    const r = await handleSlash("/notify", {
      session,
      config: { ...DEFAULT_CONFIG, workspace: d },
      hooks,
    });
    assert.equal(r.handled, true);
    const out = String(r.output || "").replace(/\x1b\[[0-9;]*m/g, "");
    assert.match(out, /Session trail:/i);
    assert.match(out, /last-verify stale|last-verify npm test/i);
  });
});

describe("/bell trail orientation", () => {
  it("status shows session last-verify trail", async () => {
    const d = tmpDir("forge-bell-trail-");
    write(d, "package.json", JSON.stringify({ scripts: { test: "node --test" } }));
    write(d, "package-lock.json", "{}");
    const { createSession } = await import("../src/session/session.js");
    const { handleSlash } = await import("../src/commands/slash.js");
    const { HookRunner } = await import("../src/harness/hooks.js");
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const session = createSession({ cwd: d, provider: "xai", model: "m" });
    session.meta.editCount = 2;
    session.meta.lastVerificationCommand = "npm test";
    session.meta.lastVerificationAt = "2026-04-10T12:00:00.000Z";
    session.meta.lastEditAt = "2026-04-10T12:10:00.000Z";
    const hooks = new HookRunner(DEFAULT_CONFIG, d);
    const r = await handleSlash("/bell", {
      session,
      config: { ...DEFAULT_CONFIG, workspace: d },
      hooks,
    });
    assert.equal(r.handled, true);
    const out = String(r.output || "").replace(/\x1b\[[0-9;]*m/g, "");
    assert.match(out, /Session trail:/i);
    assert.match(out, /last-verify stale|last-verify npm test/i);
  });
});

describe("slash verify orientation helpers", () => {
  it("formatSlashVerifyOrient + formatSlashSessionTrail", async () => {
    const d = tmpDir("forge-slash-orient-helpers-");
    write(
      d,
      "package.json",
      JSON.stringify({ scripts: { typecheck: "tsc -b", test: "node --test" } }),
    );
    write(d, "package-lock.json", "{}");
    const {
      formatSlashVerifyOrient,
      formatSlashSessionTrail,
    } = await import("../src/commands/slash.js");
    const orient = formatSlashVerifyOrient({
      workspace: d,
      editCount: 2,
      lastVerificationCommand: "npm test",
      lastVerificationAt: "2026-04-10T12:00:00.000Z",
      lastEditAt: "2026-04-10T12:10:00.000Z",
    });
    assert.match(orient, /Preferred checks:/);
    assert.match(orient, /Last verify: npm test/);
    assert.match(orient, /stale/);
    const none = formatSlashVerifyOrient({
      workspace: d,
      editCount: 3,
    });
    assert.match(none, /No last-verify after 3 edit/);
    const trail = formatSlashSessionTrail({
      editCount: 2,
      lastVerificationCommand: "npm test",
      lastVerificationAt: "2026-04-10T12:00:00.000Z",
      lastEditAt: "2026-04-10T12:10:00.000Z",
    });
    assert.match(trail, /Session trail: edits=2/);
    assert.match(trail, /last-verify stale/);
  });
});

describe("/ulw preferred checks tip", () => {
  it("arms ULW with preferred project checks on banner", async () => {
    const d = tmpDir("forge-ulw-checks-");
    write(
      d,
      "package.json",
      JSON.stringify({ scripts: { typecheck: "tsc -b", test: "node --test" } }),
    );
    write(d, "package-lock.json", "{}");
    const { createSession } = await import("../src/session/session.js");
    const { handleSlash } = await import("../src/commands/slash.js");
    const { HookRunner } = await import("../src/harness/hooks.js");
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const session = createSession({ cwd: d, provider: "xai", model: "m" });
    const hooks = new HookRunner(DEFAULT_CONFIG, d);
    const r = await handleSlash("/ulw ship it", {
      session,
      config: { ...DEFAULT_CONFIG, workspace: d },
      hooks,
    });
    assert.equal(r.handled, true);
    const out = String(r.output || "").replace(/\x1b\[[0-9;]*m/g, "");
    assert.match(out, /ULW ON/i);
    assert.match(out, /Preferred checks:/i);
    assert.match(out, /npm run typecheck|npm test/);
    assert.match(out, /proof-demand requires green/i);
  });
});

describe("/goal set preferred checks tip", () => {
  it("arms goal with preferred project checks on banner", async () => {
    const d = tmpDir("forge-goal-checks-");
    write(
      d,
      "package.json",
      JSON.stringify({ scripts: { typecheck: "tsc -b", test: "node --test" } }),
    );
    write(d, "package-lock.json", "{}");
    const { createSession } = await import("../src/session/session.js");
    const { handleSlash } = await import("../src/commands/slash.js");
    const { HookRunner } = await import("../src/harness/hooks.js");
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const session = createSession({ cwd: d, provider: "xai", model: "m" });
    const hooks = new HookRunner(DEFAULT_CONFIG, d);
    const r = await handleSlash("/goal set ship the feature", {
      session,
      config: { ...DEFAULT_CONFIG, workspace: d },
      hooks,
    });
    assert.equal(r.handled, true);
    const out = String(r.output || "").replace(/\x1b\[[0-9;]*m/g, "");
    assert.match(out, /Goal ARMED/i);
    assert.match(out, /Preferred checks:/i);
    assert.match(out, /npm run typecheck|npm test/);
    assert.match(out, /attestation needs green/i);
  });
});

describe("/goal resume preferred checks tip", () => {
  it("resumes goal with preferred project checks on banner", async () => {
    const d = tmpDir("forge-goal-resume-checks-");
    write(
      d,
      "package.json",
      JSON.stringify({ scripts: { typecheck: "tsc -b", test: "node --test" } }),
    );
    write(d, "package-lock.json", "{}");
    const { createSession } = await import("../src/session/session.js");
    const { handleSlash } = await import("../src/commands/slash.js");
    const { HookRunner } = await import("../src/harness/hooks.js");
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const session = createSession({ cwd: d, provider: "xai", model: "m" });
    const hooks = new HookRunner(DEFAULT_CONFIG, d);
    await handleSlash("/goal set ship the feature", {
      session,
      config: { ...DEFAULT_CONFIG, workspace: d },
      hooks,
    });
    await handleSlash("/goal pause", {
      session,
      config: { ...DEFAULT_CONFIG, workspace: d },
      hooks,
    });
    const r = await handleSlash("/goal resume", {
      session,
      config: { ...DEFAULT_CONFIG, workspace: d },
      hooks,
    });
    assert.equal(r.handled, true);
    const out = String(r.output || "").replace(/\x1b\[[0-9;]*m/g, "");
    assert.match(out, /Goal resumed/i);
    assert.match(out, /Preferred checks:/i);
    assert.match(out, /npm run typecheck|npm test/);
  });
});

describe("/cycle 0 preferred checks tip", () => {
  it("LAST wind-down lists preferred checks + session trail", async () => {
    const d = tmpDir("forge-cycle0-checks-");
    write(
      d,
      "package.json",
      JSON.stringify({ scripts: { typecheck: "tsc -b", test: "node --test" } }),
    );
    write(d, "package-lock.json", "{}");
    const { createSession } = await import("../src/session/session.js");
    const { handleSlash } = await import("../src/commands/slash.js");
    const { HookRunner } = await import("../src/harness/hooks.js");
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const session = createSession({ cwd: d, provider: "xai", model: "m" });
    session.meta.editCount = 2;
    session.meta.lastVerificationCommand = "npm test";
    session.meta.lastVerificationAt = "2026-04-10T12:00:00.000Z";
    session.meta.lastEditAt = "2026-04-10T12:10:00.000Z";
    const hooks = new HookRunner(DEFAULT_CONFIG, d);
    await handleSlash("/ulw ship it", {
      session,
      config: { ...DEFAULT_CONFIG, workspace: d },
      hooks,
    });
    const r = await handleSlash("/cycle 0", {
      session,
      config: { ...DEFAULT_CONFIG, workspace: d },
      hooks,
    });
    assert.equal(r.handled, true);
    const out = String(r.output || "").replace(/\x1b\[[0-9;]*m/g, "");
    assert.match(out, /cycle=0 LAST/i);
    assert.match(out, /Preferred checks before \*\*Cycle complete\*\*|Preferred checks/i);
    assert.match(out, /npm run typecheck|npm test/);
    assert.match(out, /Session trail:|last-verify/i);
  });
});

describe("/max-waves LAST preferred checks tip", () => {
  it("auto-LAST flip lists preferred checks + session trail", async () => {
    const d = tmpDir("forge-maxwaves-last-");
    write(
      d,
      "package.json",
      JSON.stringify({ scripts: { typecheck: "tsc -b", test: "node --test" } }),
    );
    write(d, "package-lock.json", "{}");
    const { createSession } = await import("../src/session/session.js");
    const { handleSlash } = await import("../src/commands/slash.js");
    const { HookRunner } = await import("../src/harness/hooks.js");
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const {
      armUlwCycle,
      loadUlwCycle,
      saveUlwCycle,
    } = await import("../src/harness/ulw-cycle.js");
    const session = createSession({ cwd: d, provider: "xai", model: "m" });
    session.meta.editCount = 2;
    session.meta.lastVerificationCommand = "npm test";
    session.meta.lastVerificationAt = "2026-04-10T12:00:00.000Z";
    session.meta.lastEditAt = "2026-04-10T12:10:00.000Z";
    const hooks = new HookRunner(DEFAULT_CONFIG, d);
    await handleSlash("/ulw ship it", {
      session,
      config: { ...DEFAULT_CONFIG, workspace: d },
      hooks,
    });
    // Advance wave so max_waves=1 flips to LAST immediately
    const u = loadUlwCycle(session.meta.id)!;
    u.wave = 1;
    saveUlwCycle(u);
    const r = await handleSlash("/max-waves 1", {
      session,
      config: { ...DEFAULT_CONFIG, workspace: d },
      hooks,
    });
    assert.equal(r.handled, true);
    const out = String(r.output || "").replace(/\x1b\[[0-9;]*m/g, "");
    assert.match(out, /LAST/i);
    assert.match(out, /Preferred checks before \*\*Cycle complete\*\*|Preferred checks/i);
    assert.match(out, /npm run typecheck|npm test/);
  });
});

describe("compact advisory intent", () => {
  it("marks ADVISORY/Q&A when last user message is a question", async () => {
    const { buildStructuredSummary } = await import(
      "../src/session/compaction.js"
    );
    const summary = buildStructuredSummary(
      [
        { role: "user", content: "please fix the tests" },
        { role: "assistant", content: "working on it" },
        { role: "user", content: "what do you think about the landing page?" },
      ],
      { cwd: process.cwd() },
    );
    assert.match(summary, /ADVISORY\/Q&A/i);
    assert.match(summary, /do \*\*not\*\* implement/i);
    assert.match(summary, /Last meta-request:.*landing page/i);
    // Intent must lead harness section (before soft-prompt expansion noise).
    const intentAt = summary.indexOf("Intent:");
    const softAt = summary.indexOf("Soft prompt expanded");
    if (softAt >= 0) assert.ok(intentAt >= 0 && intentAt < softAt);

    // Soft-prompt god-scope is suspended while advisory.
    const withSoft = buildStructuredSummary(
      [
        { role: "user", content: "please fix the tests" },
        { role: "assistant", content: "working on it" },
        { role: "user", content: "what do you think about the landing page?" },
      ],
      {
        cwd: process.cwd(),
        ulw: {
          enabled: true,
          cycle: 1,
          wave: 2,
          blocks: 0,
          mandate: "ship it",
          softPrompt: true,
          expandedMandate: "god scope expand",
        } as any,
      },
    );
    assert.match(withSoft, /ADVISORY\/Q&A/i);
    assert.match(withSoft, /suspended while Intent is ADVISORY/i);
    assert.match(withSoft, /Expanded mandate \(abbrev, suspended while ADVISORY/i);

    const withGoal = buildStructuredSummary(
      [
        { role: "user", content: "what do you think about the landing page?" },
      ],
      {
        cwd: process.cwd(),
        goal: {
          status: "active",
          objective: "ship the feature",
          criteria: ["tests pass"],
          paused: false,
        } as any,
      },
    );
    assert.match(withGoal, /Goal ACTIVE \(paused for ADVISORY\/Q&A/i);

    const withTodos = buildStructuredSummary(
      [{ role: "user", content: "what do you think about the landing page?" }],
      {
        cwd: process.cwd(),
        todos: [
          { id: "w1", content: "implement feature", status: "pending" },
        ] as any,
      },
    );
    assert.match(withTodos, /ADVISORY\/Q&A: list is context only/i);
  });

  it("keeps default intent for implement language", async () => {
    const { buildStructuredSummary } = await import(
      "../src/session/compaction.js"
    );
    const summary = buildStructuredSummary(
      [
        { role: "user", content: "please implement the fix and ship it" },
      ],
      { cwd: process.cwd() },
    );
    assert.doesNotMatch(summary, /ADVISORY\/Q&A/i);
    assert.match(summary, /pure questions are not work orders/i);
  });
});

