import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createSession, saveSession } from "../src/session/session.js";
import { appendFileMutation } from "../src/session/mutations.js";
import {
  buildRunReport,
  endedUnshaped,
  gitCommitCountSince,
  gitCommitsSince,
  maybeRenderRunReportForRun,
  operatorItemsFrom,
  renderRunReportAddendum,
  renderRunReportText,
  runReportPath,
  shouldPrintRunReport,
  statusHeadLines,
} from "../src/harness/run-report.js";
import { armUlwReady } from "./helpers/ulw-arm.js";
import { looksLikeRunReport } from "../src/harness/report-guard.js";

import { assembleStatusReport } from "../src/tui/status-card.js";

describe("run report", () => {
  beforeEach(() => {
    process.env.FORGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-home-rr-"));
  });

  it("plain run: outcome first, files changed, verify state, open todos, needs-you from Operator: lines", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "forge-rr-"));
    const s = createSession({ cwd, provider: "xai", model: "grok-4" });
    s.messages.push({ role: "user", content: "add expiry check to the session middleware" });
    s.meta.turnCount = 1;
    s.meta.editCount = 2;
    s.meta.lastVerificationCommand = "npm test";
    s.meta.lastVerificationAt = new Date().toISOString();
    s.meta.lastVerificationOk = true;
    s.todos = [
      { id: "t1", content: "wire the config flag", status: "pending" },
      { id: "t2", content: "done thing", status: "completed" },
    ];
    saveSession(s);
    appendFileMutation(s.meta.id, { path: path.join(cwd, "src/mw.ts"), kind: "update", turn: 1, before: "x" });
    appendFileMutation(s.meta.id, { path: path.join(cwd, "tests/mw.test.ts"), kind: "create", turn: 1 });

    const r = buildRunReport({
      session: s,
      workspace: cwd,
      noGit: true,
      guidelineLines: ["AGENTS.md revised by the agent (139 → 96 lines)"],
      result: { finalText: "Done.\nOperator: add STRIPE_KEY to .env — I cannot read it." },
    });
    assert.match(r.outcome, /^Done — 2 files changed, verified with `npm test`; 1 todo still open\.$/);
    assert.equal(r.request, "add expiry check to the session middleware");
    const titles = r.sections.map((x) => x.title);
    assert.deepEqual(titles, ["What shipped", "Verified", "Not done", "Agent guidelines", "Needs you", "Resume"]);
    const shipped = r.sections[0].lines.join("\n");
    assert.match(shipped, /2 files changed: src\/mw\.ts, tests\/mw\.test\.ts \(new\)/);
    assert.match(r.sections[1].lines[0], /`npm test` passed at/);
    assert.match(r.sections[2].lines[0], /Todo \(open\): wire the config flag/);
    assert.match(r.sections[3].lines[0], /AGENTS\.md revised/);
    assert.deepEqual(r.sections[4].lines, ["Operator: add STRIPE_KEY to .env — I cannot read it."]);
    assert.match(r.sections[5].lines[0], /forge --continue/);
    // Markdown: outcome line first, bold labels, bullets.
    assert.ok(r.markdown.startsWith(r.outcome));
    assert.match(r.markdown, /\n\*\*What shipped\*\*\n- /);
    // Facts for the report guard.
    assert.ok(r.facts.some((f) => /^Shipped: 2 files changed/.test(f)));
    // Status head.
    const head = statusHeadLines(r);
    assert.match(head[0], /^run      Done — 2 files changed/);
    assert.match(head[1], /^open     1 item: Todo \(open\): wire the config flag/);
    // 9-char label column, same as the card's `plan     ` row.
    assert.match(head[2], /^needs    Operator: add STRIPE_KEY/);
    const status = assembleStatusReport({ hud: "hud", detail: "detail", issues: [], runLines: head });
    assert.ok(status.split("\n")[1].startsWith("run      Done"));
  });

  it("unverified edits and a red check change the outcome; stale check is called out", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "forge-rr2-"));
    const s = createSession({ cwd, provider: "xai", model: "grok-4" });
    s.meta.turnCount = 1;
    s.meta.editCount = 1;
    saveSession(s);
    appendFileMutation(s.meta.id, { path: path.join(cwd, "a.ts"), kind: "update", turn: 1, before: "" });
    assert.match(buildRunReport({ session: s, workspace: cwd, noGit: true }).outcome, /^Done, unverified — 1 file changed, no check run\./);

    s.meta.lastVerificationCommand = "npm test";
    s.meta.lastVerificationOk = false;
    s.meta.lastVerificationAt = new Date().toISOString();
    const red = buildRunReport({ session: s, workspace: cwd, noGit: true });
    assert.match(red.outcome, /^Partly done — 1 file changed, but the last check `npm test` is RED\./);
    assert.ok(red.sections[2].lines.some((l) => /last check is red/.test(l)));

    s.meta.lastVerificationOk = true;
    s.meta.lastVerificationAt = "2020-01-01T00:00:00.000Z";
    s.meta.lastEditAt = new Date().toISOString();
    const stale = buildRunReport({ session: s, workspace: cwd, noGit: true });
    assert.match(stale.sections[1].lines[0], /files were edited afterwards/);
    assert.ok(stale.sections[2].lines.some((l) => /Re-run the last check/.test(l)));
  });

  it("answer-only run and stop reasons", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "forge-rr3-"));
    const s = createSession({ cwd, provider: "xai", model: "grok-4" });
    s.meta.turnCount = 1;
    saveSession(s);
    assert.equal(buildRunReport({ session: s, workspace: cwd, noGit: true }).outcome, "Answered — no files changed.");
    assert.match(
      buildRunReport({ session: s, workspace: cwd, noGit: true, result: { hitCostCap: true } }).outcome,
      /^Stopped at the spend cap/,
    );
    assert.match(
      buildRunReport({ session: s, workspace: cwd, noGit: true, result: { aborted: true } }).outcome,
      /^Aborted by the user/,
    );
  });

  it("ULW run: waves in What shipped, proof counts, open named ships and must-fix in Not done", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "forge-rr4-"));
    const s = createSession({ cwd, provider: "xai", model: "grok-4", ultrawork: true });
    s.meta.turnCount = 1;
    saveSession(s);
    const st = armUlwReady(s.meta.id, "improve the onboarding flow comprehensively");
    st.waves = [
      { wave: 1, editDelta: 3, proof: true, proofKind: "full", summary: "Welcome screen explains the three modes", ts: new Date().toISOString() },
      { wave: 2, editDelta: 2, proof: false, summary: "Keyboard hints on the first prompt", ts: new Date().toISOString() },
    ];
    st.namedShips = [
      { text: "resume card on relaunch", status: "open" },
      { text: "welcome screen", status: "done" },
    ];
    st.lastReflectHoles = ["1 wave(s) closed without successful proof."];
    st.fullSuitePassed = true;
    const { saveUlwCycle } = await import("../src/harness/ulw-cycle.js");
    saveUlwCycle(st);

    const r = buildRunReport({
      session: s,
      workspace: cwd,
      noGit: true,
      result: { lastCycleReleased: true, stopContinues: 4 },
    });
    assert.match(r.outcome, /^Done — ULW run complete: 2 waves shipped \(1 with proof\), 0 commits landed, 0 files changed\./);
    assert.equal(r.request, "improve the onboarding flow comprehensively");
    const shipped = r.sections[0].lines;
    assert.match(shipped[0], /^Wave 1 ✓ Welcome screen/);
    assert.match(shipped[1], /^Wave 2 ✗ Keyboard hints/);
    assert.match(r.sections[1].lines.join("\n"), /1 of 2 waves closed with proof; the full suite passed this run/);
    const notDone = r.sections[2].lines.join("\n");
    assert.match(notDone, /Named ship still open: resume card on relaunch/);
    assert.match(notDone, /Must-fix from LAST reflect: 1 wave\(s\) closed without successful proof/);
    assert.doesNotMatch(notDone, /welcome screen/);
    assert.ok(r.facts.some((f) => /4 harness rounds/.test(f)));

    // Sit-down keeps ULW on and says so in Resume.
    const sat = buildRunReport({ session: s, workspace: cwd, noGit: true, result: { lastCycleSatDown: true } });
    assert.match(sat.outcome, /^Paused — \/cycle 0 sat down/);
    assert.ok(sat.sections.find((x) => x.title === "Resume")!.lines.some((l) => /ULW/.test(l)));
  });

  it("ledger markdown does not leak into the report, and the commit count is the real one", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "forge-rr6-"));
    execFileSync("git", ["init", "-q", "."], { cwd });
    execFileSync("git", ["config", "user.email", "t@t.t"], { cwd });
    execFileSync("git", ["config", "user.name", "t"], { cwd });
    const since = new Date(Date.now() - 60_000).toISOString();
    for (let i = 0; i < 23; i++) {
      fs.writeFileSync(path.join(cwd, `f${i}.txt`), `${i}`);
      execFileSync("git", ["add", "-A"], { cwd });
      execFileSync("git", ["commit", "-qm", `commit ${i}`], { cwd });
    }
    assert.equal(gitCommitsSince(cwd, since).length, 20, "page is capped at 20");
    assert.equal(gitCommitCountSince(cwd, since), 23, "count is the real total");

    const s = createSession({ cwd, provider: "xai", model: "grok-4", ultrawork: true });
    s.meta.turnCount = 1;
    saveSession(s);
    const st = armUlwReady(s.meta.id, "**Improve** the `importer` comprehensively");
    st.startedAt = since;
    st.waves = [
      {
        wave: 1,
        editDelta: 3,
        proof: true,
        proofKind: "full",
        // Real ledgers hold orphan bold from the closer's own markdown.
        summary: "** CLI `together run` cannot force a writer",
        ts: new Date().toISOString(),
      },
    ];
    st.namedShips = [{ text: "- **resume card** on relaunch", status: "open" }];
    const { saveUlwCycle } = await import("../src/harness/ulw-cycle.js");
    saveUlwCycle(st);

    const r = buildRunReport({
      session: s,
      workspace: cwd,
      result: { lastCycleReleased: true },
    });
    assert.equal(r.request, "Improve the importer comprehensively");
    assert.match(r.outcome, /23 commits landed/);
    const shipped = r.sections[0].lines.join("\n");
    assert.match(shipped, /^Wave 1 ✓ CLI together run cannot force a writer$/m);
    assert.doesNotMatch(shipped, /\*\*/);
    assert.match(shipped, /23 commits since the request/);
    assert.match(shipped, /\+15 more/, "shows the page, counts the total");
    assert.match(
      r.sections[2].lines.join("\n"),
      /Named ship still open: resume card on relaunch/,
    );
  });

  it("shouldPrintRunReport: driver ends and multi-round edits, not single-round chats; render persists report.md", () => {
    assert.equal(shouldPrintRunReport({ stopContinues: 0, editCount: 3 }), false);
    assert.equal(shouldPrintRunReport({ stopContinues: 2, editCount: 3 }), true);
    assert.equal(shouldPrintRunReport({ stopContinues: 5, editCount: 0 }), false);
    assert.equal(shouldPrintRunReport({ lastCycleReleased: true }), true);
    assert.equal(shouldPrintRunReport({ lastCycleSatDown: true }), true);
    assert.equal(shouldPrintRunReport({ hitCostCap: true }), true);
    assert.equal(shouldPrintRunReport({ lastCycleReleased: true, aborted: true }), false);

    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "forge-rr5-"));
    const s = createSession({ cwd, provider: "xai", model: "grok-4" });
    s.meta.turnCount = 1;
    s.meta.editCount = 1;
    saveSession(s);
    assert.equal(
      maybeRenderRunReportForRun({ session: s, workspace: cwd, result: { stopContinues: 0 } }),
      null,
    );
    const text = maybeRenderRunReportForRun({ session: s, workspace: cwd, result: { stopContinues: 3 } });
    assert.ok(text);
    assert.match(text!, /^Done, unverified|^Answered/);
    assert.match(text!, /\nWhat shipped\n  - /);
    assert.ok(fs.existsSync(runReportPath(s.meta.id)));
    assert.match(fs.readFileSync(runReportPath(s.meta.id), "utf8"), /\*\*Needs you\*\*/);
    const colored = renderRunReportText(buildRunReport({ session: s, workspace: cwd, noGit: true }), { color: true });
    assert.match(colored, /\x1b\[1m/);
  });

  it("one report per run: a report-shaped closer gets the addendum, not a second copy", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "forge-rr7-"));
    const s = createSession({ cwd, provider: "xai", model: "grok-4" });
    s.meta.turnCount = 1;
    s.meta.editCount = 3;
    saveSession(s);
    appendFileMutation(s.meta.id, {
      path: path.join(cwd, "a.ts"),
      kind: "update",
      turn: 1,
      before: "",
    });
    const closer = `**Cycle complete.**

Done — the importer streams now and 3 waves shipped since the mandate.

**What shipped**
- Streaming importer.

**Verified**
- \`npm test\` passed.

**Needs you**
- Nothing.`;

    const addendum = maybeRenderRunReportForRun({
      session: s,
      workspace: cwd,
      result: { lastCycleReleased: true, stopContinues: 9, finalText: closer },
    });
    assert.ok(addendum, "the harness still speaks");
    // None of the model's four headings are repeated.
    for (const h of ["What shipped", "Verified", "Not done", "Needs you"]) {
      assert.doesNotMatch(addendum!, new RegExp(`\\n${h}\\n`), `${h} repeated`);
    }
    assert.doesNotMatch(addendum!, /^Done —/m, "the outcome line is not repeated");
    // What the model could not know is still said.
    assert.match(addendum!, /resume {6}Session /);
    assert.match(addendum!, /saved {7}.*report\.md/);
    // report.md still holds the full report for /report and --json.
    assert.match(
      fs.readFileSync(runReportPath(s.meta.id), "utf8"),
      /\*\*What shipped\*\*/,
    );

    // A closer that is not a report still gets the full card.
    const full = maybeRenderRunReportForRun({
      session: s,
      workspace: cwd,
      result: { lastCycleReleased: true, stopContinues: 9, finalText: "Fixed the nit." },
    });
    assert.match(full!, /\nWhat shipped\n {2}- /);
    assert.match(full!, /\nNeeds you\n/);
    // …and `full: true` forces it even behind a good closer.
    const forced = maybeRenderRunReportForRun({
      session: s,
      workspace: cwd,
      result: { lastCycleReleased: true, stopContinues: 9, finalText: closer },
      full: true,
    });
    assert.match(forced!, /\nWhat shipped\n {2}- /);
  });

  it("an ending no guard shaped always gets the full card, whatever the closer looked like", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "forge-rr9-"));
    const s = createSession({ cwd, provider: "xai", model: "grok-4" });
    s.meta.turnCount = 1;
    s.meta.editCount = 4;
    saveSession(s);
    appendFileMutation(s.meta.id, {
      path: path.join(cwd, "a.ts"),
      kind: "update",
      turn: 1,
      before: "",
    });
    // Two labels and a four-word line is all looksLikeRunReport needs, and a
    // mid-work message can pass it by accident.
    const accidental = "## Summary\nStill tracing the importer regression.\n\n## Next\n- keep going";
    assert.equal(looksLikeRunReport(accidental), true, "the heuristic passes it");

    for (const ending of [
      { stuckReleased: true },
      { hitCostCap: true },
      { hitMaxTurns: true },
      { releasedOnContinueCap: true, stopContinues: 9 },
    ]) {
      assert.equal(endedUnshaped(ending), true, JSON.stringify(ending));
      const card = maybeRenderRunReportForRun({
        session: s,
        workspace: cwd,
        result: { ...ending, finalText: accidental },
      });
      assert.ok(card, JSON.stringify(ending));
      // The reason the run ended is in Not done — it must not be suppressed.
      assert.match(card!, /\nWhat shipped\n {2}- /, JSON.stringify(ending));
      assert.match(card!, /\nNot done\n {2}- /, JSON.stringify(ending));
    }

    // A driver end whose attestation the guard did shape still gets the addendum.
    assert.equal(endedUnshaped({ lastCycleReleased: true } as never), false);
    const addendum = maybeRenderRunReportForRun({
      session: s,
      workspace: cwd,
      result: { lastCycleReleased: true, stopContinues: 9, finalText: accidental },
    });
    assert.doesNotMatch(addendum!, /\nWhat shipped\n/);
  });

  it("a live ULW run is winding down, not done, until a driver flag says so", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "forge-rr8-"));
    const s = createSession({ cwd, provider: "xai", model: "grok-4", ultrawork: true });
    s.meta.turnCount = 1;
    s.meta.lastVerificationCommand = "npm test";
    s.meta.lastVerificationAt = new Date().toISOString();
    s.meta.lastVerificationOk = true;
    saveSession(s);
    const st = armUlwReady(s.meta.id, "improve the importer");
    st.cycle = 0;
    st.wave = 12;
    const { saveUlwCycle } = await import("../src/harness/ulw-cycle.js");
    saveUlwCycle(st);

    // No result flags: /done and /status both build the report this way.
    const r = buildRunReport({ session: s, workspace: cwd, noGit: true });
    assert.match(r.outcome, /^Winding down — ULW is on its last cycle after 12 waves/);
    assert.match(r.outcome, /the wrap, LAST reflect and \*\*Cycle complete\.\*\* are still ahead/);
    const resume = r.sections.find((x) => x.title === "Resume")!.lines.join("\n");
    assert.match(resume, /ULW is on LAST \(cycle=0\)/);
    assert.doesNotMatch(resume, /sat down/);

    // The driver actually sitting a wrap down is a different sentence.
    const sat = buildRunReport({
      session: s,
      workspace: cwd,
      noGit: true,
      result: { lastCycleSatDown: true },
    });
    assert.match(sat.outcome, /^Paused — \/cycle 0 sat down/);
    assert.match(
      sat.sections.find((x) => x.title === "Resume")!.lines.join("\n"),
      /wrap sat down \(cycle=0\) and ULW stays on/,
    );
  });

  it("operatorItemsFrom reads bold and bulleted Operator: lines", () => {
    assert.deepEqual(
      operatorItemsFrom("x\n- **Operator:** rotate the key\nOperator: approve the prod migration\nnot this"),
      ["rotate the key", "approve the prod migration"],
    );
  });
  it("NO_COLOR wins over the caller's color flag in both renderers", () => {
    // Both renderers hand-roll SGR instead of going through chalk, and chalk
    // is the thing that self-disables under NO_COLOR (src/util/log.ts forces
    // FORCE_COLOR=0). Every caller passes a bare `Boolean(process.stdout.isTTY)`
    // — cli.ts, repl.ts, /done and /report — so the veto has to live in the
    // renderers or the next caller reintroduces it.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "forge-rr-nocolor-"));
    const s = createSession({ cwd, provider: "xai", model: "grok-4" });
    s.meta.turnCount = 1;
    s.meta.editCount = 2;
    saveSession(s);
    const report = buildRunReport({
      session: s,
      workspace: cwd,
      noGit: true,
      guidelineLines: ["AGENTS.md never proofread"],
      result: {
        finalText: "Done.\nOperator: rotate the deploy key.",
      },
    });

    const prior = process.env.NO_COLOR;
    try {
      // Colour still works when NO_COLOR is unset (the flag is the caller's).
      delete process.env.NO_COLOR;
      assert.match(renderRunReportText(report, { color: true }), /\x1b\[1m/);
      assert.match(
        renderRunReportAddendum(report, { color: true, savedPath: "/tmp/r.md" }),
        /\x1b\[2m/,
      );

      process.env.NO_COLOR = "1";
      const text = renderRunReportText(report, { color: true });
      const add = renderRunReportAddendum(report, {
        color: true,
        savedPath: "/tmp/r.md",
      });
      assert.ok(text.length > 20 && add.length > 20, "still renders, just plain");
      assert.ok(!text.includes("\x1b["), `escape in report text: ${JSON.stringify(text)}`);
      assert.ok(!add.includes("\x1b["), `escape in addendum: ${JSON.stringify(add)}`);
      // And the content is byte-identical to an explicit color:false render.
      assert.equal(text, renderRunReportText(report, { color: false }));
      assert.equal(
        add,
        renderRunReportAddendum(report, { color: false, savedPath: "/tmp/r.md" }),
      );
    } finally {
      if (prior == null) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = prior;
    }
  });

  it("addendum: every row's text starts in the same label column", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "forge-rr-col-"));
    const s = createSession({ cwd, provider: "xai", model: "grok-4" });
    s.meta.turnCount = 1;
    saveSession(s);
    const report = buildRunReport({
      session: s,
      workspace: cwd,
      noGit: true,
      guidelineLines: ["AGENTS.md revised by the agent (139 → 96 lines)"],
      result: {
        finalText: "Done.\nOperator: rotate the deploy key — I cannot read it.",
      },
    });
    const rows = renderRunReportAddendum(report, {
      savedPath: "/tmp/session/report.md",
    }).split("\n");

    // All four labels the addendum can print are exercised here.
    const labels = rows.map((r) => /^ {2}([a-z ]+?) {2,}\S/.exec(r)?.[1]);
    assert.deepEqual(
      [...new Set(labels)].sort(),
      ["guidelines", "needs you", "resume", "saved"],
      `unparsed addendum row: ${JSON.stringify(rows)}`,
    );
    // `needs you` shipped one space short and bent the column. Pin the
    // column, not the individual paddings: two-space indent + a 12-char
    // label field.
    const starts = rows.map((r) => r.length - r.replace(/^ {2}[a-z ]+? {2,}/, "").length);
    assert.deepEqual(
      [...new Set(starts)],
      [14],
      `label column bends: ${JSON.stringify(rows)}`,
    );
  });
});
