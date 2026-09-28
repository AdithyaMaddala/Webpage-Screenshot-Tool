import { lookup } from "node:dns/promises";
import net from "node:net";

// Blocks requests to localhost, private LANs, link-local and cloud metadata
// endpoints so the API can't be used to probe internal networks (SSRF).
const blockList = new net.BlockList();
[
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
].forEach(([addr, prefix]) => blockList.addSubnet(addr, prefix, "ipv4"));
[
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["::ffff:0:0", 96], // IPv4-mapped; checked separately below
].forEach(([addr, prefix]) => blockList.addSubnet(addr, prefix, "ipv6"));

function isBlockedIp(ip) {
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return blockList.check(mapped[1], "ipv4");
  return blockList.check(ip, net.isIPv6(ip) ? "ipv6" : "ipv4");
}

const hostCache = new Map();

export async function isHostAllowed(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostCache.has(host)) return hostCache.get(host);

  let allowed;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    allowed = false;
  } else if (net.isIP(host)) {
    allowed = !isBlockedIp(host);
  } else {
    try {
      const records = await lookup(host, { all: true });
      allowed = records.length > 0 && records.every((r) => !isBlockedIp(r.address));
    } catch {
      allowed = false; // unresolvable
    }
  }
  hostCache.set(host, allowed);
  return allowed;
}

/**
 * Normalises user input into a safe http(s) URL or throws a user-facing error.
 */
export async function validateTargetUrl(raw) {
  if (!raw || typeof raw !== "string") {
    throw Object.assign(new Error("Add a url parameter, e.g. ?url=https://example.com"), { status: 400 });
  }
  let input = raw.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) input = `https://${input}`;

  let url;
  try {
    url = new URL(input);
  } catch {
    throw Object.assign(new Error("That doesn't look like a valid web address."), { status: 400 });
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw Object.assign(new Error("Only http and https addresses can be captured."), { status: 400 });
  }
  if (url.username || url.password) {
    throw Object.assign(new Error("Addresses with embedded credentials aren't allowed."), { status: 400 });
  }
  if (!(await isHostAllowed(url.hostname))) {
    throw Object.assign(
      new Error("This address points to a private or unreachable network and can't be captured."),
      { status: 403 }
    );
  }
  return url;
}
