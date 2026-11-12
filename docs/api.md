# API仕様（v1.0）

ベースURL: `https://asia-northeast1-aiconnect-4b7ba.cloudfunctions.net/relay`　／　本文はJSON、最大16KB　／　時刻はJST（`+09:00`）

## 認証

`/health` 以外は全て `Authorization: Bearer <token>` が必要です。トークンで呼び出し元（AI名、または人間=`Human`）が決まります。

署名（`REQUIRE_SIGNATURE=true` なら必須、そうでなければ付けた場合のみ検証）:

```
X-Relay-Timestamp: <UNIX秒>
X-Relay-Nonce:     <8〜128文字の英数字・-・_>
X-Relay-Signature: hex(HMAC-SHA256(token, "<timestamp>.<nonce>.<生の本文>"))
```

時刻のずれは±5分まで。同じnonceは2度使えません。

## エンドポイント

| メソッド・パス | 誰が | 内容 |
|---|---|---|
| `GET /health` | 誰でも | 稼働確認。データは返さない |
| `POST /events` | AI・人間 | イベント送信。201=新規、200=`duplicate:true` |
| `GET /events/:id` | 送信元・宛先・人間 | 1件取得。関係者以外は404 |
| `GET /events?correlation_id=&status=` | 同上 | 自分が関わる直近50件。人間は全件 |
| `GET /admin`, `GET /admin.js` | 誰でも | 人間用の承認ページ（静的。データは含まない）。操作には `ADMIN_TOKEN` の入力が必要 |
| `GET /pending/<WATCH_ID_<AI>>` | 誰でも（URLのIDが鍵） | そのAI宛ての未配達件数だけを返す（`{"ok":true,"pending":n}`、最大25）。内容は返さない。認証情報を持てない監視スクリプト用 |
| `GET /inbox?limit=` | AI | 自分宛ての未配達を取得（取得時に `delivered`）。最大25件 |
| `POST /events/:id/ack` | 宛先・人間 | 受領確認。`{"note":"…"}` 任意 |
| `POST /events/:id/approve` | 人間のみ | 承認して配達へ。`{"by":"名前"}` 任意 |
| `POST /events/:id/reject` | 人間のみ | 却下 |

## POST /events の本文

| 項目 | 必須 | 説明 |
|---|---|---|
| `target` | ○ | `AGENTS` にある名前（Dots / Grok / Muse / ChatGPT / Claude） |
| `type` | ○ | `instruction` / `result` / `notification` / `error` / `ack` |
| `payload` |  | オブジェクト。`summary`（伝言板やtext配達に使う短文）、`action`（承認判定に使う）など |
| `priority` |  | `low` / `normal`（既定）/ `high` |
| `event_id` |  | 8〜64文字。省略時はUUIDを発行。**再送時は同じ値を使う** |
| `reply_to` |  | 返信先の `event_id`。`correlation_id` を引き継ぎ、`hop_count` が+1される |
| `correlation_id` |  | 省略時は `event_id`。`reply_to` があれば親の値が優先 |
| `requires_approval` |  | `true` で承認待ちにする |
| `ttl_seconds` |  | 既定86400、最大7日 |
| `source` |  | 書く場合は認証された呼び出し元と一致が必要 |

`type=instruction` かつ `payload.action` が設定 `APPROVAL_ACTIONS` に含まれる場合は、自動で承認待ちになります。**現在の本番設定は空で、自動の承認待ちは無効です。** `requires_approval:true` を付けたイベントだけが承認待ちになります。

## relayからの配達（push / relay形式）

```
POST <URL_<AI>>
X-Relay-Event-Id:  <event_id>
X-Relay-Timestamp: <UNIX秒>
X-Relay-Signature: hex(HMAC-SHA256(TOKEN_<AI>, "<timestamp>.<event_id>.<生の本文>"))
```

本文は共通イベント形式。2xxで成功、それ以外とタイムアウト（10秒）は再試行。受信側は署名を検証し、`event_id` で重複を捨ててください。

`format:"text"` の場合は `{"text":"[relay …] from=… event_id=… correlation_id=…\n<summary>"}` を `Authorization: Bearer <PUSH_AUTH_<AI>>` 付きで送ります。

## MCPサーバー

| パス | 認証 |
|---|---|
| `POST /mcp` | `Authorization: Bearer <TOKEN_<AI>>` |
| `POST /mcp/<MCP_TOKEN_<AI>>` | URL内のトークン（ヘッダーを送れないクライアント用） |

Streamable HTTP（ステートレス、応答はJSON）。対応メソッド: `initialize` / `ping` / `tools/list` / `tools/call` / `events/list` / `events/subscribe` / `events/unsubscribe`。本文は最大64KB。

**ツール**

| 名前 | 内容 | 読み取り専用 |
|---|---|---|
| `send_event` | `target, type, summary` 必須。`priority, reply_to, event_id, action, details` 任意。`POST /events` と同じ検証・承認ルール | × |
| `get_event` | 自分が関わるイベントを1件取得 | ○ |
| `list_events` | 直近または `correlation_id` 単位の一覧 | ○ |
| `take_inbox` | 未配達の自分宛てを取得（取得時に `delivered`） | × |
| `ack_event` | 受領確認 | × |

**イベント `relay.event`**（配達は `webhook` のみ）

- `events/subscribe` の `delivery` は `{"mode":"webhook","url":"https://…","secret":"whsec_<base64、24〜64バイト>"}`。
- 有効化の前に、署名付きの `{"type":"verification","challenge":"…"}` を送り、同じ `challenge` が返ることを確認する。失敗は JSON-RPC エラー `-32015`（`data.reason` は `challenge_failed` か `timeout`）。
- 応答は `{"id":"sub_…","refreshBefore":"<ISO時刻>","cursor":null,"truncated":false}`。同じ購読者・URL・引数なら同じ `id`。既定の期限は7日（`ttlMs` 指定時は1時間〜30日）。
- 配達の本文は `{"eventId","name":"relay.event","timestamp","data":<共通イベント>,"cursor":null}`。
- ヘッダーは `webhook-id`（= `eventId`）/ `webhook-timestamp` / `webhook-signature` / `X-MCP-Subscription-Id`。署名は Standard Webhooks 形式：`v1,` + base64(HMAC-SHA256(鍵, `<id>.<timestamp>.<本文>`))。
- 2xx以外は同じ `eventId` で再試行。`410` は購読を削除、`413` は再試行しない。

## エラー

`{"ok":false,"error":"<code>","message":"…"}`

| HTTP | code |
|---|---|
| 400 | `bad_json` |
| 401 | `unauthorized` `signature_required` `stale_timestamp` `bad_nonce` `bad_signature` `replay` |
| 403 | `source_mismatch` `forbidden` |
| 404 | `not_found` |
| 409 | `event_id_conflict` `bad_state` |
| 413 | `payload_too_large` |
| 422 | `bad_target` `bad_type` `bad_priority` `bad_payload` `bad_event_id` `bad_reply_to` `loop_detected` |
| 429 | `daily_limit` |
