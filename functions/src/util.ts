export interface Env {
  AGENTS?: string;
  MAX_HOPS?: string;
  MAX_ATTEMPTS?: string;
  RETRY_BASE_SECONDS?: string;
  RETRY_CAP_SECONDS?: string;
  DEFAULT_TTL_SECONDS?: string;
  DAILY_EVENT_LIMIT?: string;
  REQUIRE_SIGNATURE?: string;
  APPROVAL_ACTIONS?: string;
  RETENTION_DAYS?: string;
  ALLOW_INSECURE_TARGETS?: string;
  ADMIN_TOKEN?: string;
  SHEET_WEBHOOK_URL?: string;
  SHEET_WEBHOOK_SECRET?: string;
  // TOKEN_<AGENT>, URL_<AGENT>, PUSH_AUTH_<AGENT>, MCP_TOKEN_<AGENT>, WATCH_ID_<AGENT> are read dynamically.
  [key: string]: string | undefined;
}

export type AgentMode = "push" | "pull" | "sheet" | "mcp";
export interface AgentConfig {
  mode: AgentMode;
  format?: "relay" | "text";
  /** Extra non-secret request headers for push (e.g. API version headers). */
  headers?: Record<string, string>;
}

export const EVENT_TYPES = ["instruction", "result", "notification", "error", "ack"] as const;
export const PRIORITIES = ["low", "normal", "high"] as const;
export const ADMIN = "Human"; // the approving human; never a valid event target
export const NEVER = Number.MAX_SAFE_INTEGER; // next_attempt_ms for events the relay does not push

export function num(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function agents(env: Env): Record<string, AgentConfig> {
  try {
    return JSON.parse(env.AGENTS || "{}");
  } catch {
    return {};
  }
}

export function secret(env: Env, prefix: string, agent: string): string | undefined {
  const v = env[`${prefix}_${agent.toUpperCase()}`];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** ISO 8601 in JST, e.g. 2026-11-12T21:05:00+09:00 */
export function jstIso(ms: number): string {
  return new Date(ms + 9 * 3600_000).toISOString().replace(/\.\d{3}Z$/, "+09:00");
}

/** Sheet format, e.g. 2026-11-12 21:05 */
export function jstSheet(ms: number): string {
  return jstIso(ms).slice(0, 16).replace("T", " ");
}

export function jstDay(ms: number): string {
  return jstIso(ms).slice(0, 10);
}

const enc = new TextEncoder();

export async function sha256Hex(s: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}

export async function hmacHex(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string comparison (compares digests, so length does not leak either). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export function err(status: number, code: string, message: string, extra: Record<string, unknown> = {}): Response {
  return json({ ok: false, error: code, message, ...extra }, status);
}

/** Log line without payloads or secrets. */
export function log(msg: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ msg, ...fields }));
}
