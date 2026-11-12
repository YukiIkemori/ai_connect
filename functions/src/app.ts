import { authenticate } from "./auth";
import { deliver, publicEvent } from "./deliver";
import { queueSheetRow } from "./sheet";
import { EventRow, countDay, getEvent, inboxTake, insertEvent, listEvents as queryEvents, ping, transition } from "./store";
import { ADMIN, EVENT_TYPES, Env, PRIORITIES, agents, err, json, jstDay, jstIso, log, num, sha256Hex } from "./util";

const MAX_BODY_BYTES = 16 * 1024;
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** Work that must finish before the function instance is allowed to idle. */
export interface Ctx {
  waitUntil(p: Promise<unknown>): void;
}

export async function handle(req: Request, raw: string, env: Env, ctx: Ctx): Promise<Response> {
  try {
    return await route(req, raw, env, ctx);
  } catch (e) {
    log("unhandled", { error: (e as Error).message });
    return err(500, "internal_error", "Internal error");
  }
}

async function route(req: Request, raw: string, env: Env, ctx: Ctx): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "GET" && path === "/health") {
    // Unauthenticated: liveness only, no data.
    let db = "ok";
    try {
      await ping();
    } catch {
      db = "error";
    }
    return json({ ok: db === "ok", service: "ai-relay", version: "1.0.0", db, time: jstIso(Date.now()) }, db === "ok" ? 200 : 503);
  }

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
  if (req.method === "GET" && path === "/events") return listEvents(auth.agent, auth.isAdmin, url);
  if (req.method === "GET" && path === "/inbox") return inbox(auth.agent, url);

  const m = /^\/events\/([A-Za-z0-9_-]{8,64})(?:\/(ack|approve|reject))?$/.exec(path);
  if (m) {
    const ev = await getEvent(m[1]);
    const visible = ev && (auth.isAdmin || ev.source === auth.agent || ev.target === auth.agent);
    if (!ev || !visible) return err(404, "not_found", "No such event");
    if (req.method === "GET" && !m[2]) return json({ ok: true, event: publicEvent(ev) });
    if (req.method === "POST" && m[2] === "ack") return ack(ev, auth.agent, auth.isAdmin, body);
    if (req.method === "POST" && (m[2] === "approve" || m[2] === "reject")) {
      if (!auth.isAdmin) return err(403, "forbidden", "Only the human admin token can approve or reject");
      return decide(env, ctx, ev, m[2] === "approve", body);
    }
  }
  return err(404, "not_found", "No such route");
}

async function createEvent(env: Env, ctx: Ctx, caller: string, isAdmin: boolean, b: Record<string, unknown>): Promise<Response> {
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
  const existing = await getEvent(eventId);
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
    const parent = await getEvent(replyTo);
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
  const limit = num(env.DAILY_EVENT_LIMIT, 1000);
  if (!(await countDay(day, limit))) return err(429, "daily_limit", `Daily event limit (${limit}) reached; resets at 00:00 JST`);

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
    open: true,
    requires_approval: needsApproval,
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
  if (!(await insertEvent(ev))) {
    // Lost a race against the same event_id.
    const again = await getEvent(eventId);
    return json({ ok: true, duplicate: true, event: again ? publicEvent(again) : null });
  }
  log("accepted", { event_id: eventId, source, target, type, status: ev.status });

  // Audit log: only what matters (results, errors, high priority, approvals).
  if (needsApproval) await queueSheetRow(ev, "audit:approval", "relay: 人間の承認待ち(外部送信/課金系)");
  else if ((type === "result" || type === "error" || priority === "high") && known[target].mode !== "sheet") {
    await queueSheetRow(ev, "audit:event", "relay監査ログ");
  }
  if (!needsApproval) ctx.waitUntil(deliver(env, eventId));
  return json({ ok: true, duplicate: false, event: publicEvent(ev) }, 201);
}

async function ack(ev: EventRow, caller: string, isAdmin: boolean, b: Record<string, unknown>): Promise<Response> {
  if (!isAdmin && ev.target !== caller) return err(403, "forbidden", "Only the target can ack");
  if (ev.status === "acked") return json({ ok: true, duplicate: true, event: publicEvent(ev) });
  const note = typeof b.note === "string" ? b.note.slice(0, 500) : null;
  const done = await transition(ev.event_id, ["queued", "delivering", "delivered", "dead"], { status: "acked", acked_ms: Date.now(), ack_note: note });
  if (!done) return err(409, "bad_state", `Cannot ack an event in status ${ev.status}`);
  return json({ ok: true, duplicate: false, event: publicEvent(done) });
}

async function decide(env: Env, ctx: Ctx, ev: EventRow, approve: boolean, b: Record<string, unknown>): Promise<Response> {
  const by = typeof b.by === "string" ? b.by.slice(0, 60) : ADMIN;
  const done = await transition(
    ev.event_id,
    ["awaiting_approval"],
    approve ? { status: "queued", approved_by: by, next_attempt_ms: 0 } : { status: "rejected" },
  );
  if (!done) return err(409, "bad_state", `Event is ${ev.status}, not awaiting_approval`);
  log(approve ? "approved" : "rejected", { event_id: ev.event_id });
  if (approve) ctx.waitUntil(deliver(env, ev.event_id));
  else await queueSheetRow(done, "audit:rejected", "relay: 人間が却下");
  return json({ ok: true, event: publicEvent(done) });
}

/** For agents that cannot receive webhooks but can make HTTPS requests: collect what is waiting. */
async function inbox(caller: string, url: URL): Promise<Response> {
  const limit = Math.min(num(url.searchParams.get("limit"), 10), 25);
  const taken = await inboxTake(caller, Date.now(), limit);
  return json({ ok: true, events: taken.map(publicEvent) });
}

async function listEvents(caller: string, isAdmin: boolean, url: URL): Promise<Response> {
  const rows = await queryEvents(isAdmin ? null : caller, url.searchParams.get("correlation_id"), url.searchParams.get("status"));
  return json({ ok: true, events: rows.map(publicEvent) });
}
