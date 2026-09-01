/**
 * Unlimited ULW quality: job card on the wire, sibling mill, bestWave job-move.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChatMessage } from "../src/providers/types.js";
import { compactMessagesStructured } from "../src/session/compaction.js";
import { appendMemoryRecord } from "../src/harness/decision-memory.js";
import {
  bestWave,
  evaluateUlwAtStop,
  exploreSpawnSkipReason,
  loadUlwCycle,
  maybeStampUlwWave,
  midReflectHolding,
  notePlayLoopRan,
  noteUlwThoughtOnlyStop,
  saveUlwCycle,
  THOUGHT_ONLY_LOOK_CYCLE,
} from "../src/harness/ulw-cycle.js";
import {
  buildUlwJobCard,
  formatUlwJobCard,
  waveMovedJob,
} from "../src/harness/ulw-job-card.js";
import {
  isSiblingPathMill,
  siblingMillHits,
  siblingMillHolding,
  SIBLING_MILL_HOLD,
} from "../src/harness/job-delta.js";
import { armUlwReady } from "./helpers/ulw-arm.js";
import { formatThoughtOnlyRecoverPoke } from "../src/agent/reasoned-stop.js";
import { isUserFacingProductWork } from "../src/harness/product-quality.js";

function withHome(fn: () => void): void {
  const prev = process.env.FORGE_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-jobcard-"));
  process.env.FORGE_HOME = dir;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("ulw job card on the wire", () => {
  it("compact at a w40 mill suffix still keeps Wave-1 reading + open ships", () => {
    withHome(() => {
      const sid = "job-card-w40";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      const ulw = armUlwReady(sid, "improve the code", {
        cycle: 1,
        skipCheckpoint: true,
      });
      appendMemoryRecord(sid, {
        kind: "decision",
        text: "Reading: daily REPL trust beats chrome catalogs. Verify: npm test.",
        source: "agent",
      });
      ulw.namedShips = [
        { text: "Memory Walk reskin on floor 1", status: "open" },
        { text: "Online hearth join path", status: "open" },
      ];
      ulw.wave = 40;
      ulw.waves = Array.from({ length: 40 }, (_, i) => ({
        wave: i + 1,
        editDelta: i === 0 ? 8 : 22,
        proof: true,
        proofKind: i === 0 ? ("full" as const) : ("isolate" as const),
        millClass: i > 0,
        siblingMill: i > 2,
        jobMoved: i === 0,
        summary:
          i === 0
            ? "ship the REPL trust empty state"
            : `Wave ${i + 1} sibling: clip widget ${i}`,
        ts: "",
      }));
      saveUlwCycle(ulw);

      const msgs: ChatMessage[] = [{ role: "system", content: "You are Forge" }];
      for (let i = 0; i < 40; i++) {
        msgs.push({
          role: "assistant",
          content: `Wave ${i + 1} mill closer filler`,
        });
        msgs.push({
          role: "user",
          content: `continue mill ${i}`,
        });
      }
      const result = compactMessagesStructured(msgs, {
        keepLast: 3,
        context: { sessionId: sid, ulw: loadUlwCycle(sid), todos: [] },
      });
      assert.ok(result.droppedCount > 0);
      assert.match(result.summary, /daily REPL trust/);
      assert.match(result.summary, /Memory Walk reskin/);
      assert.match(result.summary, /Job card/);
      assert.match(result.summary, /Last job-moving ship: w1/);
    });
  });

  it("re-anchor names the open job, not the fattest mill", () => {
    withHome(() => {
      const sid = "job-card-reanchor";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      const ulw = armUlwReady(sid, "improve this game", {
        cycle: 1,
        skipCheckpoint: true,
      });
      appendMemoryRecord(sid, {
        kind: "decision",
        text: "Reading: plant the cry on floor 1. Verify: npm test.",
        source: "agent",
      });
      ulw.namedShips = [{ text: "plant the cry on floor 1", status: "open" }];
      ulw.waves = [
        {
          wave: 1,
          editDelta: 6,
          proof: true,
          proofKind: "full",
          jobMoved: true,
          summary: "planted the cry",
          ts: "",
        },
        {
          wave: 87,
          editDelta: 40,
          proof: true,
          millClass: true,
          siblingMill: true,
          summary: "another NPC toast mill",
          ts: "",
        },
      ];
      saveUlwCycle(ulw);
      const card = formatUlwJobCard(
        buildUlwJobCard(loadUlwCycle(sid)!),
      );
      assert.match(card, /plant the cry/);
      assert.match(card, /Last job-moving ship: w1/);
      assert.doesNotMatch(card, /w87/);
      const d = evaluateUlwAtStop({
        sessionId: sid,
        lastAssistantMessage: "still working",
        editCount: 0,
        openTodoCount: 0,
        stuckThreshold: 50,
      });
      assert.equal(d.block, true);
      assert.match(d.reanchor || "", /plant(?:ed)? the cry/);
      assert.match(d.reanchor || "", /job-move/);
    });
  });
});

describe("bestWave is job movement, not mill volume", () => {
  it("crowns the job-moving ship over a fatter sibling mill", () => {
    const best = bestWave([
      {
        wave: 1,
        editDelta: 7,
        proof: true,
        proofKind: "full",
        jobMoved: true,
        summary: "planted the cry",
        ts: "",
      },
      {
        wave: 40,
        editDelta: 28,
        proof: true,
        millClass: true,
        siblingMill: true,
        summary: "src/systems/foo-12.js",
        ts: "",
      },
      {
        wave: 41,
        editDelta: 30,
        proof: true,
        chrome: true,
        summary: "changelog chrome",
        ts: "",
      },
    ]);
    assert.equal(best!.wave, 1);
    assert.equal(waveMovedJob(best!), true);
  });
});

describe("sibling new-module mill", () => {
  it("detects foo-n.js path mill without maze regex", () => {
    assert.equal(
      isSiblingPathMill(
        ["src/systems/foo-2.js"],
        ["src/systems/foo.js"],
      ),
      true,
    );
    assert.equal(
      isSiblingPathMill(["src/npcs/bar.js"], ["src/systems/foo.js"]),
      false,
    );
    const waves = [
      { editKind: "new-module" as const, treeSurfaceKey: "new-module:src/systems/foo.js" },
      { editKind: "new-module" as const, treeSurfaceKey: "new-module:src/systems/foo-2.js" },
    ];
    assert.equal(
      siblingMillHits(waves, ["src/systems/foo-3.js"], "new-module"),
      2,
    );
    assert.equal(
      siblingMillHolding(waves, ["src/systems/foo-3.js"], "new-module"),
      true,
    );
    assert.equal(SIBLING_MILL_HOLD, 3);
  });

  it("third numbered sibling does not increment w and demands explore", () => {
    withHome(() => {
      const sid = "sib-mill";
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sib-cwd-"));
      try {
        fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
          recursive: true,
        });
        fs.mkdirSync(path.join(cwd, "src", "systems"), { recursive: true });
        armUlwReady(sid, "improve this game", {
          cycle: 1,
          skipCheckpoint: true,
        });
        const files = [
          "src/systems/foo.js",
          "src/systems/foo-2.js",
          "src/systems/foo-3.js",
        ];
        let edits = 0;
        const waves: number[] = [];
        for (let i = 0; i < 3; i++) {
          fs.writeFileSync(
            path.join(cwd, files[i]!),
            `export function f${i}() { if (true) return ${i}; }\n`,
          );
          edits += 4;
          const r = maybeStampUlwWave({
            sessionId: sid,
            editCount: edits,
            openTodoCount: 0,
            stepsSinceStamp: 1,
            lastAssistantMessage: `Wave shipped: module ${files[i]}.`,
            verificationPassed: true,
            cwd,
            changedPaths: [files[i]!],
          });
          waves.push(loadUlwCycle(sid)!.wave);
          if (i === 2) {
            assert.equal(r.stamped, false, "3rd sibling must not stamp w");
            assert.match(r.admit || "", /sibling/i);
          }
        }
        const s = loadUlwCycle(sid)!;
        assert.ok(s.wave <= 2, `w stuck on mill, got ${s.wave} (${waves})`);
        assert.equal(s.siblingMillHold, true);
        assert.equal(exploreSpawnSkipReason(sid), undefined);
        assert.equal(s.reorientRequested, true);
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });
  });
});

describe("cadence re-PLAN on off-job ships", () => {
  it("3 credited ships that do not move the job re-arm PLAN + explore", () => {
    withHome(() => {
      const sid = "off-job";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      const ulw = armUlwReady(sid, "improve this game", {
        cycle: 1,
        skipCheckpoint: true,
      });
      ulw.namedShips = [{ text: "plant the cry on floor 1", status: "open" }];
      saveUlwCycle(ulw);
      let edits = 0;
      for (let i = 0; i < 3; i++) {
        edits += 3;
        maybeStampUlwWave({
          sessionId: sid,
          editCount: edits,
          openTodoCount: 0,
          stepsSinceStamp: 1,
          lastAssistantMessage: `Wave shipped: leftover chrome clip ${i}.`,
          verificationPassed: true,
          verificationHelperOnly: true,
        });
      }
      const s = loadUlwCycle(sid)!;
      assert.ok(
        (s.offJobStreak ?? 0) >= 3,
        `off-job streak ${s.offJobStreak}`,
      );
      assert.equal(s.reorientRequested, true);
    });
  });
});

describe("thought-only cycle forces a look", () => {
  it("does not LAST, and the poke asks for explore/play", () => {
    withHome(() => {
      const sid = "thought-look";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      armUlwReady(sid, "improve this game", { cycle: 1, skipCheckpoint: true });
      let last = { count: 0, forceLook: false };
      for (let i = 0; i < THOUGHT_ONLY_LOOK_CYCLE; i++) {
        last = noteUlwThoughtOnlyStop(sid);
      }
      assert.equal(last.forceLook, true);
      const s = loadUlwCycle(sid)!;
      assert.equal(s.cycle, 1);
      assert.equal(s.reorientRequested, true);
      assert.equal(s.exploreRequired, true);
      const poke = formatThoughtOnlyRecoverPoke(3, { forceLook: true });
      assert.match(poke, /spawn_subagent type=explore/);
      assert.doesNotMatch(poke, /Wave 1 reading:/);
    });
  });
});

describe("product-quality arms from Wave-1 reading", () => {
  it("soft mandate + game reading is user-facing; bare improve the code is not", () => {
    assert.equal(isUserFacingProductWork("improve the code"), false);
    assert.equal(
      isUserFacingProductWork("improve the code", {
        reading: "this game's first-hour cry on floor 1",
      }),
      true,
    );
  });
});

describe("jobMoved is named/pick/play or reading files", () => {
  it("does not treat a full-suite pass or control-flow net=new as a job move", () => {
    assert.equal(
      waveMovedJob({
        wave: 4,
        editDelta: 12,
        proof: true,
        proofKind: "full",
        netDiff: "new",
        editKind: "control-flow",
        summary: "npm test green",
        ts: "",
      }),
      false,
    );
    assert.equal(
      waveMovedJob({
        wave: 5,
        editDelta: 9,
        proof: true,
        proofKind: "play",
        summary: "play-loop on floor 1",
        ts: "",
      }),
      true,
    );
    assert.equal(
      waveMovedJob({
        wave: 1,
        editDelta: 6,
        proof: true,
        jobMoved: true,
        summary: "planted the cry",
        ts: "",
      }),
      true,
    );
  });
});

describe("consolidation Must-fix + no job-move holds", () => {
  it("holds on capped ULW the same as unlimited", () => {
    withHome(() => {
      const sid = "cons-hold-cap";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      armUlwReady(sid, "improve the code", {
        cycle: 1,
        maxWaves: 20,
        skipCheckpoint: true,
      });
      const closers = [
        "Wave shipped: plant the cry seed on floor 1.",
        "Wave shipped: hearth join timeout no longer freezes.",
        "Wave shipped: host bag ticks while the joiner is away.",
        "Wave shipped: journal leftover recipes become the walk goal.",
      ];
      let edits = 0;
      let last;
      for (let i = 0; i < 4; i++) {
        edits += 5;
        last = maybeStampUlwWave({
          sessionId: sid,
          editCount: edits,
          openTodoCount: 0,
          stepsSinceStamp: 1,
          lastAssistantMessage: closers[i],
          verificationPassed: true,
          verificationHelperOnly: true,
          changedPaths: [`src/area${i}/mod.js`],
        });
      }
      assert.equal(last?.stamped, true, JSON.stringify(last));
      const held = loadUlwCycle(sid)!;
      assert.equal(midReflectHolding(held), true);
      assert.ok((held.midReflectHoles ?? []).length > 0);
    });
  });

  it("blocks the next stamp after 4 off-job credited waves", () => {
    withHome(() => {
      const sid = "cons-hold";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      armUlwReady(sid, "improve the code", {
        cycle: 1,
        skipCheckpoint: true,
      });
      const closers = [
        "Wave shipped: plant the cry seed on floor 1.",
        "Wave shipped: hearth join timeout no longer freezes.",
        "Wave shipped: host bag ticks while the joiner is away.",
        "Wave shipped: journal leftover recipes become the walk goal.",
      ];
      let edits = 0;
      let last;
      for (let i = 0; i < 4; i++) {
        edits += 5;
        last = maybeStampUlwWave({
          sessionId: sid,
          editCount: edits,
          openTodoCount: 0,
          stepsSinceStamp: 1,
          lastAssistantMessage: closers[i],
          verificationPassed: true,
          verificationHelperOnly: true,
          changedPaths: [`src/area${i}/mod.js`],
        });
      }
      assert.equal(last?.stamped, true, JSON.stringify(last));
      const held = loadUlwCycle(sid)!;
      assert.equal(
        midReflectHolding(held),
        true,
        `hold=${held.midReflectHold} holes=${JSON.stringify(held.midReflectHoles)} wave=${held.wave} same=${held.sameSurfaceHold}`,
      );
      assert.ok((held.midReflectHoles ?? []).length > 0);
      edits += 5;
      const blocked = maybeStampUlwWave({
        sessionId: sid,
        editCount: edits,
        openTodoCount: 0,
        stepsSinceStamp: 1,
        lastAssistantMessage: "Wave shipped: yet another npc controller.",
        verificationPassed: true,
        verificationHelperOnly: true,
        changedPaths: ["src/area9/npc.js"],
      });
      assert.equal(blocked.stamped, false, JSON.stringify(blocked));
      assert.match(
        blocked.admit || "",
        /Must-fix|consolidation|job-move|explore/i,
      );
    });
  });
});

describe("play/look is a proof kind", () => {
  it("prose 'Playwright play-loop' is a claim, not a look — proofKind stays what the check earned", () => {
    withHome(() => {
      const sid = "play-kind-prose";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      armUlwReady(sid, "improve this game", {
        cycle: 1,
        skipCheckpoint: true,
      });
      // Dogfood: a Swift menu-bar app with no browser stamped seven
      // proof=play waves by writing "Play-loop:" in the closer.
      const r = maybeStampUlwWave({
        sessionId: sid,
        editCount: 4,
        openTodoCount: 0,
        stepsSinceStamp: 1,
        lastAssistantMessage:
          "Wave shipped: planted the cry. Playwright play-loop, zero JS errors.",
        verificationPassed: true,
      });
      assert.equal(r.stamped, true);
      const w = loadUlwCycle(sid)!.waves?.at(-1);
      assert.notEqual(w?.proofKind, "play");
      assert.equal(w?.proofKind, "full");
    });
  });

  it("stamps proofKind=play after a structural look (browser call / screenshot read)", () => {
    withHome(() => {
      const sid = "play-kind";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      armUlwReady(sid, "improve this game", {
        cycle: 1,
        skipCheckpoint: true,
      });
      // The loop calls this on playwright/browser MCP calls and png reads.
      notePlayLoopRan(sid);
      const r = maybeStampUlwWave({
        sessionId: sid,
        editCount: 4,
        openTodoCount: 0,
        stepsSinceStamp: 1,
        lastAssistantMessage:
          "Wave shipped: planted the cry. Playwright play-loop, zero JS errors.",
        verificationPassed: true,
      });
      assert.equal(r.stamped, true);
      const w = loadUlwCycle(sid)!.waves?.at(-1);
      assert.equal(w?.proofKind, "play");
      assert.equal(w?.proof, true);
      assert.equal(w?.jobMoved, true);
      // The look is consumed by the stamp — the next wave must look again.
      assert.equal(loadUlwCycle(sid)!.playLoopPending, false);
    });
  });
});
