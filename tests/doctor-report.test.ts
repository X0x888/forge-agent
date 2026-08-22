import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assembleDoctorReport,
  formatDoctorCloser,
  formatDoctorHeader,
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
    assert.match(report, /Next  forge login  ·  \/setup/);
    assert.doesNotMatch(report, /Next  \/auth/);
  });

  it("yolo closer is /permissions on both surfaces", () => {
    assert.match(formatDoctorCloser([YOLO_ISSUE]), /\/permissions/);
    assert.match(
      formatDoctorCloser([YOLO_ISSUE], { surface: "cli" }),
      /\/permissions/,
    );
    assert.doesNotMatch(formatDoctorCloser([YOLO_ISSUE]), /forge login/);
    assert.doesNotMatch(
      formatDoctorCloser([YOLO_ISSUE], { surface: "cli" }),
      /forge login/,
    );
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

  it("header stays scrapeable as Forge doctor", () => {
    assert.match(formatDoctorHeader([], { color: false }), /Forge doctor/);
    assert.match(
      formatDoctorHeader(["x", "y"], { color: false }),
      /2 issues/,
    );
  });
});
