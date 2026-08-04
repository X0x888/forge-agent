import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  atomicWriteFile,
  atomicWriteFileSync,
} from "../src/agent/tools/atomic-write.js";

function tmpFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-aw-"));
  return path.join(dir, name);
}

/**
 * Create a file with an exact permission mode without calling chmod.
 * Sandboxed runners often allow open(mode=…) but deny chmod(2).
 * Returns false when the platform/umask cannot honor the requested mode.
 */
function writeWithMode(p: string, body: string, mode: number): boolean {
  fs.writeFileSync(p, body, { mode });
  return (fs.statSync(p).mode & 0o777) === (mode & 0o777);
}

describe("atomic-write mode preservation", () => {
  it("keeps 0600 when editing a secret file", async () => {
    const p = tmpFile("secret.txt");
    if (!writeWithMode(p, "before", 0o600)) return;
    await atomicWriteFile(p, "after");
    assert.equal(fs.readFileSync(p, "utf8"), "after");
    assert.equal(fs.statSync(p).mode & 0o777, 0o600);
  });

  it("keeps 0755 when editing an executable", async () => {
    const p = tmpFile("run.sh");
    if (!writeWithMode(p, "#!/bin/sh\necho before\n", 0o755)) return;
    await atomicWriteFile(p, "#!/bin/sh\necho after\n");
    assert.equal(fs.statSync(p).mode & 0o777, 0o755);
  });

  it("explicit mode option still wins over the existing mode", async () => {
    const p = tmpFile("secret.txt");
    if (!writeWithMode(p, "before", 0o600)) return;
    await atomicWriteFile(p, "after", { mode: 0o644 });
    assert.equal(fs.statSync(p).mode & 0o777, 0o644);
  });

  it("new files keep the umask default", async () => {
    const p = tmpFile("fresh.txt");
    await atomicWriteFile(p, "fresh");
    const expected = 0o666 & ~process.umask();
    assert.equal(fs.statSync(p).mode & 0o777, expected);
  });

  it("sync variant preserves the existing mode too", () => {
    const p = tmpFile("secret.txt");
    if (!writeWithMode(p, "before", 0o600)) return;
    atomicWriteFileSync(p, "after");
    assert.equal(fs.readFileSync(p, "utf8"), "after");
    assert.equal(fs.statSync(p).mode & 0o777, 0o600);
  });
});
