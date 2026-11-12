#!/usr/bin/env node
// Minimal relay client (signed requests). Secrets come from the environment only.
//   RELAY_URL=https://ai-relay.<you>.workers.dev RELAY_TOKEN=... node scripts/relay.mjs send Dots notification "要確認1件"
//   ... relay.mjs inbox | get <id> | ack <id> [note] | approve <id> | reject <id> | trail <correlation_id>
import { createHmac, randomBytes } from "node:crypto";

const { RELAY_URL, RELAY_TOKEN } = process.env;
if (!RELAY_URL || !RELAY_TOKEN) {
  console.error("RELAY_URL and RELAY_TOKEN must be set");
  process.exit(2);
}
async function call(method, path, body) {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = randomBytes(16).toString("hex");
  const headers = {
    authorization: `Bearer ${RELAY_TOKEN}`,
    "x-relay-timestamp": ts,
    "x-relay-nonce": nonce,
    "x-relay-signature": createHmac("sha256", RELAY_TOKEN).update(`${ts}.${nonce}.${raw}`).digest("hex"),
  };
  if (raw) headers["content-type"] = "application/json";
  const res = await fetch(RELAY_URL.replace(/\/+$/, "") + path, { method, headers, body: raw || undefined });
  console.log(res.status, JSON.stringify(await res.json().catch(() => null), null, 2));
  process.exit(res.ok ? 0 : 1);
}
const [cmd, a, b, c, d] = process.argv.slice(2);
if (cmd === "send") await call("POST", "/events", { target: a, type: b, payload: { summary: c }, ...(d ? { reply_to: d } : {}) });
else if (cmd === "inbox") await call("GET", "/inbox");
else if (cmd === "get") await call("GET", `/events/${a}`);
else if (cmd === "trail") await call("GET", `/events?correlation_id=${a}`);
else if (cmd === "ack") await call("POST", `/events/${a}/ack`, { note: b });
else if (cmd === "approve" || cmd === "reject") await call("POST", `/events/${a}/${cmd}`, {});
else console.error("usage: relay.mjs send <target> <type> <summary> [reply_to] | inbox | get <id> | trail <corr> | ack <id> [note] | approve <id> | reject <id>");
