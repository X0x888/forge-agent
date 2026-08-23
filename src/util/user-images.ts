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

/** Tool-result receipt so outbound vision expand can attach the file. */
export function imageReadReceipt(rel: string, size: number): string {
  const tooBig =
    size > MAX_IMAGE_BYTES
      ? ` Too large to inline (${size} bytes; vision cap ${MAX_IMAGE_BYTES}).`
      : "";
  return (
    `Image: ${rel} (${size} bytes).${tooBig} ` +
    `Describe what you see before editing. Use image_edit to change pixels.\n` +
    `[[image:${rel}]]`
  );
}

/**
 * Load a workspace-relative or absolute image as a data URL.
 * Returns null if missing / too large / not an image.
 */
export function loadImageDataUrl(
  filePath: string,
  workspace?: string,
): { dataUrl: string; abs: string } | null {
  let abs = filePath;
  if (!path.isAbsolute(abs) && workspace) {
    abs = path.resolve(workspace, filePath);
  } else {
    abs = path.resolve(abs);
  }
  try {
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
    if (!isImagePath(abs)) return null;
    const st = fs.statSync(abs);
    if (st.size <= 0 || st.size > MAX_IMAGE_BYTES) return null;
    const buf = fs.readFileSync(abs);
    const b64 = buf.toString("base64");
    const mime = mimeForImagePath(abs);
    return { dataUrl: `data:${mime};base64,${b64}`, abs };
  } catch {
    return null;
  }
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
