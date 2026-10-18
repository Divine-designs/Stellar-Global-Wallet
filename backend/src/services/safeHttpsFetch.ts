/**
 * Outbound HTTPS GET for attacker-influenced URLs (issue #52).
 *
 * An issuer's `home_domain` is set by whoever controls the issuing account,
 * so fetching `https://<home_domain>/.well-known/stellar.toml` is a request
 * to an arbitrary host chosen by a third party. Without guards that is a
 * textbook SSRF: a home domain resolving to 127.0.0.1, 10.x, 169.254.169.254
 * (cloud metadata) etc. would make this API probe its own network.
 *
 * Guards, in order:
 *   - https only, default port only (no `host:port` smuggling);
 *   - the hostname must be a syntactically valid DNS name (no IP literals);
 *   - every address the name resolves to is checked against private,
 *     loopback, link-local, CGNAT, multicast and reserved ranges, and the
 *     check runs inside the socket's own `lookup` hook — so the address we
 *     validate is the address we connect to (no DNS-rebinding window
 *     between "check" and "connect");
 *   - redirects are followed at most MAX_REDIRECTS times and each hop goes
 *     through the same checks;
 *   - hard timeout and response-size cap, enforced while streaming.
 */
import https from "node:https";
import dns from "node:dns";
import net from "node:net";
import type { LookupFunction } from "node:net";

export type SafeFetchFailure =
  | "INVALID_URL"
  | "BLOCKED_ADDRESS"
  | "DNS_FAILURE"
  | "TIMEOUT"
  | "TOO_LARGE"
  | "HTTP_STATUS"
  | "TOO_MANY_REDIRECTS"
  | "NETWORK_ERROR";

export class SafeFetchError extends Error {
  constructor(readonly reason: SafeFetchFailure, message: string) {
    super(message);
    this.name = "SafeFetchError";
  }
}

export interface SafeFetchOptions {
  timeoutMs: number;
  maxBytes: number;
  /** Injected in tests; defaults to `dns.lookup` with `all: true`. */
  resolve?: (hostname: string) => Promise<string[]>;
}

const MAX_REDIRECTS = 3;

// RFC 1123 hostname: dot-separated labels of letters/digits/hyphens, at least
// one dot, TLD not purely numeric (rules out dotted-quad IPv4 literals).
const HOSTNAME_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/i;

export function isValidPublicHostname(hostname: string): boolean {
  return HOSTNAME_PATTERN.test(hostname) && net.isIP(hostname) === 0;
}

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

const BLOCKED_IPV4_CIDRS: Array<[string, number]> = [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local / cloud metadata
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
];

function isBlockedIPv4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  return BLOCKED_IPV4_CIDRS.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (value & mask) === (ipv4ToInt(base) & mask);
  });
}

function isBlockedIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  // IPv4-mapped (::ffff:a.b.c.d) — judge by the embedded IPv4 address.
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIPv4(mapped[1]);
  if (lower === "::" || lower === "::1") return true;
  const firstHextet = parseInt(lower.split(":")[0] || "0", 16);
  if ((firstHextet & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((firstHextet & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((firstHextet & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (lower.startsWith("64:ff9b:")) return true; // NAT64 can reach IPv4 private space
  if (lower.startsWith("2001:db8:")) return true; // documentation
  return false;
}

export function isBlockedAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return isBlockedIPv4(ip);
  if (family === 6) return isBlockedIPv6(ip);
  return true;
}

async function defaultResolve(hostname: string): Promise<string[]> {
  const records = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return records.map((r) => r.address);
}

/** `lookup` hook for https.request that refuses to hand a blocked address to the socket. */
function guardedLookup(resolve: (hostname: string) => Promise<string[]>): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname)
      .then((addresses) => {
        if (addresses.length === 0) {
          callback(new SafeFetchError("DNS_FAILURE", `No addresses for ${hostname}`), "", 4);
          return;
        }
        // Reject if *any* record is internal: a name that mixes public and
        // private records is either misconfigured or an attack.
        if (addresses.some(isBlockedAddress)) {
          callback(
            new SafeFetchError("BLOCKED_ADDRESS", `${hostname} resolves to a non-public address`),
            "",
            4
          );
          return;
        }
        const address = addresses[0];
        const family = net.isIP(address);
        if ((options as { all?: boolean }).all) {
          (callback as unknown as (err: null, addrs: Array<{ address: string; family: number }>) => void)(
            null,
            addresses.map((a) => ({ address: a, family: net.isIP(a) }))
          );
          return;
        }
        callback(null, address, family);
      })
      .catch(() => {
        callback(new SafeFetchError("DNS_FAILURE", `Could not resolve ${hostname}`), "", 4);
      });
  };
}

function parseTarget(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SafeFetchError("INVALID_URL", "Malformed URL");
  }
  if (url.protocol !== "https:") throw new SafeFetchError("INVALID_URL", "Only https URLs are allowed");
  if (url.port !== "" && url.port !== "443") {
    throw new SafeFetchError("INVALID_URL", "Non-default ports are not allowed");
  }
  if (url.username || url.password) throw new SafeFetchError("INVALID_URL", "Credentials in URL are not allowed");
  if (!isValidPublicHostname(url.hostname)) {
    throw new SafeFetchError("INVALID_URL", "Host must be a public DNS name");
  }
  return url;
}

function requestOnce(
  url: URL,
  options: Required<Pick<SafeFetchOptions, "timeoutMs" | "maxBytes">> & {
    resolve: (hostname: string) => Promise<string[]>;
    deadline: number;
  }
): Promise<{ status: number; location?: string; body?: string }> {
  return new Promise((resolvePromise, reject) => {
    const remaining = options.deadline - Date.now();
    if (remaining <= 0) {
      reject(new SafeFetchError("TIMEOUT", "Request timed out"));
      return;
    }

    const req = https.request(
      url,
      {
        method: "GET",
        lookup: guardedLookup(options.resolve),
        headers: { Accept: "text/plain, application/toml, */*;q=0.1", "User-Agent": "GlobeWallet/1.0" },
        timeout: remaining,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          resolvePromise({ status, location: res.headers.location });
          return;
        }
        if (status !== 200) {
          res.resume();
          reject(new SafeFetchError("HTTP_STATUS", `Upstream responded ${status}`));
          return;
        }

        const declared = Number(res.headers["content-length"]);
        if (Number.isFinite(declared) && declared > options.maxBytes) {
          res.destroy();
          reject(new SafeFetchError("TOO_LARGE", "Response exceeds size limit"));
          return;
        }

        const chunks: Buffer[] = [];
        let received = 0;
        res.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > options.maxBytes) {
            res.destroy();
            reject(new SafeFetchError("TOO_LARGE", "Response exceeds size limit"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolvePromise({ status, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", () => reject(new SafeFetchError("NETWORK_ERROR", "Response stream failed")));
      }
    );

    const timer = setTimeout(() => {
      req.destroy(new SafeFetchError("TIMEOUT", "Request timed out"));
    }, remaining);

    req.on("timeout", () => req.destroy(new SafeFetchError("TIMEOUT", "Request timed out")));
    req.on("error", (err) => {
      clearTimeout(timer);
      reject(err instanceof SafeFetchError ? err : new SafeFetchError("NETWORK_ERROR", "Request failed"));
    });
    req.on("close", () => clearTimeout(timer));
    req.end();
  });
}

/**
 * GET `rawUrl` as UTF-8 text under the SSRF, size and time guards described
 * above. Rejects with {@link SafeFetchError}; never with a raw socket error.
 */
export async function safeHttpsGetText(rawUrl: string, options: SafeFetchOptions): Promise<string> {
  const resolve = options.resolve ?? defaultResolve;
  const deadline = Date.now() + options.timeoutMs;
  let url = parseTarget(rawUrl);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await requestOnce(url, {
      timeoutMs: options.timeoutMs,
      maxBytes: options.maxBytes,
      resolve,
      deadline,
    });
    if (res.body !== undefined) return res.body;
    url = parseTarget(new URL(res.location as string, url).toString());
  }

  throw new SafeFetchError("TOO_MANY_REDIRECTS", "Too many redirects");
}
