/**
 * Phase 5 security helpers: IP allowlist matching (item 12) and
 * login-event recording with new-device alerts (item 13).
 */

import { randomId } from "./tokens";
import { nowIso } from "./accounts";
import { dispatchNotifications } from "./notify";
import type { Env } from "./types";

/** Client IP for the current request, preferring Cloudflare's header. */
export function requestIp(headers: Headers): string {
  const cf = headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const xff = headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]?.trim() ?? "";
  return "";
}

/** Parse a 32-bit IPv4 address into a number, or null. */
function parseIpv4(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value;
}

function ipv4Matches(ip: string, entry: string): boolean {
  const slash = entry.indexOf("/");
  if (slash === -1) return ip === entry;
  const network = parseIpv4(entry.slice(0, slash));
  const bitsRaw = entry.slice(slash + 1);
  if (!/^\d{1,2}$/.test(bitsRaw)) return false;
  const bits = Number(bitsRaw);
  if (bits > 32 || network === null) return false;
  const addr = parseIpv4(ip);
  if (addr === null) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (addr & mask) === (network & mask);
}

/** True when one allowlist entry matches the given IP. */
export function ipMatchesEntry(ip: string, entry: string): boolean {
  const e = entry.trim();
  if (!e || !ip) return false;
  if (e.includes(":")) return ip.toLowerCase() === e.toLowerCase();
  return ipv4Matches(ip, e);
}

/** Validate an entry for storage (IPv4, IPv4 CIDR, or IPv6 literal). */
export function isValidIpEntry(entry: string): boolean {
  const e = entry.trim();
  if (!e) return false;
  if (e.includes(":")) return /^[0-9a-fA-F:]+$/.test(e) && e.includes(":");
  const slash = e.indexOf("/");
  if (slash === -1) return parseIpv4(e) !== null;
  const bits = e.slice(slash + 1);
  return (
    parseIpv4(e.slice(0, slash)) !== null &&
    /^\d{1,2}$/.test(bits) &&
    Number(bits) <= 32
  );
}

/**
 * True when `ip` is allowed by a comma-separated allowlist. An empty /
 * null allowlist means unrestricted. An empty request IP (local tests,
 * non-HTTP callers) is treated as allowed — the edge always sets the
 * header in production, and failing closed here would break the API
 * for every non-browser client on a typo.
 */
export function ipAllowed(allowlist: string | null | undefined, ip: string): boolean {
  if (!allowlist || allowlist.trim() === "") return true;
  if (!ip) return true;
  return allowlist
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e !== "")
    .some((e) => ipMatchesEntry(ip, e));
}

/**
 * Record a completed login and, when the (IP, user agent) pair is new
 * for this account, send a login alert. The very first login is never
 * alerted (there is no history to compare against).
 */
export async function recordLoginEvent(
  env: Env,
  accountId: string,
  ip: string,
  userAgent: string,
): Promise<void> {
  const now = nowIso();
  const { results } = await env.DB.prepare(
    "SELECT ip, user_agent FROM login_events WHERE account_id = ?1",
  )
    .bind(accountId)
    .all<{ ip: string; user_agent: string }>();
  const seen = results ?? [];
  const isNew =
    seen.length > 0 &&
    !seen.some((r) => r.ip === ip && r.user_agent === userAgent);
  await env.DB.prepare(
    "INSERT INTO login_events (id, account_id, ip, user_agent, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
  )
    .bind(randomId(), accountId, ip, userAgent, now)
    .run();
  if (isNew) {
    // Notifications are tenant-scoped; deliver the alert through the
    // account's first (personal) tenant. No actorAccountId: the
    // dispatcher drops actor == recipient pairs, and a login alert is
    // precisely a self-notification.
    const membership = await env.DB.prepare(
      "SELECT tenant_id FROM tenant_members WHERE account_id = ?1",
    )
      .bind(accountId)
      .first<{ tenant_id: string }>();
    if (membership) {
      await dispatchNotifications(env, {
        kind: "login_alert",
        tenantId: membership.tenant_id,
        recipientIds: [accountId],
        title: "新しい端末または場所からのログインがありました",
        payload: { ip, user_agent_prefix: userAgent.slice(0, 60), at: now },
        relatedType: "account",
        relatedId: accountId,
      });
    }
  }
}
