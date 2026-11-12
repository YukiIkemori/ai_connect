import { initializeApp } from "firebase-admin/app";
import { defineSecret } from "firebase-functions/params";
import { onRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { handle } from "./app";
import { sweep } from "./deliver";
import { Env, log } from "./util";

initializeApp();

// One Secret Manager secret holding a JSON object of every token/URL
// (TOKEN_*, URL_*, PUSH_AUTH_*, ADMIN_TOKEN, SHEET_WEBHOOK_*). One secret = one billable version.
const RELAY_SECRETS = defineSecret("RELAY_SECRETS");

const REGION = "asia-northeast1";

function env(): Env {
  let secrets: Record<string, string> = {};
  try {
    secrets = JSON.parse(RELAY_SECRETS.value() || "{}");
  } catch {
    log("bad_relay_secrets"); // malformed secret: every request will be refused as unauthorized
  }
  return { ...(process.env as Record<string, string | undefined>), ...secrets };
}

// maxInstances caps how far a runaway caller can drive usage.
export const relay = onRequest(
  { region: REGION, memory: "256MiB", timeoutSeconds: 60, maxInstances: 2, concurrency: 20, invoker: "public", secrets: [RELAY_SECRETS] },
  async (req, res) => {
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
    const raw = req.method === "POST" && req.rawBody ? req.rawBody.toString("utf8") : "";
    const pending: Promise<unknown>[] = [];
    const out = await handle(new Request(`https://relay.invalid${req.url}`, { method: req.method, headers }), raw, env(), {
      waitUntil: (p) => void pending.push(p),
    });
    // Cloud Functions may stop the CPU once the response is sent, so the first delivery attempt finishes first.
    await Promise.allSettled(pending);
    out.headers.forEach((v, k) => res.setHeader(k, v));
    res.status(out.status).send(await out.text());
  },
);

export const sweeper = onSchedule(
  { region: REGION, memory: "256MiB", timeoutSeconds: 60, maxInstances: 1, retryCount: 0, schedule: "every 1 minutes", timeZone: "Asia/Tokyo", secrets: [RELAY_SECRETS] },
  async () => {
    log("sweep", await sweep(env()));
  },
);

// Local emulator only: lets the test suite run the sweep on demand. Never exported in production.
export const testSweep =
  process.env.FUNCTIONS_EMULATOR === "true"
    ? onRequest({ region: REGION, secrets: [RELAY_SECRETS] }, async (_req, res) => {
        res.json(await sweep(env()));
      })
    : undefined;
