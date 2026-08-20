/**
 * Node `http2` / nghttp2 stream and session failures.
 *
 * Cursor AgentService uses native HTTP/2. A server RST_STREAM surfaces as
 * `ERR_HTTP2_STREAM_ERROR` / `Stream closed with error code NGHTTP2_*`
 * (not undici `terminated`). That is a dropped Run, not a capability miss.
 */
export function isHttp2ProtocolError(err: unknown): boolean {
  const code = errorCode(err);
  const msg = err instanceof Error ? err.message : String(err ?? "");
  if (/^ERR_HTTP2_/i.test(code)) return true;
  if (/NGHTTP2_/i.test(code) || /NGHTTP2_/i.test(msg)) return true;
  if (
    /stream closed with error code|session closed with error code|\bGOAWAY\b/i.test(
      msg,
    )
  ) {
    return true;
  }
  return false;
}

function errorCode(err: unknown): string {
  if (!err || typeof err !== "object" || !("code" in err)) return "";
  const c = (err as { code?: unknown }).code;
  return typeof c === "string" ? c : "";
}
