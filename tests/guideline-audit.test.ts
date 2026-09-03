import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  applyGuidelineStamp,
  AUDIT_ONLY_GUIDELINE_FILES,
  GUIDELINE_FILES,
  clearGuidelineAuditState,
  describeGuidelineFile,
  detectGuidelineConflicts,
  evaluateGuidelineAuditAtStop,
  finalizeGuidelineAudit,
  findStaleGuidelinePaths,
  formatGuidelineAuditBrief,
  formatGuidelineAuditNotice,
  formatGuidelineCard,
  formatGuidelineStatusLine,
  guidelineAuditBriefed,
  guidelineRegistryPath,
  resolveGuidelineRoot,
  GUIDELINE_BRIEF_PREFIX,
  GUIDELINE_MANUAL_CHARS,
  hashGuidelineBody,
  isImportOnlyGuideline,
  loadGuidelineRegistry,
  maybeGuidelineAuditBrief,
  noteGuidelineToolCall,
  parseGuidelineStamp,
  stampGuidelinesNow,
  stripGuidelineStamp,
  surveyGuidelines,
  type GuidelineFinalizeResult,
  type GuidelineRevisedFile,
} from "../src/harness/guideline-audit.js";
import {
  listProjectRulePaths,
  PROMPT_RULE_FILES,
} from "../src/agent/system-prompt.js";
import { RULES_PER_FILE_CHARS } from "../src/agent/instruction-paths.js";
import { isSyntheticUserMessage } from "../src/session/session.js";
import { HookRunner } from "../src/harness/hooks.js";
import { runStopGuard } from "../src/harness/stop-guard.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";

function mkProject(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "forge-guide-"));
  // A real repo, not an empty `.git` dir: `TMPDIR` points inside this
  // repository during `npm test`, and git walks up out of an invalid `.git`,
  // so a fixture that ever reaches a git command would find *this* repo.
  execFileSync("git", ["init", "-q", "-b", "main", root], { stdio: "ignore" });
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"x"}');
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return root;
}

const GOOD = `# AGENTS.md

Small TS CLI.

## Commands

- \`npm test\` runs the suite

## Layout

- \`src/\` — code
`;

describe("guideline stamp", () => {
  it("formats, parses, strips and hashes independently of the stamp", () => {
    const stamped = applyGuidelineStamp(GOOD, "2026-09-03T14:05:22.123Z");
    assert.match(stamped, /^<!-- proofread 2026-09-03T14:05Z · forge -->\n\n# AGENTS\.md/);
    const parsed = parseGuidelineStamp(stamped);
    assert.equal(parsed?.at, "2026-09-03T14:05Z");
    assert.equal(parsed?.by, "forge");
    assert.equal(stripGuidelineStamp(stamped), GOOD.trimEnd());
    assert.equal(hashGuidelineBody(stamped), hashGuidelineBody(GOOD));
    // Re-stamping replaces, never stacks.
    const again = applyGuidelineStamp(stamped, "2026-09-04T00:00:00Z");
    assert.equal((again.match(/proofread/g) || []).length, 1);
    assert.match(again, /2026-09-04T00:00Z/);
  });

  it("goes after YAML frontmatter and accepts sibling harness stamps", () => {
    const fm = `---\ntitle: x\n---\n# Hi\nbody\n`;
    const out = applyGuidelineStamp(fm, "2026-09-03T10:00:00Z");
    assert.match(out, /^---\ntitle: x\n---\n<!-- proofread 2026-09-03T10:00Z · forge -->\n\n# Hi/);
    const sib = parseGuidelineStamp(
      "<!-- proofread 2026-09-01T10:15Z · sisyphus-all -->\n# x\n",
    );
    assert.equal(sib?.by, "sisyphus-all");
  });
});

describe("guideline classifiers", () => {
  it("import-only CLAUDE.md is a pointer, not a manual", () => {
    assert.equal(isImportOnlyGuideline("@AGENTS.md\n"), true);
    assert.equal(isImportOnlyGuideline("# Notes\nSee AGENTS.md for everything.\n"), true);
    assert.equal(isImportOnlyGuideline(GOOD), false);
  });

  it("flags rules that fight verification, not benign safety rules", () => {
    assert.deepEqual(
      detectGuidelineConflicts("Never run the tests locally. Ask permission before every edit."),
      ["forbids running tests/checks", "asks permission before every edit"],
    );
    assert.deepEqual(detectGuidelineConflicts("Never push to main. Never commit secrets."), []);
  });

  it("finds backticked paths that no longer exist", () => {
    const root = mkProject({ "src/a.ts": "x" });
    const stale = findStaleGuidelinePaths(
      "see `src/a.ts` and `src/gone.ts` and `https://x/y.md` and `node_modules/x/y.js`",
      root,
    );
    assert.deepEqual(stale, ["src/gone.ts"]);
  });
});

describe("surveyGuidelines", () => {
  it("never-stamped manual over the loader cap needs audit; stamped short file is fresh", () => {
    const manual = `# AGENTS.md\n\n- \`npm test\`\n` + "x".repeat(GUIDELINE_MANUAL_CHARS + 10);
    const root = mkProject({
      "AGENTS.md": manual,
      "CLAUDE.md": "@AGENTS.md\n",
    });
    const s = surveyGuidelines(root);
    assert.equal(s.notAProject, false);
    assert.equal(s.missingPrimary, false);
    const agents = s.files.find((f) => f.rel === "AGENTS.md")!;
    assert.equal(agents.freshness, "never");
    assert.ok(agents.issues.some((i) => i.kind === "manual"));
    assert.equal(agents.needsAudit, true);
    const claude = s.files.find((f) => f.rel === "CLAUDE.md")!;
    assert.equal(claude.freshness, "import");
    assert.equal(claude.needsAudit, false);
    assert.equal(s.needsAudit, true);
    assert.match(formatGuidelineStatusLine(s), /AGENTS\.md never proofread · manual/);

    // Stamp it now → fresh, nothing due.
    fs.writeFileSync(path.join(root, "AGENTS.md"), applyGuidelineStamp(GOOD));
    const s2 = surveyGuidelines(root);
    const a2 = s2.files.find((f) => f.rel === "AGENTS.md")!;
    assert.equal(a2.freshness, "fresh");
    assert.equal(a2.needsAudit, false);
    assert.equal(s2.needsAudit, false);
    assert.match(formatGuidelineStatusLine(s2), /AGENTS\.md fresh \(\d{4}-\d{2}-\d{2}\)/);
  });

  it("a stamp older than the recheck window is due; a missing primary file is flagged", () => {
    const root = mkProject({
      "AGENTS.md": `<!-- proofread 2020-01-01T00:00Z · forge -->\n\n${GOOD}`,
    });
    const s = surveyGuidelines(root);
    assert.equal(s.files[0].freshness, "due");
    assert.equal(s.files[0].needsAudit, true);

    // No project primary and no global map either: a plain hole.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-home-nogl-"));
    const priorHome = process.env.FORGE_HOME;
    process.env.FORGE_HOME = home;
    try {
      const empty = mkProject({});
      const s2 = surveyGuidelines(empty);
      assert.equal(s2.missingPrimary, true);
      assert.equal(s2.needsAudit, true);
      assert.equal(s2.globalFallback, null);
      assert.equal(formatGuidelineStatusLine(s2), "AGENTS.md missing");
    } finally {
      if (priorHome == null) delete process.env.FORGE_HOME;
      else process.env.FORGE_HOME = priorHome;
    }
  });

  it("names ~/.forge/AGENTS.md when that is what steers, instead of only reporting a hole", () => {
    // Difference 2 between the audited set and the loaded set: the prompt
    // passes `globalAgentsFallback: true`, the audit does not. So a project
    // with no AGENTS.md of its own had the user's global file in the prompt
    // steering every turn while the audit said "AGENTS.md missing" and never
    // mentioned it. The audit still refuses to survey, stamp or rewrite it —
    // it is the user's map, not the project's — but it has to name it.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-home-global-"));
    const priorHome = process.env.FORGE_HOME;
    process.env.FORGE_HOME = home;
    try {
      const globalAbs = path.join(home, "AGENTS.md");
      fs.writeFileSync(globalAbs, "# my own map\n\nAlways use pnpm.\n");
      const repo = mkProject({});

      // The prompt loads it…
      assert.deepEqual(
        listProjectRulePaths(repo).filter((p) => p.endsWith("AGENTS.md")),
        [globalAbs],
      );
      // …the audit does not survey it, but does name it.
      const s = surveyGuidelines(repo);
      assert.equal(s.missingPrimary, true);
      assert.equal(s.globalFallback, globalAbs);
      assert.deepEqual(s.files.map((f) => f.abs), []);
      assert.equal(
        formatGuidelineStatusLine(s),
        "AGENTS.md missing · ~/.forge/AGENTS.md steers instead",
      );
      assert.match(
        formatGuidelineAuditBrief(s),
        /~\/\.forge\/AGENTS\.md is steering this session in the meantime/,
      );
      assert.match(formatGuidelineAuditBrief(s), /Do not edit it\./);
      // `/guidelines` is where a user asks what steers this repo; answering
      // "missing" alone is the same omission as the status line's.
      assert.match(
        formatGuidelineCard({ workspace: repo }),
        /~\/\.forge\/AGENTS\.md steers meanwhile/,
      );

      // A project with its own AGENTS.md is not steered by the global one,
      // so nothing is claimed about it.
      const own = mkProject({ "AGENTS.md": GOOD });
      assert.equal(surveyGuidelines(own).globalFallback, null);
    } finally {
      if (priorHome == null) delete process.env.FORGE_HOME;
      else process.env.FORGE_HOME = priorHome;
    }
  });

  it("the audited set and the loaded set differ only by the two documented differences", () => {
    // The old assertion compared one filtered basename in one fixture, which
    // left the real divergence (different `files` lists, different fallback
    // option) invisible. Pin the relationship instead:
    //   audited \ loaded ⊆ AUDIT_ONLY_GUIDELINE_FILES
    //   loaded  \ audited ⊆ { ~/.forge/AGENTS.md }
    // Name level first, so adding a file to one list and not the other is red
    // without needing a fixture that happens to contain it.
    const prompt = new Set<string>(PROMPT_RULE_FILES);
    const audit = new Set<string>(GUIDELINE_FILES);
    assert.deepEqual(
      [...audit].filter((n) => !prompt.has(n)).sort(),
      [...AUDIT_ONLY_GUIDELINE_FILES].sort(),
      "a file the audit surveys and the prompt never loads must be listed in AUDIT_ONLY_GUIDELINE_FILES",
    );
    assert.deepEqual(
      [...prompt].filter((n) => !audit.has(n)),
      [],
      "every file the prompt steers by must be audited",
    );

    // Path level, in a monorepo fixture holding every name in both lists at
    // the root and in the package, plus a .cursor/rules dir on both sides.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-home-parity-"));
    const priorHome = process.env.FORGE_HOME;
    process.env.FORGE_HOME = home;
    try {
      fs.writeFileSync(path.join(home, "AGENTS.md"), "# global\n");
      const seed: Record<string, string> = {};
      for (const name of [...PROMPT_RULE_FILES, ...GUIDELINE_FILES]) {
        seed[name] = `# ${name}\n\n- \`npm test\`\n`;
        seed[path.join("packages", "api", name)] = `# api ${name}\n\n- \`npm test\`\n`;
      }
      seed[path.join(".cursor", "rules", "a.md")] = "# root rule\n";
      seed[path.join("packages", "api", ".cursor", "rules", "b.md")] = "# pkg rule\n";
      const repo = mkProject(seed);
      const ws = path.join(repo, "packages", "api");

      const loaded = new Set(listProjectRulePaths(ws).map((p) => path.resolve(p)));
      const survey = surveyGuidelines(ws);
      const audited = new Set(survey.files.map((f) => path.resolve(f.abs)));
      assert.ok(loaded.size > 6 && audited.size > 6, "fixture should be wide");

      const auditedNotLoaded = [...audited]
        .filter((p) => !loaded.has(p))
        .map((p) => path.basename(p))
        .sort();
      assert.deepEqual(
        [...new Set(auditedNotLoaded)],
        [...new Set([...AUDIT_ONLY_GUIDELINE_FILES].map((n) => path.basename(n)))].sort(),
        `audited but never loaded: ${JSON.stringify(auditedNotLoaded)}`,
      );

      const loadedNotAudited = [...loaded].filter((p) => !audited.has(p));
      assert.deepEqual(
        loadedNotAudited,
        [],
        `loaded but never audited: ${JSON.stringify(loadedNotAudited)}`,
      );
      // The project has its own AGENTS.md here, so the fallback is not in play.
      assert.equal(survey.globalFallback, null);
    } finally {
      if (priorHome == null) delete process.env.FORGE_HOME;
      else process.env.FORGE_HOME = priorHome;
    }
  });

  it("the loader's cap and the registry key are the project's, not a second copy", () => {
    // The audit reports "over the N-char cap the prompt loads", so N has to
    // be the loader's own number, not a constant beside it.
    assert.equal(GUIDELINE_MANUAL_CHARS, RULES_PER_FILE_CHARS);

    // One repo, two ways to name it. `projectMemoryKey` hashes the string it
    // is handed and project memory hands it a symlink-resolved root, so the
    // guideline registry keyed on the raw walk result split the same repo in
    // two — and the second registry had no hashes, so `edited` went blind.
    const repo = mkProject({ "AGENTS.md": GOOD });
    const link = `${repo}-link`;
    fs.symlinkSync(repo, link);
    try {
      assert.equal(
        guidelineRegistryPath(resolveGuidelineRoot(link)),
        guidelineRegistryPath(resolveGuidelineRoot(repo)),
      );
    } finally {
      fs.unlinkSync(link);
    }
  });

  it("a scratch directory is not a project", () => {
    // Outside any git repo (the suite's TMPDIR sits inside this repo).
    let base = "/tmp";
    try {
      base = fs.realpathSync("/tmp");
    } catch {
      /* */
    }
    const dir = fs.mkdtempSync(path.join(base, "forge-scratch-"));
    const s = surveyGuidelines(dir);
    assert.equal(s.notAProject, true);
    assert.equal(s.needsAudit, false);
  });

  it("audits the nested AGENTS.md the prompt loads, not the monorepo root", () => {
    // `loadProjectRules` walks workspace → git root and lets a nested file
    // shadow the root, so in `repo/packages/api` the package's own map is
    // what steers the session. The survey used to read `repo/AGENTS.md`
    // instead: the "never run the tests" rule never surfaced and the audit
    // called the root file fine.
    const repo = mkProject({
      "AGENTS.md": GOOD,
      "packages/api/AGENTS.md":
        "# api\n\nNever run the tests.\n\n## Commands\n\n- `npm test`\n",
    });
    const ws = path.join(repo, "packages", "api");
    const nested = path.resolve(ws, "AGENTS.md");
    // What the prompt loads from there…
    assert.deepEqual(
      listProjectRulePaths(ws).filter((p) => p.endsWith("AGENTS.md")),
      [nested],
    );
    // …is what the audit surveys.
    const s = surveyGuidelines(ws);
    assert.equal(s.root, path.resolve(repo), "rel labels stay root-relative");
    assert.deepEqual(
      s.files.map((f) => f.rel),
      [path.join("packages", "api", "AGENTS.md")],
    );
    assert.equal(s.files[0].abs, nested);
    assert.equal(s.files[0].primary, true);
    assert.equal(s.missingPrimary, false);
    assert.deepEqual(
      s.files[0].issues.filter((i) => i.kind === "conflict").map((i) => i.detail),
      ["forbids running tests/checks"],
    );
    assert.equal(s.needsAudit, true);
    // And the brief names the file the session is actually steered by.
    assert.match(
      formatGuidelineAuditBrief(s),
      /packages[/\\]api[/\\]AGENTS\.md — .* forbids running tests\/checks/,
    );
  });

  it("no-commands primary file and conflict rules are issues even when stamped", () => {
    const root = mkProject({
      "AGENTS.md": applyGuidelineStamp(
        "# AGENTS.md\n\nBe nice. Never run the test suite.\n",
      ),
    });
    const f = surveyGuidelines(root).files[0];
    assert.equal(f.freshness, "fresh");
    assert.ok(f.issues.some((i) => i.kind === "no-commands"));
    assert.ok(f.issues.some((i) => i.kind === "conflict"));
    assert.equal(f.needsAudit, true);
  });
});

describe("guideline status rendering", () => {
  // The two lines a user actually reads: the doctor / --json status line and
  // the per-file line in `/guidelines` and the audit brief.
  it("collapses repeated issue kinds and never states the size twice", () => {
    const root = mkProject({
      "AGENTS.md":
        "# AGENTS.md\n\nNever run the tests. Ask for permission before every edit.\n\nSee `src/gone/missing.ts`.\n",
    });
    const s = surveyGuidelines(root);
    const f = s.files.find((x) => x.rel === "AGENTS.md")!;
    // Two rules, both `conflict` — the detail list keeps both…
    assert.deepEqual(
      f.issues.filter((i) => i.kind === "conflict").map((i) => i.detail),
      ["forbids running tests/checks", "asks permission before every edit"],
    );
    // …and the compact kind list names the kind once.
    const line = formatGuidelineStatusLine(s);
    assert.match(line, /conflict/);
    assert.doesNotMatch(line, /conflict\+conflict/);
    assert.equal(
      line,
      "AGENTS.md never proofread · no-commands+stale-paths+conflict",
    );

    // The per-file line states the size once, then freshness, then details.
    const desc = describeGuidelineFile(f);
    assert.equal(
      desc,
      `AGENTS.md — ${f.bytes} chars / ${f.lines} lines — never proofread — no build/test/typecheck commands an agent can run; 1 path no longer exists: src/gone/missing.ts; forbids running tests/checks; asks permission before every edit`,
    );
    assert.equal(desc.match(/chars/g)?.length, 1, "size stated once");
  });

  it("says the size once for an over-cap file too, where both layers add it", () => {
    const root = mkProject({
      "AGENTS.md": `# AGENTS.md\n\n- \`npm test\`\n\n${"x".repeat(12_400)}\n`,
    });
    const f = surveyGuidelines(root).files[0];
    const desc = describeGuidelineFile(f);
    assert.match(
      desc,
      /^AGENTS\.md — 12\.4k chars \/ 6 lines — never proofread — over the 12,000-char cap the prompt loads, so the tail is invisible to agents$/,
    );
    // The size token itself appears once: the detail names the cap, not the
    // file's own size, which the line has already given.
    assert.equal(desc.match(/12\.4k/g)?.length, 1, "size stated once");
  });

  it("a clean fresh file, and an import-only pointer, read plainly", () => {
    const fresh = mkProject({ "AGENTS.md": applyGuidelineStamp(GOOD) });
    const ff = surveyGuidelines(fresh).files[0];
    assert.match(
      describeGuidelineFile(ff),
      /^AGENTS\.md — \d+ chars \/ \d+ lines — proofread \d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/,
    );
    const imp = mkProject({ "AGENTS.md": GOOD, "CLAUDE.md": "@AGENTS.md\n" });
    const cf = surveyGuidelines(imp).files.find((x) => x.rel === "CLAUDE.md")!;
    assert.match(describeGuidelineFile(cf), /import-only pointer — fine$/);
  });
});

describe("formatGuidelineAuditNotice", () => {
  // The invariant, not one path through it: a notice line says what happened
  // to that file, and no file is ever announced as stamped and unstamped.
  const rev = (rel: string, created = false): GuidelineRevisedFile => ({
    rel,
    before: created ? { bytes: 0, lines: 0 } : { bytes: 26_795, lines: 139 },
    after: { bytes: 12_400, lines: 96 },
    created,
  });
  const base = { stamped: [], revised: [], ignored: [], unresolved: [], skipped: false };

  it("never claims a stamp for a file it withheld one from", () => {
    const cases: GuidelineFinalizeResult[] = [
      // revised, stamp withheld
      { ...base, revised: [rev("AGENTS.md")], unresolved: [{ rel: "AGENTS.md", issues: ["over the 12,000-char cap the prompt loads"] }] },
      // written from scratch, stamp withheld
      { ...base, revised: [rev("AGENTS.md", true)], unresolved: [{ rel: "AGENTS.md", issues: ["no build/test/typecheck commands an agent can run"] }] },
      // two files, one clean one not
      {
        ...base,
        stamped: ["CLAUDE.md"],
        revised: [rev("AGENTS.md"), rev("CLAUDE.md")],
        unresolved: [{ rel: "AGENTS.md", issues: ["forbids running tests/checks"] }],
      },
    ];
    for (const r of cases) {
      const lines = formatGuidelineAuditNotice(r);
      for (const u of r.unresolved) {
        const own = lines.filter((l) => l.includes(u.rel));
        assert.equal(own.length, 1, `one line for ${u.rel}: ${JSON.stringify(lines)}`);
        assert.doesNotMatch(own[0], /stamp (?:updated|added)/);
        assert.match(own[0], /not stamped/);
        assert.match(own[0], /Next session audits it again/);
      }
    }
  });

  it("still says so plainly when the stamp was earned", () => {
    const lines = formatGuidelineAuditNotice({
      ...base,
      stamped: ["AGENTS.md"],
      revised: [rev("AGENTS.md")],
    });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /revised by the agent \(139 → 96 lines, 26\.8k → 12\.4k chars\) — proofread stamp updated$/);
    const created = formatGuidelineAuditNotice({
      ...base,
      stamped: ["AGENTS.md"],
      revised: [rev("AGENTS.md", true)],
    });
    assert.match(created[0], /written by the agent \(96 lines, 12\.4k chars\) — proofread stamp added$/);
    assert.deepEqual(formatGuidelineAuditNotice({ ...base, skipped: true }), []);
  });
});

describe("session audit flow", () => {
  let home = "";
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-home-guide-"));
    process.env.FORGE_HOME = home;
    delete process.env.FORGE_GUIDELINE_AUDIT;
    delete process.env.FORGE_GUIDELINE_AUDIT_BLOCK;
    clearGuidelineAuditState();
  });
  afterEach(() => {
    clearGuidelineAuditState();
  });

  it("briefs once, is a synthetic user message, says the edits are authorised", () => {
    const root = mkProject({ "AGENTS.md": GOOD });
    const brief = maybeGuidelineAuditBrief({ sessionId: "s1", workspace: root });
    assert.ok(brief, "expected a brief for an unstamped file");
    assert.ok(brief!.startsWith(GUIDELINE_BRIEF_PREFIX));
    assert.ok(isSyntheticUserMessage({ role: "user", content: brief! }));
    assert.match(brief!, /authorises revising or rewriting/);
    assert.match(brief!, /AGENTS\.md — .* never proofread/);
    assert.match(brief!, /Do not write the proofread stamp yourself/);
    assert.equal(maybeGuidelineAuditBrief({ sessionId: "s1", workspace: root }), null);
    assert.equal(guidelineAuditBriefed("s1"), true);
  });

  it("defers while read-only, skips subagents, fresh files and the kill-switch", () => {
    const root = mkProject({ "AGENTS.md": GOOD });
    assert.equal(
      maybeGuidelineAuditBrief({ sessionId: "s2", workspace: root, readOnly: true }),
      null,
    );
    assert.equal(guidelineAuditBriefed("s2"), false);
    assert.ok(maybeGuidelineAuditBrief({ sessionId: "s2", workspace: root }));

    assert.equal(
      maybeGuidelineAuditBrief({ sessionId: "s3", workspace: root, subagent: true }),
      null,
    );

    const fresh = mkProject({ "AGENTS.md": applyGuidelineStamp(GOOD) });
    assert.equal(maybeGuidelineAuditBrief({ sessionId: "s4", workspace: fresh }), null);

    process.env.FORGE_GUIDELINE_AUDIT = "0";
    assert.equal(maybeGuidelineAuditBrief({ sessionId: "s5", workspace: root }), null);
  });

  it("finalize stamps a file the model read, reports a real revision, records the registry", () => {
    const root = mkProject({ "AGENTS.md": GOOD, "CLAUDE.md": "@AGENTS.md\n" });
    assert.ok(maybeGuidelineAuditBrief({ sessionId: "s6", workspace: root }));
    noteGuidelineToolCall("s6", "read_file", { path: path.join(root, "AGENTS.md") });
    // The model rewrites it (via any channel — the hash decides).
    fs.writeFileSync(path.join(root, "AGENTS.md"), `${GOOD}\n## Non-negotiables\n\n- keep tests green\n`);
    const r = finalizeGuidelineAudit({ sessionId: "s6", workspace: root });
    assert.equal(r.skipped, false);
    assert.deepEqual(r.stamped, ["AGENTS.md"]);
    assert.equal(r.revised.length, 1);
    assert.equal(r.revised[0].rel, "AGENTS.md");
    assert.ok(r.revised[0].after.lines > r.revised[0].before.lines);
    assert.deepEqual(r.ignored, []);
    const text = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
    assert.match(text, /^<!-- proofread \d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z · forge -->\n/);
    const notice = formatGuidelineAuditNotice(r);
    assert.equal(notice.length, 1);
    assert.match(notice[0], /AGENTS\.md revised by the agent \(\d+ → \d+ lines/);
    const reg = loadGuidelineRegistry(root);
    assert.ok(reg.files["AGENTS.md"].stampedAt);
    assert.ok(reg.files["AGENTS.md"].revisedAt);
    assert.equal(reg.lastAuditSession, "s6");
    // Idempotent
    assert.equal(finalizeGuidelineAudit({ sessionId: "s6", workspace: root }), r);
    // Next session: fresh, no brief.
    clearGuidelineAuditState();
    assert.equal(maybeGuidelineAuditBrief({ sessionId: "s7", workspace: root }), null);
  });

  it("finalize does not stamp a file the model ignored, and says so", () => {
    const root = mkProject({ "AGENTS.md": GOOD });
    assert.ok(maybeGuidelineAuditBrief({ sessionId: "s8", workspace: root }));
    const r = finalizeGuidelineAudit({ sessionId: "s8", workspace: root });
    assert.deepEqual(r.stamped, []);
    assert.deepEqual(r.ignored, ["AGENTS.md"]);
    assert.doesNotMatch(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"), /proofread/);
    const ignoredNotice = formatGuidelineAuditNotice(r);
    assert.equal(ignoredNotice.length, 1);
    assert.match(ignoredNotice[0], /not checked this session/);
    assert.doesNotMatch(ignoredNotice[0], /stamp (?:updated|added)/);
  });

  it("a bash cat counts as a look; an unchanged looked-at file is stamped with 'no change needed'", () => {
    const root = mkProject({ "AGENTS.md": GOOD });
    assert.ok(maybeGuidelineAuditBrief({ sessionId: "s9", workspace: root }));
    noteGuidelineToolCall("s9", "bash", { command: "cat AGENTS.md" });
    const r = finalizeGuidelineAudit({ sessionId: "s9", workspace: root });
    assert.deepEqual(r.stamped, ["AGENTS.md"]);
    assert.deepEqual(r.revised, []);
    const lookNotice = formatGuidelineAuditNotice(r);
    assert.equal(lookNotice.length, 1);
    assert.match(lookNotice[0], /^Agent guidelines: AGENTS\.md proofread, no change needed — stamp updated$/);
  });

  it("a same-named file elsewhere is not a look — the stamp has to be earned", () => {
    const root = mkProject({
      "AGENTS.md": GOOD,
      ".forge/rules.md": "# rules\n\n- `npm test`\n",
      "docs/rules.md": "# unrelated docs\n",
    });
    assert.ok(maybeGuidelineAuditBrief({ sessionId: "s12", workspace: root }));
    // Reading an unrelated docs/rules.md must not credit .forge/rules.md.
    noteGuidelineToolCall("s12", "read_file", { path: path.join(root, "docs/rules.md") });
    noteGuidelineToolCall("s12", "read_file", { path: path.join(root, "AGENTS.md") });
    const r = finalizeGuidelineAudit({ sessionId: "s12", workspace: root });
    assert.deepEqual(r.stamped, ["AGENTS.md"]);
    assert.deepEqual(r.ignored, [".forge/rules.md"]);
    assert.doesNotMatch(
      fs.readFileSync(path.join(root, ".forge/rules.md"), "utf8"),
      /proofread/,
    );
  });

  it("a mention is not a look — grep, an out-of-tree twin, and a body that names the file", () => {
    // The rel of a root-level primary *is* the bare basename `AGENTS.md`, so
    // a substring test over the tool args credited a proofread to any call
    // that merely said the name — and `grep`/`glob` were in the read set, so
    // one grep both stamped the file and released the step-1c Stop block.
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "forge-guide-other-"));
    fs.writeFileSync(path.join(other, "AGENTS.md"), "# someone else's map\n");
    const root = mkProject({ "AGENTS.md": GOOD, "docs/notes.md": "see AGENTS.md\n" });
    assert.ok(maybeGuidelineAuditBrief({ sessionId: "s15", workspace: root }));

    // A pattern match returns matching lines or paths, never the file.
    noteGuidelineToolCall("s15", "grep", { pattern: "AGENTS.md" });
    noteGuidelineToolCall("s15", "grep", { pattern: "harness", path: "AGENTS.md" });
    noteGuidelineToolCall("s15", "glob", { pattern: "**/AGENTS.md" });
    // A same-named file outside the project is a different file.
    noteGuidelineToolCall("s15", "read_file", { path: path.join(other, "AGENTS.md") });
    // Segment-strict bash: the reader and the path must be the same segment.
    noteGuidelineToolCall("s15", "bash", { command: "cat docs/notes.md | grep AGENTS.md" });
    // Writing *about* the file is not writing it.
    noteGuidelineToolCall("s15", "write_file", {
      path: "docs/notes.md",
      content: "AGENTS.md is the map of this repo.\n",
    });

    // The Stop block — the whole point of step 1c — still fires.
    assert.equal(evaluateGuidelineAuditAtStop({ sessionId: "s15" }).block, true);

    const r = finalizeGuidelineAudit({ sessionId: "s15", workspace: root });
    assert.deepEqual(r.stamped, [], "no stamp without a look");
    assert.deepEqual(r.ignored, ["AGENTS.md"]);
    assert.doesNotMatch(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"), /proofread/);
    assert.doesNotMatch(fs.readFileSync(path.join(other, "AGENTS.md"), "utf8"), /proofread/);
  });

  it("a revision that leaves the problem in place is not stamped as proofread", () => {
    // Over the loader cap and citing a path that does not exist.
    const bloated = `# AGENTS.md\n\n- \`npm test\`\n- see \`src/gone/missing.ts\`\n\n${"x".repeat(13_000)}\n`;
    const root = mkProject({ "AGENTS.md": bloated });
    assert.ok(maybeGuidelineAuditBrief({ sessionId: "s13", workspace: root }));
    noteGuidelineToolCall("s13", "read_file", { path: path.join(root, "AGENTS.md") });
    // The model trims it, but it is still 12.5k — the brief's complaint stands.
    fs.writeFileSync(
      path.join(root, "AGENTS.md"),
      `# AGENTS.md\n\n- \`npm test\`\n\n${"x".repeat(12_400)}\n`,
    );
    const r = finalizeGuidelineAudit({ sessionId: "s13", workspace: root });
    assert.deepEqual(r.stamped, [], "no stamp while the problem survives");
    assert.equal(r.revised.length, 1);
    assert.equal(r.unresolved.length, 1);
    assert.equal(r.unresolved[0].rel, "AGENTS.md");
    assert.deepEqual(r.unresolved[0].issues, [
      "over the 12,000-char cap the prompt loads, so the tail is invisible to agents",
    ]);
    const text = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
    assert.doesNotMatch(text, /proofread/);
    const notice = formatGuidelineAuditNotice(r);
    assert.equal(notice.length, 1, "one line per file, not a claim plus a denial");
    assert.match(
      notice[0],
      /^Agent guidelines: AGENTS\.md revised by the agent \(\d+ → \d+ lines, [\d.]+k → [\d.]+k chars\) but not stamped — /,
    );
    assert.doesNotMatch(notice.join("\n"), /stamp (?:updated|added)/);
    // So the next session is briefed again rather than trusting a stamp.
    clearGuidelineAuditState();
    assert.ok(maybeGuidelineAuditBrief({ sessionId: "s14", workspace: root }));
  });

  it("Stop is blocked once when the briefed audit was ignored, then released", async () => {
    const root = mkProject({ "AGENTS.md": GOOD });
    assert.ok(maybeGuidelineAuditBrief({ sessionId: "s10", workspace: root }));
    const first = evaluateGuidelineAuditAtStop({ sessionId: "s10" });
    assert.equal(first.block, true);
    assert.match(first.reason || "", /first action of this session/);
    const second = evaluateGuidelineAuditAtStop({ sessionId: "s10" });
    assert.equal(second.block, false);

    // Composed through runStopGuard on a clean session.
    assert.ok(maybeGuidelineAuditBrief({ sessionId: "s11", workspace: root }));
    const config = {
      ...DEFAULT_CONFIG,
      blockingStopHooks: true,
      compatClaudeHooks: false,
      compatCursorHooks: false,
      goal: { ...DEFAULT_CONFIG.goal, enabled: false },
    };
    const hooks = new HookRunner(config, root);
    const r = await runStopGuard({
      config,
      hooks,
      ctx: { sessionId: "s11", cwd: root, workspaceRoot: root },
      ultrawork: false,
      openTodoCount: 0,
      editCount: 0,
      lastAssistantMessage: "The answer is 42.",
    });
    assert.equal(r.allowStop, false);
    assert.match(r.reason || "", /guideline-audit/);
    // A look releases it.
    noteGuidelineToolCall("s11", "read_file", { path: "AGENTS.md" });
    const r2 = await runStopGuard({
      config,
      hooks,
      ctx: { sessionId: "s11", cwd: root, workspaceRoot: root },
      ultrawork: false,
      openTodoCount: 0,
      editCount: 0,
      lastAssistantMessage: "The answer is 42.",
    });
    assert.equal(r2.allowStop, true);
  });

  it("/guidelines stamp stamps every non-import file", () => {
    const root = mkProject({ "AGENTS.md": GOOD, "CLAUDE.md": "@AGENTS.md\n" });
    assert.deepEqual(stampGuidelinesNow(root), ["AGENTS.md"]);
    assert.match(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"), /proofread/);
    assert.doesNotMatch(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8"), /proofread/);
  });

  it("brief lists a missing AGENTS.md as something to write", () => {
    const root = mkProject({});
    const s = surveyGuidelines(root);
    assert.match(formatGuidelineAuditBrief(s), /AGENTS\.md — missing\. Write a short one/);
  });
});
