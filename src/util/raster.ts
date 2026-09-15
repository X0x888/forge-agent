/**
 * Tiny raster helpers for vision attach: decode BMP / simple PNG, encode PNG,
 * nearest-neighbour scale. No extra deps — Node zlib only.
 *
 * xAI accepts JPG, PNG, WebP, ICO. Dump art is BMP; game icons are 15×17.
 * Convert + upscale here so a look cannot 400 the provider.
 */
import zlib from "node:zlib";

export type RgbaBitmap = {
  width: number;
  height: number;
  /** length = width * height * 4, RGBA */
  rgba: Buffer;
};

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Encode 8-bit RGBA as a valid PNG. */
export function encodePngRgba(img: RgbaBitmap): Buffer {
  const { width, height, rgba } = img;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const dest = y * (stride + 1);
    raw[dest] = 0;
    rgba.copy(raw, dest + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([
    PNG_SIG,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export function scaleRgbaNearest(img: RgbaBitmap, nw: number, nh: number): RgbaBitmap {
  const w = Math.max(1, Math.floor(nw));
  const h = Math.max(1, Math.floor(nh));
  if (w === img.width && h === img.height) return img;
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.height - 1, Math.floor((y * img.height) / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.floor((x * img.width) / w));
      img.rgba.copy(out, (y * w + x) * 4, (sy * img.width + sx) * 4, (sy * img.width + sx) * 4 + 4);
    }
  }
  return { width: w, height: h, rgba: out };
}

function parsePngChunks(buf: Buffer): Map<string, Buffer[]> | null {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) return null;
  const map = new Map<string, Buffer[]>();
  let i = 8;
  while (i + 12 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString("ascii", i + 4, i + 8);
    if (i + 12 + len > buf.length) return null;
    const data = buf.subarray(i + 8, i + 8 + len);
    const list = map.get(type) ?? [];
    list.push(data);
    map.set(type, list);
    i += 12 + len;
    if (type === "IEND") break;
  }
  return map;
}

function unfilter(raw: Buffer, height: number, stride: number, bpp: number): Buffer | null {
  const out = Buffer.alloc(stride * height);
  let src = 0;
  for (let y = 0; y < height; y++) {
    if (src + 1 + stride > raw.length) return null;
    const ft = raw[src]!;
    src += 1;
    const row = raw.subarray(src, src + stride);
    src += stride;
    const dest = y * stride;
    const prev = y === 0 ? null : out.subarray((y - 1) * stride, y * stride);
    for (let x = 0; x < stride; x++) {
      const left = x >= bpp ? out[dest + x - bpp]! : 0;
      const up = prev ? prev[x]! : 0;
      const upLeft = prev && x >= bpp ? prev[x - bpp]! : 0;
      let v = row[x]!;
      if (ft === 1) v = (v + left) & 255;
      else if (ft === 2) v = (v + up) & 255;
      else if (ft === 3) v = (v + Math.floor((left + up) / 2)) & 255;
      else if (ft === 4) v = (v + paeth(left, up, upLeft)) & 255;
      else if (ft !== 0) return null;
      out[dest + x] = v;
    }
  }
  return out;
}

/** Decode 8-bit non-interlaced PNG (gray / RGB / palette / RGBA). */
export function decodePng(buf: Buffer): RgbaBitmap | null {
  const chunks = parsePngChunks(buf);
  if (!chunks) return null;
  const ihdr = chunks.get("IHDR")?.[0];
  if (!ihdr || ihdr.length < 13) return null;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  if (width < 1 || height < 1 || width > 8192 || height > 8192) return null;
  if (ihdr[8] !== 8 || ihdr[12] !== 0) return null;
  const colorType = ihdr[9]!;
  const idatParts = chunks.get("IDAT");
  if (!idatParts?.length) return null;
  let inflated: Buffer;
  try {
    inflated = zlib.inflateSync(Buffer.concat(idatParts));
  } catch {
    return null;
  }
  let channels = 0;
  if (colorType === 0) channels = 1;
  else if (colorType === 2) channels = 3;
  else if (colorType === 3) channels = 1;
  else if (colorType === 4) channels = 2;
  else if (colorType === 6) channels = 4;
  else return null;
  const stride = width * channels;
  const raw = unfilter(inflated, height, stride, channels);
  if (!raw) return null;
  const rgba = Buffer.alloc(width * height * 4);
  let pal: Buffer | undefined;
  if (colorType === 3) {
    pal = chunks.get("PLTE")?.[0];
    if (!pal || pal.length < 3) return null;
  }
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    if (colorType === 6) {
      raw.copy(rgba, o, i * 4, i * 4 + 4);
    } else if (colorType === 2) {
      rgba[o] = raw[i * 3]!;
      rgba[o + 1] = raw[i * 3 + 1]!;
      rgba[o + 2] = raw[i * 3 + 2]!;
      rgba[o + 3] = 255;
    } else if (colorType === 0) {
      const g = raw[i]!;
      rgba[o] = g;
      rgba[o + 1] = g;
      rgba[o + 2] = g;
      rgba[o + 3] = 255;
    } else if (colorType === 4) {
      const g = raw[i * 2]!;
      rgba[o] = g;
      rgba[o + 1] = g;
      rgba[o + 2] = g;
      rgba[o + 3] = raw[i * 2 + 1]!;
    } else if (colorType === 3 && pal) {
      const idx = raw[i]! * 3;
      rgba[o] = pal[idx] ?? 0;
      rgba[o + 1] = pal[idx + 1] ?? 0;
      rgba[o + 2] = pal[idx + 2] ?? 0;
      rgba[o + 3] = 255;
    }
  }
  return { width, height, rgba };
}

/** Uncompressed 24/32-bit BMP (BI_RGB). */
export function decodeBmp(buf: Buffer): RgbaBitmap | null {
  if (buf.length < 54 || buf[0] !== 0x42 || buf[1] !== 0x4d) return null;
  const pixelOff = buf.readUInt32LE(10);
  const dib = buf.readUInt32LE(14);
  if (dib < 40 || pixelOff < 14 + dib || pixelOff >= buf.length) return null;
  const width = buf.readInt32LE(18);
  let height = buf.readInt32LE(22);
  const bpp = buf.readUInt16LE(28);
  const compression = buf.readUInt32LE(30);
  if (compression !== 0 || (bpp !== 24 && bpp !== 32)) return null;
  if (width < 1 || Math.abs(height) < 1 || width > 8192 || Math.abs(height) > 8192) {
    return null;
  }
  const bottomUp = height > 0;
  const h = Math.abs(height);
  const rowBytes = Math.floor((bpp * width + 31) / 32) * 4;
  const rgba = Buffer.alloc(width * h * 4);
  for (let y = 0; y < h; y++) {
    const srcY = bottomUp ? h - 1 - y : y;
    const rowOff = pixelOff + srcY * rowBytes;
    if (rowOff + rowBytes > buf.length) return null;
    for (let x = 0; x < width; x++) {
      const p = rowOff + x * (bpp / 8);
      const o = (y * width + x) * 4;
      rgba[o] = buf[p + 2]!;
      rgba[o + 1] = buf[p + 1]!;
      rgba[o + 2] = buf[p]!;
      rgba[o + 3] = bpp === 32 ? buf[p + 3]! : 255;
    }
  }
  return { width, height: h, rgba };
}

/** 24-bit uncompressed BMP for tests. */
export function encodeBmp24(img: RgbaBitmap): Buffer {
  const rowBytes = Math.floor((24 * img.width + 31) / 32) * 4;
  const pixelBytes = rowBytes * img.height;
  const buf = Buffer.alloc(54 + pixelBytes);
  buf[0] = 0x42;
  buf[1] = 0x4d;
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(img.width, 18);
  buf.writeInt32LE(img.height, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  for (let y = 0; y < img.height; y++) {
    const srcY = img.height - 1 - y;
    const rowOff = 54 + y * rowBytes;
    for (let x = 0; x < img.width; x++) {
      const i = (srcY * img.width + x) * 4;
      const p = rowOff + x * 3;
      buf[p] = img.rgba[i + 2]!;
      buf[p + 1] = img.rgba[i + 1]!;
      buf[p + 2] = img.rgba[i]!;
    }
  }
  return buf;
}

export function decodeRaster(buf: Buffer): RgbaBitmap | null {
  if (!buf || buf.length < 8) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50) return decodePng(buf);
  if (buf[0] === 0x42 && buf[1] === 0x4d) return decodeBmp(buf);
  return null;
}
