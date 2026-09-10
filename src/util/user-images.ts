/**
 * Multimodal user attachments — expand image paths in user text into
 * vision-capable message content parts (OpenAI-compat + Anthropic shapes).
 *
 * Supported markers in user text:
 *   [[image:path/to.png]]
 *   @path/to.png (when path ends with a known image extension)
 *   /attach path  (slash strips to attachment before send — handled by slash)
 */
import fs from "node:fs";
import path from "node:path";
import { envPositiveInt } from "./env.js";

const IMAGE_EXT = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
]);

export type TextContentPart = { type: "text"; text: string };
export type ImageContentPart = {
  type: "image_url";
  image_url: { url: string; detail?: "auto" | "low" | "high" };
};
export type UserContentPart = TextContentPart | ImageContentPart;

export function isImagePath(p: string): boolean {
  const ext = path.extname(p).toLowerCase();
  return IMAGE_EXT.has(ext);
}

export function mimeForImagePath(p: string): string {
  const ext = path.extname(p).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".bmp") return "image/bmp";
  return "application/octet-stream";
}

/** Max image bytes we'll base64-inline (default 4 MiB). */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/** xAI (and peers) 400 below this; failed CDP sits were 1×1. */
export const MIN_VISION_EDGE = 8;

export function visionMinEdge(): number {
  return envPositiveInt("FORGE_VISION_MIN_EDGE", MIN_VISION_EDGE);
}

export type ImageVisionStatus =
  | "ok"
  | "too_small"
  | "too_large"
  | "missing"
  | "not_image";

/**
 * PNG IHDR / JPEG SOF0+SOF2. Truncated or unknown container → null.
 */
export function imagePixelSize(
  buf: Buffer,
): { width: number; height: number } | null {
  if (!buf || buf.length < 4) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return pngIhdrSize(buf);
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    return jpegSofSize(buf);
  }
  return null;
}

function pngIhdrSize(buf: Buffer): { width: number; height: number } | null {
  // sig(8) + len(4) + type(4) + width(4) + height(4)
  if (buf.length < 24) return null;
  if (buf.toString("ascii", 12, 16) !== "IHDR") return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return { width, height };
}

function jpegSofSize(buf: Buffer): { width: number; height: number } | null {
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) {
      i += 1;
      continue;
    }
    while (i < buf.length && buf[i] === 0xff) i += 1;
    if (i >= buf.length) return null;
    const marker = buf[i]!;
    i += 1;
    // Standalone markers (no length): SOI/EOI/RST/TEM/stuffed 0x00
    if (
      marker === 0x00 ||
      marker === 0x01 ||
      marker === 0xd8 ||
      marker === 0xd9 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      continue;
    }
    if (i + 2 > buf.length) return null;
    const len = buf.readUInt16BE(i);
    if (len < 2) return null;
    // SOF0 (baseline) / SOF2 (progressive) — xAI's 8px floor is on these.
    if (marker === 0xc0 || marker === 0xc2) {
      if (i + 7 > buf.length) return null;
      const height = buf.readUInt16BE(i + 3);
      const width = buf.readUInt16BE(i + 5);
      return { width, height };
    }
    i += len;
  }
  return null;
}

export function imageVisionStatus(input: {
  exists?: boolean;
  isImage?: boolean;
  size: number;
  width?: number | null;
  height?: number | null;
}): ImageVisionStatus {
  if (input.exists === false) return "missing";
  if (input.isImage === false) return "not_image";
  if (!(input.size > 0)) return "missing";
  if (input.size > MAX_IMAGE_BYTES) return "too_large";
  const w = input.width;
  const h = input.height;
  if (typeof w === "number" && typeof h === "number") {
    const min = visionMinEdge();
    if (w < min || h < min) return "too_small";
  }
  return "ok";
}

function resolveImageAbs(filePath: string, workspace?: string): string {
  if (!path.isAbsolute(filePath) && workspace) {
    return path.resolve(workspace, filePath);
  }
  return path.resolve(filePath);
}

function pngOrJpegExt(p: string): boolean {
  const ext = path.extname(p).toLowerCase();
  return ext === ".png" || ext === ".jpg" || ext === ".jpeg";
}

/** Tool-result receipt so outbound vision expand can attach the file. */
export function imageReadReceipt(
  rel: string,
  size: number,
  opts?: { width?: number; height?: number },
): string {
  const status = imageVisionStatus({
    exists: true,
    isImage: true,
    size,
    width: opts?.width,
    height: opts?.height,
  });
  const dimKnown =
    typeof opts?.width === "number" && typeof opts?.height === "number";
  const dimText = dimKnown ? `, ${opts!.width}x${opts!.height}` : "";

  if (status === "too_small") {
    const min = visionMinEdge();
    return (
      `Image: ${rel} (${size} bytes${dimText}). ` +
      `Not attached — both edges must be at least ${min} pixels.`
    );
  }
  if (status === "too_large") {
    return (
      `Image: ${rel} (${size} bytes). ` +
      `Too large to inline (${size} bytes; vision cap ${MAX_IMAGE_BYTES}). ` +
      `Describe what you see before editing. Use image_edit to change pixels.\n`
    );
  }
  return (
    `Image: ${rel} (${size} bytes${dimText}). ` +
    `Describe what you see before editing. Use image_edit to change pixels.\n` +
    `[[image:${rel}]]`
  );
}

/**
 * Load a workspace-relative or absolute image as a data URL.
 * Returns null if missing / too large / too small / not an image / truncated header.
 */
export function loadImageDataUrl(
  filePath: string,
  workspace?: string,
): { dataUrl: string; abs: string } | null {
  const abs = resolveImageAbs(filePath, workspace);
  try {
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
    if (!isImagePath(abs)) return null;
    const st = fs.statSync(abs);
    if (st.size <= 0 || st.size > MAX_IMAGE_BYTES) return null;
    const buf = fs.readFileSync(abs);
    const dim = imagePixelSize(buf);
    // PNG/JPEG with no parseable header cannot be floored — do not send.
    if (pngOrJpegExt(abs) && !dim) return null;
    const status = imageVisionStatus({
      exists: true,
      isImage: true,
      size: st.size,
      width: dim?.width,
      height: dim?.height,
    });
    if (status !== "ok") return null;
    const b64 = buf.toString("base64");
    const mime = mimeForImagePath(abs);
    return { dataUrl: `data:${mime};base64,${b64}`, abs };
  } catch {
    return null;
  }
}

/** Drop image_url parts after a dimension 400 so the retry is not the same payload. */
export function stripOutboundImageParts<
  M extends { content?: string | UserContentPart[] | null },
>(messages: M[]): M[] {
  return messages.map((m) => {
    const c = m.content;
    if (!Array.isArray(c)) return m;
    const kept = c.filter((p) => p?.type !== "image_url");
    if (kept.length === c.length) return m;
    return {
      ...m,
      content: kept.length > 0 ? kept : "",
    };
  });
}

/**
 * Parse user text for image attachments and build multimodal content parts.
 * Returns string content when no images found (unchanged).
 */
export function expandUserContentWithImages(
  text: string,
  workspace?: string,
): string | UserContentPart[] {
  if (!text || !text.trim()) return text;
  const found: Array<{ raw: string; path: string }> = [];

  // [[image:path]]
  for (const m of text.matchAll(/\[\[image:\s*([^\]\n]+)\s*\]\]/gi)) {
    found.push({ raw: m[0], path: m[1].trim() });
  }
  // @./foo.png or @/abs/foo.png
  for (const m of text.matchAll(
    /(?:^|\s)@((?:\.\/|\.\.\/|\/)?[^\s]+\.(?:png|jpe?g|gif|webp|bmp))\b/gi,
  )) {
    found.push({ raw: m[0], path: m[1].trim() });
  }

  if (found.length === 0) return text;

  const parts: UserContentPart[] = [];
  let remaining = text;
  const loaded: string[] = [];
  for (const f of found) {
    const img = loadImageDataUrl(f.path, workspace);
    if (!img) continue;
    remaining = remaining.split(f.raw).join(` [attached image: ${img.abs}] `);
    parts.push({
      type: "image_url",
      image_url: { url: img.dataUrl, detail: "auto" },
    });
    loaded.push(img.abs);
  }
  if (parts.length === 0) return text;
  const cleaned = remaining.replace(/\s+/g, " ").trim();
  if (cleaned) {
    parts.unshift({ type: "text", text: cleaned });
  } else {
    parts.unshift({
      type: "text",
      text: `User attached ${loaded.length} image(s). Describe and use for the task.`,
    });
  }
  return parts;
}

/**
 * Anthropic messages API content shape for images.
 */
export function toAnthropicImageContent(
  parts: UserContentPart[],
): unknown[] {
  const out: unknown[] = [];
  for (const p of parts) {
    if (p.type === "text") {
      out.push({ type: "text", text: p.text });
      continue;
    }
    const url = p.image_url.url;
    const m = url.match(/^data:([^;]+);base64,(.+)$/);
    if (m) {
      out.push({
        type: "image",
        source: {
          type: "base64",
          media_type: m[1],
          data: m[2],
        },
      });
    } else {
      out.push({
        type: "image",
        source: { type: "url", url },
      });
    }
  }
  return out;
}

/** Whether a ChatMessage content field needs multimodal serialization. */
export function contentHasImages(
  content: string | UserContentPart[] | null | undefined,
): content is UserContentPart[] {
  return Array.isArray(content) && content.some((p) => p?.type === "image_url");
}
