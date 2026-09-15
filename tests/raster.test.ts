import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decodeBmp,
  decodePng,
  encodeBmp24,
  encodePngRgba,
  scaleRgbaNearest,
} from "../src/util/raster.js";

function solid(w: number, h: number, r = 10, g = 20, b = 30): Buffer {
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

describe("raster png/bmp", () => {
  it("round-trips RGBA PNG", () => {
    const img = { width: 4, height: 3, rgba: solid(4, 3) };
    const png = encodePngRgba(img);
    const back = decodePng(png);
    assert.ok(back);
    assert.equal(back.width, 4);
    assert.equal(back.height, 3);
    assert.equal(back.rgba[0], 10);
    assert.equal(back.rgba[2], 30);
  });

  it("round-trips 24-bit BMP", () => {
    const img = { width: 5, height: 2, rgba: solid(5, 2, 1, 2, 3) };
    const bmp = encodeBmp24(img);
    assert.equal(bmp[0], 0x42);
    const back = decodeBmp(bmp);
    assert.ok(back);
    assert.equal(back.width, 5);
    assert.equal(back.height, 2);
    assert.equal(back.rgba[0], 1);
    assert.equal(back.rgba[2], 3);
  });

  it("scales nearest-neighbour", () => {
    const img = { width: 1, height: 1, rgba: Buffer.from([9, 8, 7, 255]) };
    const out = scaleRgbaNearest(img, 2, 2);
    assert.equal(out.width, 2);
    assert.equal(out.height, 2);
    assert.equal(out.rgba.length, 16);
    assert.equal(out.rgba[0], 9);
    assert.equal(out.rgba[12], 9);
  });
});
