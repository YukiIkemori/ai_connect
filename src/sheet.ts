import { Env, jstSheet, log, num } from "./util";

export interface EventRow {
  event_id: string;
  correlation_id: string;
  created_at: string;
  created_ms: number;
  source: string;
  target: string;
  type: string;
  priority: string;
  payload: string;
  reply_to: string | null;
  status: string;
  hop_count: number;
  requires_approval: number;
  approved_by: string | null;
  attempts: number;
  next_attempt_ms: number;
  expires_ms: number;
  last_error: string | null;
  delivered_ms: number | null;
  acked_ms: number | null;
  ack_note: string | null;
  body_hash: string;
  updated_ms: number;
}

const KIND: Record<string, string> = {
  instruction: "依頼",
  result: "報告",
  notification: "連絡",
  error: "報告",
  ack: "報告",
};

/** Short, human-readable text for the sheet. The full payload never goes to the sheet. */
export function summarize(ev: EventRow, max = 500): string {
  let p: Record<string, unknown> = {};
  try {
    p = JSON.parse(ev.payload);
  } catch {
    /* keep empty */
  }
  const s = typeof p.summary === "string" ? p.summary : typeof p.text === "string" ? p.text : `(${ev.type})`;
  return s.length > max ? s.slice(0, max) + "…" : s;
}

/**
 * Queue a row for AI伝言板 (columns A-G: 日時/書いた人/宛先/種類/内容/状態/対応メモ).
 * reason "fallback" = the row IS the delivery (状態 未読, the target reads it on its patrol).
 * reason "audit:<what>" = log only (状態 完了).
 */
export async function queueSheetRow(env: Env, ev: EventRow, reason: string, note: string): Promise<void> {
  const fallback = reason === "fallback";
  const row = [
    jstSheet(Date.now()),
    ev.source,
    ev.target,
    KIND[ev.type] || "連絡",
    `[relay ${ev.type}/${ev.priority} id=${ev.event_id} corr=${ev.correlation_id}] ${summarize(ev)}`,
    fallback ? "未読" : "完了",
    note,
  ];
  await env.DB.prepare("INSERT OR IGNORE INTO sheet_outbox (event_id, reason, row) VALUES (?, ?, ?)")
    .bind(ev.event_id, reason, JSON.stringify(row))
    .run();
}

/** Append pending rows through the Apps Script web app. Returns ids that were appended. */
export async function flushSheet(env: Env, limit = 10): Promise<number[]> {
  if (!env.SHEET_WEBHOOK_URL || !env.SHEET_WEBHOOK_SECRET) return [];
  const now = Date.now();
  const due = await env.DB.prepare(
    "SELECT id, event_id, reason, row, attempts FROM sheet_outbox WHERE done = 0 AND next_attempt_ms <= ? ORDER BY id LIMIT ?",
  )
    .bind(now, limit)
    .all<{ id: number; event_id: string; reason: string; row: string; attempts: number }>();
  const rows = due.results || [];
  if (!rows.length) return [];

  let error: string | null = null;
  try {
    const res = await fetch(env.SHEET_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Apps Script web apps cannot read request headers, so the secret travels in the body (TLS only).
      body: JSON.stringify({
        secret: env.SHEET_WEBHOOK_SECRET,
        rows: rows.map((r) => ({ key: `${r.event_id}:${r.reason}`, row: JSON.parse(r.row) })),
      }),
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let ok = false;
    try {
      ok = res.ok && JSON.parse(text).ok === true;
    } catch {
      ok = false;
    }
    if (!ok) error = `sheet webhook HTTP ${res.status}`;
  } catch (e) {
    error = `sheet webhook ${(e as Error).name}`;
  }

  if (error) {
    const base = num(env.RETRY_BASE_SECONDS, 30) * 1000;
    const cap = num(env.RETRY_CAP_SECONDS, 1800) * 1000;
    await env.DB.batch(
      rows.map((r) =>
        env.DB.prepare("UPDATE sheet_outbox SET attempts = attempts + 1, next_attempt_ms = ?, last_error = ? WHERE id = ?").bind(
          now + Math.min(cap, base * 2 ** r.attempts),
          error,
          r.id,
        ),
      ),
    );
    log("sheet_flush_failed", { count: rows.length, error });
    return [];
  }

  const stmts: D1PreparedStatement[] = [];
  for (const r of rows) {
    stmts.push(env.DB.prepare("UPDATE sheet_outbox SET done = 1, last_error = NULL WHERE id = ?").bind(r.id));
    if (r.reason === "fallback") {
      // The sheet row is the delivery for sheet-mode targets.
      stmts.push(
        env.DB.prepare(
          "UPDATE events SET status = 'delivered', delivered_ms = ?, updated_ms = ? WHERE event_id = ? AND status IN ('queued','delivering')",
        ).bind(now, now, r.event_id),
      );
    }
  }
  await env.DB.batch(stmts);
  log("sheet_flushed", { count: rows.length });
  return rows.map((r) => r.id);
}
