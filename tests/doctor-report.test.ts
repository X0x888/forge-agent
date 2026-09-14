import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assembleDoctorReport,
  formatDoctorCloser,
  formatDoctorHeader,
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

  it("yolo closer is /permissions at › and a shell flag on CLI", () => {
    assert.match(formatDoctorCloser([YOLO_ISSUE]), /\/permissions/);
    assert.doesNotMatch(
      formatDoctorCloser([YOLO_ISSUE], { surface: "cli" }),
      /\/permissions/,
    );
    assert.match(
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

  it("header stays scrapeable as Forge doctor", () => {
    assert.match(formatDoctorHeader([], { color: false }), /Forge doctor/);
    assert.match(
      formatDoctorHeader(["x", "y"], { color: false }),
      /2 issues/,
    );
  });
});
