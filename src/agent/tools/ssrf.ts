/**
 * SSRF guards for web_fetch (Grok-inspired).
 * Blocks non-public addresses; local only when allowLocal + explicit loopback host.
 */
import dns from "node:dns/promises";
import net from "node:net";

export function isExplicitLocalHost(host: string): boolean {
  let h = host.trim().toLowerCase();
  h = h.replace(/\.$/, "");
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  h = h.split("%")[0] || h;
  if (h === "localhost") return true;
  if (net.isIP(h)) return isLoopbackAddr(h);
  return false;
}

function ipv4InCidr(ip: string, base: string, prefix: number): boolean {
  const toInt = (s: string) =>
    s.split(".").reduce((acc, o) => ((acc << 8) + Number(o)) >>> 0, 0);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (toInt(ip) & mask) === (toInt(base) & mask);
}

export function isNonPublicIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    if (
      ip === "0.0.0.0" ||
      ip.startsWith("127.") ||
      ip.startsWith("10.") ||
      ip.startsWith("192.168.") ||
      ip.startsWith("169.254.") ||
      ip.startsWith("224.") ||
      ip === "255.255.255.255"
    ) {
      return true;
    }
    // 172.16.0.0/12
    const parts = ip.split(".").map(Number);
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    // CGNAT 100.64.0.0/10
    if (ipv4InCidr(ip, "100.64.0.0", 10)) return true;
    // TEST-NET / benchmarking / reserved
    if (ipv4InCidr(ip, "192.0.0.0", 24)) return true;
    if (ipv4InCidr(ip, "192.0.2.0", 24)) return true;
    if (ipv4InCidr(ip, "198.18.0.0", 15)) return true;
    if (ipv4InCidr(ip, "198.51.100.0", 24)) return true;
    if (ipv4InCidr(ip, "203.0.113.0", 24)) return true;
    if (ipv4InCidr(ip, "240.0.0.0", 4)) return true;
    if (ipv4InCidr(ip, "0.0.0.0", 8)) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::" || lower.startsWith("fe80:")) return true;
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA
    if (lower.startsWith("ff")) return true; // multicast
    // IPv4-mapped
    const mapped = lower.match(/^:ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (mapped) return isNonPublicIp(mapped[1]);
    const mapped2 = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (mapped2) return isNonPublicIp(mapped2[1]);
    return false;
  }
  return true;
}

function isLoopbackAddr(ip: string): boolean {
  if (net.isIPv4(ip)) return ip.startsWith("127.");
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === "::1") return true;
    const mapped = lower.match(/^:ffff:(127\.\d+\.\d+\.\d+)$/i);
    if (mapped) return true;
    const mapped2 = lower.match(/^::ffff:(127\.\d+\.\d+\.\d+)$/i);
    if (mapped2) return true;
  }
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
    throw new Error(`URL must be http(s); got ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error("URL must not include credentials");
  }

  const host = url.hostname;
  if (!host) throw new Error("URL missing hostname");

  if (net.isIP(host)) {
    if (isBlockedForHost(host, host, allowLocal)) {
      throw new Error(`Blocked non-public address: ${host}`);
    }
    return url;
  }

  if (!allowLocal && isExplicitLocalHost(host)) {
    throw new Error(
      `Local host blocked (pass allow_local=true for explicit loopback only): ${host}`,
    );
  }

  let addrs: Array<{ address: string; family: number }>;
  try {
    addrs = await dns.lookup(host, { all: true, verbatim: true });
  } catch (err) {
    throw new Error(`DNS lookup failed for ${host}: ${(err as Error).message}`);
  }
  if (!addrs.length) throw new Error(`No DNS records for ${host}`);

  for (const a of addrs) {
    if (isBlockedForHost(a.address, host, allowLocal)) {
      throw new Error(
        `Blocked: ${host} resolves to non-public address ${a.address}`,
      );
    }
  }
  return url;
}
