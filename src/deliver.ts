import { EventRow, flushSheet, queueSheetRow, summarize } from "./sheet";
import { Env, agents, hmacHex, log, num, secret } from "./util";

export function publicEvent(ev: EventRow): Record<string, unknown> {
  let payload: unknown = {};
  try {
    payload = JSON.parse(ev.payload);
  } catch {
    /* keep empty */
  }
  return {
    event_id: ev.event_id,
    correlation_id: ev.correlation_id,
    created_at: ev.created_at,
    source: ev.source,
    target: ev.target,
    type: ev.type,
    priority: ev.priority,
    payload,
    reply_to: ev.reply_to,
    status: ev.status,
    hop_count: ev.hop_count,
    requires_approval: !!ev.requires_approval,
    approved_by: ev.approved_by,
    attempts: ev.attempts,
    last_error: ev.last_error,
    ack_note: ev.ack_note,
  };
}

function targetUrlAllowed(env: Env, url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === "https:") return true;
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    return u.protocol === "http:" && local && String(env.ALLOW_INSECURE_TARGETS).toLowerCase() === "true";
  } catch {
    return false;
  }
}

/** One push attempt. Returns null on success, otherwise a short error string (no payload, no URL). */
async function push(env: Env, ev: EventRow): Promise<string | null> {
  const cfg = agents(env)[ev.target];
  const url = secret(env, "URL", ev.target);
  if (!url) return "no target URL configured";
  if (!targetUrlAllowed(env, url)) return "target URL must be https";

  const headers: Record<string, string> = { ...(cfg?.headers || {}), "content-type": "application/json", "x-relay-event-id": ev.event_id };
  let body: string;
  if (cfg?.format === "text") {
    // For endpoints that only accept free text (e.g. an API-triggered agent session).
    const auth = secret(env, "PUSH_AUTH", ev.target);
    if (auth) headers["authorization"] = `Bearer ${auth}`;
    body = JSON.stringify({
      text: `[relay ${ev.type}/${ev.priority}] from=${ev.source} event_id=${ev.event_id} correlation_id=${ev.correlation_id}\n${summarize(ev, 4000)}`,
    });
  } else {
    const token = secret(env, "TOKEN", ev.target);
    if (!token) return "no target token configured";
    body = JSON.stringify({ ...publicEvent(ev), status: "delivered" });
    const ts = Math.floor(Date.now() / 1000).toString();
    headers["x-relay-timestamp"] = ts;
    headers["x-relay-signature"] = await hmacHex(token, `${ts}.${ev.event_id}.${body}`);
  }
  try {
    const res = await fetch(url, { method: "POST", headers, body, redirect: "manual", signal: AbortSignal.timeout(10_000) });
    await res.body?.cancel();
    return res.status >= 200 && res.status < 300 ? null : `target HTTP ${res.status}`;
  } catch (e) {
    return `target ${(e as Error).name}`;
  }
}

/** Deliver one event if it is still queued. Safe to call concurrently: the claim is atomic. */
export async function deliver(env: Env, eventId: string): Promise<void> {
  const now = Date.now();
  const claim = await env.DB.prepare(
    "UPDATE events SET status = 'delivering', updated_ms = ? WHERE event_id = ? AND status = 'queued' AND next_attempt_ms <= ?",
  )
    .bind(now, eventId, now)
    .run();
  if (!claim.meta.changes) return;
  const ev = await env.DB.prepare("SELECT * FROM events WHERE event_id = ?").bind(eventId).first<EventRow>();
  if (!ev) return;

  const mode = agents(env)[ev.target]?.mode || "sheet";
  if (mode === "pull") {
    // Nothing to send: the target collects it from GET /inbox.
    await env.DB.prepare("UPDATE events SET status = 'queued', next_attempt_ms = ?, updated_ms = ? WHERE event_id = ?")
      .bind(Number.MAX_SAFE_INTEGER, now, eventId)
      .run();
    return;
  }
  if (mode === "sheet") {
    await queueSheetRow(env, ev, "fallback", "relay経由。実時間の受信経路なし→伝言板で配達");
    await env.DB.prepare("UPDATE events SET status = 'queued', next_attempt_ms = ?, updated_ms = ? WHERE event_id = ?")
      .bind(Number.MAX_SAFE_INTEGER, now, eventId)
      .run();
    await flushSheet(env);
    return;
  }

  const error = await push(env, ev);
  if (!error) {
    await env.DB.prepare(
      "UPDATE events SET status = 'delivered', delivered_ms = ?, attempts = attempts + 1, last_error = NULL, updated_ms = ? WHERE event_id = ?",
    )
      .bind(now, now, eventId)
      .run();
    log("delivered", { event_id: eventId, target: ev.target });
    return;
  }

  const attempts = ev.attempts + 1;
  if (attempts >= num(env.MAX_ATTEMPTS, 6)) {
    // Park it: status dead, plus a sheet row so the target (and the human) still sees it.
    await env.DB.prepare("UPDATE events SET status = 'dead', attempts = ?, last_error = ?, updated_ms = ? WHERE event_id = ?")
      .bind(attempts, error, now, eventId)
      .run();
    await queueSheetRow(env, { ...ev, status: "dead" }, "fallback", `relay配達失敗(${attempts}回: ${error})→伝言板へ退避`);
    log("dead", { event_id: eventId, target: ev.target, error });
    return;
  }
  const base = num(env.RETRY_BASE_SECONDS, 30) * 1000;
  const cap = num(env.RETRY_CAP_SECONDS, 1800) * 1000;
  const delay = Math.min(cap, base * 2 ** (attempts - 1));
  const jitter = Math.floor(Math.random() * delay * 0.2);
  await env.DB.prepare(
    "UPDATE events SET status = 'queued', attempts = ?, next_attempt_ms = ?, last_error = ?, updated_ms = ? WHERE event_id = ?",
  )
    .bind(attempts, now + delay + jitter, error, now, eventId)
    .run();
  log("retry_scheduled", { event_id: eventId, target: ev.target, attempts, error });
}

/** Cron sweep: retries, expiry, stuck claims, sheet flush, housekeeping. */
export async function sweep(env: Env): Promise<Record<string, number>> {
  const now = Date.now();
  // A claim older than 2 minutes means the invocation died mid-delivery.
  await env.DB.prepare("UPDATE events SET status = 'queued', updated_ms = ? WHERE status = 'delivering' AND updated_ms < ?")
    .bind(now, now - 120_000)
    .run();

  const expired = await env.DB.prepare(
    "SELECT * FROM events WHERE status IN ('queued','awaiting_approval') AND expires_ms <= ? LIMIT 5",
  )
    .bind(now)
    .all<EventRow>();
  for (const ev of expired.results || []) {
    await env.DB.prepare("UPDATE events SET status = 'expired', updated_ms = ? WHERE event_id = ?").bind(now, ev.event_id).run();
    await queueSheetRow(env, { ...ev, status: "expired" }, "audit:expired", "relay: 期限切れ(未配達/未承認)");
  }

  // Small batch: free plan allows 50 subrequests and 50 D1 queries per invocation.
  const due = await env.DB.prepare(
    "SELECT event_id FROM events WHERE status = 'queued' AND next_attempt_ms <= ? ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, created_ms LIMIT 5",
  )
    .bind(now)
    .all<{ event_id: string }>();
  for (const r of due.results || []) await deliver(env, r.event_id);

  const flushed = await flushSheet(env);

  const keepMs = num(env.RETENTION_DAYS, 30) * 86_400_000;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM nonces WHERE seen_ms < ?").bind(now - 900_000),
    env.DB.prepare("DELETE FROM events WHERE updated_ms < ? AND status IN ('acked','dead','expired','rejected','delivered')").bind(now - keepMs),
    env.DB.prepare("DELETE FROM sheet_outbox WHERE done = 1 AND next_attempt_ms < ?").bind(now - keepMs),
  ]);
  return { expired: (expired.results || []).length, retried: (due.results || []).length, sheet_rows: flushed.length };
}
