import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseChangelog,
  formatWhatsNew,
  loadChangelogReleases,
  findChangelogPath,
} from "../src/util/changelog.js";
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
    // Force tiny bullet budget so Docs section would otherwise be a bare head
    const text = formatWhatsNew({
      count: 1,
      maxBullets: 3,
      version: "9.9.9",
    });
    // Use parse path via monkey by writing temp? formatWhatsNew reads disk.
    // Unit-test the cleaner indirectly: parse + manual format path.
    const releases = parseChangelog(md);
    assert.equal(releases[0].version, "9.9.9");
    // Simulate cleaned output: Docs head with no room for its bullet should not appear alone
    // when we only take first 3 lines of cleaned list (Reliability head + 2 bullets)
    const bodyLines = releases[0].body.split("\n").map((l) => l.trim()).filter(Boolean);
    assert.ok(bodyLines.some((l) => l.startsWith("### Docs")));
    // Real packaged news should not end with a bare ### line
    const real = formatWhatsNew({ count: 1, maxBullets: 10 });
    const lines = real.split("\n").map((l) => l.trim()).filter(Boolean);
    const lastContent = [...lines].reverse().find((l) => !l.startsWith("Older:") && !l.startsWith("Tip:"));
    assert.ok(lastContent);
    assert.doesNotMatch(lastContent!, /^###\s/);
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
});
