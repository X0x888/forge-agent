import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isLeftoverSiblingShip,
  isSameSurface,
  isSitDownCardShip,
  isSlashPeekMillShip,
  isDumpCatalogPick,
  isPeekMillPaths,
  nextSameSurfaceStreak,
  surfaceHits,
  surfaceKey,
  surfaceOverlap,
  SAME_SURFACE_HOLD,
  SIT_DOWN_SURFACE_KEY,
} from "../src/harness/same-surface.js";

const MAZE_27 =
  "Smoke is green. Objective: you only notice things along openings, not through stone. Proof: `npm test`.";
const MAZE_28 =
  "You only notice things along openings now — not through stone. **What you will feel** - A shape around the corner stays unknown until the c…";
const MAZE_29 =
  "Smoke is green. Objective: the floor you see is a floor you can walk. Proof: `npm test`.";
const MAZE_35 =
  "Smoke is green. Objective: rest only names what you have actually lived. Proof: `npm test`.";
const MAZE_36 =
  "Rest now only names what you have actually lived. **What you will feel** - A first rest on dry stone does not mention water or weight.";
const MAZE_37 =
  "Consolidation pass. The leftover rest card no longer names water, weight, or the hidden hour. **What you will feel** - A first pause only s…";
const MAZE_38 =
  "Smoke is green. Objective: you only hear nearby things along openings, not through stone. Proof: `npm test`.";
const MAZE_39 =
  "Smoke is green. Objective: listen only along openings. Proof: `npm test`.";
const MAZE_40 =
  "Smoke is green. Leftover: wanderer proximity still leaks through stone to the audio. Fix that only.";
const LIFETIME =
  "Hidden lifetime now ticks from the start of a life, not only after a reveal.";
const ITEMS =
  "Functional tools no longer spawn fully revealed on depths 1–3.";
const FLOOD_WARN =
  "Flood warning is a felt hush, not a modal popup.";
const FLOOD_SPREAD =
  "Flood water spreads through open neighbors only.";

describe("same-surface tokens", () => {
  it("strips ritual smoke/proof words so maze 27 and 28 overlap", () => {
    assert.ok(surfaceKey(MAZE_27).includes("openings"));
    assert.doesNotMatch(surfaceKey(MAZE_27), /smoke|objective|proof|npm/);
    assert.ok(isSameSurface(MAZE_27, MAZE_28));
    assert.ok(surfaceHits(MAZE_27, MAZE_28) >= 2);
    assert.ok(surfaceOverlap(MAZE_27, MAZE_28) >= 0.5);
  });

  it("does not treat flood warning vs flood spread as the same surface", () => {
    assert.equal(isSameSurface(FLOOD_WARN, FLOOD_SPREAD), false);
  });

  it("does not treat lifetime tick vs revealed tools as the same surface", () => {
    assert.equal(isSameSurface(LIFETIME, ITEMS), false);
  });
});

describe("sit-down-card class", () => {
  const resume =
    "Sit-down resume is verdict-first. When something is wrong, forge and /resume open on the problem.";
  const verify =
    "**Ship landed:** `/verify` is the sit-down Next for the proof trail. Trust is the key you type.";
  const commit =
    "**`/commit` is now a real key.** Typing it no longer starts a model turn — the same hole `/verify` closed. Sit-down already showed the problem.";
  const budget =
    "**`/budget` is now a sit-down key**, not a config dump. Sit-down already showed `budget HIT`.";
  const flood = FLOOD_WARN;

  it("classifies sit-down slash keys as one surface", () => {
    assert.equal(isSitDownCardShip(resume), true);
    assert.equal(isSitDownCardShip(verify), true);
    assert.equal(isSitDownCardShip(commit), true);
    assert.equal(isSitDownCardShip(budget), true);
    assert.equal(isSitDownCardShip(flood), false);
    assert.equal(
      isSitDownCardShip(
        "Sit-down glance: --help / argv is the operator first line, not a dump.",
      ),
      true,
    );
    assert.equal(
      isSitDownCardShip("Wave shipped: document --help for the new flag."),
      false,
    );
    assert.equal(surfaceKey(verify), SIT_DOWN_SURFACE_KEY);
    assert.equal(isSameSurface(verify, commit), true);
    assert.equal(isSameSurface(resume, budget), true);
    assert.equal(isSameSurface(verify, flood), false);
  });

  it("three sit-down ships reach hold streak", () => {
    const a = nextSameSurfaceStreak([], verify, 0);
    assert.equal(a.streak, 1);
    const b = nextSameSurfaceStreak([verify], commit, a.streak);
    assert.equal(b.same, true);
    assert.equal(b.streak, 2);
    const c = nextSameSurfaceStreak([verify, commit], budget, b.streak);
    assert.equal(c.same, true);
    assert.equal(c.streak, 3);
    assert.ok(c.streak >= SAME_SURFACE_HOLD);
  });
});

describe("slash-peek mill is one job", () => {
  const model =
    "Ship: `/model` is a verdict-first sit-down card, not formatParamMenu. ``` model  ·  grok-4.6 Next  /effort ```";
  const context =
    "Ship: `/context` is a sit-down peek, not a bar lecture. ``` context  ·  HARD Next  /compact ```";
  const mcp =
    "`/mcp` is a connect/ready/error peek. The catalog moved to `/mcp tools`.";

  it("clusters /model /context /mcp peeks as the same surface", () => {
    assert.equal(isSlashPeekMillShip(model), true);
    assert.equal(isSlashPeekMillShip(context), true);
    assert.equal(isSlashPeekMillShip(mcp), true);
    assert.equal(isSameSurface(model, context), true);
    assert.equal(isSameSurface(model, mcp), true);
    assert.equal(surfaceKey(model), SIT_DOWN_SURFACE_KEY);
    assert.equal(surfaceKey(mcp), SIT_DOWN_SURFACE_KEY);
  });

  it("treats *-card.ts trees as one peek-mill surface", () => {
    assert.equal(
      isPeekMillPaths(["src/tui/model-card.ts", "src/commands/slash.ts"]),
      true,
    );
    assert.equal(isPeekMillPaths(["src/tui/context-card.ts"]), true);
    assert.equal(isPeekMillPaths(["src/commands/slash.ts"]), false);
    assert.equal(
      isPeekMillPaths(["src/tui/model-card.ts", "src/session/mutations.ts"]),
      false,
    );
    assert.equal(
      isDumpCatalogPick("`/model` still dumps formatParamMenu as a numbered catalog."),
      true,
    );
  });

  it("explore dump-picks do not reset the peek-mill streak", () => {
    const a = nextSameSurfaceStreak([], model, 0);
    assert.equal(a.streak, 1);
    const b = nextSameSurfaceStreak([model], context, a.streak, {
      onContract: true,
    });
    assert.equal(b.same, true);
    assert.equal(b.streak, 2);
    const c = nextSameSurfaceStreak([model, context], mcp, b.streak, {
      onContract: true,
    });
    assert.equal(c.same, true);
    assert.equal(c.streak, 3);
    assert.ok(c.streak >= SAME_SURFACE_HOLD);
  });
});

describe("leftover-sibling language", () => {
  it("flags maze wave 40 Fix that only", () => {
    assert.equal(isLeftoverSiblingShip(MAZE_40), true);
    assert.equal(isLeftoverSiblingShip(MAZE_37), true);
    assert.equal(isLeftoverSiblingShip(LIFETIME), false);
  });
});

describe("maze streak replay", () => {
  it("27–28 is streak 2, not a hold", () => {
    const a = nextSameSurfaceStreak([], MAZE_27, 0);
    assert.equal(a.streak, 1);
    const b = nextSameSurfaceStreak([MAZE_27], MAZE_28, a.streak);
    assert.equal(b.same, true);
    assert.equal(b.streak, 2);
    assert.ok(b.streak < SAME_SURFACE_HOLD);
  });

  it("35–37 rest card reaches hold", () => {
    const a = nextSameSurfaceStreak([], MAZE_35, 0);
    const b = nextSameSurfaceStreak([MAZE_35], MAZE_36, a.streak);
    assert.equal(b.same, true);
    const c = nextSameSurfaceStreak([MAZE_35, MAZE_36], MAZE_37, b.streak);
    assert.equal(c.same, true);
    assert.ok(c.streak >= SAME_SURFACE_HOLD, `rest streak=${c.streak}`);
  });

  it("38–40 listen / leftover audio reaches hold", () => {
    const a = nextSameSurfaceStreak([], MAZE_38, 0);
    const b = nextSameSurfaceStreak([MAZE_38], MAZE_39, a.streak);
    assert.equal(b.same, true, "38–39 should be same surface");
    const c = nextSameSurfaceStreak([MAZE_38, MAZE_39], MAZE_40, b.streak);
    assert.equal(c.same, true, "40 leftover should continue the listen theme");
    assert.ok(c.streak >= SAME_SURFACE_HOLD, `listen streak=${c.streak}`);
  });

  it("one-wave pivot does not reset a returned theme (28 → 29 → 38)", () => {
    const after28 = nextSameSurfaceStreak([], MAZE_28, 0);
    const floor = nextSameSurfaceStreak([MAZE_28], MAZE_29, after28.streak);
    assert.equal(floor.same, false);
    assert.equal(floor.streak, 1);
    const back = nextSameSurfaceStreak([MAZE_28, MAZE_29], MAZE_38, floor.streak);
    assert.equal(back.same, true);
    assert.equal(back.streak, 2);
  });

  it("lifetime then items does not hold", () => {
    const a = nextSameSurfaceStreak([], LIFETIME, 0);
    const b = nextSameSurfaceStreak([LIFETIME], ITEMS, a.streak);
    assert.equal(b.same, false);
    assert.equal(b.streak, 1);
  });

  it("true consolidation closer does not increment or reset", () => {
    const a = nextSameSurfaceStreak([], MAZE_35, 0);
    const b = nextSameSurfaceStreak([MAZE_35], MAZE_36, a.streak);
    const cons = nextSameSurfaceStreak(
      [MAZE_35, MAZE_36],
      "Wave shipped (consolidation). No new scope. 1819 tests pass.",
      b.streak,
      { consolidation: true },
    );
    assert.equal(cons.streak, b.streak);
    assert.equal(cons.same, false);
  });
});
