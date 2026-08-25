import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CITE_DELTA_POKE,
  citeDeltaShouldPoke,
  citeDeltaShouldStop,
  exploreMapWindow,
  formatExploreMap,
  formatExploreMapDeref,
  lookupExploreMapFile,
  noteCiteDelta,
  parseExploreMap,
  pathsMatch,
  readHasExplicitWindow,
  rememberExploreMap,
  normalizeExploreMaps,
} from "../src/session/explore-map.js";
import type { SessionData, SessionMeta } from "../src/session/session.js";
import { toolRead } from "../src/agent/tools/read.js";
import type { ToolContext } from "../src/agent/tools/types.js";

describe("parseExploreMap", () => {
  it("parses pick / passed_on / file:line claims", () => {
    const map = parseExploreMap(`
pick: first-run 1–6 are not typeable
passed_on: README version skew
files:
  src/tui/repl.ts:345  idle digits go to the model
  src/util/setup-readiness.ts:158  card advertises 1–6
`);
    assert.ok(map);
    assert.match(map!.pick, /1–6/);
    assert.match(map!.passedOn, /README/);
    assert.equal(map!.files.length, 2);
    assert.equal(map!.files[0]!.path, "src/tui/repl.ts");
    assert.equal(map!.files[0]!.line, 345);
  });

  it("returns null when there is no map", () => {
    assert.equal(parseExploreMap("I looked at a lot of files today."), null);
  });

  it("returns null for a file list without pick:", () => {
    assert.equal(
      parseExploreMap(
        "files:\n  src/game.js:411  Boot starts this.players = []\n  src/net/protocol.js:10  encodeMonsterTells\n",
      ),
      null,
    );
    assert.equal(parseExploreMap("pick:\nfiles:\n  a.ts:1  x\n"), null);
  });
});

describe("explore map session lookup", () => {
  it("remembers and finds by relative or suffix path", () => {
    const meta = { exploreMaps: [] } as unknown as SessionMeta;
    const map = parseExploreMap(
      "pick: dock\nfiles:\n  src/tui/repl.ts:10  handleLine\n",
    )!;
    rememberExploreMap(meta, map);
    const hit = lookupExploreMapFile(meta, "/Users/x/src/tui/repl.ts");
    assert.ok(hit);
    assert.match(formatExploreMapDeref(hit!), /handleLine/);
    assert.match(formatExploreMap(map), /pick: dock/);
    assert.equal(pathsMatch("src/tui/repl.ts", "/abs/src/tui/repl.ts"), true);
  });

  it("offset/limit is an explicit window", () => {
    assert.equal(readHasExplicitWindow({ path: "a.ts" }), false);
    assert.equal(readHasExplicitWindow({ path: "a.ts", offset: 1 }), true);
    assert.equal(readHasExplicitWindow({ path: "a.ts", limit: 20 }), true);
  });

  it("normalizeExploreMaps drops garbage and keeps claims", () => {
    assert.equal(normalizeExploreMaps(null), undefined);
    assert.equal(normalizeExploreMaps("x"), undefined);
    const maps = normalizeExploreMaps([
      { pick: "dock", files: [{ path: "src/tui/repl.ts", line: 10, claim: "x" }] },
      { pick: "", files: [] },
      {
        pick: "",
        files: [{ path: "src/game.js", line: 411, claim: "Boot starts empty" }],
      },
      7,
      { files: [{ path: "", claim: "nope" }] },
    ]);
    assert.ok(maps);
    assert.equal(maps!.length, 1);
    assert.equal(maps![0]!.files[0]!.path, "src/tui/repl.ts");
  });

  it("windows ±40 around a cited line", () => {
    assert.deepEqual(exploreMapWindow(345), { offset: 305, limit: 81 });
    assert.deepEqual(exploreMapWindow(10), { offset: 1, limit: 81 });
  });
});

describe("cite-delta", () => {
  it("resets on growth and pokes then stops", () => {
    const seen = new Set<string>();
    assert.equal(noteCiteDelta(seen, ["a.ts"], 0).staleTurns, 0);
    assert.equal(noteCiteDelta(seen, ["a.ts"], 0).staleTurns, 1);
    assert.equal(noteCiteDelta(seen, ["a.ts"], 1).staleTurns, 2);
    assert.equal(citeDeltaShouldPoke(2), true);
    assert.equal(citeDeltaShouldStop(2, false), false);
    assert.equal(citeDeltaShouldStop(2, true), true);
    assert.equal(
      citeDeltaShouldStop(2, true, { lastWasToolsOnly: true }),
      false,
    );
    assert.equal(
      citeDeltaShouldStop(2, true, { hasPick: true, lastWasToolsOnly: true }),
      true,
    );
    assert.equal(
      citeDeltaShouldStop(2, true, { hasPick: false, lastWasToolsOnly: false }),
      true,
    );
    assert.equal(
      citeDeltaShouldStop(2, true, {
        lastWasToolsOnly: true,
        pickDemanded: true,
      }),
      true,
    );
    assert.match(CITE_DELTA_POKE, /Cite-delta/);
    assert.equal(noteCiteDelta(seen, ["a.ts", "b.ts"], 2).staleTurns, 0);
    // Pathless grep/glob (no path args) still counts as stale.
    assert.equal(noteCiteDelta(new Set(), [], 0).staleTurns, 1);
  });
});

describe("toolRead explore-map deref", () => {
  it("returns the claim when the map has no line, and a window when it does", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-map-read-"));
    try {
      const body = Array.from({ length: 200 }, (_, i) => `L${i + 1}`).join("\n");
      fs.writeFileSync(path.join(dir, "repl.ts"), body, "utf8");
      const map = parseExploreMap(
        "pick: idle digits\nfiles:\n  repl.ts:50  handleLine\n  notes.md  no line\n",
      )!;
      const session = {
        meta: { exploreMaps: [] },
        messages: [],
      } as unknown as SessionData;
      rememberExploreMap(session.meta, map);
      const ctx: ToolContext = { workspace: dir, session };

      const windowed = await toolRead({ path: "repl.ts" }, ctx);
      assert.match(windowed.output, /In explore map: repl.ts:50/);
      assert.match(windowed.output, /handleLine/);
      assert.match(windowed.output, /Windowed/);
      assert.match(windowed.output, /L50/);
      assert.doesNotMatch(windowed.output, /L200/);

      const explicit = await toolRead({ path: "repl.ts", offset: 1, limit: 3 }, ctx);
      assert.match(explicit.output, /L1/);
      assert.doesNotMatch(explicit.output, /In explore map/);

      fs.writeFileSync(path.join(dir, "notes.md"), "hello\n", "utf8");
      const claimOnly = await toolRead({ path: "notes.md" }, ctx);
      assert.match(claimOnly.output, /In explore map: notes.md/);
      assert.doesNotMatch(claimOnly.output, /^File:/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("mapped read wins over the unchanged-full-read stub", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-map-stub-"));
    const prevGuard = process.env.FORGE_FILE_READ_GUARD;
    process.env.FORGE_FILE_READ_GUARD = "1";
    try {
      const body = Array.from({ length: 80 }, (_, i) => `L${i + 1}`).join("\n");
      fs.writeFileSync(path.join(dir, "dock.ts"), body, "utf8");
      const { FileReadState } = await import("../src/agent/tools/file-read-state.js");
      const fileReads = new FileReadState();
      const session = {
        meta: { exploreMaps: [] },
        messages: [],
      } as unknown as SessionData;
      const ctx: ToolContext = { workspace: dir, session, fileReads };
      const first = await toolRead({ path: "dock.ts" }, ctx);
      assert.match(first.output, /File:/);
      session.messages = [
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "r1",
              type: "function",
              function: {
                name: "read_file",
                arguments: JSON.stringify({ path: "dock.ts" }),
              },
            },
          ],
        },
        { role: "tool", tool_call_id: "r1", content: first.output },
      ];
      rememberExploreMap(
        session.meta,
        parseExploreMap("pick: dock\nfiles:\n  dock.ts:20  paint\n")!,
      );
      const mapped = await toolRead({ path: "dock.ts" }, ctx);
      assert.match(mapped.output, /In explore map: dock.ts:20/);
      assert.match(mapped.output, /L20/);
      assert.doesNotMatch(mapped.output, /Unchanged since last read/);
    } finally {
      if (prevGuard === undefined) delete process.env.FORGE_FILE_READ_GUARD;
      else process.env.FORGE_FILE_READ_GUARD = prevGuard;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
