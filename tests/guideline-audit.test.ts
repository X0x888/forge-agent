import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  applyGuidelineProposals,
  applyGuidelineStamp,
  AUDIT_ONLY_GUIDELINE_FILES,
  GUIDELINE_FILES,
  clearGuidelineAuditState,
  describeGuidelineFile,
  detectGuidelineConflicts,
  discardGuidelineProposals,
  extractGuidelineCommands,
  finalizeGuidelineAudit,
  findGuidelinePmMismatch,
  findStaleGuidelineCommands,
  findStaleGuidelinePaths,
  formatGuidelineAuditBrief,
  formatGuidelineAuditNotice,
  formatGuidelineCard,
  formatGuidelineProposalDiff,
  formatGuidelineReportLines,
  formatGuidelineStatusLine,
  guidelineAuditBriefed,
  guidelineHasCommands,
  guidelineProposalPath,
  guidelineRegistryPath,
  resolveGuidelineRoot,
  GUIDELINE_BRIEF_PREFIX,
  GUIDELINE_MANUAL_CHARS,
  GUIDELINE_MANUAL_LINES,
  hashGuidelineBody,
  isImportOnlyGuideline,
  issueClass,
  listGuidelineProposals,
  loadGuidelineRegistry,
  maybeGuidelineAuditBrief,
  noteGuidelineToolCall,
  parseGuidelineStamp,
  stampGuidelinesNow,
  stripGuidelineStamp,
  surveyGuidelines,
} from "../src/harness/guideline-audit.js";
import {
  listProjectRulePaths,
  loadProjectRulesReport,
  PROMPT_RULE_FILES,
} from "../src/agent/system-prompt.js";
import { RULES_PER_FILE_CHARS, ruleFileBudget } from "../src/agent/instruction-paths.js";
import { isSyntheticUserMessage } from "../src/session/session.js";
import { readFileMutations } from "../src/session/mutations.js";

function mkProject(files: Record<string, string>, opts?: { pkg?: string }): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "forge-guide-"));
  // A real repo, not an empty `.git` dir: `TMPDIR` points inside this
  // repository during `npm test`, and git walks up out of an invalid `.git`,
  // so a fixture that ever reaches a git command would find *this* repo.
  execFileSync("git", ["init", "-q", "-b", "main", root], { stdio: "ignore" });
  fs.writeFileSync(
    path.join(root, "package.json"),
    opts?.pkg ?? '{"name":"x","scripts":{"test":"node --test","build":"tsc"}}',
  );
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return root;
}

/** A clean map: every cited path and command exists in `mkProject`'s repo. */
const GOOD = `# AGENTS.md

Small TS CLI.

## Commands

- \`npm test\` runs the suite

## Layout

- \`src/\` — code
`;

/** One fact defect: a cited path that does not exist. */
const DEAD_PATH = `${GOOD}- \`src/gone/missing.ts\` — the importer\n`;

describe("guideline stamp", () => {
  it("formats, parses, strips and hashes independently of the stamp", () => {
    const stamped = applyGuidelineStamp(GOOD, "2026-09-03T14:05:22.123Z");
    assert.match(stamped, /^<!-- proofread 2026-09-03T14:05Z · forge -->\n\n# AGENTS\.md/);
    const parsed = parseGuidelineStamp(stamped);
    assert.equal(parsed?.at, "2026-09-03T14:05Z");
    assert.equal(parsed?.by, "forge");
    assert.equal(stripGuidelineStamp(stamped), GOOD.trimEnd());
    assert.equal(hashGuidelineBody(stamped), hashGuidelineBody(GOOD));
    const again = applyGuidelineStamp(stamped, "2026-09-04T00:00:00Z");
    assert.equal((again.match(/proofread/g) || []).length, 1);
    assert.match(again, /2026-09-04T00:00Z/);
  });

  it("goes after YAML frontmatter and accepts sibling harness stamps", () => {
    const fm = `---\ntitle: x\n---\n# Hi\nbody\n`;
    const out = applyGuidelineStamp(fm, "2026-09-03T10:00:00Z");
    assert.match(out, /^---\ntitle: x\n---\n<!-- proofread 2026-09-03T10:00Z · forge -->\n\n# Hi/);
    const sib = parseGuidelineStamp("<!-- proofread 2026-09-01T10:15Z · sisyphus-all -->\n# x\n");
    assert.equal(sib?.by, "sisyphus-all");
  });
});

describe("guideline fact checks", () => {
  it("import-only CLAUDE.md is a pointer, not a manual", () => {
    assert.equal(isImportOnlyGuideline("@AGENTS.md\n"), true);
    assert.equal(isImportOnlyGuideline("# Notes\nSee AGENTS.md for everything.\n"), true);
    assert.equal(isImportOnlyGuideline(GOOD), false);
  });

  it("finds backticked paths that no longer exist", () => {
    const root = mkProject({ "src/a.ts": "x" });
    const stale = findStaleGuidelinePaths(
      "see `src/a.ts` and `src/gone.ts` and `https://x/y.md` and `node_modules/x/y.js`",
      root,
    );
    assert.deepEqual(stale, ["src/gone.ts"]);
  });

  it("extracts commands from inline code and shell fences, not from symbols", () => {
    const text =
      "Run `npm test` then `./scripts/check.sh --fast`. The `ForgeConfig` type and `src/x.ts` are not commands.\n" +
      "```bash\n$ make lint  # linter\nnpm run build && npm run typecheck\n```\n";
    assert.deepEqual(extractGuidelineCommands(text), [
      "make lint",
      "npm run build && npm run typecheck",
      "npm test",
      "./scripts/check.sh --fast",
    ]);
  });

  it("flags scripts and Makefile targets the repo does not have — never bare binaries", () => {
    const root = mkProject(
      { Makefile: "build:\n\ttsc\n\n.PHONY: build\n", "scripts/check.sh": "#!/bin/sh\n" },
      { pkg: '{"name":"x","scripts":{"test":"node --test"}}' },
    );
    const stale = findStaleGuidelineCommands(
      [
        "- `npm test` — fine",
        "- `npm run lint` — no such script",
        "- `pnpm run typecheck && npm test` — first segment is stale",
        "- `make build` — fine",
        "- `make release` — no such target",
        "- `./scripts/check.sh` — exists",
        "- `./build.sh` — does not",
        "- `cargo test` — a bare binary: this machine's PATH is not the file's fault",
        "- `npm run $SCRIPT` — placeholder, ignored",
        // npm built-ins need no script: this repo's own AGENTS.md was flagged
        // for `npm install` before these were excluded.
        "- `npm install` then `npm ci` and `npm publish` — built-ins, never stale",
        "- `npm start` — a script alias with no `start` script",
      ].join("\n"),
      root,
    );
    assert.deepEqual(stale, [
      "`npm run lint` — no `lint` script in package.json",
      "`pnpm run typecheck` — no `typecheck` script in package.json",
      "`make release` — no `release` target in the Makefile",
      "`./build.sh` — ./build.sh does not exist",
      "`npm start` — no `start` script in package.json",
    ]);
  });

  it("flags a package-manager command that contradicts the only lockfile, and only then", () => {
    const npmRepo = mkProject({ "package-lock.json": "{}" });
    assert.equal(
      findGuidelinePmMismatch("- `pnpm install` then `pnpm test`", npmRepo),
      "says `pnpm` but the repo uses npm (its lockfile is the only one)",
    );
    assert.equal(findGuidelinePmMismatch("- `npm test` and `npx tsc`", npmRepo), null);
    // Two lockfiles: ambiguous, not the file's defect.
    const both = mkProject({ "package-lock.json": "{}", "pnpm-lock.yaml": "" });
    assert.equal(findGuidelinePmMismatch("- `pnpm test`", both), null);
    // No lockfile: nothing to contradict.
    const none = mkProject({});
    assert.equal(findGuidelinePmMismatch("- `yarn test`", none), null);
  });

  it("recognises commands by repo scripts and targets, not only a runner list", () => {
    const root = mkProject(
      { Makefile: "ship:\n\techo ok\n" },
      { pkg: '{"name":"x","scripts":{"verify":"node v.js"}}' },
    );
    assert.equal(guidelineHasCommands("Run `verify --all` before pushing.", root), true);
    assert.equal(guidelineHasCommands("Run `ship prod`.", root), true);
    assert.equal(guidelineHasCommands("Use `bazel test //...` for everything.", root), true);
    assert.equal(guidelineHasCommands("Be kind. Write tests. See `ForgeConfig`.", root), false);
  });

  it("flags rules that fight verification, not benign safety rules", () => {
    assert.deepEqual(
      detectGuidelineConflicts("Never run the tests locally. Ask permission before every edit."),
      ["forbids running tests/checks", "asks permission before every edit"],
    );
    assert.deepEqual(detectGuidelineConflicts("Never push to main. Never commit secrets."), []);
    assert.deepEqual(
      detectGuidelineConflicts("Never run the tests against production."),
      [],
      "a scoped prohibition is a safety rule",
    );
  });

  it("classes: paths, commands, pm, clipped and empty are facts; long, conflict, no-commands are doctrine", () => {
    for (const k of ["stale-paths", "stale-commands", "pm-mismatch", "clipped", "empty"] as const) {
      assert.equal(issueClass(k), "fact");
    }
    for (const k of ["long", "conflict", "no-commands"] as const) {
      assert.equal(issueClass(k), "doctrine");
    }
  });
});

describe("surveyGuidelines — evidence trigger", () => {
  let home = "";
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-home-survey-"));
    process.env.FORGE_HOME = home;
  });

  it("a clean unstamped file does not need an audit; a fact defect always does", () => {
    // Under the old calendar trigger every unstamped file was briefed, so a
    // perfectly good AGENTS.md cost the first turn of every new repo. The
    // trigger is evidence now: nothing wrong, nothing to do.
    const clean = surveyGuidelines(mkProject({ "AGENTS.md": GOOD }));
    assert.equal(clean.files[0].freshness, "never");
    assert.deepEqual(clean.files[0].issues, []);
    assert.equal(clean.needsAudit, false);

    const dead = surveyGuidelines(mkProject({ "AGENTS.md": DEAD_PATH }));
    assert.deepEqual(
      dead.files[0].issues.map((i) => [i.kind, i.class]),
      [["stale-paths", "fact"]],
    );
    assert.equal(dead.needsAudit, true);

    // A stamp does not silence a fact defect: the path went dead after the
    // proofread, and that is exactly when the map needs fixing.
    const stampedDead = surveyGuidelines(mkProject({ "AGENTS.md": applyGuidelineStamp(DEAD_PATH) }));
    assert.equal(stampedDead.files[0].freshness, "fresh");
    assert.equal(stampedDead.needsAudit, true);
  });

  it("doctrine on a fresh stamp is quiet; on an edited or never-stamped body it briefs", () => {
    const conflict = "# AGENTS.md\n\nNever run the tests.\n\n- `npm test`\n";
    // Never stamped + doctrine issue → brief (the model proposes).
    const never = surveyGuidelines(mkProject({ "AGENTS.md": conflict }));
    assert.deepEqual(never.files[0].issues.map((i) => i.class), ["doctrine"]);
    assert.equal(never.needsAudit, true);
    // Stamped at this hash with only doctrine issues → seen already, quiet.
    const fresh = surveyGuidelines(mkProject({ "AGENTS.md": applyGuidelineStamp(conflict) }));
    assert.equal(fresh.files[0].freshness, "fresh");
    assert.equal(fresh.needsAudit, false, "doctrine never nags a proofread file");
    // Edited since the stamp (registry hash differs) → briefed again.
    const root = mkProject({ "AGENTS.md": applyGuidelineStamp(conflict) });
    const s0 = surveyGuidelines(root);
    stampGuidelinesNow(root);
    fs.writeFileSync(path.join(root, "AGENTS.md"), applyGuidelineStamp(`${conflict}\nAnd be brief.\n`));
    const edited = surveyGuidelines(root);
    assert.equal(edited.files[0].freshness, "edited");
    assert.equal(edited.needsAudit, true);
    assert.notEqual(edited.files[0].hash, s0.files[0].hash);
  });

  it("'clipped' is the prompt's own arithmetic: a lone 20k file fits, two 20k files do not", () => {
    const big = `# AGENTS.md\n\n- \`npm test\`\n\n## Layout\n\n${"x".repeat(20_000)}\n`;
    const lone = mkProject({ "AGENTS.md": big });
    const s1 = surveyGuidelines(lone);
    assert.equal(ruleFileBudget(1), 28_000);
    assert.deepEqual(s1.files[0].issues.filter((i) => i.kind === "clipped"), []);
    assert.equal(loadProjectRulesReport(lone).files[0].clipped, false);

    const two = mkProject({ "AGENTS.md": big, "CLAUDE.md": big });
    const s2 = surveyGuidelines(two);
    const clipped = s2.files.filter((f) => f.issues.some((i) => i.kind === "clipped"));
    assert.equal(clipped.length, 2, "both files compete for 14k each");
    assert.match(clipped[0].issues[0].detail, /over the 14,000-char share the prompt can load/);
    assert.equal(loadProjectRulesReport(two).files.every((f) => f.clipped), true);
    assert.equal(GUIDELINE_MANUAL_CHARS, RULES_PER_FILE_CHARS);
  });

  it("/guidelines stamp acknowledges the current issues so they stay quiet until the body changes", () => {
    const root = mkProject({ "AGENTS.md": DEAD_PATH });
    assert.equal(surveyGuidelines(root).needsAudit, true);
    assert.deepEqual(stampGuidelinesNow(root), ["AGENTS.md"]);
    const after = surveyGuidelines(root);
    assert.equal(after.needsAudit, false, "the user's override has to override");
    assert.equal(after.files[0].acknowledged, 1);
    assert.deepEqual(after.files[0].issues, []);
    // Edit the body → the acknowledgement is spent.
    fs.appendFileSync(path.join(root, "AGENTS.md"), "\n- `src/also/gone.ts`\n");
    const edited = surveyGuidelines(root);
    assert.equal(edited.needsAudit, true);
    assert.equal(edited.files[0].acknowledged, 0);
  });

  it("a missing primary file is flagged; an import-only CLAUDE.md is fine", () => {
    const s = surveyGuidelines(mkProject({ "CLAUDE.md": "@AGENTS.md\n" }));
    assert.equal(s.missingPrimary, true);
    assert.equal(s.needsAudit, true);
    assert.match(formatGuidelineAuditBrief(s), /AGENTS\.md — missing\. Write a short one/);
    const withAgents = surveyGuidelines(mkProject({ "AGENTS.md": GOOD, "CLAUDE.md": "@AGENTS.md\n" }));
    assert.equal(withAgents.files.find((f) => f.rel === "CLAUDE.md")?.freshness, "import");
    assert.equal(withAgents.needsAudit, false);
  });

  it("names ~/.forge/AGENTS.md when that is what steers, instead of only reporting a hole", () => {
    const globalAbs = path.join(home, "AGENTS.md");
    fs.writeFileSync(globalAbs, "# my own map\n\nAlways use pnpm.\n");
    const repo = mkProject({});
    assert.deepEqual(listProjectRulePaths(repo).filter((p) => p.endsWith("AGENTS.md")), [globalAbs]);
    const s = surveyGuidelines(repo);
    assert.equal(s.missingPrimary, true);
    assert.equal(s.globalFallback, globalAbs);
    assert.deepEqual(s.files.map((f) => f.abs), []);
    assert.equal(formatGuidelineStatusLine(s), "AGENTS.md missing · ~/.forge/AGENTS.md steers instead");
    assert.match(formatGuidelineAuditBrief(s), /~\/\.forge\/AGENTS\.md is steering this session in the meantime/);
    assert.match(formatGuidelineAuditBrief(s), /Do not edit it\./);
    assert.match(formatGuidelineCard({ workspace: repo }), /~\/\.forge\/AGENTS\.md steers meanwhile/);
    assert.equal(surveyGuidelines(mkProject({ "AGENTS.md": GOOD })).globalFallback, null);
  });

  it("the audited set and the loaded set differ only by the two documented differences", () => {
    const prompt = new Set<string>(PROMPT_RULE_FILES);
    const audit = new Set<string>(GUIDELINE_FILES);
    assert.deepEqual(
      [...audit].filter((n) => !prompt.has(n)).sort(),
      [...AUDIT_ONLY_GUIDELINE_FILES].sort(),
    );
    assert.deepEqual([...prompt].filter((n) => !audit.has(n)), []);

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
    assert.ok(loaded.size > 6 && audited.size > 6);
    const auditedNotLoaded = [...audited].filter((p) => !loaded.has(p)).map((p) => path.basename(p)).sort();
    assert.deepEqual(
      [...new Set(auditedNotLoaded)],
      [...new Set([...AUDIT_ONLY_GUIDELINE_FILES].map((n) => path.basename(n)))].sort(),
    );
    assert.deepEqual([...loaded].filter((p) => !audited.has(p)), []);
    assert.equal(survey.globalFallback, null);
  });

  it("the registry key is the project's realpath, not a second copy per symlink", () => {
    const repo = mkProject({ "AGENTS.md": GOOD });
    const link = `${repo}-link`;
    fs.symlinkSync(repo, link);
    try {
      assert.equal(guidelineRegistryPath(resolveGuidelineRoot(link)), guidelineRegistryPath(resolveGuidelineRoot(repo)));
      assert.equal(
        path.dirname(guidelineProposalPath(resolveGuidelineRoot(link), "AGENTS.md")),
        path.dirname(guidelineProposalPath(resolveGuidelineRoot(repo), "AGENTS.md")),
      );
    } finally {
      fs.unlinkSync(link);
    }
  });

  it("a scratch directory is not a project", () => {
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
    const repo = mkProject({
      "AGENTS.md": GOOD,
      "packages/api/AGENTS.md": "# api\n\nNever run the tests.\n\n## Commands\n\n- `npm test`\n",
    });
    const ws = path.join(repo, "packages", "api");
    const nested = path.resolve(ws, "AGENTS.md");
    assert.deepEqual(listProjectRulePaths(ws).filter((p) => p.endsWith("AGENTS.md")), [nested]);
    const s = surveyGuidelines(ws);
    assert.equal(s.root, path.resolve(repo));
    assert.deepEqual(s.files.map((f) => f.rel), [path.join("packages", "api", "AGENTS.md")]);
    assert.equal(s.files[0].primary, true);
    assert.deepEqual(
      s.files[0].issues.filter((i) => i.kind === "conflict").map((i) => i.detail),
      ["forbids running tests/checks"],
    );
    assert.equal(s.needsAudit, true);
    assert.match(formatGuidelineAuditBrief(s), /packages[/\\]api[/\\]AGENTS\.md — .* forbids running tests\/checks/);
  });
});

describe("guideline rendering", () => {
  it("describe separates defects from doctrine and states the size once", () => {
    const root = mkProject({
      "AGENTS.md": `# AGENTS.md\n\nNever run the tests.\n\n- \`npm test\`\n- \`src/gone.ts\`\n`,
    });
    const f = surveyGuidelines(root).files[0];
    const line = describeGuidelineFile(f);
    assert.match(line, /^AGENTS\.md — \d+ chars \/ \d+ lines — never proofread — defects: 1 path no longer exists: src\/gone\.ts — doctrine: forbids running tests\/checks$/);
    assert.equal((line.match(/chars/g) || []).length, 1);
    const status = formatGuidelineStatusLine(surveyGuidelines(root));
    assert.equal(status, "AGENTS.md never proofread · 1 defect · 1 doctrine");
  });

  it("the brief has a Fix-now section for facts and a Propose section for doctrine, naming the proposal path", () => {
    const root = mkProject({
      "AGENTS.md": `# AGENTS.md\n\nNever run the tests.\n\n- \`npm test\`\n- \`src/gone.ts\`\n`,
    });
    const s = surveyGuidelines(root);
    const brief = formatGuidelineAuditBrief(s);
    assert.ok(brief.startsWith(GUIDELINE_BRIEF_PREFIX));
    assert.match(brief, /Fix now — factual defects \(edit the file directly; you are authorised\):\n {2}• AGENTS\.md: 1 path no longer exists: src\/gone\.ts/);
    assert.match(brief, /Propose — doctrine \(judgement, so it is the user's call\):\n {2}• AGENTS\.md: forbids running tests\/checks\n {4}proposal file: .*AGENTS\.md\.proposed\.md/);
    assert.match(brief, /Do NOT edit the tracked file for doctrine/);
    assert.match(brief, /Do not write the proofread stamp yourself/);
    assert.doesNotMatch(brief, /whatever they say/, "no blanket authority to rewrite the user's instructions");
  });
});

describe("session audit flow", () => {
  let home = "";
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-home-guide-"));
    process.env.FORGE_HOME = home;
    delete process.env.FORGE_GUIDELINE_AUDIT;
    clearGuidelineAuditState();
  });
  afterEach(() => {
    clearGuidelineAuditState();
  });

  it("briefs once as a synthetic user message; a clean file is not briefed at all", () => {
    const root = mkProject({ "AGENTS.md": DEAD_PATH });
    const brief = maybeGuidelineAuditBrief({ sessionId: "s1", workspace: root });
    assert.ok(brief, "expected a brief for a fact defect");
    assert.ok(brief!.startsWith(GUIDELINE_BRIEF_PREFIX));
    assert.ok(isSyntheticUserMessage({ role: "user", content: brief! }));
    assert.match(brief!, /AGENTS\.md — .* never proofread — defects: 1 path no longer exists/);
    assert.equal(maybeGuidelineAuditBrief({ sessionId: "s1", workspace: root }), null);
    assert.equal(guidelineAuditBriefed("s1"), true);

    const clean = mkProject({ "AGENTS.md": GOOD });
    assert.equal(maybeGuidelineAuditBrief({ sessionId: "s1b", workspace: clean }), null);
    assert.equal(guidelineAuditBriefed("s1b"), false);
  });

  it("defers while read-only, skips subagents and the kill-switch", () => {
    const root = mkProject({ "AGENTS.md": DEAD_PATH });
    assert.equal(maybeGuidelineAuditBrief({ sessionId: "s2", workspace: root, readOnly: true }), null);
    assert.equal(guidelineAuditBriefed("s2"), false);
    assert.ok(maybeGuidelineAuditBrief({ sessionId: "s2", workspace: root }));
    assert.equal(maybeGuidelineAuditBrief({ sessionId: "s3", workspace: root, subagent: true }), null);
    process.env.FORGE_GUIDELINE_AUDIT = "0";
    assert.equal(maybeGuidelineAuditBrief({ sessionId: "s5", workspace: root }), null);
  });

  it("finalize stamps a file whose fact defect the model fixed, reports the revision, records the registry", () => {
    const root = mkProject({ "AGENTS.md": DEAD_PATH, "CLAUDE.md": "@AGENTS.md\n" });
    assert.ok(maybeGuidelineAuditBrief({ sessionId: "s6", workspace: root }));
    noteGuidelineToolCall("s6", "read_file", { path: path.join(root, "AGENTS.md") });
    fs.writeFileSync(path.join(root, "AGENTS.md"), GOOD);
    const r = finalizeGuidelineAudit({ sessionId: "s6", workspace: root });
    assert.equal(r.skipped, false);
    assert.deepEqual(r.stamped, ["AGENTS.md"]);
    assert.equal(r.revised.length, 1);
    assert.deepEqual(r.ignored, []);
    assert.deepEqual(r.unresolved, []);
    const text = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
    assert.match(text, /^<!-- proofread \d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z · forge -->\n/);
    const notice = formatGuidelineAuditNotice(r);
    assert.equal(notice.length, 1);
    assert.match(notice[0], /AGENTS\.md revised by the agent \(\d+ → \d+ lines/);
    const reg = loadGuidelineRegistry(root);
    assert.ok(reg.files["AGENTS.md"].stampedAt);
    assert.ok(reg.files["AGENTS.md"].revisedAt);
    assert.equal(reg.lastAuditSession, "s6");
    const again = finalizeGuidelineAudit({ sessionId: "s6", workspace: root });
    assert.deepEqual(again, { ...r, repeat: true });
    clearGuidelineAuditState();
    assert.equal(maybeGuidelineAuditBrief({ sessionId: "s7", workspace: root }), null);
  });

  it("finalize does not stamp a file the model ignored, and says so — no Stop block", () => {
    const root = mkProject({ "AGENTS.md": DEAD_PATH });
    assert.ok(maybeGuidelineAuditBrief({ sessionId: "s8", workspace: root }));
    const r = finalizeGuidelineAudit({ sessionId: "s8", workspace: root });
    assert.deepEqual(r.stamped, []);
    assert.deepEqual(r.ignored, ["AGENTS.md"]);
    assert.doesNotMatch(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"), /proofread/);
    const n = formatGuidelineAuditNotice(r);
    assert.equal(n.length, 1);
    assert.match(n[0], /not checked this session \(brief ignored\) — re-briefs next prompt/);
  });

  it("a fact defect left in place is not stamped; the notice names it and offers the acknowledge path", () => {
    const root = mkProject({ "AGENTS.md": DEAD_PATH });
    assert.ok(maybeGuidelineAuditBrief({ sessionId: "s13", workspace: root }));
    noteGuidelineToolCall("s13", "bash", { command: "cat AGENTS.md" });
    const r = finalizeGuidelineAudit({ sessionId: "s13", workspace: root });
    assert.deepEqual(r.stamped, []);
    assert.equal(r.unresolved.length, 1);
    assert.deepEqual(r.unresolved[0].issues, ["1 path no longer exists: src/gone/missing.ts"]);
    const n = formatGuidelineAuditNotice(r);
    assert.equal(n.length, 1);
    assert.match(n[0], /^Agent guidelines: AGENTS\.md checked but not stamped — 1 path no longer exists: src\/gone\/missing\.ts\. Re-briefs next prompt \(\/guidelines stamp to acknowledge\)$/);
    clearGuidelineAuditState();
    assert.ok(maybeGuidelineAuditBrief({ sessionId: "s14", workspace: root }));
  });

  it("doctrine never withholds the stamp: a looked-at conflict file with clean facts is stamped", () => {
    const conflict = "# AGENTS.md\n\nNever run the tests.\n\n- `npm test`\n";
    const root = mkProject({ "AGENTS.md": conflict });
    assert.ok(maybeGuidelineAuditBrief({ sessionId: "d1", workspace: root }));
    noteGuidelineToolCall("d1", "read_file", { path: "AGENTS.md" });
    const r = finalizeGuidelineAudit({ sessionId: "d1", workspace: root });
    assert.deepEqual(r.stamped, ["AGENTS.md"]);
    assert.deepEqual(r.unresolved, []);
    assert.match(formatGuidelineAuditNotice(r)[0], /checked, no defects — stamp updated/);
    // And now quiet: fresh + doctrine only.
    clearGuidelineAuditState();
    assert.equal(maybeGuidelineAuditBrief({ sessionId: "d2", workspace: root }), null);
  });

  it("a doctrine proposal is parked outside the repo; /guidelines diff · apply · discard operate on it", () => {
    const conflict = "# AGENTS.md\n\nNever run the tests.\n\n- `npm test`\n";
    const root = mkProject({ "AGENTS.md": conflict });
    assert.ok(maybeGuidelineAuditBrief({ sessionId: "p1", workspace: root }));
    const proposal = guidelineProposalPath(root, "AGENTS.md");
    assert.ok(!proposal.startsWith(root), "the proposal lives beside the registry, not in the tree");
    // The model writes the pruned version to the proposal path.
    fs.mkdirSync(path.dirname(proposal), { recursive: true });
    fs.writeFileSync(proposal, "# AGENTS.md\n\n- `npm test`\n");
    noteGuidelineToolCall("p1", "write_file", { path: proposal, content: "…" });
    const r = finalizeGuidelineAudit({ sessionId: "p1", workspace: root });
    assert.equal(r.proposals.length, 1);
    assert.equal(r.proposals[0].rel, "AGENTS.md");
    assert.deepEqual(r.applied, []);
    // The tracked file is untouched except for the stamp (facts were clean).
    assert.equal(stripGuidelineStamp(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8")), conflict.trimEnd());
    assert.match(formatGuidelineAuditNotice(r).join("\n"), /doctrine proposal written .* \/guidelines diff to review · \/guidelines apply to accept/);
    // Survey and card see it.
    assert.equal(surveyGuidelines(root).files[0].proposalPath, proposal);
    assert.match(formatGuidelineCard({ workspace: root }), /proposal: AGENTS\.md →/);
    assert.equal(listGuidelineProposals(root).length, 1);
    assert.match(formatGuidelineProposalDiff(root), /-Never run the tests\./);
    // Apply: journaled, stamped, proposal gone.
    const landed = applyGuidelineProposals({ workspace: root, sessionId: "p1", turn: 3 });
    assert.equal(landed.length, 1);
    const after = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
    assert.doesNotMatch(after, /Never run the tests/);
    assert.match(after, /proofread/);
    assert.equal(fs.existsSync(proposal), false);
    const journal = readFileMutations("p1");
    assert.equal(journal.length, 1);
    assert.equal(journal[0].kind, "update");
    assert.match(journal[0].before || "", /Never run the tests/);
    assert.equal(listGuidelineProposals(root).length, 0);
    assert.equal(formatGuidelineProposalDiff(root), "No guideline proposal is pending.");
    // Discard path.
    fs.writeFileSync(proposal, "# AGENTS.md\n\n- `npm test`\n\nsomething else\n");
    const reg = loadGuidelineRegistry(root);
    reg.files["AGENTS.md"].proposal = { path: proposal, hash: "x", at: "now" };
    fs.writeFileSync(guidelineRegistryPath(root), JSON.stringify(reg));
    assert.equal(listGuidelineProposals(root).length, 1);
    assert.deepEqual(discardGuidelineProposals(root), ["AGENTS.md"]);
    assert.equal(fs.existsSync(proposal), false);
  });

  it("autoApply lands the proposal directly, journaled for /undo, and the notice says so", () => {
    const conflict = "# AGENTS.md\n\nNever run the tests.\n\n- `npm test`\n";
    const root = mkProject({ "AGENTS.md": conflict });
    assert.ok(maybeGuidelineAuditBrief({ sessionId: "a1", workspace: root, autoApply: true }));
    const proposal = guidelineProposalPath(root, "AGENTS.md");
    fs.mkdirSync(path.dirname(proposal), { recursive: true });
    fs.writeFileSync(proposal, "# AGENTS.md\n\n- `npm test`\n");
    noteGuidelineToolCall("a1", "write_file", { path: proposal, content: "…" });
    const r = finalizeGuidelineAudit({ sessionId: "a1", workspace: root, autoApply: true, turn: 2 });
    assert.equal(r.applied.length, 1);
    assert.deepEqual(r.proposals, []);
    assert.deepEqual(r.stamped, ["AGENTS.md"]);
    assert.doesNotMatch(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"), /Never run the tests/);
    assert.equal(fs.existsSync(proposal), false);
    assert.equal(readFileMutations("a1").length, 1);
    assert.match(formatGuidelineAuditNotice(r).join("\n"), /doctrine proposal applied \(guidelineAutoApply; .*\) — stamped; \/undo reverts/);
  });

  it("a proposal identical to the tracked file is dropped, not announced", () => {
    const conflict = "# AGENTS.md\n\nNever run the tests.\n\n- `npm test`\n";
    const root = mkProject({ "AGENTS.md": conflict });
    assert.ok(maybeGuidelineAuditBrief({ sessionId: "p2", workspace: root }));
    const proposal = guidelineProposalPath(root, "AGENTS.md");
    fs.mkdirSync(path.dirname(proposal), { recursive: true });
    fs.writeFileSync(proposal, conflict);
    noteGuidelineToolCall("p2", "write_file", { path: proposal, content: conflict });
    const r = finalizeGuidelineAudit({ sessionId: "p2", workspace: root });
    assert.deepEqual(r.proposals, []);
    assert.equal(fs.existsSync(proposal), false);
    assert.deepEqual(r.stamped, ["AGENTS.md"]);
  });

  it("a same-named file elsewhere is not a look — the stamp has to be earned", () => {
    const root = mkProject({
      "AGENTS.md": DEAD_PATH,
      ".forge/rules.md": "# rules\n\n- `npm test`\n- `src/nope.ts`\n",
      "docs/rules.md": "# unrelated docs\n",
    });
    assert.ok(maybeGuidelineAuditBrief({ sessionId: "s12", workspace: root }));
    noteGuidelineToolCall("s12", "read_file", { path: path.join(root, "docs/rules.md") });
    noteGuidelineToolCall("s12", "read_file", { path: path.join(root, "AGENTS.md") });
    fs.writeFileSync(path.join(root, "AGENTS.md"), GOOD);
    const r = finalizeGuidelineAudit({ sessionId: "s12", workspace: root });
    assert.deepEqual(r.stamped, ["AGENTS.md"]);
    assert.deepEqual(r.ignored, [".forge/rules.md"]);
    assert.doesNotMatch(fs.readFileSync(path.join(root, ".forge/rules.md"), "utf8"), /proofread/);
  });

  it("a mention is not a look — grep, an out-of-tree twin, and a body that names the file", () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "forge-guide-other-"));
    fs.writeFileSync(path.join(other, "AGENTS.md"), "# someone else's map\n");
    const root = mkProject({ "AGENTS.md": DEAD_PATH, "docs/notes.md": "see AGENTS.md\n" });
    assert.ok(maybeGuidelineAuditBrief({ sessionId: "s15", workspace: root }));
    noteGuidelineToolCall("s15", "grep", { pattern: "AGENTS.md" });
    noteGuidelineToolCall("s15", "grep", { pattern: "harness", path: "AGENTS.md" });
    noteGuidelineToolCall("s15", "glob", { pattern: "**/AGENTS.md" });
    noteGuidelineToolCall("s15", "read_file", { path: path.join(other, "AGENTS.md") });
    noteGuidelineToolCall("s15", "bash", { command: "cat docs/notes.md | grep AGENTS.md" });
    noteGuidelineToolCall("s15", "write_file", { path: "docs/notes.md", content: "AGENTS.md is the map.\n" });
    const r = finalizeGuidelineAudit({ sessionId: "s15", workspace: root });
    assert.deepEqual(r.stamped, []);
    assert.deepEqual(r.ignored, ["AGENTS.md"]);
    assert.doesNotMatch(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"), /proofread/);
    assert.doesNotMatch(fs.readFileSync(path.join(other, "AGENTS.md"), "utf8"), /proofread/);
  });

  it("an advisory prompt defers the brief without ever skipping it", () => {
    const root = mkProject({ "AGENTS.md": DEAD_PATH });
    assert.equal(
      maybeGuidelineAuditBrief({ sessionId: "adv1", workspace: root, lastUserMessage: "what does this repo do?" }),
      null,
    );
    assert.equal(guidelineAuditBriefed("adv1"), false);
    const brief = maybeGuidelineAuditBrief({ sessionId: "adv1", workspace: root, lastUserMessage: "add a streaming importer" });
    assert.ok(brief);
    assert.ok(brief!.startsWith(GUIDELINE_BRIEF_PREFIX));
  });

  it("an advisory turn does not stamp the user's tracked file", () => {
    const root = mkProject({ "AGENTS.md": DEAD_PATH });
    assert.ok(maybeGuidelineAuditBrief({ sessionId: "adv3", workspace: root, lastUserMessage: "add a streaming importer" }));
    noteGuidelineToolCall("adv3", "read_file", { path: "AGENTS.md" });
    fs.writeFileSync(path.join(root, "AGENTS.md"), GOOD);
    const skipped = finalizeGuidelineAudit({ sessionId: "adv3", workspace: root, lastUserMessage: "what does this repo do?" });
    assert.equal(skipped.skipped, true);
    assert.doesNotMatch(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"), /proofread/);
    const done = finalizeGuidelineAudit({ sessionId: "adv3", workspace: root, lastUserMessage: "add a streaming importer" });
    assert.deepEqual(done.stamped, ["AGENTS.md"]);
  });

  it("the run report announces the audit for the run that ran it, and not after", () => {
    const root = mkProject({ "AGENTS.md": DEAD_PATH });
    assert.ok(maybeGuidelineAuditBrief({ sessionId: "rep2", workspace: root }));
    noteGuidelineToolCall("rep2", "read_file", { path: "AGENTS.md" });
    fs.writeFileSync(path.join(root, "AGENTS.md"), GOOD);
    finalizeGuidelineAudit({ sessionId: "rep2", workspace: root });
    const own = formatGuidelineReportLines({ sessionId: "rep2", workspace: root });
    assert.match(own.join("\n"), /revised by the agent/);
    finalizeGuidelineAudit({ sessionId: "rep2", workspace: root });
    const later = formatGuidelineReportLines({ sessionId: "rep2", workspace: root });
    assert.doesNotMatch(later.join("\n"), /stamp updated|revised by the agent/);
    assert.deepEqual(later, [formatGuidelineStatusLine(surveyGuidelines(root))]);
  });

  it("/guidelines stamp stamps every non-import file", () => {
    const root = mkProject({ "AGENTS.md": GOOD, "CLAUDE.md": "@AGENTS.md\n" });
    assert.deepEqual(stampGuidelinesNow(root), ["AGENTS.md"]);
    assert.match(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"), /proofread/);
    assert.doesNotMatch(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8"), /proofread/);
  });

  it("a long file is doctrine, so it can never nag: stamped on a look, quiet after", () => {
    const lines = Array.from({ length: GUIDELINE_MANUAL_LINES + 20 }, (_, i) => `- rule ${i}`).join("\n");
    const root = mkProject({ "AGENTS.md": `# AGENTS.md\n\n- \`npm test\`\n\n${lines}\n` });
    const s = surveyGuidelines(root);
    assert.deepEqual(s.files[0].issues.map((i) => [i.kind, i.class]), [["long", "doctrine"]]);
    assert.ok(maybeGuidelineAuditBrief({ sessionId: "l1", workspace: root }));
    noteGuidelineToolCall("l1", "read_file", { path: "AGENTS.md" });
    const r = finalizeGuidelineAudit({ sessionId: "l1", workspace: root });
    assert.deepEqual(r.stamped, ["AGENTS.md"]);
    clearGuidelineAuditState();
    assert.equal(maybeGuidelineAuditBrief({ sessionId: "l2", workspace: root }), null);
  });
});
