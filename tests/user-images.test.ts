import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  imagePixelSize,
  imageReadReceipt,
  imageVisionStatus,
  loadImageDataUrl,
  MAX_IMAGE_BYTES,
  MIN_VISION_EDGE,
  stripOutboundImageParts,
} from "../src/util/user-images.js";
import { isImageDimensionError, ProviderApiError } from "../src/providers/errors.js";

/** Exact Maze leftover-door 1×1 PNG (also in imagine.test.ts). */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const MAZE_HEADLINE =
  "xai HTTP 400 · model grok-4.6: Image dimensions 1x1 are too small.\n" +
  "Both width and height must be at least 8 pixels.  [bad_request]";

function pngWithEdge(n: number): Buffer {
  const b = Buffer.from(PNG_1X1);
  b.writeUInt32BE(n, 16);
  b.writeUInt32BE(n, 20);
  return b;
}

function jpegSof(
  width: number,
  height: number,
  marker = 0xc0,
): Buffer {
  const buf = Buffer.alloc(14);
  buf[0] = 0xff;
  buf[1] = 0xd8;
  buf[2] = 0xff;
  buf[3] = marker;
  buf.writeUInt16BE(8, 4);
  buf[6] = 8;
  buf.writeUInt16BE(height, 7);
  buf.writeUInt16BE(width, 9);
  buf[11] = 0;
  buf[12] = 0xff;
  buf[13] = 0xd9;
  return buf;
}

describe("imagePixelSize", () => {
  it("reads PNG IHDR including the Maze 1×1", () => {
    assert.deepEqual(imagePixelSize(PNG_1X1), { width: 1, height: 1 });
    assert.deepEqual(imagePixelSize(pngWithEdge(8)), { width: 8, height: 8 });
    assert.deepEqual(imagePixelSize(pngWithEdge(32)), { width: 32, height: 32 });
  });

  it("returns null for a truncated PNG", () => {
    assert.equal(imagePixelSize(PNG_1X1.subarray(0, 16)), null);
    assert.equal(
      imagePixelSize(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
      null,
    );
  });

  it("reads JPEG SOF0 and SOF2", () => {
    assert.deepEqual(imagePixelSize(jpegSof(1, 1)), { width: 1, height: 1 });
    assert.deepEqual(imagePixelSize(jpegSof(8, 8)), { width: 8, height: 8 });
    assert.deepEqual(imagePixelSize(jpegSof(640, 480, 0xc2)), {
      width: 640,
      height: 480,
    });
  });

  it("returns null for a truncated JPEG SOF", () => {
    const truncated = jpegSof(8, 8).subarray(0, 8);
    assert.equal(imagePixelSize(truncated), null);
  });

  it("skips JPEG APP0 to reach SOF0", () => {
    const app0 = Buffer.from([
      0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00,
      0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    ]);
    const buf = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      app0,
      jpegSof(16, 9).subarray(2),
    ]);
    assert.deepEqual(imagePixelSize(buf), { width: 16, height: 9 });
  });
});

describe("imageVisionStatus / imageReadReceipt", () => {
  it("classifies too_small / too_large / missing / not_image / ok", () => {
    assert.equal(
      imageVisionStatus({ exists: false, isImage: true, size: 0 }),
      "missing",
    );
    assert.equal(
      imageVisionStatus({ exists: true, isImage: false, size: 10 }),
      "not_image",
    );
    assert.equal(
      imageVisionStatus({
        exists: true,
        isImage: true,
        size: MAX_IMAGE_BYTES + 1,
      }),
      "too_large",
    );
    assert.equal(
      imageVisionStatus({
        exists: true,
        isImage: true,
        size: 68,
        width: 1,
        height: 1,
      }),
      "too_small",
    );
    assert.equal(
      imageVisionStatus({
        exists: true,
        isImage: true,
        size: 200,
        width: 8,
        height: 8,
      }),
      "ok",
    );
  });

  it("1×1 receipt has no [[image:]] marker", () => {
    const text = imageReadReceipt("leftover-door.png", PNG_1X1.length, {
      width: 1,
      height: 1,
    });
    assert.doesNotMatch(text, /\[\[image:/);
    assert.match(
      text,
      new RegExp(
        `Image: leftover-door\\.png \\(${PNG_1X1.length} bytes, 1x1\\)\\. Not attached — both edges must be at least 8 pixels\\.`,
      ),
    );
    assert.equal(MIN_VISION_EDGE, 8);
  });

  it("8×8 receipt still emits [[image:]] and names WxH", () => {
    const text = imageReadReceipt("shot.png", 120, { width: 8, height: 8 });
    assert.match(text, /\[\[image:shot\.png\]\]/);
    assert.match(text, /Image: shot\.png \(120 bytes, 8x8\)\./);
  });

  it("too-large receipt keeps the size message and does not attach", () => {
    const size = MAX_IMAGE_BYTES + 10;
    const text = imageReadReceipt("huge.png", size, { width: 1024, height: 768 });
    assert.doesNotMatch(text, /\[\[image:/);
    assert.match(text, /Too large to inline/);
    assert.match(text, new RegExp(`vision cap ${MAX_IMAGE_BYTES}`));
  });

  it("FORGE_VISION_MIN_EDGE raises the floor", () => {
    const prev = process.env.FORGE_VISION_MIN_EDGE;
    process.env.FORGE_VISION_MIN_EDGE = "16";
    try {
      const text = imageReadReceipt("shot.png", 120, { width: 8, height: 8 });
      assert.doesNotMatch(text, /\[\[image:/);
      assert.match(text, /at least 16 pixels/);
    } finally {
      if (prev === undefined) delete process.env.FORGE_VISION_MIN_EDGE;
      else process.env.FORGE_VISION_MIN_EDGE = prev;
    }
  });
});

describe("loadImageDataUrl vision floor", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-img-floor-"));
  after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  it("returns null for a 1×1 PNG", () => {
    const p = path.join(dir, "door.png");
    fs.writeFileSync(p, PNG_1X1);
    assert.equal(loadImageDataUrl(p, dir), null);
    assert.equal(loadImageDataUrl("door.png", dir), null);
  });

  it("returns null for a truncated PNG (missing IHDR)", () => {
    const p = path.join(dir, "trunc.png");
    fs.writeFileSync(p, PNG_1X1.subarray(0, 12));
    assert.equal(loadImageDataUrl(p, dir), null);
  });

  it("returns null for a 1×1 JPEG", () => {
    const p = path.join(dir, "tiny.jpg");
    fs.writeFileSync(p, jpegSof(1, 1));
    assert.equal(loadImageDataUrl(p, dir), null);
  });

  it("inlines an 8×8 PNG and a 32×32 PNG", () => {
    const a = path.join(dir, "ok8.png");
    const b = path.join(dir, "ok32.png");
    fs.writeFileSync(a, pngWithEdge(8));
    fs.writeFileSync(b, pngWithEdge(32));
    const eight = loadImageDataUrl(a, dir);
    const thirty = loadImageDataUrl("ok32.png", dir);
    assert.ok(eight?.dataUrl.startsWith("data:image/png;base64,"));
    assert.ok(thirty?.dataUrl.startsWith("data:image/png;base64,"));
  });

  it("returns null for size 0", () => {
    const p = path.join(dir, "empty.png");
    fs.writeFileSync(p, Buffer.alloc(0));
    assert.equal(loadImageDataUrl(p, dir), null);
  });
});

describe("isImageDimensionError", () => {
  it("matches the exact Maze headline", () => {
    assert.equal(isImageDimensionError(new Error(MAZE_HEADLINE)), true);
    assert.equal(isImageDimensionError(MAZE_HEADLINE), true);
  });

  it("matches an xAI 400 ProviderApiError body", () => {
    const err = new ProviderApiError({
      provider: "xai",
      status: 400,
      body: JSON.stringify({
        error: {
          message:
            "Image dimensions 1x1 are too small. Both width and height must be at least 8 pixels.",
          type: "bad_request",
        },
      }),
    });
    assert.equal(isImageDimensionError(err), true);
  });

  it("does not match a generic 400 or a 500", () => {
    assert.equal(
      isImageDimensionError(
        new ProviderApiError({
          provider: "xai",
          status: 400,
          body: "invalid schema for function",
        }),
      ),
      false,
    );
    assert.equal(
      isImageDimensionError(
        new ProviderApiError({
          provider: "xai",
          status: 500,
          body: "Image dimensions 1x1 are too small.",
        }),
      ),
      false,
    );
    assert.equal(isImageDimensionError(new Error("invalid api key")), false);
  });
});

describe("stripOutboundImageParts", () => {
  it("drops image_url parts and keeps text", () => {
    const out = stripOutboundImageParts([
      { role: "user", content: "plain" },
      {
        role: "user",
        content: [
          { type: "text" as const, text: "Vision: look" },
          {
            type: "image_url" as const,
            image_url: { url: "data:image/png;base64,xx" },
          },
        ],
      },
    ]);
    assert.equal(out[0]!.content, "plain");
    const parts = out[1]!.content as Array<{ type: string; text?: string }>;
    assert.equal(parts.length, 1);
    assert.equal(parts[0]!.type, "text");
    assert.ok(!JSON.stringify(out).includes("image_url"));
  });
});
