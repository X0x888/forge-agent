import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assembleDoctorReport,
  doctorSessionsRecoveryVerb,
  doctorForceLastErrorHelp,
  formatDoctorCloser,
  formatDoctorHeader,
  formatDoctorPinnedLine,
  formatDoctorRecommended,
} from "../src/tui/doctor-card.js";

const AUTH_ISSUE = "Not authenticated — run forge login or set an API key env var";
const YOLO_ISSUE =
  "Permission mode is bypassPermissions (yolo) — all tools auto-approved";
const OTHER_ISSUE = "Sandbox is off — tools can touch the host";

describe("doctor health card", () => {
  it("opens with a verdict, not Version", () => {
    const ok = assembleDoctorReport(
      ["Version: 0.9.99", "Auth: none"],
      [],
      { color: false },
    );
    assert.match(ok, /^Forge doctor  ·  ok/);
    assert.match(ok, /✓ No blocking issues detected/);
    assert.ok(
      ok.indexOf("Forge doctor") < ok.indexOf("Version:"),
      "verdict must precede Version",
    );
    assert.match(ok, /Next  \/setup/);
    assert.doesNotMatch(ok, /forge login/);
  });

  it("default/repl auth closer is /auth — never forge login", () => {
    const report = assembleDoctorReport(
      ["Version: 0.9.99", "Auth: none"],
      [AUTH_ISSUE],
      { color: false },
    );
    assert.match(report, /^Forge doctor  ·  1 issue\n/);
    assert.match(report, /⚠ 1 issue\(s\):/);
    assert.ok(
      report.indexOf("Not authenticated") < report.indexOf("Version:"),
      "issues must precede facts",
    );
    assert.match(report, /Next  \/auth  ·  \/setup/);
    assert.doesNotMatch(report, /Next  forge login/);
    assert.doesNotMatch(report, /run forge login/);
    assert.doesNotMatch(report, /forge doctor --json/);
    assert.doesNotMatch(report, /No blocking issues detected/);
  });

  it("cli auth closer keeps forge login", () => {
    const report = assembleDoctorReport(
      ["Version: 0.9.99", "Auth: none"],
      [AUTH_ISSUE],
      { color: false, surface: "cli" },
    );
    assert.match(report, /Next  forge login  ·  forge setup/);
    assert.doesNotMatch(report, /Next  \/auth/);
    assert.doesNotMatch(report, /\/setup/);
    assert.doesNotMatch(report, /\/permissions/);
  });

  it("yolo closer is /permissions at › and forge permissions default on CLI", () => {
    assert.match(formatDoctorCloser([YOLO_ISSUE]), /\/permissions/);
    assert.doesNotMatch(
      formatDoctorCloser([YOLO_ISSUE], { surface: "cli" }),
      /\/permissions/,
    );
    assert.match(
      formatDoctorCloser([YOLO_ISSUE], { surface: "cli" }),
      /forge permissions default/,
    );
    assert.doesNotMatch(
      formatDoctorCloser([YOLO_ISSUE], { surface: "cli" }),
      /forge --permission-mode default/,
    );
    assert.doesNotMatch(formatDoctorCloser([YOLO_ISSUE]), /forge login/);
    assert.doesNotMatch(
      formatDoctorCloser([YOLO_ISSUE], { surface: "cli" }),
      /forge login/,
    );
  });

  it("CLI Next never lists slash commands", () => {
    const closer = formatDoctorCloser([YOLO_ISSUE, AUTH_ISSUE], {
      surface: "cli",
      recommendations: [
        {
          id: "project-memory",
          severity: "hygiene",
          detail: "20 notes",
          replAction: "/memory project prune",
          cliAction: "/memory project prune",
        },
      ],
    });
    assert.doesNotMatch(closer, /\/[a-zA-Z]/);
    assert.doesNotMatch(closer, /\/permissions/);
    assert.match(closer, /forge login/);
  });

  it("other-issue fallback is /status at › and forge doctor --json on CLI", () => {
    assert.match(formatDoctorCloser([OTHER_ISSUE]), /^Next  \/status$/);
    assert.doesNotMatch(
      formatDoctorCloser([OTHER_ISSUE]),
      /forge doctor --json/,
    );
    assert.match(
      formatDoctorCloser([OTHER_ISSUE], { surface: "cli" }),
      /^Next  forge doctor --json$/,
    );
  });

  it("Recommended block sits between issues and facts; Next uses rec actions", () => {
    const recs = [
      {
        id: "tmp-scratch",
        severity: "hygiene" as const,
        detail: "~/.forge/tmp has 4 leftover look/Chrome dir(s) (200.0 MB)",
        cliAction: "forge tmp prune",
      },
      {
        id: "orphan-subagents",
        severity: "hygiene" as const,
        detail: "12 nested subagent sessions with no ulw.json",
        replAction: "/sessions errors",
        cliAction: "forge sessions prune --orphans",
      },
    ];
    const report = assembleDoctorReport(
      ["Version: 0.9.99"],
      [OTHER_ISSUE],
      { color: false, recommendations: recs },
    );
    assert.match(report, /Recommended/);
    assert.match(report, /forge tmp prune/);
    assert.ok(
      report.indexOf("Recommended") < report.indexOf("Version:"),
      "Recommended must precede facts",
    );
    assert.match(
      formatDoctorCloser([OTHER_ISSUE], {
        recommendations: recs,
        surface: "cli",
      }),
      /forge tmp prune/,
    );
    assert.match(
      formatDoctorCloser([OTHER_ISSUE], { recommendations: recs }),
      /\/sessions errors/,
    );
    assert.doesNotMatch(
      formatDoctorCloser([OTHER_ISSUE], { recommendations: recs }),
      /forge tmp prune/,
    );
    const recLines = formatDoctorRecommended(recs, {
      color: false,
      surface: "cli",
    });
    assert.ok(recLines.some((l) => /forge tmp prune/.test(l)));
  });

  it("journal issue Next is prune --journals, not --keep 50", () => {
    const issue =
      "Undo journal is large (~720145.1 KB, 20587 entries across 175 session(s)) — forge sessions prune --journals (keeps sessions / lastError; drops mutations.jsonl)";
    const cli = formatDoctorCloser([issue], { surface: "cli" });
    assert.match(cli, /forge sessions prune --journals/);
    assert.doesNotMatch(cli, /--keep 50/);
    const repl = formatDoctorCloser([issue]);
    assert.match(repl, /\/sessions prune --journals/);
    assert.doesNotMatch(repl, /--keep 50/);
    const countIssue =
      "120 sessions on disk — consider forge sessions prune --keep 50";
    assert.match(
      formatDoctorCloser([countIssue], { surface: "cli" }),
      /forge sessions prune --keep 50/,
    );
  });

  it("crowded closer still prints bash install.sh", () => {
    const recs = [
      {
        id: "stale-dist",
        severity: "hygiene" as const,
        detail: "Built dist/cli.js is older than src/cli.ts",
        cliAction: "bash install.sh",
      },
    ];
    const issues = [
      AUTH_ISSUE,
      YOLO_ISSUE,
      "Undo journal is large (~720145.1 KB, 20587 entries across 175 session(s)) — forge sessions prune --journals",
      "120 sessions on disk — consider forge sessions prune --keep 50",
    ];
    const cli = formatDoctorCloser(issues, { surface: "cli", recommendations: recs });
    assert.match(cli, /bash install\.sh/);
    assert.match(cli, /forge login/);
    assert.doesNotMatch(cli, /\/sessions errors/);
  });

  it("CLI recovery catalog has no slash keys; REPL keeps /sessions errors", () => {
    const kinds = ["errors", "untitled", "pinned", "pin", "unpin"] as const;
    for (const kind of kinds) {
      const cli = doctorSessionsRecoveryVerb(kind, "cli");
      assert.doesNotMatch(cli, /^\//);
      assert.doesNotMatch(cli, /\/sessions/);
      assert.match(doctorSessionsRecoveryVerb(kind, "repl"), /^\//);
    }
    assert.equal(
      doctorSessionsRecoveryVerb("errors", "repl"),
      "/sessions errors",
    );
    assert.doesNotMatch(doctorForceLastErrorHelp("cli"), /\/sessions/);
    assert.match(doctorForceLastErrorHelp("cli"), /forge sessions errors/);
    const pinCli = formatDoctorPinnedLine(12, "cli");
    assert.match(pinCli, /forge sessions pinned/);
    assert.match(pinCli, /forge sessions unpin/);
    assert.doesNotMatch(pinCli, /\/sessions pinned/);
    assert.doesNotMatch(pinCli, /\/unpin/);
    const pinRepl = formatDoctorPinnedLine(3, "repl");
    assert.match(pinRepl, /\/sessions pinned/);
    assert.match(pinRepl, /\/pin/);
  });

  it("header stays scrapeable as Forge doctor", () => {
    assert.match(formatDoctorHeader([], { color: false }), /Forge doctor/);
    assert.match(
      formatDoctorHeader(["x", "y"], { color: false }),
      /2 issues/,
    );
  });
});
