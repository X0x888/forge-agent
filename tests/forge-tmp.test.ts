import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  forgeTmpDir,
  forgeTmpStats,
  isForgeTmpScratchName,
  pruneForgeTmp,
} from "../src/util/forge-tmp.js";

describe("forge tmp scratch", () => {
  it("classifies leftover look/Chrome names", () => {
    assert.equal(isForgeTmpScratchName("chrome-cft-c6-scout"), true);
    assert.equal(isForgeTmpScratchName("hashpet-cycle20-chrome4"), true);
    assert.equal(isForgeTmpScratchName("cycle10-scout"), true);
    assert.equal(isForgeTmpScratchName("playwright-output"), true);
    assert.equal(isForgeTmpScratchName("keep-me"), false);
  });

  it("stats and prune only scratch children, never the tmp root", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-tmp-home-"));
    process.env.FORGE_HOME = home;
    const dir = forgeTmpDir();
    fs.mkdirSync(path.join(dir, "chrome-cft-old"), { recursive: true });
    fs.writeFileSync(path.join(dir, "chrome-cft-old", "x"), "xxxxxxxx");
    fs.mkdirSync(path.join(dir, "keep-me"), { recursive: true });
    fs.writeFileSync(path.join(dir, "keep-me", "y"), "yy");
    const old = new Date(Date.now() - 8 * 60 * 60 * 1000);
    fs.utimesSync(path.join(dir, "chrome-cft-old"), old, old);

    const st = forgeTmpStats();
    assert.equal(st.exists, true);
    assert.ok(st.scratchDirs >= 1);
    assert.ok(st.scratchBytes >= 8);

    const dry = pruneForgeTmp({ maxAgeMs: 6 * 60 * 60 * 1000, dry: true });
    assert.ok(dry.deleted.includes("chrome-cft-old"));
    assert.equal(dry.dry, true);
    assert.ok(fs.existsSync(path.join(dir, "chrome-cft-old")));

    const gone = pruneForgeTmp({ maxAgeMs: 6 * 60 * 60 * 1000 });
    assert.ok(gone.deleted.includes("chrome-cft-old"));
    assert.ok(!fs.existsSync(path.join(dir, "chrome-cft-old")));
    assert.ok(fs.existsSync(path.join(dir, "keep-me")));
    assert.ok(fs.existsSync(dir));
  });
});
