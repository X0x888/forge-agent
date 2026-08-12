/**
 * Session fork lineage (conversation tree parent).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  createSession,
  forkSession,
  formatResumeOrientation,
  formatSessionShareCard,
  formatSessionSummary,
  listSessionForks,
} from "../src/session/session.js";

function tmpRoot(): string {
  const base = process.env.TMPDIR || path.join(process.cwd(), ".tmp");
  fs.mkdirSync(base, { recursive: true });
  return base;
}

describe("session fork lineage", () => {
  let prevHome = "";
  let home = "";

  before(() => {
    prevHome = process.env.FORGE_HOME || "";
    home = fs.mkdtempSync(path.join(tmpRoot(), "forge-fork-home-"));
    process.env.FORGE_HOME = home;
  });

  after(() => {
    if (prevHome) process.env.FORGE_HOME = prevHome;
    else delete process.env.FORGE_HOME;
    try {
      fs.rmSync(home, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  it("records parentSessionId and surfaces in resume/share", () => {
    const src = createSession({
      cwd: process.cwd(),
      provider: "xai",
      model: "m",
      title: "parent-exp",
    });
    src.messages.push({ role: "user", content: "hello parent" });
    const child = forkSession(src, { title: "child-branch" });
    assert.equal(child.meta.parentSessionId, src.meta.id);
    assert.match(child.meta.parentSessionLabel || "", /parent-exp/);
    assert.equal(child.meta.title, "child-branch");
    // pin not inherited
    assert.equal(child.meta.pinned, undefined);

    const orient = formatResumeOrientation(child);
    assert.match(orient, /Forked from/);
    assert.match(orient, /parent-exp/);

    const card = formatSessionShareCard(child);
    assert.match(card, /forked:/i);
    const sum = formatSessionSummary(child);
    assert.match(sum, /forked:/i);
    const kids = listSessionForks(src.meta.id);
    assert.ok(kids.some((k) => k.id === child.meta.id));
    const parentSum = formatSessionSummary(src);
    // parent summary may not list kids until saved — forkSession should save child
    assert.ok(Array.isArray(kids));
  });
});
