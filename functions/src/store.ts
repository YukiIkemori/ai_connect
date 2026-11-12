// Firestore persistence. Collections: events, nonces, counters, sheet_outbox.
// Client SDK access is denied by firestore.rules; only this function (Admin SDK) touches the data.
import { Firestore, getFirestore } from "firebase-admin/firestore";

export interface EventRow {
  event_id: string;
  correlation_id: string;
  created_at: string; // ISO 8601, JST
  created_ms: number;
  source: string;
  target: string;
  type: string;
  priority: string;
  payload: string; // JSON
  reply_to: string | null;
  status: string; // awaiting_approval/queued/delivering/delivered/acked/dead/expired/rejected
  open: boolean; // true while the event can still expire (awaiting_approval/queued/delivering)
  hop_count: number;
  requires_approval: boolean;
  approved_by: string | null;
  attempts: number;
  next_attempt_ms: number;
  expires_ms: number;
  last_error: string | null;
  delivered_ms: number | null;
  acked_ms: number | null;
  ack_note: string | null;
  body_hash: string; // idempotency: the same event_id must carry the same content
  updated_ms: number;
}

export interface SheetRow {
  id: string;
  event_id: string;
  reason: string;
  row: string[];
  attempts: number;
}

const OPEN = ["awaiting_approval", "queued", "delivering"];
const TERMINAL = ["acked", "dead", "expired", "rejected", "delivered"];
const ALREADY_EXISTS = 6;
const PRIORITY_RANK: Record<string, number> = { high: 0, normal: 1, low: 2 };

let _db: Firestore | undefined;
const db = (): Firestore => (_db ??= getFirestore());
const events = () => db().collection("events");
const outbox = () => db().collection("sheet_outbox");

const byPriority = (a: EventRow, b: EventRow) =>
  (PRIORITY_RANK[a.priority] ?? 1) - (PRIORITY_RANK[b.priority] ?? 1) || a.created_ms - b.created_ms;

async function createIfAbsent(ref: FirebaseFirestore.DocumentReference, data: object): Promise<boolean> {
  try {
    await ref.create(data);
    return true;
  } catch (e) {
    if ((e as { code?: number }).code === ALREADY_EXISTS) return false;
    throw e;
  }
}

export async function ping(): Promise<void> {
  await db().collection("counters").limit(1).get();
}

export async function getEvent(id: string): Promise<EventRow | null> {
  const s = await events().doc(id).get();
  return s.exists ? (s.data() as EventRow) : null;
}

/** False when the event_id already exists. */
export function insertEvent(ev: EventRow): Promise<boolean> {
  return createIfAbsent(events().doc(ev.event_id), ev);
}

/**
 * Atomic state change: applies `patch` only if the event is currently in one of `from`.
 * Returns the updated event, or null when the precondition did not hold.
 */
export async function transition(
  id: string,
  from: string[],
  patch: Partial<EventRow> | ((ev: EventRow) => Partial<EventRow> | null),
): Promise<EventRow | null> {
  const ref = events().doc(id);
  return db().runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists) return null;
    const ev = s.data() as EventRow;
    if (!from.includes(ev.status)) return null;
    const p = typeof patch === "function" ? patch(ev) : patch;
    if (!p) return null;
    const next = { ...p, updated_ms: Date.now() } as Partial<EventRow>;
    if (next.status) next.open = OPEN.includes(next.status);
    tx.update(ref, next);
    return { ...ev, ...next };
  });
}

/** Replay protection: false when the nonce was already used. */
export function useNonce(key: string, now: number): Promise<boolean> {
  return createIfAbsent(db().collection("nonces").doc(key), { seen_ms: now });
}

/** Free-tier guard: counts one accepted event for the day; false when the limit is reached. */
export async function countDay(day: string, limit: number): Promise<boolean> {
  const ref = db().collection("counters").doc(day);
  return db().runTransaction(async (tx) => {
    const s = await tx.get(ref);
    const count = s.exists ? (s.data()!.count as number) : 0;
    if (count >= limit) return false;
    tx.set(ref, { count: count + 1 });
    return true;
  });
}

export async function dueEvents(now: number, limit: number): Promise<EventRow[]> {
  const q = await events().where("status", "==", "queued").where("next_attempt_ms", "<=", now).orderBy("next_attempt_ms").limit(limit * 4).get();
  return q.docs.map((d) => d.data() as EventRow).sort(byPriority).slice(0, limit);
}

export async function expiredOpen(now: number, limit: number): Promise<EventRow[]> {
  const q = await events().where("open", "==", true).where("expires_ms", "<=", now).orderBy("expires_ms").limit(limit).get();
  return q.docs.map((d) => d.data() as EventRow);
}

/** A claim older than `olderThanMs` means the invocation died mid-delivery. */
export async function resetStuck(now: number, olderThanMs: number): Promise<void> {
  const q = await events().where("status", "==", "delivering").limit(20).get();
  for (const d of q.docs) {
    if ((d.data() as EventRow).updated_ms < now - olderThanMs) await transition(d.id, ["delivering"], { status: "queued" });
  }
}

/** Hands queued events to their target once (pull delivery). */
export async function inboxTake(caller: string, now: number, limit: number): Promise<EventRow[]> {
  const q = await events().where("target", "==", caller).where("status", "==", "queued").limit(100).get();
  const candidates = q.docs.map((d) => d.data() as EventRow).filter((e) => e.expires_ms > now).sort(byPriority).slice(0, limit);
  const taken: EventRow[] = [];
  for (const c of candidates) {
    const ev = await transition(c.event_id, ["queued"], { status: "delivered", delivered_ms: now });
    if (ev) taken.push(ev);
  }
  return taken;
}

export async function listEvents(caller: string | null, correlationId: string | null, status: string | null): Promise<EventRow[]> {
  let rows: EventRow[];
  if (correlationId) {
    const q = await events().where("correlation_id", "==", correlationId).limit(200).get();
    rows = q.docs.map((d) => d.data() as EventRow);
    if (caller) rows = rows.filter((e) => e.source === caller || e.target === caller);
  } else if (caller) {
    const [a, b] = await Promise.all([
      events().where("source", "==", caller).orderBy("created_ms", "desc").limit(50).get(),
      events().where("target", "==", caller).orderBy("created_ms", "desc").limit(50).get(),
    ]);
    rows = [...a.docs, ...b.docs].map((d) => d.data() as EventRow);
  } else {
    const q = await events().orderBy("created_ms", "desc").limit(50).get();
    rows = q.docs.map((d) => d.data() as EventRow);
  }
  if (status) rows = rows.filter((e) => e.status === status);
  return rows.sort((x, y) => y.created_ms - x.created_ms).slice(0, 50);
}

// ---- sheet outbox -----------------------------------------------------------

export async function queueSheet(eventId: string, reason: string, row: string[]): Promise<void> {
  await createIfAbsent(outbox().doc(`${eventId}__${reason.replace(/[^A-Za-z0-9_-]/g, "_")}`), {
    event_id: eventId,
    reason,
    row,
    attempts: 0,
    next_attempt_ms: 0,
    done: false,
    last_error: null,
    created_ms: Date.now(),
  });
}

export async function dueSheet(now: number, limit: number): Promise<SheetRow[]> {
  const q = await outbox().where("done", "==", false).where("next_attempt_ms", "<=", now).orderBy("next_attempt_ms").limit(limit).get();
  return q.docs
    .map((d) => ({ id: d.id, ...(d.data() as Omit<SheetRow, "id"> & { created_ms: number }) }))
    .sort((a, b) => a.created_ms - b.created_ms);
}

export async function sheetFailed(rows: SheetRow[], error: string, nextMs: (attempts: number) => number): Promise<void> {
  const batch = db().batch();
  for (const r of rows) batch.update(outbox().doc(r.id), { attempts: r.attempts + 1, next_attempt_ms: nextMs(r.attempts), last_error: error });
  await batch.commit();
}

export async function sheetDone(rows: SheetRow[], now: number): Promise<void> {
  const batch = db().batch();
  for (const r of rows) batch.update(outbox().doc(r.id), { done: true, last_error: null, done_ms: now });
  await batch.commit();
}

// ---- housekeeping -----------------------------------------------------------

export async function housekeeping(now: number, keepMs: number): Promise<void> {
  const [nonces, oldEvents, oldRows] = await Promise.all([
    db().collection("nonces").where("seen_ms", "<", now - 900_000).limit(200).get(),
    events().where("updated_ms", "<", now - keepMs).limit(100).get(),
    outbox().where("done_ms", "<", now - keepMs).limit(100).get(),
  ]);
  const refs = [
    ...nonces.docs.map((d) => d.ref),
    ...oldEvents.docs.filter((d) => TERMINAL.includes((d.data() as EventRow).status)).map((d) => d.ref),
    ...oldRows.docs.map((d) => d.ref),
  ];
  if (!refs.length) return;
  const batch = db().batch();
  for (const r of refs) batch.delete(r);
  await batch.commit();
}
