import { deliverToSubscriptions } from "./mcp";
import { flushSheet, queueSheetRow, summarize } from "./sheet";
import { EventRow, dueEvents, expiredOpen, housekeeping, resetStuck, transition } from "./store";
import { Env, NEVER, agents, hmacHex, log, num, secret } from "./util";

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
    requires_approval: ev.requires_approval,
    approved_by: ev.approved_by,
    attempts: ev.attempts,
    last_error: ev.last_error,
    ack_note: ev.ack_note,
  };
}

export function targetUrlAllowed(env: Env, url: string): boolean {
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
    // For endpoints that only accept free text (an agent's webhook-triggered routine or API-triggered task).
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

/** Deliver one event if it is still queued and due. Safe to call concurrently: the claim is a transaction. */
export async function deliver(env: Env, eventId: string): Promise<void> {
  const now = Date.now();
  const ev = await transition(eventId, ["queued"], (e) => (e.next_attempt_ms <= now ? { status: "delivering" } : null));
  if (!ev) return;

  let mode: string = agents(env)[ev.target]?.mode || "sheet";
  let error: string | null = null;
  let fatal = false;
  if (mode === "mcp") {
    // Webhook subscription created by the agent through MCP Events; without one, fall back to the sheet.
    const r = await deliverToSubscriptions(ev, { ...publicEvent(ev), status: "delivered" });
    if (r === "none") mode = "sheet";
    else if (r) ({ error, fatal } = r);
  }
  if (mode === "pull") {
    // Nothing to send: the target collects it from GET /inbox.
    await transition(eventId, ["delivering"], { status: "queued", next_attempt_ms: NEVER });
    return;
  }
  if (mode === "sheet") {
    await queueSheetRow(ev, "fallback", "relay経由。実時間の受信経路なし→伝言板で配達");
    await transition(eventId, ["delivering"], { status: "queued", next_attempt_ms: NEVER });
    await flushSheet(env);
    return;
  }

  if (mode === "push") error = await push(env, ev);
  const attempts = ev.attempts + 1;
  if (!error) {
    await transition(eventId, ["delivering"], { status: "delivered", delivered_ms: now, attempts, last_error: null });
    log("delivered", { event_id: eventId, target: ev.target });
    return;
  }
  if (fatal || attempts >= num(env.MAX_ATTEMPTS, 6)) {
    // Park it: status dead, plus a sheet row so the target (and the human) still sees it.
    await transition(eventId, ["delivering"], { status: "dead", attempts, last_error: error });
    await queueSheetRow({ ...ev, status: "dead" }, "fallback", `relay配達失敗(${attempts}回: ${error})→伝言板へ退避`);
    log("dead", { event_id: eventId, target: ev.target, error });
    return;
  }
  const base = num(env.RETRY_BASE_SECONDS, 30) * 1000;
  const cap = num(env.RETRY_CAP_SECONDS, 1800) * 1000;
  const delay = Math.min(cap, base * 2 ** (attempts - 1));
  const jitter = Math.floor(Math.random() * delay * 0.2);
  await transition(eventId, ["delivering"], { status: "queued", attempts, next_attempt_ms: now + delay + jitter, last_error: error });
  log("retry_scheduled", { event_id: eventId, target: ev.target, attempts, error });
}

/** Scheduled sweep: retries, expiry, stuck claims, sheet flush, housekeeping. */
export async function sweep(env: Env): Promise<Record<string, number>> {
  const now = Date.now();
  await resetStuck(now, 120_000);

  const expired = await expiredOpen(now, 10);
  let expiredCount = 0;
  for (const e of expired) {
    const ev = await transition(e.event_id, ["queued", "awaiting_approval"], { status: "expired" });
    if (!ev) continue;
    expiredCount++;
    await queueSheetRow(ev, "audit:expired", "relay: 期限切れ(未配達/未承認)");
  }

  const due = await dueEvents(now, 10);
  for (const e of due) await deliver(env, e.event_id);

  const sheetRows = await flushSheet(env);
  await housekeeping(now, num(env.RETENTION_DAYS, 30) * 86_400_000);
  return { expired: expiredCount, retried: due.length, sheet_rows: sheetRows };
}
