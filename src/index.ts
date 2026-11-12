import { authenticate } from "./auth";
import { deliver, publicEvent, sweep } from "./deliver";
import { EventRow, queueSheetRow } from "./sheet";
import { ADMIN, EVENT_TYPES, Env, PRIORITIES, agents, err, json, jstDay, jstIso, log, num, sha256Hex } from "./util";

const MAX_BODY_BYTES = 16 * 1024;
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await route(req, env, ctx);
    } catch (e) {
      log("unhandled", { error: (e as Error).message });
      return err(500, "internal_error", "Internal error");
    }
  },
  async scheduled(_c: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(sweep(env).then((r) => log("sweep", r)));
  },
} satisfies ExportedHandler<Env>;

async function route(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "GET" && path === "/health") {
    // Unauthenticated: liveness only, no data.
    let db = "ok";
    try {
      await env.DB.prepare("SELECT 1").first();
    } catch {
      db = "error";
    }
    return json({ ok: db === "ok", service: "ai-relay", version: "1.0.0", db, time: jstIso(Date.now()) }, db === "ok" ? 200 : 503);
  }

  const lenHeader = Number(req.headers.get("content-length") || 0);
  if (lenHeader > MAX_BODY_BYTES) return err(413, "payload_too_large", `Body must be at most ${MAX_BODY_BYTES} bytes`);
  const raw = req.method === "POST" ? await req.text() : "";
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return err(413, "payload_too_large", `Body must be at most ${MAX_BODY_BYTES} bytes`);

  const auth = await authenticate(req, env, raw);
  if (!auth.ok) return err(auth.status, auth.code, auth.message);

  let body: Record<string, unknown> = {};
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      body = parsed;
    } catch {
      return err(400, "bad_json", "Body must be a JSON object");
    }
  }

  if (req.method === "POST" && path === "/events") return createEvent(env, ctx, auth.agent, auth.isAdmin, body);
  if (req.method === "GET" && path === "/events") return listEvents(env, auth.agent, auth.isAdmin, url);
  if (req.method === "GET" && path === "/inbox") return inbox(env, auth.agent, url);

  const m = /^\/events\/([A-Za-z0-9_-]{8,64})(?:\/(ack|approve|reject))?$/.exec(path);
  if (m) {
    const ev = await env.DB.prepare("SELECT * FROM events WHERE event_id = ?").bind(m[1]).first<EventRow>();
    const visible = ev && (auth.isAdmin || ev.source === auth.agent || ev.target === auth.agent);
    if (!ev || !visible) return err(404, "not_found", "No such event");
    if (req.method === "GET" && !m[2]) return json({ ok: true, event: publicEvent(ev) });
    if (req.method === "POST" && m[2] === "ack") return ack(env, ev, auth.agent, auth.isAdmin, body);
    if (req.method === "POST" && (m[2] === "approve" || m[2] === "reject")) {
      if (!auth.isAdmin) return err(403, "forbidden", "Only the human admin token can approve or reject");
      return decide(env, ctx, ev, m[2] === "approve", body);
    }
  }
  return err(404, "not_found", "No such route");
}

async function createEvent(env: Env, ctx: ExecutionContext, caller: string, isAdmin: boolean, b: Record<string, unknown>): Promise<Response> {
  const known = agents(env);
  const now = Date.now();
  const source = isAdmin ? ADMIN : caller;
  // Source verification: the claimed source must be the authenticated caller.
  if (b.source !== undefined && b.source !== source) return err(403, "source_mismatch", "source must match the authenticated caller");

  const target = b.target;
  if (typeof target !== "string" || !known[target]) return err(422, "bad_target", `target must be one of: ${Object.keys(known).join(", ")}`);
  if (target === source) return err(422, "bad_target", "source and target must differ");
  const type = b.type as string;
  if (!EVENT_TYPES.includes(type as never)) return err(422, "bad_type", `type must be one of: ${EVENT_TYPES.join(", ")}`);
  const priority = (b.priority ?? "normal") as string;
  if (!PRIORITIES.includes(priority as never)) return err(422, "bad_priority", `priority must be one of: ${PRIORITIES.join(", ")}`);
  const payload = b.payload ?? {};
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return err(422, "bad_payload", "payload must be an object");

  const eventId = b.event_id === undefined ? crypto.randomUUID() : b.event_id;
  if (typeof eventId !== "string" || !ID_RE.test(eventId)) return err(422, "bad_event_id", "event_id must be 8-64 URL-safe characters");
  for (const k of ["correlation_id", "reply_to"] as const) {
    if (b[k] !== undefined && b[k] !== null && (typeof b[k] !== "string" || !ID_RE.test(b[k] as string))) {
      return err(422, `bad_${k}`, `${k} must be 8-64 URL-safe characters`);
    }
  }

  // Idempotency: the same event_id is accepted once; a repeat with identical content returns the stored event.
  const bodyHash = await sha256Hex(JSON.stringify([source, target, type, priority, payload, b.reply_to ?? null]));
  const existing = await env.DB.prepare("SELECT * FROM events WHERE event_id = ?").bind(eventId).first<EventRow>();
  if (existing) {
    if (existing.body_hash !== bodyHash) return err(409, "event_id_conflict", "event_id already used with different content");
    return json({ ok: true, duplicate: true, event: publicEvent(existing) });
  }

  // Loop prevention: every reply is one hop deeper than what it answers.
  const maxHops = num(env.MAX_HOPS, 5);
  let hop = Number.isInteger(b.hop_count) && (b.hop_count as number) >= 0 ? (b.hop_count as number) : 0;
  let correlationId = (b.correlation_id as string | undefined) || eventId;
  const replyTo = (b.reply_to as string | undefined) || null;
  if (replyTo) {
    const parent = await env.DB.prepare("SELECT correlation_id, hop_count, source, target FROM events WHERE event_id = ?")
      .bind(replyTo)
      .first<{ correlation_id: string; hop_count: number; source: string; target: string }>();
    if (!parent) return err(422, "bad_reply_to", "reply_to does not match a known event");
    if (!isAdmin && parent.target !== source && parent.source !== source) return err(403, "forbidden", "reply_to refers to an event you are not part of");
    hop = Math.max(hop, parent.hop_count + 1);
    correlationId = parent.correlation_id;
  }
  if (hop > maxHops) {
    log("loop_blocked", { event_id: eventId, source, target, hop });
    return err(422, "loop_detected", `hop_count ${hop} exceeds max_hops ${maxHops}`, { hop_count: hop, max_hops: maxHops });
  }

  // Free-tier guard.
  const day = jstDay(now);
  const limit = num(env.DAILY_EVENT_LIMIT, 2000);
  const counted = await env.DB.prepare(
    "INSERT INTO counters (day, count) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET count = count + 1 WHERE count < ? RETURNING count",
  )
    .bind(day, limit)
    .first<{ count: number }>();
  if (!counted) return err(429, "daily_limit", `Daily event limit (${limit}) reached; resets at 00:00 JST`);

  // Outward actions wait for a human.
  const actions = String(env.APPROVAL_ACTIONS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const action = (payload as Record<string, unknown>).action;
  const needsApproval = type === "instruction" && (b.requires_approval === true || (typeof action === "string" && actions.includes(action)));

  const ttl = Math.min(num(b.ttl_seconds, num(env.DEFAULT_TTL_SECONDS, 86400)), 7 * 86400);
  const ev: EventRow = {
    event_id: eventId,
    correlation_id: correlationId,
    created_at: jstIso(now),
    created_ms: now,
    source,
    target,
    type,
    priority,
    payload: JSON.stringify(payload),
    reply_to: replyTo,
    status: needsApproval ? "awaiting_approval" : "queued",
    hop_count: hop,
    requires_approval: needsApproval ? 1 : 0,
    approved_by: null,
    attempts: 0,
    next_attempt_ms: 0,
    expires_ms: now + ttl * 1000,
    last_error: null,
    delivered_ms: null,
    acked_ms: null,
    ack_note: null,
    body_hash: bodyHash,
    updated_ms: now,
  };
  const ins = await env.DB.prepare(
    `INSERT OR IGNORE INTO events (event_id, correlation_id, created_at, created_ms, source, target, type, priority, payload, reply_to,
       status, hop_count, requires_approval, expires_ms, body_hash, updated_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(ev.event_id, ev.correlation_id, ev.created_at, ev.created_ms, ev.source, ev.target, ev.type, ev.priority, ev.payload, ev.reply_to,
      ev.status, ev.hop_count, ev.requires_approval, ev.expires_ms, ev.body_hash, ev.updated_ms)
    .run();
  if (!ins.meta.changes) {
    // Lost a race against the same event_id.
    const again = await env.DB.prepare("SELECT * FROM events WHERE event_id = ?").bind(eventId).first<EventRow>();
    return json({ ok: true, duplicate: true, event: again ? publicEvent(again) : null });
  }
  log("accepted", { event_id: eventId, source, target, type, status: ev.status });

  // Audit log: only what matters (results, errors, high priority, approvals).
  if (needsApproval) await queueSheetRow(env, ev, "audit:approval", "relay: 人間の承認待ち(外部送信/課金系)");
  else if ((type === "result" || type === "error" || priority === "high") && known[target].mode !== "sheet") {
    await queueSheetRow(env, ev, "audit:event", "relay監査ログ");
  }
  if (!needsApproval) ctx.waitUntil(deliver(env, eventId));
  return json({ ok: true, duplicate: false, event: publicEvent(ev) }, 201);
}

async function ack(env: Env, ev: EventRow, caller: string, isAdmin: boolean, b: Record<string, unknown>): Promise<Response> {
  if (!isAdmin && ev.target !== caller) return err(403, "forbidden", "Only the target can ack");
  if (ev.status === "acked") return json({ ok: true, duplicate: true, event: publicEvent(ev) });
  if (!["queued", "delivering", "delivered", "dead"].includes(ev.status)) return err(409, "bad_state", `Cannot ack an event in status ${ev.status}`);
  const note = typeof b.note === "string" ? b.note.slice(0, 500) : null;
  const now = Date.now();
  await env.DB.prepare("UPDATE events SET status = 'acked', acked_ms = ?, ack_note = ?, updated_ms = ? WHERE event_id = ?")
    .bind(now, note, now, ev.event_id)
    .run();
  return json({ ok: true, duplicate: false, event: publicEvent({ ...ev, status: "acked", ack_note: note }) });
}

async function decide(env: Env, ctx: ExecutionContext, ev: EventRow, approve: boolean, b: Record<string, unknown>): Promise<Response> {
  if (ev.status !== "awaiting_approval") return err(409, "bad_state", `Event is ${ev.status}, not awaiting_approval`);
  const now = Date.now();
  const by = typeof b.by === "string" ? b.by.slice(0, 60) : ADMIN;
  const next = approve ? "queued" : "rejected";
  const upd = await env.DB.prepare(
    "UPDATE events SET status = ?, approved_by = ?, next_attempt_ms = 0, updated_ms = ? WHERE event_id = ? AND status = 'awaiting_approval'",
  )
    .bind(next, approve ? by : null, now, ev.event_id)
    .run();
  if (!upd.meta.changes) return err(409, "bad_state", "Event was decided concurrently");
  log(approve ? "approved" : "rejected", { event_id: ev.event_id });
  if (approve) ctx.waitUntil(deliver(env, ev.event_id));
  else await queueSheetRow(env, { ...ev, status: "rejected" }, "audit:rejected", "relay: 人間が却下");
  return json({ ok: true, event: publicEvent({ ...ev, status: next, approved_by: approve ? by : null }) });
}

/** For agents that cannot receive webhooks but can make HTTPS requests: collect what is waiting. */
async function inbox(env: Env, caller: string, url: URL): Promise<Response> {
  const limit = Math.min(num(url.searchParams.get("limit"), 10), 25);
  const now = Date.now();
  const rows = await env.DB.prepare(
    "SELECT * FROM events WHERE target = ? AND status = 'queued' AND expires_ms > ? ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, created_ms LIMIT ?",
  )
    .bind(caller, now, limit)
    .all<EventRow>();
  const events = rows.results || [];
  if (events.length) {
    await env.DB.batch(
      events.map((e) =>
        env.DB.prepare("UPDATE events SET status = 'delivered', delivered_ms = ?, updated_ms = ? WHERE event_id = ? AND status = 'queued'").bind(now, now, e.event_id),
      ),
    );
  }
  return json({ ok: true, events: events.map((e) => publicEvent({ ...e, status: "delivered" })) });
}

async function listEvents(env: Env, caller: string, isAdmin: boolean, url: URL): Promise<Response> {
  const corr = url.searchParams.get("correlation_id");
  const status = url.searchParams.get("status");
  const where: string[] = [];
  const args: unknown[] = [];
  if (corr) (where.push("correlation_id = ?"), args.push(corr));
  if (status) (where.push("status = ?"), args.push(status));
  if (!isAdmin) (where.push("(source = ? OR target = ?)"), args.push(caller, caller));
  const sql = `SELECT * FROM events ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_ms DESC LIMIT 50`;
  const rows = await env.DB.prepare(sql).bind(...args).all<EventRow>();
  return json({ ok: true, events: (rows.results || []).map(publicEvent) });
}
