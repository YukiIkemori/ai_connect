import { EventRow, dueSheet, queueSheet, sheetDone, sheetFailed, transition } from "./store";
import { Env, jstSheet, log, num } from "./util";

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
export async function queueSheetRow(ev: EventRow, reason: string, note: string): Promise<void> {
  const fallback = reason === "fallback";
  await queueSheet(ev.event_id, reason, [
    jstSheet(Date.now()),
    ev.source,
    ev.target,
    KIND[ev.type] || "連絡",
    `[relay ${ev.type}/${ev.priority} id=${ev.event_id} corr=${ev.correlation_id}] ${summarize(ev)}`,
    fallback ? "未読" : "完了",
    note,
  ]);
}

/** Append pending rows through the Apps Script web app. Returns how many rows were appended. */
export async function flushSheet(env: Env, limit = 10): Promise<number> {
  if (!env.SHEET_WEBHOOK_URL || !env.SHEET_WEBHOOK_SECRET) return 0;
  const now = Date.now();
  const rows = await dueSheet(now, limit);
  if (!rows.length) return 0;

  let error: string | null = null;
  try {
    const res = await fetch(env.SHEET_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Apps Script web apps cannot read request headers, so the secret travels in the body (TLS only).
      body: JSON.stringify({
        secret: env.SHEET_WEBHOOK_SECRET,
        rows: rows.map((r) => ({ key: `${r.event_id}:${r.reason}`, row: r.row })),
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
    await sheetFailed(rows, error, (attempts) => now + Math.min(cap, base * 2 ** attempts));
    log("sheet_flush_failed", { count: rows.length, error });
    return 0;
  }

  await sheetDone(rows, now);
  for (const r of rows) {
    // The sheet row is the delivery for sheet-mode targets.
    if (r.reason === "fallback") await transition(r.event_id, ["queued", "delivering"], { status: "delivered", delivered_ms: now });
  }
  log("sheet_flushed", { count: rows.length });
  return rows.length;
}
