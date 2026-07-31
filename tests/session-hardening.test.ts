/**
 * P1 session hardening regressions:
 *  1. /undo turn marks must skip synthetic harness user-messages
 *  2. foreign live-lock EPERM (other-user pid) must count as ALIVE
 *  3. title/pin writes are meta-only (never roll back racing messages)
 *  4. session id containment (no path traversal via ids / sidecar meta)
 *  5. /undo restores the journaled pre-image file mode (not always 0600)
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createSession,
  saveSession,
  loadSession,
  loadSessionMeta,
  setSessionTitle,
  setSessionPinned,
  clearConversation,
  markUserTurn,
  rebuildUserTurnMarks,
  rewindSessionDetailed,
  isSyntheticUserMessage,
  isValidSessionId,
  resolveSessionId,
  deleteSessionDetailed,
  sessionHasForeignLiveLock,
  isSessionPinned,
  sessionDir,
  type SessionData,
} from "../src/session/session.js";
import { buildStructuredSummary } from "../src/session/compaction.js";
import { formatLiveNoticesMessage } from "../src/harness/live-notices.js";
import { renderHarnessAdmission } from "../src/harness/context-admit.js";
import { formatInterjectionsMessage } from "../src/harness/interjection.js";
import {
  appendFileMutation,
  readFileMutations,
  restoreMutationsAfterTurn,
  snapshotForWrite,
} from "../src/session/mutations.js";
import { collectUsageStats } from "../src/session/metrics.js";
import { executeTool } from "../src/agent/tools/index.js";

let home: string;
let workspace: string;
let prevHome: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-hard-home-"));
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "forge-hard-ws-"));
  prevHome = process.env.FORGE_HOME;
  process.env.FORGE_HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.FORGE_HOME;
  else process.env.FORGE_HOME = prevHome;
});

function newSession(): SessionData {
  return createSession({ cwd: workspace, provider: "xai", model: "grok-4" });
}

function sessionJsonRaw(id: string): string {
  return fs.readFileSync(path.join(sessionDir(id), "session.json"), "utf8");
}

/** Swap process.kill for a stub throwing the given errno on signal 0. */
function stubKill(code: string): () => void {
  const orig = process.kill;
  process.kill = ((pid: number, signal?: string | number) => {
    if (signal === 0 || signal === undefined) {
      const err = new Error(`kill ${code}`) as NodeJS.ErrnoException;
      err.code = code;
      throw err;
    }
    return orig(pid, signal as number);
  }) as typeof process.kill;
  return () => {
    process.kill = orig;
  };
}

describe("(1) synthetic user messages are not undo turn marks", () => {
  it("isSyntheticUserMessage matches every harness producer format", () => {
    const summary = buildStructuredSummary([
      { role: "user", content: "old prompt" },
      { role: "assistant", content: "old answer" },
    ]);
    assert.ok(summary.startsWith("[Conversation compacted"));
    assert.equal(isSyntheticUserMessage({ role: "user", content: summary }), true);

    const admission = renderHarnessAdmission({
      ulwEnabled: true,
      cycle: 1,
      wave: 2,
      maxWaves: null,
      blocks: 0,
      mandate: "ship it",
      softPrompt: false,
      goalActive: false,
      goalObjective: "",
      goalPaused: false,
      openTodos: 0,
      permissionMode: "default",
      gitBranch: "",
    });
    assert.equal(
      isSyntheticUserMessage({ role: "user", content: admission }),
      true,
    );

    const notice = formatLiveNoticesMessage(["/cycle 0"]);
    assert.equal(
      isSyntheticUserMessage({ role: "user", content: notice }),
      true,
    );

    const interjection = formatInterjectionsMessage(["hold on a second"]);
    assert.equal(
      isSyntheticUserMessage({ role: "user", content: interjection }),
      true,
    );

    // Stop-guard re-anchors / continue steers / nudges all share [Forge…
    for (const steer of [
      "[Forge ULW cycle driver] Stop blocked — cycle=1 wave=1 (CONTINUE).",
      "[Forge /goal driver] Stop blocked — goal not yet achieved.",
      "[Forge TodoGate] Stop blocked — 2 open todo(s) remain.",
      "[Forge handoff-guard] Stop blocked — premature yield / handoff.",
      "[Forge proof-claim] Stop blocked — verification claimed without running it.",
      "[Forge system-reminder — TodoNudge]\nUpdate todos now.",
      "[Forge] Your previous reply was cut off by the output token limit.",
      "[Forge] Context overflow recovered — history was compacted.",
      "   [Forge] leading whitespace is still synthetic",
    ]) {
      assert.equal(
        isSyntheticUserMessage({ role: "user", content: steer }),
        true,
        steer.slice(0, 40),
      );
    }

    // Real user prompts are never synthetic. Note the documented tradeoff:
    // a prompt literally STARTING with "[Forge" is treated as synthetic
    // (fail-safe toward the harness's own tags; /undo then just cuts one
    // real turn deeper after a rebuild).
    assert.equal(
      isSyntheticUserMessage({ role: "user", content: "[Forge notes] deploy" }),
      true,
    );
    for (const real of [
      "fix the login bug",
      "Forge is down, please check the status page",
      "please continue [Forge] mid-sentence is fine",
      "<user_query>\nwrapped real prompt\n</user_query>",
    ]) {
      assert.equal(
        isSyntheticUserMessage({ role: "user", content: real }),
        false,
        real.slice(0, 40),
      );
    }
    assert.equal(
      isSyntheticUserMessage({ role: "assistant", content: "[Forge] x" }),
      false,
    );
    assert.equal(isSyntheticUserMessage({ role: "user", content: null }), false);
  });

  it("rebuildUserTurnMarks excludes synthetic messages", () => {
    const s = newSession();
    s.messages.push({ role: "system", content: "sys" }); // 0
    s.messages.push({ role: "user", content: "real one" }); // 1
    s.messages.push({ role: "assistant", content: "a1" }); // 2
    s.messages.push({
      role: "user",
      content: "[Forge harness — mid-conversation update]\n## ULW",
    }); // 3 synthetic
    s.messages.push({ role: "assistant", content: "a2" }); // 4
    s.messages.push({
      role: "user",
      content: "[Conversation compacted — 9 earlier messages summarized]\nx",
    }); // 5 synthetic
    s.messages.push({ role: "user", content: "real two" }); // 6
    rebuildUserTurnMarks(s);
    assert.deepEqual(s.meta.userTurnMarks, [1, 6]);
  });

  it("/undo after rebuild cuts at the real turn, not a synthetic steer", () => {
    const s = newSession();
    const target = path.join(workspace, "keep.txt");
    fs.writeFileSync(target, "v2\n");
    s.messages.push({ role: "system", content: "sys" }); // 0
    markUserTurn(s);
    s.messages.push({ role: "user", content: "edit the file" }); // 1 real
    s.messages.push({ role: "assistant", content: "working" }); // 2
    s.messages.push({
      role: "user",
      content: "[Forge ULW cycle driver] Stop blocked — cycle=1 wave=1 (CONTINUE).",
    }); // 3 synthetic
    s.messages.push({ role: "assistant", content: "continued" }); // 4
    s.meta.turnCount = 1;
    appendFileMutation(s.meta.id, {
      path: target,
      kind: "update",
      before: "v1\n",
      turn: 1,
    });
    // Force the rebuild path (marks past end, e.g. left by compact)
    s.meta.userTurnMarks = [99];
    const r = rewindSessionDetailed(s, 1);
    assert.equal(r.turns, 1);
    assert.equal(s.messages.length, 1, "only the system message survives");
    assert.equal(s.messages[0]?.role, "system");
    assert.equal(s.meta.turnCount, 0);
    assert.equal(
      fs.readFileSync(target, "utf8"),
      "v1\n",
      "disk restore matches the real rewound turn",
    );
  });

  it("rewind fallback (no marks) also skips synthetic user messages", () => {
    const s = newSession();
    s.messages.push({ role: "user", content: "real prompt" }); // 0
    s.messages.push({ role: "assistant", content: "a1" }); // 1
    s.messages.push({
      role: "user",
      content: "[User control — mid-run]\n/cycle 0",
    }); // 2 synthetic
    s.messages.push({ role: "assistant", content: "a2" }); // 3
    s.meta.turnCount = 1;
    s.meta.userTurnMarks = []; // force fallback scan
    const r = rewindSessionDetailed(s, 1);
    assert.equal(r.removed, 4, "cut at the real prompt, not the notice");
    assert.equal(s.messages.length, 0);
    assert.equal(s.meta.turnCount, 0);
  });
});

describe("(2) EPERM foreign locks are alive", () => {
  it("sessionHasForeignLiveLock: EPERM → locked, ESRCH → free", () => {
    const s = newSession();
    fs.writeFileSync(
      path.join(sessionDir(s.meta.id), "session.lock"),
      JSON.stringify({
        pid: 424_242,
        hostname: "otherhost",
        acquiredAt: new Date().toISOString(),
        sessionId: s.meta.id,
      }),
    );
    let restore = stubKill("EPERM");
    try {
      assert.equal(sessionHasForeignLiveLock(s.meta.id), true);
      const del = deleteSessionDetailed(s.meta.id);
      assert.equal(del.ok, false);
      assert.equal(del.reason, "locked");
    } finally {
      restore();
    }
    restore = stubKill("ESRCH");
    try {
      assert.equal(sessionHasForeignLiveLock(s.meta.id), false);
    } finally {
      restore();
    }
  });

  it("collectUsageStats counts EPERM lock holders as locked", () => {
    const id = "deadbeef-lock";
    const dir = path.join(home, "sessions", id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "meta.json"),
      JSON.stringify({
        id,
        cwd: workspace,
        provider: "xai",
        model: "m",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    fs.writeFileSync(
      path.join(dir, "session.lock"),
      JSON.stringify({ pid: 424_243 }),
    );
    let restore = stubKill("EPERM");
    try {
      assert.equal(collectUsageStats().sessions.locked, 1);
    } finally {
      restore();
    }
    restore = stubKill("ESRCH");
    try {
      assert.equal(collectUsageStats().sessions.locked, 0);
    } finally {
      restore();
    }
  });
});

describe("(3) title/pin writes are meta-only", () => {
  it("setSessionTitle does not touch session.json and never rolls back newer messages", () => {
    const s = newSession();
    s.messages.push({ role: "user", content: "first" });
    saveSession(s);
    // CLI loads a snapshot, then the racing session appends + saves.
    const cliSnap = loadSession(s.meta.id)!;
    s.messages.push({ role: "assistant", content: "newer reply" });
    saveSession(s);
    const before = sessionJsonRaw(s.meta.id);
    setSessionTitle(cliSnap, "incident-42");
    assert.equal(
      sessionJsonRaw(s.meta.id),
      before,
      "session.json untouched by a meta-only title write",
    );
    const reloaded = loadSession(s.meta.id)!;
    assert.equal(reloaded.meta.title, "incident-42");
    assert.equal(reloaded.messages.length, 2, "newer messages survive");
  });

  it("a racing process save does not revert an externally-set title/pin", () => {
    const s = newSession();
    s.messages.push({ role: "user", content: "hi" });
    saveSession(s);
    // Second process (its own handle) sets title + pin meta-only.
    const other = loadSession(s.meta.id)!;
    setSessionTitle(other, "keep-this");
    setSessionPinned(other, true);
    assert.equal(s.meta.title, undefined, "first process unaware in memory");
    saveSession(s); // its next save must merge, not revert
    assert.equal(s.meta.title, "keep-this", "merged into the saving process");
    assert.equal(s.meta.pinned, true);
    const meta = loadSessionMeta(s.meta.id)!;
    assert.equal(meta.title, "keep-this");
    assert.equal(isSessionPinned(meta), true);
    const full = loadSession(s.meta.id)!;
    assert.equal(full.meta.title, "keep-this");
    assert.equal(isSessionPinned(full), true);
  });

  it("in-process clear/unpin stays cleared (sidecar updated first)", () => {
    const s = newSession();
    s.messages.push({ role: "user", content: "hi" });
    saveSession(s);
    setSessionTitle(s, "temp");
    setSessionPinned(s, true);
    setSessionTitle(s, "");
    setSessionPinned(s, false);
    saveSession(s);
    const meta = loadSessionMeta(s.meta.id)!;
    assert.equal(meta.title, undefined);
    assert.equal(isSessionPinned(meta), false);
  });

  it("clearConversation wipes the title durably (no merge resurrection)", () => {
    const s = newSession();
    s.messages.push({ role: "user", content: "hi" });
    saveSession(s);
    setSessionTitle(s, "wipe-me");
    clearConversation(s);
    assert.equal(loadSessionMeta(s.meta.id)!.title, undefined);
    saveSession(s);
    assert.equal(loadSessionMeta(s.meta.id)!.title, undefined);
  });

  it("loadSession treats the sidecar as authoritative for title/pinned", () => {
    const s = newSession();
    s.meta.title = "primary-title";
    saveSession(s);
    const sidePath = path.join(sessionDir(s.meta.id), "meta.json");
    const side = JSON.parse(fs.readFileSync(sidePath, "utf8")) as Record<
      string,
      unknown
    >;
    side.title = "side-title";
    side.pinned = true;
    fs.writeFileSync(sidePath, JSON.stringify(side));
    const loaded = loadSession(s.meta.id)!;
    assert.equal(loaded.meta.title, "side-title");
    assert.equal(loaded.meta.pinned, true);
  });
});

describe("(4) session id containment", () => {
  it("isValidSessionId accepts slugs, rejects traversal shapes", () => {
    assert.equal(isValidSessionId(randomUUID()), true);
    assert.equal(isValidSessionId("abc123_DEF-456"), true);
    for (const bad of [
      "../../x",
      "..",
      "../evil",
      "a/b",
      "a\\b",
      "a.b",
      "a..b",
      "",
      " x",
      "-abc",
      "_abc",
      ".hidden",
      "a".repeat(200),
    ]) {
      assert.equal(isValidSessionId(bad), false, JSON.stringify(bad));
    }
  });

  it("resolveSessionId refuses traversal even when the escaped dir looks like a session", () => {
    const evil = path.join(home, "evil-lookalike");
    fs.mkdirSync(evil, { recursive: true });
    fs.writeFileSync(
      path.join(evil, "session.json"),
      JSON.stringify({ meta: { id: "evil" }, messages: [], todos: [] }),
    );
    // "../evil-lookalike" resolves outside sessions/ into a dir that WOULD
    // pass sessionDirLooksValid — the exact delete-rm -rf bait.
    assert.equal(resolveSessionId("../evil-lookalike"), null);
    const del = deleteSessionDetailed("../evil-lookalike");
    assert.equal(del.ok, false);
    assert.equal(del.reason, "not_found");
    assert.ok(
      fs.existsSync(path.join(evil, "session.json")),
      "nothing outside the sessions root was touched",
    );
  });

  it("poisoned sidecar ids fall back to the containing directory id", () => {
    const s = newSession();
    const sidePath = path.join(sessionDir(s.meta.id), "meta.json");
    const side = JSON.parse(fs.readFileSync(sidePath, "utf8")) as Record<
      string,
      unknown
    >;
    side.id = "../../poisoned";
    fs.writeFileSync(sidePath, JSON.stringify(side));
    const meta = loadSessionMeta(s.meta.id)!;
    assert.equal(meta.id, s.meta.id);
    // Full load stays intact and ignores the foreign sidecar overlay
    const loaded = loadSession(s.meta.id)!;
    assert.equal(loaded.meta.id, s.meta.id);
  });
});

describe("(5) undo restores the journaled pre-image mode", () => {
  it("snapshotForWrite captures the pre-image mode", async () => {
    const p = path.join(workspace, "m.txt");
    fs.writeFileSync(p, "x\n");
    fs.chmodSync(p, 0o640);
    const snap = await snapshotForWrite(p);
    assert.equal(snap.kind, "update");
    if (process.platform !== "win32") {
      assert.equal(snap.mode, 0o640);
    }
  });

  it("restore re-applies the journaled mode (0600 only when unknown)", () => {
    const s = newSession();
    const a = path.join(workspace, "script.sh");
    fs.writeFileSync(a, "echo v1\n");
    appendFileMutation(s.meta.id, {
      path: a,
      kind: "update",
      before: "echo v1\n",
      mode: 0o755,
      turn: 1,
    });
    const b = path.join(workspace, "legacy.txt");
    fs.writeFileSync(b, "old\n");
    appendFileMutation(s.meta.id, {
      path: b,
      kind: "update",
      before: "old\n",
      turn: 1, // no mode — legacy journal entry
    });
    fs.writeFileSync(a, "echo v2\n");
    fs.chmodSync(a, 0o644);
    fs.writeFileSync(b, "new\n");
    fs.chmodSync(b, 0o644);
    const r = restoreMutationsAfterTurn(s.meta.id, 0);
    assert.deepEqual(r.failed, []);
    assert.equal(fs.readFileSync(a, "utf8"), "echo v1\n");
    assert.equal(fs.readFileSync(b, "utf8"), "old\n");
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(a).mode & 0o777, 0o755, "journaled +x restored");
      assert.equal(
        fs.statSync(b).mode & 0o777,
        0o600,
        "unknown mode falls back to restrictive 0600",
      );
    }
  });

  it("search_replace journals pre-image mode; /undo keeps scripts executable", async () => {
    const s = newSession();
    const target = path.join(workspace, "run.sh");
    fs.writeFileSync(target, "echo v1\n");
    fs.chmodSync(target, 0o755);
    s.meta.turnCount = 1;
    markUserTurn(s);
    s.messages.push({ role: "user", content: "edit script" });
    const res = await executeTool(
      "search_replace",
      JSON.stringify({
        path: "run.sh",
        old_string: "v1",
        new_string: "v2",
      }),
      {
        workspace,
        recordMutation: (input) =>
          appendFileMutation(s.meta.id, { ...input, turn: s.meta.turnCount }),
      },
    );
    assert.equal(res.isError, undefined);
    const journal = readFileMutations(s.meta.id);
    assert.equal(journal.length, 1);
    if (process.platform !== "win32") {
      assert.equal(journal[0]!.mode, 0o755);
    }
    s.messages.push({ role: "assistant", content: "done" });
    const rw = rewindSessionDetailed(s, 1);
    assert.deepEqual(rw.disk?.failed ?? [], []);
    assert.equal(fs.readFileSync(target, "utf8"), "echo v1\n");
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(target).mode & 0o777, 0o755);
    }
  });
});
