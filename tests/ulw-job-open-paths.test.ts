/**
 * Job-move credit follows the OPEN job. Every explore path ever cited used
 * to count forever — a single-file Swift app credited 185/256 waves as job
 * moves because every edit touched Sources/main.swift.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildUlwJobCard,
  collectUlwJobKeepPaths,
  extractReadingFilePaths,
  formatUlwJobCard,
} from "../src/harness/ulw-job-card.js";
import { appendMemoryRecord } from "../src/harness/decision-memory.js";
import { hasUlwPlan } from "../src/harness/decision-memory.js";

function withHome(fn: () => void): void {
  const prev = process.env.FORGE_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-jobopen-"));
  process.env.FORGE_HOME = dir;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const PICK_A =
  "Permission extra click never opens Settings after a real tap-create fail and instead haptic-muteStarted";
const PICK_B =
  "Isolate Front Safari never ends while any com.apple.WebKit helper is still running";

function seedMaps(sid: string): void {
  const dir = path.join(process.env.FORGE_HOME!, "sessions", sid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify({
      exploreMaps: [
        { pick: PICK_A, files: [{ path: "Sources/Permission.swift", line: 10, claim: "retryThenOpenSettings" }] },
        { pick: PICK_B, files: [{ path: "Sources/IsolateFront.swift", line: 44, claim: "runningIsolationKeys" }] },
      ],
    }),
  );
}

describe("collectUlwJobKeepPaths openOnly", () => {
  it("drops the paths of a done explore pick; keeps open picks and open named ships", () => {
    withHome(() => {
      const sid = "jobopen-1";
      seedMaps(sid);
      const namedShips = [
        { text: PICK_A, status: "done", source: "explore-map" },
        { text: PICK_B, status: "open", source: "explore-map" },
        { text: "wire src/export/csv.ts to the session ledger", status: "open", source: "reading" },
        { text: "retire src/legacy/old-dock.ts", status: "done", source: "reading" },
      ];
      const broad = collectUlwJobKeepPaths(sid, { namedShips });
      assert.ok(broad.includes("Sources/Permission.swift"));
      assert.ok(broad.includes("Sources/IsolateFront.swift"));
      assert.ok(broad.includes("src/legacy/old-dock.ts"), "prune keep-set stays broad");

      const open = collectUlwJobKeepPaths(sid, { namedShips, openOnly: true });
      assert.equal(open.includes("Sources/Permission.swift"), false, "done pick is no longer the job");
      assert.ok(open.includes("Sources/IsolateFront.swift"));
      assert.ok(open.includes("src/export/csv.ts"));
      assert.equal(open.includes("src/legacy/old-dock.ts"), false, "done named ship is not the job");
    });
  });

  it("keeps every explore path while nothing is seeded yet (the map is the job)", () => {
    withHome(() => {
      const sid = "jobopen-2";
      seedMaps(sid);
      const open = collectUlwJobKeepPaths(sid, { namedShips: [], openOnly: true });
      assert.ok(open.includes("Sources/Permission.swift"));
      assert.ok(open.includes("Sources/IsolateFront.swift"));
    });
  });
});

describe("reading file paths beyond JS/Py/Rust/Go", () => {
  it("recognises Swift / Kotlin / C# / Ruby / Zig / Dart sources", () => {
    const paths = extractReadingFilePaths(
      "ONE ship: Sources/main.swift pause+pendingWakeRebuild; app/Main.kt; Api/Controllers/Auth.cs; lib/dock.rb; src/main.zig; lib/app.dart; keep README.md",
    );
    assert.deepEqual(paths, [
      "Sources/main.swift",
      "app/Main.kt",
      "Api/Controllers/Auth.cs",
      "lib/dock.rb",
      "src/main.zig",
      "lib/app.dart",
      "README.md",
    ]);
  });

  it("a Swift Reading with its build script is a plan (hasUlwPlan)", () => {
    withHome(() => {
      const sid = "jobopen-swift-plan";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), { recursive: true });
      assert.equal(
        hasUlwPlan(
          sid,
          "Reading: Product is menu-bar isolator. ONE ship: isolationHotKeyAction pause; tests; ./build.sh && --self-test.",
        ),
        true,
      );
    });
  });
});

describe("job card current reading", () => {
  it("prints the latest re-PLAN Reading beside Wave 1 when they differ", () => {
    withHome(() => {
      const sid = "jobopen-card";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), { recursive: true });
      appendMemoryRecord(sid, {
        kind: "decision",
        source: "agent",
        text: "Reading: Product is a folder messenger. ONE ship: live snapshot mutate tax in src/store.ts. Verify: npm test",
      });
      appendMemoryRecord(sid, {
        kind: "decision",
        source: "agent",
        text: "Reading: named ships from waves 1–6 are spent. Different class: first launch when the daemon never comes up — src/App.tsx. Verify: npm test",
      });
      const card = buildUlwJobCard({ sessionId: sid, waves: [], namedShips: [] });
      assert.match(card.wave1Reading || "", /folder messenger/);
      assert.match(card.currentReading || "", /daemon never comes up/);
      const text = formatUlwJobCard(card);
      assert.match(text, /Wave 1 reading: Product is a folder messenger/);
      assert.match(text, /Current reading \(latest re-PLAN\): named ships from waves 1–6 are spent/);
    });
  });

  it("omits the current reading line when Wave 1 is still the plan", () => {
    withHome(() => {
      const sid = "jobopen-card-same";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), { recursive: true });
      appendMemoryRecord(sid, {
        kind: "decision",
        source: "agent",
        text: "Reading: Product is a folder messenger. ONE ship: live snapshot mutate tax in src/store.ts. Verify: npm test",
      });
      const card = buildUlwJobCard({ sessionId: sid, waves: [], namedShips: [] });
      assert.equal(card.currentReading, undefined);
      assert.doesNotMatch(formatUlwJobCard(card), /Current reading/);
    });
  });
});
