import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadProjectSkills,
  formatSkillsForPrompt,
  countProjectSkills,
} from "../src/agent/project-skills.js";
import { buildBaselineSystemPrompt } from "../src/agent/system-prompt.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";
import { handleSlash } from "../src/commands/slash.js";
import { createSession } from "../src/session/session.js";
import { HookRunner } from "../src/harness/hooks.js";

describe("project skills", () => {
  it("loads SKILL.md with frontmatter", () => {
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

  it("project overrides user skill with same name", () => {
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

  it("injects into baseline system prompt", () => {
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
    assert.match(prompt, /Project skills|skill:qa/);
    assert.match(prompt, /full suite/);
  });

  it("/skills lists packs", async () => {
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
    } finally {
      if (prev === undefined) delete process.env.FORGE_HOME;
      else process.env.FORGE_HOME = prev;
    }
  });
});
