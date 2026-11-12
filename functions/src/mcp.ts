// MCP server (Streamable HTTP, stateless JSON responses) with MCP Events.
// Lets an agent that can add a custom MCP server (e.g. a dot in ChatGPT) be woken by relay events
// through a webhook subscription, and send events back through tools.
import { authenticate } from "./auth";
import { EventRow, Subscription, deleteSubscription, getEvent, putSubscription, subscriptionsFor } from "./store";
import { EVENT_TYPES, Env, PRIORITIES, agents, json, log, safeEqual, secret, sha256Hex } from "./util";

export const EVENT_NAME = "relay.event";
const SUPPORTED_VERSIONS = ["2025-03-26", "2025-06-18", "2025-11-25"];
const MAX_MCP_BYTES = 64 * 1024;
const DAY = 86_400_000;

/** Relay operations the tools are built on (implemented in app.ts). */
export interface RelayApi {
  createEvent(agent: string, body: Record<string, unknown>): Promise<Response>;
  ack(ev: EventRow, agent: string, body: Record<string, unknown>): Promise<Response>;
  inbox(agent: string, limit: number): Promise<Response>;
  list(agent: string, correlationId: string | null, status: string | null): Promise<Response>;
  publicEvent(ev: EventRow): Record<string, unknown>;
  urlAllowed(url: string): boolean;
}

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
class RpcError extends Error {
  constructor(public code: number, message: string, public data?: unknown) {
    super(message);
  }
}

// ---- Standard Webhooks signing -------------------------------------------------

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

/** webhook-signature value: "v1," + base64(HMAC-SHA256(key, `${id}.${timestamp}.${body}`)), key = base64-decoded secret after "whsec_". */
export async function signWebhook(whsec: string, id: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", b64ToBytes(whsec.replace(/^whsec_/, "")), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`));
  return "v1," + Buffer.from(sig).toString("base64");
}

async function postSigned(sub: Pick<Subscription, "id" | "url" | "secret">, webhookId: string, body: string): Promise<Response> {
  const ts = Math.floor(Date.now() / 1000).toString();
  return fetch(sub.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "webhook-id": webhookId,
      "webhook-timestamp": ts,
      "webhook-signature": await signWebhook(sub.secret, webhookId, ts, body),
      "x-mcp-subscription-id": sub.id,
    },
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
}

/**
 * Deliver one relay event to the target's webhook subscriptions.
 * "none" = no live subscription (caller falls back to the sheet); null = accepted by at least one;
 * otherwise a short error string. `fatal` means retrying cannot help.
 */
export async function deliverToSubscriptions(ev: EventRow, data: Record<string, unknown>): Promise<"none" | null | { error: string; fatal: boolean }> {
  const live = await subscriptionsFor(ev.target, Date.now());
  if (!live.length) return "none";
  // Retries reuse the same eventId with a fresh timestamp and signature.
  const body = JSON.stringify({ eventId: ev.event_id, name: EVENT_NAME, timestamp: new Date().toISOString(), data, cursor: null });
  let ok = false;
  let gone = 0;
  let last = { error: "no subscription accepted the event", fatal: false };
  for (const sub of live) {
    try {
      const res = await postSigned(sub, ev.event_id, body);
      await res.body?.cancel();
      if (res.status >= 200 && res.status < 300) ok = true;
      else if (res.status === 410) {
        // The subscriber says this subscription no longer exists.
        await deleteSubscription(sub.id);
        gone++;
      } else last = { error: `subscriber HTTP ${res.status}`, fatal: res.status === 413 };
    } catch (e) {
      last = { error: `subscriber ${(e as Error).name}`, fatal: false };
    }
  }
  if (ok) return null;
  if (gone === live.length) return "none";
  return last;
}

// ---- tools -----------------------------------------------------------------

function tools(env: Env, agent: string) {
  const others = Object.keys(agents(env)).filter((a) => a !== agent);
  const id = { type: "string", pattern: "^[A-Za-z0-9_-]{8,64}$" };
  return [
    {
      name: "send_event",
      description:
        "Send an instruction, result, notification, error, ack, question or answer to another AI agent through the relay. Use reply_to when answering an event you received so the exchange stays under one correlation_id. Use type=question to ask the other agent (or, through it, the human) for a confirmation or decision, and type=answer with reply_to to reply to a question. Depending on the relay's settings, some instructions may wait for the human's approval (status awaiting_approval).",
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string", enum: others },
          type: { type: "string", enum: [...EVENT_TYPES] },
          summary: { type: "string", maxLength: 4000, description: "Short text of the message. Do not include personal data that is not needed." },
          priority: { type: "string", enum: [...PRIORITIES] },
          reply_to: { ...id, description: "event_id this answers" },
          event_id: { ...id, description: "Reuse the same id when retrying the same message" },
          action: { type: "string", description: "What the instruction asks for, e.g. dm_reply, post, delete, billing" },
          details: { type: "object", description: "Optional structured data for the receiver" },
        },
        required: ["target", "type", "summary"],
        additionalProperties: false,
      },
      annotations: { title: "Send relay event", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    {
      name: "get_event",
      description: "Read one relay event you sent or received, including its delivery status.",
      inputSchema: { type: "object", properties: { event_id: id }, required: ["event_id"], additionalProperties: false },
      annotations: { title: "Get relay event", readOnlyHint: true },
    },
    {
      name: "list_events",
      description: "List your recent relay events, optionally all events of one correlation_id (a whole exchange).",
      inputSchema: { type: "object", properties: { correlation_id: id, status: { type: "string" } }, additionalProperties: false },
      annotations: { title: "List relay events", readOnlyHint: true },
    },
    {
      name: "take_inbox",
      description: "Collect events addressed to you that have not been delivered yet. Each event is handed out once.",
      inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 25 } }, additionalProperties: false },
      annotations: { title: "Take relay inbox", readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    {
      name: "ack_event",
      description: "Confirm that you received and handled an event addressed to you.",
      inputSchema: { type: "object", properties: { event_id: id, note: { type: "string", maxLength: 500 } }, required: ["event_id"], additionalProperties: false },
      annotations: { title: "Acknowledge relay event", readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
  ];
}

async function callTool(env: Env, api: RelayApi, agent: string, name: unknown, a: Record<string, unknown>): Promise<unknown> {
  let res: Response;
  if (name === "send_event") {
    const details = a.details && typeof a.details === "object" && !Array.isArray(a.details) ? (a.details as Record<string, unknown>) : {};
    const payload: Record<string, unknown> = { ...details, summary: a.summary };
    if (typeof a.action === "string") payload.action = a.action;
    res = await api.createEvent(agent, { target: a.target, type: a.type, priority: a.priority, reply_to: a.reply_to, event_id: a.event_id, payload });
  } else if (name === "get_event" || name === "ack_event") {
    const ev = typeof a.event_id === "string" ? await getEvent(a.event_id) : null;
    if (!ev || (ev.source !== agent && ev.target !== agent)) res = json({ ok: false, error: "not_found", message: "No such event" }, 404);
    else res = name === "get_event" ? json({ ok: true, event: api.publicEvent(ev) }) : await api.ack(ev, agent, { note: a.note });
  } else if (name === "list_events") {
    res = await api.list(agent, typeof a.correlation_id === "string" ? a.correlation_id : null, typeof a.status === "string" ? a.status : null);
  } else if (name === "take_inbox") {
    res = await api.inbox(agent, Number.isInteger(a.limit) ? (a.limit as number) : 10);
  } else {
    throw new RpcError(-32602, `Unknown tool: ${String(name)}`);
  }
  const text = await res.text();
  return { content: [{ type: "text", text }], isError: !res.ok };
}

// ---- events ----------------------------------------------------------------

const EVENT_DEF = {
  name: EVENT_NAME,
  description: "An event (instruction, result, notification, error, ack, question or answer) addressed to you arrived at the AI relay from another agent.",
  delivery: ["webhook"],
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  payloadSchema: {
    type: "object",
    properties: {
      event_id: { type: "string" },
      correlation_id: { type: "string" },
      created_at: { type: "string", description: "ISO 8601, JST" },
      source: { type: "string" },
      target: { type: "string" },
      type: { type: "string", enum: [...EVENT_TYPES] },
      priority: { type: "string", enum: [...PRIORITIES] },
      payload: { type: "object" },
      reply_to: { type: ["string", "null"] },
      hop_count: { type: "integer" },
    },
    required: ["event_id", "correlation_id", "source", "target", "type", "payload"],
  },
};

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

/** Deterministic id: the same principal, callback URL, event name and arguments always map to the same subscription. */
async function subscriptionId(agent: string, url: string, name: string, args: unknown): Promise<string> {
  return "sub_" + (await sha256Hex([agent, url, name, canonical(args ?? {})].join("\n"))).slice(0, 32);
}

function deliveryOf(p: Record<string, unknown>, api: RelayApi): { url: string; secret?: string } {
  if (p.name !== EVENT_NAME) throw new RpcError(-32602, `Unknown event: ${String(p.name)}`);
  const d = (p.delivery || {}) as Record<string, unknown>;
  if (d.mode !== "webhook") throw new RpcError(-32602, "Only webhook delivery is supported");
  if (typeof d.url !== "string" || !api.urlAllowed(d.url)) throw new RpcError(-32602, "delivery.url must be an https URL");
  return { url: d.url, secret: typeof d.secret === "string" ? d.secret : undefined };
}

async function subscribe(api: RelayApi, agent: string, p: Record<string, unknown>): Promise<unknown> {
  const { url, secret: whsec } = deliveryOf(p, api);
  const keyLen = whsec?.startsWith("whsec_") ? b64ToBytes(whsec.slice(6)).length : 0;
  if (!whsec || keyLen < 24 || keyLen > 64) throw new RpcError(-32602, "delivery.secret must be whsec_<base64 of 24-64 bytes>");
  const id = await subscriptionId(agent, url, EVENT_NAME, p.arguments);

  // Prove the callback is reachable and holds the secret before activating.
  const challenge = crypto.randomUUID();
  let reason: string | null = null;
  try {
    const res = await postSigned({ id, url, secret: whsec }, `verify_${crypto.randomUUID()}`, JSON.stringify({ type: "verification", challenge }));
    const echoed = res.status >= 200 && res.status < 300 ? await res.json().catch(() => null) : null;
    if ((echoed as { challenge?: unknown } | null)?.challenge !== challenge) reason = "challenge_failed";
  } catch (e) {
    reason = (e as Error).name === "TimeoutError" ? "timeout" : "challenge_failed";
  }
  if (reason) throw new RpcError(-32015, "CallbackEndpointError", { reason });

  const now = Date.now();
  const ttl = typeof p.ttlMs === "number" && p.ttlMs > 0 ? Math.min(Math.max(p.ttlMs, 3_600_000), 30 * DAY) : 7 * DAY;
  await putSubscription({ id, agent, name: EVENT_NAME, url, secret: whsec, refresh_before_ms: now + ttl, created_ms: now });
  log("mcp_subscribed", { agent, subscription: id });
  return { id, refreshBefore: new Date(now + ttl).toISOString(), cursor: null, truncated: false };
}

async function unsubscribe(api: RelayApi, agent: string, p: Record<string, unknown>): Promise<unknown> {
  const { url } = deliveryOf(p, api);
  const id = await subscriptionId(agent, url, EVENT_NAME, p.arguments);
  await deleteSubscription(id);
  log("mcp_unsubscribed", { agent, subscription: id });
  return {};
}

// ---- JSON-RPC --------------------------------------------------------------

async function dispatch(env: Env, api: RelayApi, agent: string, m: Rpc): Promise<unknown> {
  const p = m.params && typeof m.params === "object" ? m.params : {};
  switch (m.method) {
    case "initialize": {
      const wanted = typeof p.protocolVersion === "string" ? p.protocolVersion : "";
      return {
        protocolVersion: SUPPORTED_VERSIONS.includes(wanted) ? wanted : SUPPORTED_VERSIONS[0],
        capabilities: { tools: {}, events: {} },
        serverInfo: { name: "ai-relay", version: "1.3.0" },
        instructions: `You are connected to the AI relay as "${agent}". Subscribe to the "${EVENT_NAME}" event to be woken when another agent sends you something. Answer with send_event and reply_to, then ack_event.`,
      };
    }
    case "ping":
      return {};
    case "tools/list":
      return { tools: tools(env, agent) };
    case "tools/call":
      return callTool(env, api, agent, p.name, (p.arguments as Record<string, unknown>) || {});
    case "events/list":
      return { events: [EVENT_DEF] };
    case "events/subscribe":
      return subscribe(api, agent, p);
    case "events/unsubscribe":
      return unsubscribe(api, agent, p);
    default:
      throw new RpcError(-32601, `Method not found: ${String(m.method)}`);
  }
}

async function answer(env: Env, api: RelayApi, agent: string, m: Rpc): Promise<object | null> {
  const isNotification = m.id === undefined || m.id === null;
  try {
    if (!m || typeof m.method !== "string") throw new RpcError(-32600, "Invalid request");
    if (isNotification) return null; // notifications/initialized etc. need no reply
    return { jsonrpc: "2.0", id: m.id, result: await dispatch(env, api, agent, m) };
  } catch (e) {
    if (isNotification) return null;
    if (e instanceof RpcError) return { jsonrpc: "2.0", id: m.id, error: { code: e.code, message: e.message, ...(e.data ? { data: e.data } : {}) } };
    log("mcp_error", { method: m.method, error: (e as Error).message });
    return { jsonrpc: "2.0", id: m.id, error: { code: -32603, message: "Internal error" } };
  }
}

/**
 * POST /mcp            — caller identified by its normal Bearer token (clients that can set headers)
 * POST /mcp/<token>    — caller identified by MCP_TOKEN_<AGENT> in the URL (clients that only allow "no authentication")
 */
export async function handleMcp(req: Request, raw: string, env: Env, api: RelayApi, pathToken: string | undefined): Promise<Response> {
  let agent: string | undefined;
  if (pathToken) {
    for (const name of Object.keys(agents(env))) {
      const t = secret(env, "MCP_TOKEN", name);
      if (t && (await safeEqual(pathToken, t)) && !agent) agent = name;
    }
  } else {
    const auth = await authenticate(req, env, raw);
    if (auth.ok && !auth.isAdmin) agent = auth.agent;
  }
  if (!agent) return json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } }, 401);
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
  if (new TextEncoder().encode(raw).length > MAX_MCP_BYTES) return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request too large" } }, 413);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  }
  if (Array.isArray(parsed)) {
    const out = (await Promise.all(parsed.slice(0, 20).map((m) => answer(env, api, agent, m as Rpc)))).filter(Boolean);
    return out.length ? json(out) : new Response(null, { status: 202 });
  }
  const out = await answer(env, api, agent, parsed as Rpc);
  return out ? json(out) : new Response(null, { status: 202 });
}
