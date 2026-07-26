import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseChangelog,
  formatWhatsNew,
  loadChangelogReleases,
  findChangelogPath,
} from "../src/util/changelog.js";
import { formatExpertTips } from "../src/util/tips.js";
import { handleSlash } from "../src/commands/slash.js";
import { createSession } from "../src/session/session.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";
import { HookRunner } from "../src/harness/hooks.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("changelog / what's new", () => {
  it("parses version sections and bullets", () => {
    const md = `# Changelog

## 1.2.3 — Cool release

### Reliability
- **alpha**: first thing
- beta item

## 1.2.2 — Prior

- older bullet
`;
    const releases = parseChangelog(md);
    assert.equal(releases.length, 2);
    assert.equal(releases[0].version, "1.2.3");
    assert.equal(releases[0].title, "Cool release");
    assert.match(releases[0].body, /alpha/);
    assert.equal(releases[1].version, "1.2.2");
  });

  it("omits empty ### heads when bullets are truncated", () => {
    const md = `## 9.9.9 — Test

### Reliability / safety
- bullet one
- bullet two
- bullet three
- bullet four
### Docs / tests
- doc only item
`;
    const releases = parseChangelog(md);
    assert.equal(releases[0].version, "9.9.9");
    const bodyLines = releases[0].body.split("\n").map((l) => l.trim()).filter(Boolean);
    assert.ok(bodyLines.some((l) => l.startsWith("### Docs")));
    // Real packaged news should not end with a bare ### line
    const real = formatWhatsNew({ count: 1, maxBullets: 10 });
    const lines = real.split("\n").map((l) => l.trim()).filter(Boolean);
    const lastContent = [...lines].reverse().find((l) => !l.startsWith("Older:") && !l.startsWith("Tip:"));
    assert.ok(lastContent);
    assert.doesNotMatch(lastContent!, /^###\s/);
  });

  it("prefers newest bullets when the release body is long", () => {
    // Write a temp CHANGELOG and point load via cwd package root — formatWhatsNew
    // reads packaged CHANGELOG; assert on real file that tail bullets appear.
    const text = formatWhatsNew({ count: 1, maxBullets: 6 });
    // Recent 0.9.5 work lives near the end of the Loop hygiene section
    assert.match(
      text,
      /finishReason|mergeRunOpts|invalid_effort|invalid_permission|failUsage|bare `forge --continue`|Bare `forge "…" --json`|api_key_required|is_directory|Heredoc-aware|eval` \/ `xargs|bash -c|apply_patch` Move|invalid_format|invalid_provider|missing_base_url|parseKeepCount|--keep 0|FORGE_PERMISSION_MODE|env enum|get_task_output|tail: 0|FORGE_GOAL_STUCK|stats --json|list --limit 0|stuck threshold|head_limit|read_file|models --json|logs\|prune|web_fetch|web_search/i,
    );
    // Should not only show the oldest content_filter bullet as the whole story
    // when newer bullets exist (regression: head-slice hid recent work).
    assert.match(text, /\+\d+ more in CHANGELOG/);
  });

  it("finds packaged CHANGELOG and formats highlights", () => {
    const p = findChangelogPath();
    assert.ok(p, "CHANGELOG.md should ship with the package");
    assert.ok(fs.existsSync(p!));
    const releases = loadChangelogReleases();
    assert.ok(releases.length >= 1);
    assert.match(releases[0].version, /^\d+\.\d+\.\d+$/);
    const text = formatWhatsNew({ count: 1, maxBullets: 8 });
    assert.match(text, /what's new/i);
    assert.match(text, new RegExp(releases[0].version.replace(/\./g, "\\.")));
  });

  it("/news is handled and live-safe", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-news-"));
    process.env.FORGE_HOME = tmp;
    const s = createSession({ cwd: tmp, provider: "xai", model: "m" });
    const hooks = new HookRunner(DEFAULT_CONFIG, tmp);
    const r = await handleSlash("/news", {
      session: s,
      config: DEFAULT_CONFIG,
      hooks,
    });
    assert.equal(r.handled, true);
    assert.match(String(r.output || ""), /what's new|CHANGELOG|Forge/i);
  });

  it("formatExpertTips is shared by /tips (no CLI/REPL drift)", async () => {
    const text = formatExpertTips();
    assert.match(text, /Forge expert tips/);
    assert.match(text, /\/clear hard/);
    assert.match(text, /forge sessions title/);
    assert.match(text, /forge run/);
    assert.match(text, /forge auth --json/);
    assert.match(text, /\/cycle 0\|1/);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-tips-"));
    process.env.FORGE_HOME = tmp;
    const s = createSession({ cwd: tmp, provider: "xai", model: "m" });
    const hooks = new HookRunner(DEFAULT_CONFIG, tmp);
    const r = await handleSlash("/tips", {
      session: s,
      config: DEFAULT_CONFIG,
      hooks,
    });
    assert.equal(r.handled, true);
    assert.equal(r.output, text);
  });
});
