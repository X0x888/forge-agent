/**
 * xAI Imagine HTTP client (images + video). Auth is the same Bearer as chat.
 */
import { resolveAuth } from "../auth/resolve.js";
import { readGrokXaiSession } from "../auth/import-grok.js";
import { DEFAULT_CONFIG, type ForgeConfig } from "../config/types.js";
import { isFalsy } from "./bool.js";
import { mergeAbortSignals } from "./abort.js";
import { nowEpoch } from "./fs.js";
import { ProviderApiError, parseRetryAfterMs } from "../providers/errors.js";
import { jsonStringifyUtf8 } from "./json-utf8.js";
import type { ResolvedAuth } from "../auth/types.js";

export const IMAGINE_IMAGE_MODEL = "grok-imagine-image-2.0";
export const IMAGINE_VIDEO_MODEL = "grok-imagine-video-1.5";
export const IMAGINE_BASE_URL = "https://api.x.ai/v1";

const IMAGE_TIMEOUT_MS = 120_000;
const VIDEO_POST_TIMEOUT_MS = 60_000;
const VIDEO_POLL_MS = 2_000;
const VIDEO_MAX_WAIT_MS = 600_000;

export function imagineEnabled(): boolean {
  return !isFalsy(process.env.FORGE_IMAGE_GEN);
}

export function videoEnabled(): boolean {
  return !isFalsy(process.env.FORGE_VIDEO_GEN ?? process.env.FORGE_IMAGE_GEN);
}

export function resolveImagineAuth(config?: ForgeConfig): ResolvedAuth | null {
  const cfg = config ?? DEFAULT_CONFIG;
  const fromCfg =
    resolveAuth(cfg, "xai") ?? resolveAuth(cfg, "grok");
  if (fromCfg?.token) return fromCfg;
  const env =
    process.env.XAI_API_KEY?.trim() || process.env.GROK_API_KEY?.trim();
  if (env) {
    return {
      provider: "xai",
      method: "api_key",
      token: env,
      baseUrl: IMAGINE_BASE_URL,
      accountLabel: "env:XAI_API_KEY",
    };
  }
  const grok = readGrokXaiSession();
  if (grok && (!grok.expiresAt || grok.expiresAt > nowEpoch())) {
    return {
      provider: "xai",
      method: "subscription",
      token: grok.accessToken,
      baseUrl: IMAGINE_BASE_URL,
      accountLabel: grok.email
        ? `grok:${grok.email}`
        : "grok:~/.grok/auth.json",
    };
  }
  return null;
}

export function imagineBaseUrl(auth: ResolvedAuth | null | undefined): string {
  const raw = auth?.baseUrl?.trim() || IMAGINE_BASE_URL;
  return raw.replace(/\/$/, "");
}

export function imagineAuthHint(): string {
  return (
    "Imagine needs an xAI credential. forge login  ·  XAI_API_KEY  ·  grok login " +
    "(reuses ~/.grok/auth.json). FORGE_IMAGE_GEN=0 disables."
  );
}

export type ImagineImageRef = { url: string; type?: "image_url" };

export interface ImagineImageRequest {
  prompt: string;
  model?: string;
  aspect_ratio?: string;
  n?: number;
  response_format?: "url" | "b64_json";
  image?: ImagineImageRef;
  images?: ImagineImageRef[];
}

export interface ImagineImageHit {
  url?: string;
  b64_json?: string;
  mime_type?: string;
}

export interface ImagineVideoRequest {
  prompt: string;
  model?: string;
  duration?: number;
  aspect_ratio?: string;
  resolution?: string;
  image?: ImagineImageRef;
  reference_images?: ImagineImageRef[];
}

async function imagineFetchJson(
  auth: ResolvedAuth,
  path: string,
  body: unknown | undefined,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<unknown> {
  const { signal: merged, dispose } = mergeAbortSignals(signal, timeoutMs);
  try {
    const res = await fetch(`${imagineBaseUrl(auth)}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${auth.token}`,
      },
      body: body === undefined ? undefined : jsonStringifyUtf8(body),
      signal: merged,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new ProviderApiError({
        provider: "xai-imagine",
        status: res.status,
        body: text.slice(0, 2000),
        retryAfterMs: parseRetryAfterMs(res.headers),
      });
    }
    if (!text.trim()) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`Imagine: invalid JSON from ${path}`);
    }
  } finally {
    dispose();
  }
}

export async function generateImagineImage(
  auth: ResolvedAuth,
  req: ImagineImageRequest,
  signal?: AbortSignal,
): Promise<ImagineImageHit[]> {
  const model =
    req.model?.trim() ||
    process.env.FORGE_IMAGE_MODEL?.trim() ||
    IMAGINE_IMAGE_MODEL;
  const body: Record<string, unknown> = {
    model,
    prompt: req.prompt,
    response_format: req.response_format ?? "b64_json",
  };
  if (req.aspect_ratio) body.aspect_ratio = req.aspect_ratio;
  if (req.n != null) body.n = req.n;
  const raw = await imagineFetchJson(
    auth,
    "/images/generations",
    body,
    signal,
    IMAGE_TIMEOUT_MS,
  );
  return parseImageHits(raw);
}

export async function editImagineImage(
  auth: ResolvedAuth,
  req: ImagineImageRequest,
  signal?: AbortSignal,
): Promise<ImagineImageHit[]> {
  const model =
    req.model?.trim() ||
    process.env.FORGE_IMAGE_MODEL?.trim() ||
    IMAGINE_IMAGE_MODEL;
  const body: Record<string, unknown> = {
    model,
    prompt: req.prompt,
    response_format: req.response_format ?? "b64_json",
  };
  if (req.aspect_ratio) body.aspect_ratio = req.aspect_ratio;
  if (req.n != null) body.n = req.n;
  if (req.images && req.images.length > 1) {
    body.images = req.images.map((im) => ({
      url: im.url,
      type: im.type ?? "image_url",
    }));
  } else {
    const one = req.image ?? req.images?.[0];
    if (one) {
      body.image = { url: one.url, type: one.type ?? "image_url" };
    }
  }
  const raw = await imagineFetchJson(
    auth,
    "/images/edits",
    body,
    signal,
    IMAGE_TIMEOUT_MS,
  );
  return parseImageHits(raw);
}

export function parseImageHits(raw: unknown): ImagineImageHit[] {
  if (!raw || typeof raw !== "object") return [];
  const data = (raw as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const out: ImagineImageHit[] = [];
  for (const row of data) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const url = typeof r.url === "string" ? r.url : undefined;
    const b64 = typeof r.b64_json === "string" ? r.b64_json : undefined;
    const mime = typeof r.mime_type === "string" ? r.mime_type : undefined;
    if (url || b64) out.push({ url, b64_json: b64, mime_type: mime });
  }
  return out;
}

export async function startImagineVideo(
  auth: ResolvedAuth,
  req: ImagineVideoRequest,
  signal?: AbortSignal,
): Promise<{ requestId: string; url?: string }> {
  const model =
    req.model?.trim() ||
    process.env.FORGE_VIDEO_MODEL?.trim() ||
    IMAGINE_VIDEO_MODEL;
  const body: Record<string, unknown> = {
    model,
    prompt: req.prompt,
  };
  if (req.duration != null) body.duration = req.duration;
  if (req.aspect_ratio) body.aspect_ratio = req.aspect_ratio;
  if (req.resolution) body.resolution = req.resolution;
  if (req.image) {
    body.image = { url: req.image.url, type: req.image.type ?? "image_url" };
  }
  if (req.reference_images?.length) {
    body.reference_images = req.reference_images.map((im) => ({
      url: im.url,
      type: im.type ?? "image_url",
    }));
  }
  const raw = await imagineFetchJson(
    auth,
    "/videos/generations",
    body,
    signal,
    VIDEO_POST_TIMEOUT_MS,
  );
  const rec = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const requestId = String(
    rec.request_id ?? rec.requestId ?? rec.id ?? "",
  ).trim();
  const url = videoUrlFromPayload(rec);
  if (!requestId && !url) {
    throw new Error("Imagine video: response missing request_id");
  }
  return { requestId: requestId || "inline", url };
}

export async function pollImagineVideo(
  auth: ResolvedAuth,
  requestId: string,
  signal?: AbortSignal,
): Promise<{ url: string }> {
  const deadline = Date.now() + VIDEO_MAX_WAIT_MS;
  let delay = VIDEO_POLL_MS;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("Aborted");
    const raw = await imagineFetchJson(
      auth,
      `/videos/${encodeURIComponent(requestId)}`,
      undefined,
      signal,
      30_000,
    );
    const rec = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const status = String(rec.status ?? rec.state ?? "").toLowerCase();
    const url = videoUrlFromPayload(rec);
    if (url && (!status || status === "done" || status === "completed" || status === "succeeded")) {
      return { url };
    }
    if (status === "failed" || status === "error" || rec.error) {
      const err =
        typeof rec.error === "string"
          ? rec.error
          : JSON.stringify(rec.error ?? rec).slice(0, 400);
      throw new Error(`Imagine video failed: ${err}`);
    }
    await sleep(delay, signal);
    delay = Math.min(8_000, Math.floor(delay * 1.4));
  }
  throw new Error(
    `Imagine video timed out after ${VIDEO_MAX_WAIT_MS / 1000}s (request ${requestId}).`,
  );
}

function videoUrlFromPayload(rec: Record<string, unknown>): string | undefined {
  if (typeof rec.url === "string" && rec.url.startsWith("http")) return rec.url;
  const video = rec.video;
  if (video && typeof video === "object") {
    const u = (video as { url?: unknown }).url;
    if (typeof u === "string" && u.startsWith("http")) return u;
  }
  const data = rec.data;
  if (Array.isArray(data) && data[0] && typeof data[0] === "object") {
    const u = (data[0] as { url?: unknown }).url;
    if (typeof u === "string" && u.startsWith("http")) return u;
  }
  return undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted"));
      return;
    }
    const t = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function downloadBinary(
  url: string,
  signal?: AbortSignal,
): Promise<{ buf: Buffer; mime?: string }> {
  const { signal: merged, dispose } = mergeAbortSignals(signal, 60_000);
  try {
    const res = await fetch(url, { method: "GET", signal: merged, redirect: "follow" });
    if (!res.ok) {
      throw new Error(`Imagine download HTTP ${res.status}`);
    }
    const mime = res.headers.get("content-type") || undefined;
    const ab = await res.arrayBuffer();
    return { buf: Buffer.from(ab), mime };
  } finally {
    dispose();
  }
}
