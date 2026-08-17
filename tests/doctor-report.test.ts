import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assembleDoctorReport,
  formatDoctorCloser,
  formatDoctorHeader,
} from "../src/tui/doctor-card.js";

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

  it("lists issues first and points at login", () => {
    const report = assembleDoctorReport(
      ["Version: 0.9.99", "Auth: none"],
      ["Not authenticated — run forge login or set an API key env var"],
      { color: false },
    );
    assert.match(report, /^Forge doctor  ·  1 issue\n/);
    assert.match(report, /⚠ 1 issue\(s\):/);
    assert.ok(
      report.indexOf("Not authenticated") < report.indexOf("Version:"),
      "issues must precede facts",
    );
    assert.match(report, /Next  forge login  ·  \/setup/);
    assert.doesNotMatch(report, /No blocking issues detected/);
  });

  it("yolo closer is /permissions", () => {
    assert.match(
      formatDoctorCloser([
        "Permission mode is bypassPermissions (yolo) — all tools auto-approved",
      ]),
      /\/permissions/,
    );
    assert.doesNotMatch(
      formatDoctorCloser([
        "Permission mode is bypassPermissions (yolo) — all tools auto-approved",
      ]),
      /forge login/,
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
