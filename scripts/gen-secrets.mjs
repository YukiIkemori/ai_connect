#!/usr/bin/env node
// Writes secrets.json with fresh random relay tokens (never printed). Existing values are kept,
// so webhook URLs and keys you added by hand survive a re-run.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const file = "secrets.json";
const random = ["ADMIN_TOKEN", "TOKEN_DOTS", "TOKEN_GROK", "TOKEN_MUSE", "TOKEN_CHATGPT", "TOKEN_CLAUDE", "MCP_TOKEN_DOTS", "MCP_TOKEN_MUSE", "WATCH_ID_MUSE", "SHEET_WEBHOOK_SECRET"];
const current = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
let added = 0;
for (const k of random) if (!current[k]) (current[k] = randomBytes(32).toString("hex")), added++;
writeFileSync(file, JSON.stringify(current, null, 2) + "\n", { mode: 0o600 });
console.log(`${file}: ${added} value(s) generated, ${Object.keys(current).length} total. Do not commit or share this file.`);
