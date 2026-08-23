/**
 * Native Imagine tools: image_gen, image_edit, image_to_video, reference_to_video.
 */
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { ToolContext, ToolResult } from "./types.js";
import {
  assertReadablePath,
  assertWritablePath,
  displayRelPath,
} from "./path-util.js";
import { atomicWriteFile } from "./atomic-write.js";
import { assertUrlSafe } from "./ssrf.js";
import {
  loadImageDataUrl,
} from "../../util/user-images.js";
import {
  downloadBinary,
  editImagineImage,
  generateImagineImage,
  imagineAuthHint,
  imagineEnabled,
  pollImagineVideo,
  resolveImagineAuth,
  startImagineVideo,
  videoEnabled,
  type ImagineImageHit,
  type ImagineImageRef,
} from "../../util/imagine-client.js";
import { isProviderApiError } from "../../providers/errors.js";
import { numberFieldError } from "./arg-types.js";

const ASPECT = new Set([
  "1:1",
  "3:4",
  "4:3",
  "9:16",
  "16:9",
  "2:3",
  "3:2",
  "9:19.5",
  "19.5:9",
  "9:20",
  "20:9",
  "1:2",
  "2:1",
  "21:9",
  "5:2",
  "auto",
]);

export function isImagineToolName(name: string): boolean {
  const n = (name || "").trim();
  return (
    n === "image_gen" ||
    n === "image_edit" ||
    n === "image_to_video" ||
    n === "reference_to_video" ||
    n === "generate_image" ||
    n === "edit_image"
  );
}

function promptArg(args: Record<string, unknown>): string {
  return String(args.prompt ?? args.description ?? args.text ?? "").trim();
}

function aspectArg(args: Record<string, unknown>): string | undefined {
  const raw = String(args.aspect_ratio ?? args.aspectRatio ?? "").trim();
  if (!raw) return undefined;
  return ASPECT.has(raw) ? raw : undefined;
}

async function imageRefFromInput(
  raw: string,
  ctx: ToolContext,
): Promise<ImagineImageRef | { error: string }> {
  const s = raw.trim();
  if (!s) return { error: "empty image path" };
  if (/^https?:\/\//i.test(s)) {
    try {
      await assertUrlSafe(s, false);
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : String(err),
      };
    }
    return { url: s, type: "image_url" };
  }
  if (s.startsWith("data:image/")) {
    return { url: s, type: "image_url" };
  }
  let abs: string;
  try {
    abs = await assertReadablePath(ctx.workspace, s);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  const loaded = loadImageDataUrl(abs, ctx.workspace);
  if (!loaded) {
    return {
      error:
        `Cannot load image ${s} (missing, not an image, or >4 MiB). ` +
        "Pass a workspace png/jpg/webp/gif or an https URL.",
    };
  }
  return { url: loaded.dataUrl, type: "image_url" };
}

function collectImageArgs(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  const one = args.image ?? args.path ?? args.file;
  if (typeof one === "string" && one.trim()) out.push(one.trim());
  const many = args.images ?? args.image_paths ?? args.refs;
  if (Array.isArray(many)) {
    for (const x of many) {
      if (typeof x === "string" && x.trim()) out.push(x.trim());
    }
  }
  return out;
}

function extForMime(mime?: string, fallback = ".png"): string {
  const m = (mime || "").split(";")[0]?.trim().toLowerCase();
  if (m === "image/jpeg" || m === "image/jpg") return ".jpg";
  if (m === "image/webp") return ".webp";
  if (m === "image/gif") return ".gif";
  if (m === "image/png") return ".png";
  if (m === "video/mp4") return ".mp4";
  if (m === "video/webm") return ".webm";
  return fallback;
}

function slugPrompt(prompt: string): string {
  const s = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return s || "imagine";
}

async function nextImaginePath(
  ctx: ToolContext,
  prompt: string,
  ext: string,
): Promise<string> {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  const id = randomBytes(3).toString("hex");
  const rel = path.join("images", `${slugPrompt(prompt)}-${stamp}-${id}${ext}`);
  const abs = path.join(ctx.workspace, rel);
  return assertWritablePath(ctx.workspace, abs).then(() => abs);
}

function b64ToBuf(b64: string): Buffer {
  const cleaned = b64.replace(/^data:[^;]+;base64,/, "");
  return Buffer.from(cleaned, "base64");
}

async function persistHits(
  ctx: ToolContext,
  prompt: string,
  hits: ImagineImageHit[],
  fallbackExt: string,
): Promise<string[]> {
  const saved: string[] = [];
  let i = 0;
  for (const hit of hits) {
    i += 1;
    let buf: Buffer | undefined;
    let mime = hit.mime_type;
    if (hit.b64_json) {
      buf = b64ToBuf(hit.b64_json);
    } else if (hit.url) {
      const dl = await downloadBinary(hit.url, ctx.signal);
      buf = dl.buf;
      mime = mime || dl.mime;
    }
    if (!buf || buf.length === 0) continue;
    const ext = extForMime(mime, fallbackExt);
    const abs = await nextImaginePath(
      ctx,
      i === 1 ? prompt : `${prompt}-${i}`,
      ext,
    );
    await atomicWriteFile(abs, buf);
    try {
      ctx.recordMutation?.({ path: abs, kind: "create" });
    } catch {
      /* */
    }
    ctx.onEdit?.();
    saved.push(displayRelPath(ctx.workspace, abs));
  }
  return saved;
}

function visionReceipt(relPaths: string[], kind: string): string {
  const lines = relPaths.map((p) => `[[image:${p}]]`);
  return (
    `${kind} saved ${relPaths.length} file(s) under images/.\n` +
    relPaths.map((p) => `- ${p}`).join("\n") +
    `\n\nVision will attach these on the next model call. ` +
    `Describe what you see before using them in the product.\n` +
    lines.join("\n")
  );
}

function fail(msg: string): ToolResult {
  return { output: msg, isError: true };
}

function catchImagine(err: unknown, tool: string): ToolResult {
  if (err instanceof Error && /^Aborted/i.test(err.message)) {
    return { output: "Aborted", isError: true };
  }
  if (isProviderApiError(err)) {
    return {
      output:
        `${tool} error: xAI Imagine HTTP ${err.status}. ${err.body.slice(0, 400)}\n` +
        imagineAuthHint(),
      isError: true,
    };
  }
  return {
    output: `${tool} error: ${err instanceof Error ? err.message : String(err)}`,
    isError: true,
  };
}

export async function toolImageGen(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (!imagineEnabled()) {
    return fail("image_gen disabled (FORGE_IMAGE_GEN=0).");
  }
  const prompt = promptArg(args);
  if (!prompt) {
    return fail(
      'image_gen error: prompt is required.\nExample: { "prompt": "pixel-art torch, isolated on #00ff00", "aspect_ratio": "1:1" }',
    );
  }
  const auth = resolveImagineAuth(ctx.config);
  if (!auth?.token) return fail(`image_gen error: ${imagineAuthHint()}`);
  let n = 1;
  if (args.n != null && String(args.n).trim() !== "") {
    const raw = Number(args.n);
    if (!Number.isFinite(raw) || raw < 1) {
      return fail(numberFieldError("image_gen", "n", args.n, "Pass 1–4."));
    }
    n = Math.min(4, Math.floor(raw));
  }
  const aspect = aspectArg(args);
  if (args.aspect_ratio && !aspect) {
    return fail(
      `image_gen error: aspect_ratio must be one of ${[...ASPECT].join(", ")}.`,
    );
  }
  try {
    const hits = await generateImagineImage(
      auth,
      { prompt, aspect_ratio: aspect, n },
      ctx.signal,
    );
    if (!hits.length) return fail("image_gen error: empty Imagine response.");
    const saved = await persistHits(ctx, prompt, hits, ".png");
    if (!saved.length) return fail("image_gen error: could not write image files.");
    return { output: visionReceipt(saved, "image_gen") };
  } catch (err) {
    return catchImagine(err, "image_gen");
  }
}

export async function toolImageEdit(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (!imagineEnabled()) {
    return fail("image_edit disabled (FORGE_IMAGE_GEN=0).");
  }
  const prompt = promptArg(args);
  if (!prompt) {
    return fail(
      'image_edit error: prompt is required.\nExample: { "prompt": "same sprite, flat #00ff00 background", "image": "images/torch.png" }',
    );
  }
  const paths = collectImageArgs(args);
  if (!paths.length) {
    return fail(
      "image_edit error: image is required (path, https URL, or images[] up to 3).",
    );
  }
  if (paths.length > 3) {
    return fail("image_edit error: at most 3 reference images.");
  }
  const refs: ImagineImageRef[] = [];
  for (const p of paths) {
    const r = await imageRefFromInput(p, ctx);
    if ("error" in r) return fail(`image_edit error: ${r.error}`);
    refs.push(r);
  }
  const auth = resolveImagineAuth(ctx.config);
  if (!auth?.token) return fail(`image_edit error: ${imagineAuthHint()}`);
  const aspect = aspectArg(args);
  try {
    const hits = await editImagineImage(
      auth,
      {
        prompt,
        aspect_ratio: aspect,
        image: refs[0],
        images: refs,
      },
      ctx.signal,
    );
    if (!hits.length) return fail("image_edit error: empty Imagine response.");
    const saved = await persistHits(ctx, prompt, hits, ".png");
    if (!saved.length) return fail("image_edit error: could not write image files.");
    return { output: visionReceipt(saved, "image_edit") };
  } catch (err) {
    return catchImagine(err, "image_edit");
  }
}

async function persistVideo(
  ctx: ToolContext,
  prompt: string,
  url: string,
): Promise<string> {
  const dl = await downloadBinary(url, ctx.signal);
  const ext = extForMime(dl.mime, ".mp4");
  const abs = await nextImaginePath(ctx, prompt, ext);
  await atomicWriteFile(abs, dl.buf);
  try {
    ctx.recordMutation?.({ path: abs, kind: "create" });
  } catch {
    /* */
  }
  ctx.onEdit?.();
  return displayRelPath(ctx.workspace, abs);
}

function durationArg(args: Record<string, unknown>): number | string {
  if (args.duration == null && args.duration_s == null) return 6;
  const n = Number(args.duration ?? args.duration_s);
  if (!Number.isFinite(n) || n < 1 || n > 15) {
    return numberFieldError(
      "image_to_video",
      "duration",
      args.duration ?? args.duration_s,
      "Pass 1–15 seconds (default 6).",
    );
  }
  return Math.round(n);
}

export async function toolImageToVideo(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (!videoEnabled()) {
    return fail("image_to_video disabled (FORGE_VIDEO_GEN=0).");
  }
  const prompt = promptArg(args) || "Animate this still, camera locked, one motion.";
  const paths = collectImageArgs(args);
  if (!paths.length) {
    return fail(
      "image_to_video error: image is required (first-frame path or https URL).",
    );
  }
  const dur = durationArg(args);
  if (typeof dur === "string") return fail(dur);
  const ref = await imageRefFromInput(paths[0]!, ctx);
  if ("error" in ref) return fail(`image_to_video error: ${ref.error}`);
  const auth = resolveImagineAuth(ctx.config);
  if (!auth?.token) return fail(`image_to_video error: ${imagineAuthHint()}`);
  const resolution = String(args.resolution ?? args.resolution_name ?? "")
    .trim()
    .toLowerCase();
  try {
    const started = await startImagineVideo(
      auth,
      {
        prompt,
        duration: dur,
        image: ref,
        resolution: resolution === "720p" || resolution === "1080p" ? resolution : undefined,
      },
      ctx.signal,
    );
    const url =
      started.url ||
      (await pollImagineVideo(auth, started.requestId, ctx.signal)).url;
    const rel = await persistVideo(ctx, prompt, url);
    return {
      output:
        `image_to_video saved ${rel}\n` +
        `Harvest frames: ffmpeg -i ${rel} -vf fps=12 images/f%03d.png\n` +
        `Then read_file a frame (vision) and keep looping frames. See forge-game-animation.`,
    };
  } catch (err) {
    return catchImagine(err, "image_to_video");
  }
}

export async function toolReferenceToVideo(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (!videoEnabled()) {
    return fail("reference_to_video disabled (FORGE_VIDEO_GEN=0).");
  }
  const prompt = promptArg(args);
  if (!prompt) {
    return fail(
      'reference_to_video error: prompt is required. Tag refs as <IMAGE_0>, <IMAGE_1> in the prompt.',
    );
  }
  const paths = collectImageArgs(args);
  if (!paths.length) {
    return fail("reference_to_video error: images[] (up to 7) is required.");
  }
  if (paths.length > 7) {
    return fail("reference_to_video error: at most 7 reference images.");
  }
  const dur = durationArg(args);
  if (typeof dur === "string") return fail(dur);
  const refs: ImagineImageRef[] = [];
  for (const p of paths) {
    const r = await imageRefFromInput(p, ctx);
    if ("error" in r) return fail(`reference_to_video error: ${r.error}`);
    refs.push(r);
  }
  const auth = resolveImagineAuth(ctx.config);
  if (!auth?.token) return fail(`reference_to_video error: ${imagineAuthHint()}`);
  const aspect = aspectArg(args);
  try {
    const started = await startImagineVideo(
      auth,
      {
        prompt,
        duration: dur,
        aspect_ratio: aspect,
        reference_images: refs,
      },
      ctx.signal,
    );
    const url =
      started.url ||
      (await pollImagineVideo(auth, started.requestId, ctx.signal)).url;
    const rel = await persistVideo(ctx, prompt, url);
    return {
      output:
        `reference_to_video saved ${rel}\n` +
        `Harvest frames with ffmpeg when you need a sprite sheet. See forge-game-animation.`,
    };
  } catch (err) {
    return catchImagine(err, "reference_to_video");
  }
}

