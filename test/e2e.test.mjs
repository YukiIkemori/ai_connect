// End-to-end tests against the real Worker runtime (wrangler dev / workerd + local D1),
// with local mock servers standing in for each AI's receiving endpoint and for the sheet web app.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const tok = Object.fromEntries(["Dots", "Grok", "Muse", "ChatGPT", "Claude", "ADMIN", "SHEET", "FIRE"].map((k) => [k, randomBytes(24).toString("hex")]));

// ---- mock receivers -------------------------------------------------------
const got = { Dots: [], Grok: [], Claude: [], sheet: [] };
let grokFailures = 0; // next N deliveries to Grok fail with 503
let grokAlwaysFail = false;
const servers = [];
function listen(port, handler) {
  return new Promise((res) => {
    const s = createServer((req, rsp) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => handler(req, rsp, body));
    });
    servers.push(s);
    s.listen(port, "127.0.0.1", res);
  });
}
function verifyRelaySignature(agent, req, body) {
  const ts = req.headers["x-relay-timestamp"];
  const id = req.headers["x-relay-event-id"];
  const expected = createHmac("sha256", tok[agent]).update(`${ts}.${id}.${body}`).digest("hex");
  return expected === req.headers["x-relay-signature"] && Math.abs(Date.now() / 1000 - Number(ts)) < 300;
}

// ---- helpers --------------------------------------------------------------
async function api(method, path, { as, body, headers = {}, token } = {}) {
  const raw = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
  const h = { ...headers };
  const t = token ?? (as ? tok[as] : undefined);
  if (t) h.authorization = `Bearer ${t}`;
  if (raw !== undefined) h["content-type"] = "application/json";
  const res = await fetch(BASE + path, { method, headers: h, body: raw });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const post = (as, body, extra) => api("POST", "/events", { as, body, ...extra });
const sweep = () => fetch(`${BASE}/__scheduled?cron=*+*+*+*+*`).then((r) => r.text());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) assert.fail(`timed out waiting for: ${label}`);
    await sleep(100);
  }
}
const statusOf = async (id) => (await api("GET", `/events/${id}`, { as: "ADMIN" })).json?.event?.status;

let wrangler;
let persist;
before(async () => {
  await listen(9101, (req, rsp, body) => {
    got.Dots.push({ ok: verifyRelaySignature("Dots", req, body), event: JSON.parse(body) });
    rsp.writeHead(200).end("{}");
  });
  await listen(9102, (req, rsp, body) => {
    if (grokAlwaysFail || grokFailures > 0) {
      grokFailures--;
      return rsp.writeHead(503).end();
    }
    got.Grok.push({ ok: verifyRelaySignature("Grok", req, body), event: JSON.parse(body) });
    rsp.writeHead(200).end("{}");
  });
  await listen(9103, (req, rsp, body) => {
    // Stand-in for an API-triggered Claude Code scheduled task (/fire): bearer auth + {"text": ...}
    got.Claude.push({ auth: req.headers.authorization, version: req.headers["anthropic-version"], body: JSON.parse(body) });
    rsp.writeHead(200, { "content-type": "application/json" }).end('{"type":"routine_fire"}');
  });
  await listen(9104, (req, rsp, body) => {
    // Stand-in for the Apps Script web app: same contract as apps-script/Code.gs
    const b = JSON.parse(body);
    if (b.secret !== tok.SHEET) return rsp.writeHead(200).end(JSON.stringify({ ok: false, error: "forbidden" }));
    for (const r of b.rows) if (!got.sheet.some((x) => x.key === r.key)) got.sheet.push(r);
    rsp.writeHead(200).end(JSON.stringify({ ok: true, appended: b.rows.length }));
  });

  writeFileSync(
    join(here, ".dev.vars"),
    [
      `TOKEN_DOTS=${tok.Dots}`, `TOKEN_GROK=${tok.Grok}`, `TOKEN_MUSE=${tok.Muse}`, `TOKEN_CHATGPT=${tok.ChatGPT}`, `TOKEN_CLAUDE=${tok.Claude}`,
      `ADMIN_TOKEN=${tok.ADMIN}`,
      `URL_DOTS=http://127.0.0.1:9101/hook`, `URL_GROK=http://127.0.0.1:9102/hook`, `URL_CLAUDE=http://127.0.0.1:9103/fire`,
      `PUSH_AUTH_CLAUDE=${tok.FIRE}`,
      `SHEET_WEBHOOK_URL=http://127.0.0.1:9104/exec`, `SHEET_WEBHOOK_SECRET=${tok.SHEET}`,
    ].join("\n") + "\n",
  );
  persist = mkdtempSync(join(tmpdir(), "ai-relay-test-"));
  const wr = join(here, "..", "node_modules", ".bin", "wrangler");
  const cfg = join(here, "wrangler.toml");
  execFileSync(wr, ["d1", "migrations", "apply", "ai-relay-test", "--local", "-c", cfg, "--persist-to", persist], { stdio: "pipe", env: { ...process.env, CI: "1" } });
  wrangler = spawn(wr, ["dev", "-c", cfg, "--port", String(PORT), "--ip", "127.0.0.1", "--test-scheduled", "--persist-to", persist, "--show-interactive-dev-session=false"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CI: "1" },
  });
  let out = "";
  wrangler.stdout.on("data", (d) => (out += d));
  wrangler.stderr.on("data", (d) => (out += d));
  await until(() => fetch(`${BASE}/health`).then((r) => r.ok).catch(() => false), "wrangler dev to start\n" + out, 60000);
});
after(async () => {
  wrangler?.kill("SIGTERM");
  for (const s of servers) s.close();
  rmSync(join(here, ".dev.vars"), { force: true });
  if (persist) rmSync(persist, { recursive: true, force: true });
});

// ---- Phase 4 --------------------------------------------------------------
test("health is public and carries no data", async () => {
  const r = await api("GET", "/health");
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.json).sort(), ["db", "ok", "service", "time", "version"]);
  assert.match(r.json.time, /\+09:00$/);
});

test("① Grok-originated event reaches Dots as a signed notification", async () => {
  const r = await post("Grok", { source: "Grok", target: "Dots", type: "notification", priority: "normal", payload: { summary: "TLで要確認の言及を検知" } });
  assert.equal(r.status, 201);
  const id = r.json.event.event_id;
  assert.match(r.json.event.created_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+09:00$/);
  const d = await until(() => got.Dots.find((x) => x.event.event_id === id), "Dots delivery");
  assert.equal(d.ok, true, "HMAC signature verifies with Dots' secret");
  assert.equal(d.event.source, "Grok");
  assert.equal(await until(async () => (await statusOf(id)) === "delivered", "status delivered"), true);
});

test("② Dots instruction → Grok processes → result returns to Dots under one correlation_id", async () => {
  const r = await post("Dots", { target: "Grok", type: "instruction", payload: { summary: "直近のメンションを要約して" } });
  const id = r.json.event.event_id;
  const g = await until(() => got.Grok.find((x) => x.event.event_id === id), "Grok delivery");
  assert.equal(g.ok, true);
  const ack = await api("POST", `/events/${id}/ack`, { as: "Grok", body: { note: "受領" } });
  assert.equal(ack.json.event.status, "acked");
  const res = await post("Grok", { target: "Dots", type: "result", reply_to: id, payload: { summary: "メンション3件、緊急なし" } });
  assert.equal(res.status, 201);
  assert.equal(res.json.event.correlation_id, id, "result inherits the instruction's correlation_id");
  assert.equal(res.json.event.hop_count, 1);
  const back = await until(() => got.Dots.find((x) => x.event.event_id === res.json.event.event_id), "result at Dots");
  assert.equal(back.event.reply_to, id);
  const trail = await api("GET", `/events?correlation_id=${id}`, { as: "Dots" });
  assert.equal(trail.json.events.length, 2);
});

test("③ Muse DM notification reaches Dots; a DM reply instruction waits for human approval, then Muse pulls it", async () => {
  const n = await post("Muse", { target: "Dots", type: "notification", priority: "high", payload: { summary: "Instagram DM 要対応1件", platform: "instagram" } });
  await until(() => got.Dots.find((x) => x.event.event_id === n.json.event.event_id), "DM notification at Dots");

  const ins = await post("Dots", { target: "Muse", type: "instruction", reply_to: n.json.event.event_id, payload: { action: "dm_reply", summary: "返信案を送信" } });
  const id = ins.json.event.event_id;
  assert.equal(ins.json.event.status, "awaiting_approval");
  assert.equal((await api("GET", "/inbox", { as: "Muse" })).json.events.length, 0, "nothing is released before approval");
  assert.equal((await api("POST", `/events/${id}/approve`, { as: "Dots" })).status, 403, "an AI cannot approve");
  const ap = await api("POST", `/events/${id}/approve`, { as: "ADMIN", body: { by: "Yuki" } });
  assert.equal(ap.json.event.status, "queued");
  const inbox = await until(async () => {
    const r = await api("GET", "/inbox", { as: "Muse" });
    return r.json.events.length ? r.json.events : null;
  }, "Muse inbox");
  assert.equal(inbox[0].event_id, id);
  assert.equal(inbox[0].approved_by, "Yuki");
  assert.equal((await api("GET", "/inbox", { as: "Muse" })).json.events.length, 0, "an event is handed out once");

  const rej = await post("Dots", { target: "Muse", type: "instruction", payload: { action: "post", summary: "投稿して" } });
  const rj = await api("POST", `/events/${rej.json.event.event_id}/reject`, { as: "ADMIN" });
  assert.equal(rj.json.event.status, "rejected");
});

test("④ implementation request to Claude Code goes out as an authenticated text fire", async () => {
  const r = await post("Dots", { target: "Claude", type: "instruction", payload: { summary: "relayのREADMEを更新して" } });
  const c = await until(() => got.Claude.find((x) => x.body.text.includes(r.json.event.event_id)), "Claude fire");
  assert.equal(c.auth, `Bearer ${tok.FIRE}`);
  assert.equal(c.version, "2023-06-01");
  assert.match(c.body.text, /relayのREADMEを更新して/);
});

test("⑤ duplicate sends are delivered once; a reused id with other content is refused", async () => {
  const body = { event_id: randomUUID(), target: "Dots", type: "notification", payload: { summary: "dup" } };
  const [a, b] = await Promise.all([post("Grok", body), post("Grok", body)]);
  assert.deepEqual([a.status, b.status].sort(), [200, 201]);
  const c = await post("Grok", body);
  assert.equal(c.status, 200);
  assert.equal(c.json.duplicate, true);
  await until(() => got.Dots.some((x) => x.event.event_id === body.event_id), "dup delivery");
  await sweep();
  await sleep(300);
  assert.equal(got.Dots.filter((x) => x.event.event_id === body.event_id).length, 1);
  const d = await post("Grok", { ...body, payload: { summary: "changed" } });
  assert.equal(d.status, 409);
});

test("⑥ authentication failures are refused", async () => {
  const body = { target: "Dots", type: "notification", payload: { summary: "x" } };
  assert.equal((await api("POST", "/events", { body })).status, 401, "no token");
  assert.equal((await api("POST", "/events", { body, token: "wrong-token" })).status, 401, "wrong token");
  assert.equal((await api("GET", "/events", {})).status, 401, "reads need auth too");
  const spoof = await post("Grok", { ...body, source: "Dots" });
  assert.equal(spoof.status, 403, "source must match the token");
  assert.equal(spoof.json.error, "source_mismatch");

  // Signed requests
  const raw = JSON.stringify(body);
  const sign = (ts, nonce, key = tok.Grok) => ({ "x-relay-timestamp": String(ts), "x-relay-nonce": nonce, "x-relay-signature": createHmac("sha256", key).update(`${ts}.${nonce}.${raw}`).digest("hex") });
  const now = Math.floor(Date.now() / 1000);
  const nonce = randomBytes(12).toString("hex");
  assert.equal((await post("Grok", raw, { headers: sign(now, nonce) })).status, 201, "valid signature");
  const replay = await post("Grok", raw, { headers: sign(now, nonce) });
  assert.equal(replay.status, 401);
  assert.equal(replay.json.error, "replay");
  const stale = await post("Grok", raw, { headers: sign(now - 3600, randomBytes(12).toString("hex")) });
  assert.equal(stale.json.error, "stale_timestamp");
  const bad = await post("Grok", raw, { headers: sign(now, randomBytes(12).toString("hex"), "other-key") });
  assert.equal(bad.json.error, "bad_signature");

  // Visibility: a third agent cannot read someone else's event
  const ev = await post("Grok", body);
  assert.equal((await api("GET", `/events/${ev.json.event.event_id}`, { as: "Muse" })).status, 404);
  assert.equal((await api("POST", `/events/${ev.json.event.event_id}/ack`, { as: "Grok" })).status, 403, "only the target acks");
});

test("⑦ target outage: retried with backoff until it recovers; a permanent outage is parked on the sheet", async () => {
  grokFailures = 2;
  const r = await post("Dots", { target: "Grok", type: "instruction", payload: { summary: "retry me" } });
  const id = r.json.event.event_id;
  await until(async () => (await api("GET", `/events/${id}`, { as: "ADMIN" })).json.event.attempts === 1, "first failure recorded");
  const e1 = (await api("GET", `/events/${id}`, { as: "ADMIN" })).json.event;
  assert.equal(e1.status, "queued");
  assert.equal(e1.last_error, "target HTTP 503");
  await sweep();
  assert.equal(got.Grok.some((x) => x.event.event_id === id), false, "not retried before the backoff elapses");
  await until(async () => { await sweep(); return got.Grok.some((x) => x.event.event_id === id); }, "delivery after recovery", 15000);
  const e2 = (await api("GET", `/events/${id}`, { as: "ADMIN" })).json.event;
  assert.equal(e2.status, "delivered");
  assert.equal(e2.attempts, 3);

  grokAlwaysFail = true;
  const d = await post("Dots", { target: "Grok", type: "instruction", payload: { summary: "never arrives" } });
  const did = d.json.event.event_id;
  await until(async () => { await sweep(); return (await statusOf(did)) === "dead"; }, "dead after max attempts", 20000);
  grokAlwaysFail = false;
  const row = await until(async () => { await sweep(); return got.sheet.find((x) => x.key === `${did}:fallback`); }, "fallback sheet row");
  assert.equal(row.row[2], "Grok");
  assert.equal(row.row[5], "未読");
});

test("⑧ a reply chain is cut at max_hops", async () => {
  let prev = (await post("Dots", { target: "Grok", type: "instruction", payload: { summary: "ping" } })).json.event;
  let from = "Grok";
  let blocked = null;
  for (let i = 0; i < 6 && !blocked; i++) {
    const r = await post(from, { target: from === "Grok" ? "Dots" : "Grok", type: "result", reply_to: prev.event_id, payload: { summary: "pong" } });
    if (r.status === 201) { prev = r.json.event; from = from === "Grok" ? "Dots" : "Grok"; }
    else blocked = r;
  }
  assert.equal(blocked.status, 422);
  assert.equal(blocked.json.error, "loop_detected");
  assert.equal(prev.hop_count, 3, "MAX_HOPS=3 in the test config");
  const forged = await post("Grok", { target: "Dots", type: "result", reply_to: prev.event_id, hop_count: 0, payload: { summary: "reset attempt" } });
  assert.equal(forged.status, 422, "a sender cannot reset hop_count");
});

test("⑨ sheet records: A-G rows for results, high priority, approvals and sheet-mode delivery", async () => {
  const c = await post("Dots", { target: "ChatGPT", type: "instruction", payload: { summary: "週次の分析をお願い", secret_detail: "must not reach the sheet" } });
  const id = c.json.event.event_id;
  const row = await until(async () => { await sweep(); return got.sheet.find((x) => x.key === `${id}:fallback`); }, "sheet-mode delivery row");
  assert.equal(row.row.length, 7);
  assert.match(row.row[0], /^\d{4}-\d\d-\d\d \d\d:\d\d$/);
  assert.deepEqual(row.row.slice(1, 4), ["Dots", "ChatGPT", "依頼"]);
  assert.match(row.row[4], new RegExp(`id=${id}`));
  assert.equal(row.row[5], "未読");
  assert.equal(JSON.stringify(row).includes("must not reach the sheet"), false, "only the summary is logged");
  assert.equal(await statusOf(id), "delivered");
  const reasons = got.sheet.map((x) => x.key.split(":").slice(1).join(":"));
  for (const want of ["audit:event", "audit:approval", "audit:rejected", "fallback"]) assert.ok(reasons.includes(want), `sheet has ${want}`);
  assert.ok(got.sheet.filter((x) => x.key.includes(":audit")).every((x) => x.row[5] === "完了"));
});

test("validation and limits", async () => {
  assert.equal((await post("Grok", { target: "Nobody", type: "notification" })).status, 422);
  assert.equal((await post("Grok", { target: "Dots", type: "shout" })).status, 422);
  assert.equal((await post("Grok", { target: "Grok", type: "notification" })).status, 422);
  assert.equal((await post("Grok", "{not json")).status, 400);
  assert.equal((await post("Grok", { target: "Dots", type: "notification", payload: { summary: "x".repeat(20000) } })).status, 413);
});

test("⑩ free-tier guard: the daily cap answers 429 instead of spending quota", async () => {
  let last;
  for (let i = 0; i < 45; i++) {
    last = await post("Muse", { target: "ChatGPT", type: "notification", priority: "low", payload: { summary: `n${i}` } });
    if (last.status === 429) break;
  }
  assert.equal(last.status, 429);
  assert.equal(last.json.error, "daily_limit");
  const all = await api("GET", "/events", { as: "ADMIN" });
  assert.ok(all.json.events.length <= 50);
});
