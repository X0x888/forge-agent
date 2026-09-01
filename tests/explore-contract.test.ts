import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  OFF_CONTRACT_HOLD,
  formatHoldContextAppendix,
  isOnExploreContract,
  loadExploreMapPicks,
} from "../src/harness/explore-contract.js";
import { armUlwReady as armUlwCycle } from "./helpers/ulw-arm.js";
import {
  contractHolding,
  disarmUlwCycle,
  loadUlwCycle,
  maybeStampUlwWave,
} from "../src/harness/ulw-cycle.js";
import {
  collectRecentMillToolIds,
  applyMillHoldPrune,
} from "../src/session/hold-context.js";
import {
  isFullSuiteCommand,
  isHelperOnlyTestCommand,
  isVerificationCommand,
  verificationPassedFromResult,
} from "../src/harness/ulw-cycle.js";
import type { SessionData } from "../src/session/session.js";

describe("helper-only test commands", () => {
  it("flags isolated wN files and not npm test / full tree", () => {
    assert.equal(
      isHelperOnlyTestCommand("node --test tests/w161-pickup-overflow.test.mjs"),
      true,
    );
    assert.equal(
      isHelperOnlyTestCommand(
        "node --test tests/w161-pickup-overflow.test.mjs tests/w22-torch-share.test.mjs",
      ),
      true,
    );
    assert.equal(isHelperOnlyTestCommand("npm test"), false);
    assert.equal(isHelperOnlyTestCommand("npm test 2>&1 | grep fail"), false);
    assert.equal(isHelperOnlyTestCommand("node --test tests/"), false);
    assert.equal(
      isHelperOnlyTestCommand("tsx --test tests/*.test.ts"),
      false,
    );
    assert.equal(
      isHelperOnlyTestCommand("node --test tests/*.test.ts"),
      false,
    );
    assert.equal(isFullSuiteCommand("npm test"), true);
    assert.equal(isFullSuiteCommand("npm test 2>&1 | grep fail"), true);
    assert.equal(isFullSuiteCommand("npm run ci"), true);
    assert.equal(isFullSuiteCommand("npm run check"), true);
    assert.equal(
      isFullSuiteCommand("node --test tests/w161-foo.test.mjs"),
      false,
    );
    assert.equal(
      isHelperOnlyTestCommand(
        "python3 -m unittest tests.test_tool.TestLine.test_line",
      ),
      true,
    );
    assert.equal(
      isHelperOnlyTestCommand("python3 -m unittest discover"),
      false,
    );
    assert.equal(isFullSuiteCommand("python3 -m unittest discover"), true);
    assert.equal(
      isFullSuiteCommand("python3 -m unittest tests.test_tool.TestLine.test_line"),
      false,
    );
    assert.equal(
      verificationPassedFromResult({
        command: "python3 -m unittest tests.test_tool.TestLine.test_line",
        isError: false,
        output: "Ran 1 test in 0.001s\n\nOK\n",
      }),
      true,
    );
    assert.equal(
      isHelperOnlyTestCommand(
        "python3 -m unittest tests.test_tool.TestLine.test_line",
      ),
      true,
    );
    assert.equal(
      isVerificationCommand("node --test tests/w161-pickup-overflow.test.mjs"),
      true,
    );
    assert.equal(
      verificationPassedFromResult({
        command: "node --test tests/w161-pickup-overflow.test.mjs",
        isError: false,
        output: "ℹ fail 0\n",
      }),
      true,
    );
  });
});

describe("explore-map contract", () => {
  const pick =
    "Memory Walk as a 13-floor couple-maze reskin, not find past memories";

  it("matches a ship that names the pick", () => {
    assert.equal(
      isOnExploreContract(
        "Memory Walk must find the kept letter before the portal opens.",
        [pick],
      ),
      true,
    );
    assert.equal(
      isOnExploreContract(
        "The brazier lights you both. Far stays the walker's.",
        [pick],
      ),
      false,
    );
  });

  it("does not treat generic pick words as on-contract", () => {
    const mazePick =
      "Memory Walk is CoupleMaze + copy, not find past memories; next: online-Hearth, same-BSP topology";
    assert.equal(
      isOnExploreContract("The same copy now covers you both.", [mazePick]),
      false,
    );
    assert.equal(
      isOnExploreContract(
        "Shipped: one BSP topology is now per-biome seeds.",
        [mazePick],
      ),
      true,
    );
    assert.equal(
      isOnExploreContract("online Hearth is no longer Sisyphus.", [mazePick]),
      true,
    );
  });

  it("holds after 8 off-contract ships when picks exist", () => {
    const prev = process.env.FORGE_HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ec-"));
    process.env.FORGE_HOME = home;
    try {
      const sid = "ec-1";
      const dir = path.join(home, "sessions", sid);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "meta.json"),
        JSON.stringify({
          exploreMaps: [
            {
              pick,
              passedOn: "combat",
              files: [
                {
                  path: "src/modes/memory-walk.js",
                  line: 9,
                  claim: "reskin",
                },
              ],
              at: new Date().toISOString(),
            },
          ],
        }),
      );
      assert.deepEqual(loadExploreMapPicks(sid), [pick]);
      // A hard mandate: on an open one ("Improve this game.") the Bet
      // contract holds first — six credited ships that touch no bet — so
      // the eight-ship explore contract is tested on its own here.
      armUlwCycle(sid, "Fix the Memory Walk reskin pick and the joiner HUD tag from the explore map; add tests.", {
        cycle: 1,
        skipCheckpoint: true,
        editCount: 0,
      });
      assert.equal(loadUlwCycle(sid)!.openMandate, false);
      const ships = [
        "Wave shipped: hidden lifetime now ticks from the start of a life.",
        "Wave shipped: functional tools no longer spawn fully revealed.",
        "Wave shipped: flood warning is a felt hush not a modal.",
        "Wave shipped: biome layout knobs vary split depth per region.",
        "Wave shipped: the journal leftover recipes become the walk goal.",
        "Wave shipped: ACT no longer swings at a downed partner.",
        "Wave shipped: host bag no longer freezes the joiner tick.",
        "Wave shipped: daily path name appears on the joiner HUD tag.",
      ];
      assert.equal(ships.length, OFF_CONTRACT_HOLD);
      let edits = 0;
      for (const msg of ships) {
        edits += 5;
        const r = maybeStampUlwWave({
          sessionId: sid,
          editCount: edits,
          openTodoCount: 0,
          stepsSinceStamp: 1,
          lastAssistantMessage: msg,
          verificationPassed: true,
        });
        assert.equal(r.stamped, true, msg);
      }
      const s = loadUlwCycle(sid)!;
      assert.ok((s.offContractStreak ?? 0) >= OFF_CONTRACT_HOLD, String(s.offContractStreak));
      assert.equal(contractHolding(s), true);
      assert.equal(s.exploreRequired, true);
      const extra = formatHoldContextAppendix(sid);
      assert.match(extra, /Memory Walk/);
      disarmUlwCycle(sid);
    } finally {
      if (prev === undefined) delete process.env.FORGE_HOME;
      else process.env.FORGE_HOME = prev;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("mill hold suffix prune", () => {
  it("collects recent mill write tool ids and merges into sticky omit", () => {
    const ids = collectRecentMillToolIds([
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call-mill-1",
            type: "function",
            function: {
              name: "write_file",
              arguments: '{"path":"tests/w161-pickup-overflow.test.mjs"}',
            },
          },
          {
            id: "call-ok-1",
            type: "function",
            function: {
              name: "read_file",
              arguments: '{"path":"src/modes/memory-walk.js"}',
            },
          },
        ],
      },
    ]);
    assert.deepEqual(ids, ["call-mill-1"]);
    const session = {
      meta: {
        requestPruneSticky: {
          omitted: ["old-1"],
          collapsed: [],
          softTrimmed: [],
          stubbedHarness: [],
          shelf: 1,
          clippedAt: "2026-08-17T00:00:00.000Z",
        },
      },
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call-mill-1",
              type: "function",
              function: {
                name: "write_file",
                arguments: '{"path":"src/systems/torch-share.js"}',
              },
            },
          ],
        },
      ],
    } as unknown as SessionData;
    const n = applyMillHoldPrune(session);
    assert.equal(n, 1);
    assert.ok(session.meta.requestPruneSticky!.omitted.includes("call-mill-1"));
    assert.ok(session.meta.requestPruneSticky!.omitted.includes("old-1"));
  });

  it("does not invent a first clip when sticky is absent", () => {
    const session = {
      meta: {},
      messages: [],
    } as unknown as SessionData;
    assert.equal(applyMillHoldPrune(session), 0);
    assert.equal(session.meta.requestPruneSticky, undefined);
  });

  it("suffix-omits mill tools without creating sticky", () => {
    const session = {
      meta: {},
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call-mill-2",
              type: "function",
              function: {
                name: "write_file",
                arguments: '{"path":"tests/w9-hush.test.mjs"}',
              },
            },
          ],
        },
      ],
    } as unknown as SessionData;
    assert.equal(applyMillHoldPrune(session), 1);
    assert.equal(session.meta.requestPruneSticky, undefined);
    assert.deepEqual(session.meta.holdOmitToolIds, ["call-mill-2"]);
  });
});
