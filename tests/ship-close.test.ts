import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isDeclaredWaveClose,
  isShipCloseText,
  extractShipSummary,
  pickShipHint,
} from "../src/harness/ship-close.js";
import {
  isGlanceableClassShip,
  isLeftoverChromeShip,
  isConsolidationCloser,
  isPolishClassShip,
  summarizeWave,
} from "../src/harness/ulw-cycle.js";
import { buildAutoCommitSubject } from "../src/util/git-auto-commit.js";
import {
  DOGFOOD_5DBF_SHIPS,
  DOGFOOD_5DBF_SURFACES,
  DOGFOOD_693C_SHIPS,
} from "./fixtures/ulw-dogfood-closers.js";

describe("ship-close grammar", () => {
  it("treats every 5dbf **Ship:** closer as a declared close", () => {
    for (const t of DOGFOOD_5DBF_SHIPS) {
      assert.equal(isDeclaredWaveClose(t), true, t);
      assert.ok(extractShipSummary(t), t);
    }
  });

  it("treats 693c Wave N ship / Wave ship / Wave shipped as closes", () => {
    for (const t of DOGFOOD_693C_SHIPS) {
      assert.equal(isShipCloseText(t), true, t);
      assert.equal(isDeclaredWaveClose(t), true, t);
    }
    assert.ok(extractShipSummary("Wave ship: get_task_output default transcript shows last 8 log lines."));
    assert.ok(extractShipSummary("Wave ship: web_fetch default transcript shows first heading + first prose lines."));
    assert.ok(
      extractShipSummary(
        "**Wave shipped.** Successful search_mcp now lists the first 5 matched tool names under the ✓ row.",
      ),
    );
  });

  it("does not treat ONE ship / mid-thought / Reading as a close", () => {
    assert.equal(isDeclaredWaveClose("The ONE ship is the tool-status line."), false);
    assert.equal(isDeclaredWaveClose("still verifying the unused import"), false);
    assert.equal(
      isDeclaredWaveClose(
        "Reading: Forge's product is the interactive REPL. Daily-loop trust beats chrome.",
      ),
      false,
    );
    assert.equal(isDeclaredWaveClose("shipped input validation"), false);
  });

  it("summarizeWave prefers **Ship:** and Wave N ship over a Reading reprint", () => {
    const reading =
      "**Reading:** Forge’s daily UX is transcript + live › + sticky dock. Help/setup already expert-grade.";
    const bold = summarizeWave(
      `${reading}\n\n**Ship:** \`createToolStartDelayer\` holds ▸ for 700ms.`,
    );
    assert.match(bold, /createToolStartDelayer|holds/);
    assert.doesNotMatch(bold, /daily UX is transcript/);
    const waveShip = summarizeWave(
      `${reading}\n\nWave 2 ship: last 5 lines under the ✓ row.`,
    );
    assert.match(waveShip, /last 5 lines/);
    assert.doesNotMatch(waveShip, /daily UX is transcript/);
  });

  it("5dbf **Ship:** bodies become distinct commit subjects", () => {
    const mandate =
      "comprehensively evaluate this tool and then improve the ui and ux of it.";
    const subjects = DOGFOOD_5DBF_SHIPS.map((h) =>
      buildAutoCommitSubject(mandate, h),
    );
    for (const s of subjects) {
      assert.doesNotMatch(s, /comprehensively evaluate/i);
    }
    assert.match(subjects[0]!, /createToolStartDelayer|700ms/);
    assert.match(subjects[2]!, /formatUserTurnOpen|you ›/);
    assert.match(subjects[3]!, /card|product/i);
    assert.notEqual(subjects[2], subjects[3]);
  });

  it("pickShipHint never falls back to a wave-1 Ship landed", () => {
    const hint = pickShipHint({
      prevWaveTs: "2026-08-16T10:00:00.000Z",
      lastWaveSummary: "Wave 16 ship: search_mcp lists first 5 matched tool names.",
      records: [
        {
          at: "2026-08-16T09:50:00.000Z",
          source: "agent",
          text: "Ship landed: empty Tab includes /resume; /resume Tab offers 1/2/3; /last hint is Conversation card.",
        },
        {
          at: "2026-08-16T10:30:00.000Z",
          source: "agent",
          text: "Wave ship: get_task_output default transcript shows last 8 log lines.",
        },
      ],
    });
    assert.match(hint || "", /get_task_output/);
    assert.doesNotMatch(hint || "", /empty Tab/);
    const ledgerOnly = pickShipHint({
      prevWaveTs: "2026-08-16T10:00:00.000Z",
      lastWaveSummary: "Wave 16 ship: search_mcp lists first 5 names under the ✓ row.",
      records: [
        {
          at: "2026-08-16T09:50:00.000Z",
          source: "agent",
          text: "Ship landed: empty Tab includes /resume; /resume Tab offers 1/2/3.",
        },
      ],
    });
    assert.match(ledgerOnly || "", /search_mcp/);
  });
});

describe("leftover-chrome family vs 5dbf surfaces", () => {
  it("does not mark 5dbf dock / delayed ▸ / landmarks / setup as chrome", () => {
    for (const t of DOGFOOD_5DBF_SURFACES) {
      assert.equal(isLeftoverChromeShip(t), false, t);
    }
    assert.equal(
      isGlanceableClassShip(
        "Forge’s daily UX is transcript + live › + sticky dock. Help/setup already expert-grade.",
      ),
      false,
    );
  });

  it("counts 693c live › / bang-shell / idle last-line / ✓ previews as chrome", () => {
    assert.equal(
      isGlanceableClassShip(
        "Wave 8 ship: live › shows last nonempty bash stdout/stderr line (200ms throttle).",
      ),
      true,
    );
    assert.equal(
      isGlanceableClassShip(
        "Wave 11 ship: bang-shell !cmd streams last-line into live › via onProgress.",
      ),
      true,
    );
    assert.equal(
      isGlanceableClassShip(
        "Wave 7 ship: idle you › bg-completion notice now includes the last log line (pass 36).",
      ),
      true,
    );
    assert.equal(
      isGlanceableClassShip(
        "Wave 10 ship: lsp diagnostics preview under ✓ (count + first hits).",
      ),
      true,
    );
    assert.equal(
      isGlanceableClassShip(
        "Wave 3 ship: successful long bash prints last 5 lines under the ✓ row.",
      ),
      true,
    );
    assert.equal(
      isGlanceableClassShip(
        "Wave 9 ship: Δ closer prints missing/stale verify on its own yellow line.",
      ),
      false,
    );
    assert.equal(isPolishClassShip("keep one TTY row"), true);
  });

  it("693c first ✓-preview cluster reaches 4 without a live › / bang-shell reset", () => {
    let streak = 0;
    const seq = [
      "Wave 2 ship: spawn_subagent first 8 lines. Same glanceable-work class as edit diffs.",
      "Wave 3 ship: last 5 lines under the ✓ row.",
      "Wave shipped (consolidation). No new scope. - **1819 tests pass**",
      "Wave 5 ship: web_search lists up to 5 hit titles under the ✓ row.",
      "Wave 7 ship: idle you › bg-completion notice now includes the last log line.",
      "Wave 8 ship: live › shows last nonempty bash stdout/stderr line.",
      "Wave 11 ship: bang-shell !cmd streams last-line into live ›.",
    ];
    for (const t of seq) {
      if (isConsolidationCloser(t)) continue;
      if (isLeftoverChromeShip(t)) streak += 1;
      else streak = 0;
    }
    assert.ok(streak >= 4, `streak=${streak}`);
  });
});
