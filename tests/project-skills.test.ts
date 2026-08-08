import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadProjectSkills,
  formatSkillsForPrompt,
  countProjectSkills,
  builtinSkillsDir,
} from "../src/agent/project-skills.js";
import { buildBaselineSystemPrompt } from "../src/agent/system-prompt.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";
import { handleSlash } from "../src/commands/slash.js";
import { createSession } from "../src/session/session.js";
import { HookRunner } from "../src/harness/hooks.js";

function withBuiltinOff<T>(fn: () => T): T;
function withBuiltinOff<T>(fn: () => Promise<T>): Promise<T>;
function withBuiltinOff<T>(fn: () => T | Promise<T>): T | Promise<T> {
  const prev = process.env.FORGE_BUILTIN_SKILLS;
  process.env.FORGE_BUILTIN_SKILLS = "0";
  const restore = () => {
    if (prev === undefined) delete process.env.FORGE_BUILTIN_SKILLS;
    else process.env.FORGE_BUILTIN_SKILLS = prev;
  };
  try {
    const out = fn();
    if (out && typeof (out as Promise<T>).then === "function") {
      return (out as Promise<T>).finally(restore);
    }
    restore();
    return out;
  } catch (e) {
    restore();
    throw e;
  }
}

describe("project skills", () => {
  it("loads SKILL.md with frontmatter", () => {
    withBuiltinOff(() => {
      const ws = fs.mkdtempSync(path.join(os.tmpdir(), "forge-skills-"));
      const dir = path.join(ws, ".forge", "skills", "deploy");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "SKILL.md"),
        `---
name: deploy
description: How to deploy this service
---
Always run smoke after deploy.
`,
      );
      const skills = loadProjectSkills(ws);
      assert.equal(skills.length, 1);
      assert.equal(skills[0].name, "deploy");
      assert.match(skills[0].description, /deploy/i);
      assert.match(skills[0].body, /smoke/);
      assert.equal(countProjectSkills(ws), 1);
      const prompt = formatSkillsForPrompt(ws);
      assert.match(prompt, /skill:deploy/);
      assert.match(prompt, /smoke/);
    });
  });

  it("project overrides user skill with same name", () => {
    withBuiltinOff(() => {
      const ws = fs.mkdtempSync(path.join(os.tmpdir(), "forge-skills-ov-"));
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-skills-home-"));
      const prev = process.env.FORGE_HOME;
      process.env.FORGE_HOME = home;
      try {
        const userDir = path.join(home, "skills", "shared");
        fs.mkdirSync(userDir, { recursive: true });
        fs.writeFileSync(
          path.join(userDir, "SKILL.md"),
          "---\nname: shared\ndescription: user\n---\nUSER BODY\n",
        );
        const pdir = path.join(ws, ".forge", "skills", "shared");
        fs.mkdirSync(pdir, { recursive: true });
        fs.writeFileSync(
          path.join(pdir, "SKILL.md"),
          "---\nname: shared\ndescription: project\n---\nPROJECT BODY\n",
        );
        const skills = loadProjectSkills(ws);
        assert.equal(skills.length, 1);
        assert.equal(skills[0].source, "project");
        assert.match(skills[0].body, /PROJECT/);
      } finally {
        if (prev === undefined) delete process.env.FORGE_HOME;
        else process.env.FORGE_HOME = prev;
      }
    });
  });

  it("loads package-shipped forge-* builtins", () => {
    const prev = process.env.FORGE_BUILTIN_SKILLS;
    delete process.env.FORGE_BUILTIN_SKILLS;
    try {
      const dir = builtinSkillsDir();
      assert.ok(fs.existsSync(dir), `expected skills dir at ${dir}`);
      const ws = fs.mkdtempSync(path.join(os.tmpdir(), "forge-skills-bi-"));
      const skills = loadProjectSkills(ws);
      const builtins = skills.filter((s) => s.source === "builtin");
      assert.ok(builtins.length >= 10, `expected ≥10 builtins, got ${builtins.length}`);
      const names = new Set(builtins.map((s) => s.name));
      for (const n of [
        "forge-method",
        "forge-prove",
        "forge-rootcause",
        "forge-blueprint",
        "forge-redgreen",
        "forge-surface",
        "forge-polish",
      ]) {
        assert.ok(names.has(n), `missing builtin ${n}`);
      }
      const method = builtins.find((s) => s.name === "forge-method")!;
      assert.equal(method.inject, "always");
      const prompt = formatSkillsForPrompt(ws);
      assert.match(prompt, /### Catalog/);
      assert.match(prompt, /\bforge-method\b/);
      assert.match(prompt, /Forge Method|forge-\*|How to use Forge/i);
      // Catalog lists others; progressive — full body of forge-prove not required
      assert.match(prompt, /\bforge-prove\b/);
      assert.match(prompt, /skills\/forge-prove\/SKILL\.md/);
      // Multi-line frontmatter description: >- must not leak as the description
      assert.ok(!/skill:forge-method.*—\s*>-/.test(prompt));
      assert.match(method.description, /built-in skills|playbook/i);
    } finally {
      if (prev === undefined) delete process.env.FORGE_BUILTIN_SKILLS;
      else process.env.FORGE_BUILTIN_SKILLS = prev;
    }
  });

  it("project skill overrides builtin with same name", () => {
    const prev = process.env.FORGE_BUILTIN_SKILLS;
    delete process.env.FORGE_BUILTIN_SKILLS;
    try {
      const ws = fs.mkdtempSync(path.join(os.tmpdir(), "forge-skills-ovb-"));
      const pdir = path.join(ws, ".forge", "skills", "forge-prove");
      fs.mkdirSync(pdir, { recursive: true });
      fs.writeFileSync(
        path.join(pdir, "SKILL.md"),
        "---\nname: forge-prove\ndescription: project prove\n---\nPROJECT PROVE BODY UNIQUE\n",
      );
      const skills = loadProjectSkills(ws);
      const prove = skills.find((s) => s.name === "forge-prove");
      assert.ok(prove);
      assert.equal(prove!.source, "project");
      assert.match(prove!.body, /PROJECT PROVE BODY UNIQUE/);
    } finally {
      if (prev === undefined) delete process.env.FORGE_BUILTIN_SKILLS;
      else process.env.FORGE_BUILTIN_SKILLS = prev;
    }
  });

  it("FORGE_BUILTIN_SKILLS=0 disables package skills", () => {
    withBuiltinOff(() => {
      const ws = fs.mkdtempSync(path.join(os.tmpdir(), "forge-skills-off-"));
      const skills = loadProjectSkills(ws);
      assert.equal(skills.filter((s) => s.source === "builtin").length, 0);
    });
  });

  it("injects into baseline system prompt", () => {
    withBuiltinOff(() => {
      const ws = fs.mkdtempSync(path.join(os.tmpdir(), "forge-skills-sp-"));
      const dir = path.join(ws, ".forge", "skills", "qa");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "SKILL.md"),
        "---\nname: qa\ndescription: QA bar\n---\nAlways run the full suite.\n",
      );
      const prompt = buildBaselineSystemPrompt({
        config: { ...DEFAULT_CONFIG, workspace: ws },
        workspace: ws,
      });
      assert.match(prompt, /## Skills|skill:qa/);
      assert.match(prompt, /full suite/);
    });
  });

  it("/context lists skills", async () => {
    await withBuiltinOff(async () => {
      const ws = fs.mkdtempSync(path.join(os.tmpdir(), "forge-skills-ctx-"));
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-skills-home3-"));
      const prev = process.env.FORGE_HOME;
      process.env.FORGE_HOME = home;
      try {
        const dir = path.join(ws, ".forge", "skills", "ship");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          path.join(dir, "SKILL.md"),
          "---\nname: ship\ndescription: Ship bar\n---\nShip carefully.\n",
        );
        const session = createSession({ cwd: ws, provider: "xai", model: "m" });
        const cfg = { ...DEFAULT_CONFIG, workspace: ws };
        const hooks = new HookRunner(cfg, ws);
        const r = await handleSlash("/context", {
          session,
          config: cfg,
          hooks,
        });
        assert.equal(r.handled, true);
        assert.match(String(r.output || ""), /Skills/i);
        assert.match(String(r.output || ""), /ship/);
      } finally {
        if (prev === undefined) delete process.env.FORGE_HOME;
        else process.env.FORGE_HOME = prev;
      }
    });
  });

  it("/skills lists packs", async () => {
    const prevBi = process.env.FORGE_BUILTIN_SKILLS;
    delete process.env.FORGE_BUILTIN_SKILLS;
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "forge-skills-slash-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-skills-home2-"));
    const prev = process.env.FORGE_HOME;
    process.env.FORGE_HOME = home;
    try {
      const dir = path.join(ws, ".forge", "skills", "lint");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "SKILL.md"),
        "---\nname: lint\ndescription: Lint rules\n---\nUse biome.\n",
      );
      const session = createSession({ cwd: ws, provider: "xai", model: "m" });
      const cfg = { ...DEFAULT_CONFIG, workspace: ws };
      const hooks = new HookRunner(cfg, ws);
      const r = await handleSlash("/skills", {
        session,
        config: cfg,
        hooks,
      });
      assert.equal(r.handled, true);
      assert.match(String(r.output || ""), /lint/);
      assert.match(String(r.output || ""), /Lint rules/);
      assert.match(String(r.output || ""), /Builtin|forge-method/i);
    } finally {
      if (prev === undefined) delete process.env.FORGE_HOME;
      else process.env.FORGE_HOME = prev;
      if (prevBi === undefined) delete process.env.FORGE_BUILTIN_SKILLS;
      else process.env.FORGE_BUILTIN_SKILLS = prevBi;
    }
  });

  it("doctor warns when skills dominate context window", async () => {
    withBuiltinOff(async () => {
      const ws = fs.mkdtempSync(path.join(os.tmpdir(), "forge-skills-press-"));
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-skills-home4-"));
      const prev = process.env.FORGE_HOME;
      process.env.FORGE_HOME = home;
      try {
        const dir = path.join(ws, ".forge", "skills", "huge");
        fs.mkdirSync(dir, { recursive: true });
        // ~4k chars → roughly 1k tokens; with tiny context window triggers ≥12%
        const body = ("Always follow this rule. " + "x".repeat(80) + "\n").repeat(
          80,
        );
        fs.writeFileSync(
          path.join(dir, "SKILL.md"),
          `---\nname: huge\ndescription: Big playbook\n---\n${body}\n`,
        );
        const { runDoctorCheck } = await import("../src/commands/slash.js");
        const doc = await runDoctorCheck({
          ...DEFAULT_CONFIG,
          workspace: ws,
          contextWindow: 2000,
        });
        assert.match(doc.report, /skills/i);
        assert.match(doc.report, /% of context window|trim SKILL/i);
      } finally {
        if (prev === undefined) delete process.env.FORGE_HOME;
        else process.env.FORGE_HOME = prev;
      }
    });
  });
});
