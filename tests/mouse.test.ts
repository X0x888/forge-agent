import "./helpers/pin-color.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseSgrMouse,
  sgrMouseConsumed,
  isMouseEnabled,
} from "../src/tui/mouse.js";

describe("SGR mouse", () => {
  it("parses left press and release", () => {
    const press = parseSgrMouse("\x1b[<0;12;20M");
    assert.deepEqual(press, {
      btn: 0,
      x: 12,
      y: 20,
      release: false,
      shift: false,
      meta: false,
      ctrl: false,
      motion: false,
      wheel: 0,
    });
    const rel = parseSgrMouse("\x1b[<0;12;20m");
    assert.equal(rel?.release, true);
  });

  it("shift-click and wheel are flagged", () => {
    const shift = parseSgrMouse("\x1b[<4;1;1M");
    assert.equal(shift?.shift, true);
    assert.equal(shift?.btn, 0);
    const wheel = parseSgrMouse("\x1b[<64;10;10M");
    assert.equal(wheel?.wheel, 1);
  });

  it("consumed reports incomplete vs complete", () => {
    assert.equal(sgrMouseConsumed("\x1b[<0;1;1M"), "\x1b[<0;1;1M".length);
    assert.equal(sgrMouseConsumed("\x1b[<0;1"), -1);
    assert.equal(sgrMouseConsumed("a"), 0);
  });

  it("FORGE_MOUSE=0 disables", () => {
    const prev = process.env.FORGE_MOUSE;
    process.env.FORGE_MOUSE = "0";
    assert.equal(isMouseEnabled(), false);
    process.env.FORGE_MOUSE = "off";
    assert.equal(isMouseEnabled(), false);
    delete process.env.FORGE_MOUSE;
    assert.equal(isMouseEnabled(), true);
    if (prev === undefined) delete process.env.FORGE_MOUSE;
    else process.env.FORGE_MOUSE = prev;
  });
});
