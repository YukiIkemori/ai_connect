import { ADMIN, Env, agents, hmacHex, safeEqual, secret } from "./util";

export interface AuthOk {
  ok: true;
  agent: string; // agent name, or ADMIN
  isAdmin: boolean;
}
export interface AuthFail {
  ok: false;
  status: number;
  code: string;
  message: string;
}

const SIGNATURE_WINDOW_SECONDS = 300;

/**
 * Bearer token identifies the caller. Optionally (or always, when REQUIRE_SIGNATURE=true) the request
 * is also signed: X-Relay-Signature = hex(HMAC-SHA256(token, `${timestamp}.${nonce}.${rawBody}`)).
 * A signed request is rejected outside a 5-minute window or when its nonce was already used.
 */
export async function authenticate(req: Request, env: Env, rawBody: string): Promise<AuthOk | AuthFail> {
  const header = req.headers.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) return { ok: false, status: 401, code: "unauthorized", message: "Bearer token required" };
  const token = m[1].trim();

  let who: string | undefined;
  if (env.ADMIN_TOKEN && (await safeEqual(token, env.ADMIN_TOKEN))) who = ADMIN;
  for (const name of Object.keys(agents(env))) {
    const t = secret(env, "TOKEN", name);
    // Every candidate is compared so timing does not reveal which agent matched.
    if (t && (await safeEqual(token, t)) && !who) who = name;
  }
  if (!who) return { ok: false, status: 401, code: "unauthorized", message: "Unknown token" };

  const sig = req.headers.get("x-relay-signature");
  const ts = req.headers.get("x-relay-timestamp");
  const nonce = req.headers.get("x-relay-nonce");
  const required = String(env.REQUIRE_SIGNATURE).toLowerCase() === "true";
  if (!sig && !required) return { ok: true, agent: who, isAdmin: who === ADMIN };
  if (!sig || !ts || !nonce) {
    return { ok: false, status: 401, code: "signature_required", message: "X-Relay-Timestamp, X-Relay-Nonce and X-Relay-Signature are required" };
  }
  const skew = Math.abs(Date.now() / 1000 - Number(ts));
  if (!Number.isFinite(skew) || skew > SIGNATURE_WINDOW_SECONDS) {
    return { ok: false, status: 401, code: "stale_timestamp", message: "Timestamp outside the allowed window" };
  }
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(nonce)) {
    return { ok: false, status: 401, code: "bad_nonce", message: "Nonce must be 8-128 URL-safe characters" };
  }
  const expected = await hmacHex(token, `${ts}.${nonce}.${rawBody}`);
  if (!(await safeEqual(expected, sig.toLowerCase()))) {
    return { ok: false, status: 401, code: "bad_signature", message: "Signature mismatch" };
  }
  const ins = await env.DB.prepare("INSERT OR IGNORE INTO nonces (nonce, seen_ms) VALUES (?, ?)")
    .bind(`${who}:${nonce}`, Date.now())
    .run();
  if (!ins.meta.changes) return { ok: false, status: 401, code: "replay", message: "Nonce already used" };
  return { ok: true, agent: who, isAdmin: who === ADMIN };
}
