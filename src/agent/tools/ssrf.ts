/**
 * SSRF guards for web_fetch (Grok-inspired).
 * Blocks non-public addresses; local only when allowLocal + explicit loopback host.
 */
import dns from "node:dns/promises";
import net from "node:net";

/** Strip URL-style brackets / zone id so net.isIP and loopback checks see bare literals. */
export function normalizeIpHost(host: string): string {
  let h = host.trim().toLowerCase();
  h = h.replace(/\.$/, "");
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  h = h.split("%")[0] || h;
  return h;
}

/**
 * Parse one IPv4 component that may be decimal, octal (leading 0), or hex (0x).
 * Returns null if the token is not a valid component.
 */
function parseIpv4Part(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  let n: number;
  if (/^0x[0-9a-f]+$/.test(s)) {
    n = parseInt(s, 16);
  } else if (/^0[0-7]+$/.test(s)) {
    // Leading 0 → octal (inet_aton). Bare "0" is decimal 0.
    n = parseInt(s, 8);
  } else if (/^\d+$/.test(s)) {
    n = parseInt(s, 10);
  } else {
    return null;
  }
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/**
 * Expand non-canonical IPv4 host spellings to dotted-quad.
 * Covers: 2130706433, 0x7f000001, 127.1, 127.0.1, 0177.0.0.1, 0x7f.0.0.1
 * (classic inet_aton / browser URL quirks used in SSRF bypasses).
 */
export function expandWeirdIpv4Literal(host: string): string | null {
  const h = normalizeIpHost(host);
  if (!h || net.isIPv6(h)) return null;
  if (net.isIPv4(h)) return h;

  // Single integer / hex whole-address form
  if (/^(0x[0-9a-f]+|\d+)$/.test(h)) {
    const n = parseIpv4Part(h);
    if (n == null || n > 0xffffffff) return null;
    return [
      (n >>> 24) & 0xff,
      (n >>> 16) & 0xff,
      (n >>> 8) & 0xff,
      n & 0xff,
    ].join(".");
  }

  // Dotted forms with 2–4 parts (short + octal/hex parts)
  if (!h.includes(".")) return null;
  const parts = h.split(".");
  if (parts.length < 2 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    const n = parseIpv4Part(p);
    if (n == null) return null;
    nums.push(n);
  }

  let a = 0;
  let b = 0;
  let c = 0;
  let d = 0;
  if (nums.length === 4) {
    if (nums.some((n) => n > 0xff)) return null;
    [a, b, c, d] = nums as [number, number, number, number];
  } else if (nums.length === 3) {
    if (nums[0]! > 0xff || nums[1]! > 0xff || nums[2]! > 0xffff) return null;
    a = nums[0]!;
    b = nums[1]!;
    c = (nums[2]! >>> 8) & 0xff;
    d = nums[2]! & 0xff;
  } else if (nums.length === 2) {
    if (nums[0]! > 0xff || nums[1]! > 0xffffff) return null;
    a = nums[0]!;
    b = (nums[1]! >>> 16) & 0xff;
    c = (nums[1]! >>> 8) & 0xff;
    d = nums[1]! & 0xff;
  } else {
    return null;
  }
  return `${a}.${b}.${c}.${d}`;
}

export function isExplicitLocalHost(host: string): boolean {
  const h = normalizeIpHost(host);
  if (h === "localhost") return true;
  if (net.isIP(h)) return isLoopbackAddr(h);
  const weird = expandWeirdIpv4Literal(h);
  if (weird) return isLoopbackAddr(weird);
  return false;
}

function ipv4InCidr(ip: string, base: string, prefix: number): boolean {
  const toInt = (s: string) =>
    s.split(".").reduce((acc, o) => ((acc << 8) + Number(o)) >>> 0, 0);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (toInt(ip) & mask) === (toInt(base) & mask);
}

/**
 * Expand an IPv6 literal to 8 hextets (lowercase, no leading zeros stripped beyond normalize).
 * Returns null if the literal is not a well-formed IPv6 address.
 */
function expandIpv6Hextets(ip: string): string[] | null {
  const lower = ip.toLowerCase().split("%")[0] || "";
  if (!net.isIPv6(lower)) return null;
  // Reject dotted IPv4 tail here — callers peel mapped forms first
  if (lower.includes(".")) return null;
  const sides = lower.split("::");
  if (sides.length > 2) return null;
  const head = sides[0] ? sides[0].split(":").filter((p) => p.length > 0) : [];
  const tail =
    sides.length === 2 && sides[1]
      ? sides[1].split(":").filter((p) => p.length > 0)
      : [];
  if (sides.length === 1) {
    if (head.length !== 8) return null;
    return head.map((h) => h.padStart(4, "0"));
  }
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  const mid = Array.from({ length: missing }, () => "0000");
  return [...head, ...mid, ...tail].map((h) => h.padStart(4, "0"));
}

/**
 * Extract embedded IPv4 from IPv4-mapped (`:ffff:`) or deprecated IPv4-compatible forms.
 * Handles both dotted-quad (`::ffff:127.0.0.1`) and hex (`::ffff:7f00:1`) tails.
 */
export function embeddedIpv4FromIpv6(ip: string): string | null {
  const lower = normalizeIpHost(ip);
  if (!net.isIPv6(lower) && !net.isIPv4(lower)) return null;

  // Dotted-quad mapped / compatible tails (must run before hextet expand —
  // expand rejects literals that still contain '.')
  const dottedMapped =
    lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i) ||
    lower.match(/^0:0:0:0:0:ffff:(\d+\.\d+\.\d+\.\d+)$/i) ||
    lower.match(/^:ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (dottedMapped && net.isIPv4(dottedMapped[1]!)) return dottedMapped[1]!;
  const dottedCompat = lower.match(/^::(\d+\.\d+\.\d+\.\d+)$/);
  if (dottedCompat && net.isIPv4(dottedCompat[1]!)) return dottedCompat[1]!;

  const hextets = expandIpv6Hextets(lower);
  if (!hextets) return null;

  // IPv4-mapped: ::ffff:x.x.x.x → 0000:0000:0000:0000:0000:ffff:HHHH:LLLL
  const isMapped =
    hextets[0] === "0000" &&
    hextets[1] === "0000" &&
    hextets[2] === "0000" &&
    hextets[3] === "0000" &&
    hextets[4] === "0000" &&
    hextets[5] === "ffff";
  if (isMapped) {
    const hi = parseInt(hextets[6]!, 16);
    const lo = parseInt(hextets[7]!, 16);
    if (!Number.isFinite(hi) || !Number.isFinite(lo)) return null;
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }

  // Deprecated IPv4-compatible: ::x.x.x.x → 0000…0000:HHHH:LLLL (not ::1)
  const isCompat =
    hextets[0] === "0000" &&
    hextets[1] === "0000" &&
    hextets[2] === "0000" &&
    hextets[3] === "0000" &&
    hextets[4] === "0000" &&
    hextets[5] === "0000";
  if (isCompat) {
    const hi = parseInt(hextets[6]!, 16);
    const lo = parseInt(hextets[7]!, 16);
    if (!Number.isFinite(hi) || !Number.isFinite(lo)) return null;
    // :: and ::1 are pure IPv6, not IPv4-compatible embeddings we re-check as v4
    if (hi === 0 && (lo === 0 || lo === 1)) return null;
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }

  return null;
}

export function isNonPublicIp(ip: string): boolean {
  ip = normalizeIpHost(ip);
  // Expand weird IPv4 spellings before classification
  const weird = !net.isIP(ip) ? expandWeirdIpv4Literal(ip) : null;
  const v4 = net.isIPv4(ip) ? ip : weird;
  if (v4 && net.isIPv4(v4)) {
    if (
      v4 === "0.0.0.0" ||
      v4.startsWith("127.") ||
      v4.startsWith("10.") ||
      v4.startsWith("192.168.") ||
      v4.startsWith("169.254.") ||
      v4.startsWith("224.") ||
      v4 === "255.255.255.255"
    ) {
      return true;
    }
    // 172.16.0.0/12
    const parts = v4.split(".").map(Number);
    if (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) return true;
    // CGNAT 100.64.0.0/10
    if (ipv4InCidr(v4, "100.64.0.0", 10)) return true;
    // TEST-NET / benchmarking / reserved
    if (ipv4InCidr(v4, "192.0.0.0", 24)) return true;
    if (ipv4InCidr(v4, "192.0.2.0", 24)) return true;
    if (ipv4InCidr(v4, "198.18.0.0", 15)) return true;
    if (ipv4InCidr(v4, "198.51.100.0", 24)) return true;
    if (ipv4InCidr(v4, "203.0.113.0", 24)) return true;
    if (ipv4InCidr(v4, "240.0.0.0", 4)) return true;
    if (ipv4InCidr(v4, "0.0.0.0", 8)) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase().split("%")[0] || "";
    if (lower === "::1" || lower === "::" || lower.startsWith("fe80:")) return true;
    // ULA fc00::/7 — check first hextet when expanded; prefix match covers common forms
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
    if (lower.startsWith("ff")) return true; // multicast
    const embedded = embeddedIpv4FromIpv6(lower);
    if (embedded) return isNonPublicIp(embedded);
    // Expanded ULA / link-local / multicast via hextets (covers 00fc:… odd forms)
    const hextets = expandIpv6Hextets(lower);
    if (hextets) {
      const h0 = parseInt(hextets[0]!, 16);
      if (Number.isFinite(h0)) {
        if ((h0 & 0xfe00) === 0xfc00) return true; // fc00::/7
        if ((h0 & 0xffc0) === 0xfe80) return true; // fe80::/10
        if ((h0 & 0xff00) === 0xff00) return true; // ff00::/8
      }
    }
    return false;
  }
  return true;
}

function isLoopbackAddr(ip: string): boolean {
  ip = normalizeIpHost(ip);
  if (net.isIPv4(ip)) return ip.startsWith("127.");
  if (net.isIPv6(ip)) {
    const lower = ip;
    if (lower === "::1") return true;
    const embedded = embeddedIpv4FromIpv6(lower);
    if (embedded) return embedded.startsWith("127.");
  }
  const weird = expandWeirdIpv4Literal(ip);
  if (weird) return weird.startsWith("127.");
  return false;
}

export function isBlockedForHost(
  ip: string,
  host: string,
  allowLocal: boolean,
): boolean {
  if (!isNonPublicIp(ip)) return false;
  if (allowLocal && isLoopbackAddr(ip) && isExplicitLocalHost(host)) {
    return false;
  }
  return true;
}

export async function assertUrlSafe(
  rawUrl: string,
  allowLocal = false,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    const scheme = url.protocol.replace(/:$/, "") || url.protocol;
    const tip =
      scheme === "ftp" || scheme === "ftps" || scheme === "file" || scheme === "ws" || scheme === "wss"
        ? " Did you mean https://…?"
        : "";
    throw new Error(`URL must be http(s); got ${url.protocol}.${tip}`);
  }
  if (url.username || url.password) {
    throw new Error("URL must not include credentials");
  }

  const host = url.hostname;
  if (!host) throw new Error("URL missing hostname");
  // Node may keep brackets on IPv6 hostnames (`[::1]`); peel before isIP / SSRF checks.
  const ipHost = normalizeIpHost(host);
  const weirdV4 = expandWeirdIpv4Literal(ipHost);

  if (net.isIP(ipHost) || weirdV4) {
    const checkIp = net.isIP(ipHost) ? ipHost : weirdV4!;
    // For allowLocal loopback exception, host must still look explicitly local
    const hostForAllow =
      weirdV4 && isLoopbackAddr(weirdV4) ? weirdV4 : ipHost;
    if (isBlockedForHost(checkIp, hostForAllow, allowLocal)) {
      throw new Error(
        `Blocked non-public address: ${ipHost}. ` +
          "web_fetch only allows public http(s); use allow_local=true for explicit localhost/127.0.0.1.",
      );
    }
    return url;
  }

  if (!allowLocal && isExplicitLocalHost(host)) {
    throw new Error(
      `Local host blocked: ${host}. Pass allow_local=true for explicit localhost/127.0.0.1 only ` +
        "(not a free read of private networks).",
    );
  }

  let addrs: Array<{ address: string; family: number }>;
  try {
    addrs = await dns.lookup(host, { all: true, verbatim: true });
  } catch (err) {
    throw new Error(
      `DNS lookup failed for ${host}: ${(err as Error).message}. ` +
        "Check the hostname spelling, network, or try a different public URL.",
    );
  }
  if (!addrs.length) {
    throw new Error(
      `No DNS records for ${host}. Check the hostname or try another public URL.`,
    );
  }

  for (const a of addrs) {
    if (isBlockedForHost(a.address, host, allowLocal)) {
      throw new Error(
        `Blocked: ${host} resolves to non-public address ${a.address}. ` +
          "Use a public URL, or allow_local=true only for explicit loopback hosts.",
      );
    }
  }
  return url;
}
