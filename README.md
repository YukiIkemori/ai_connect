# ai-relay — AI間リアルタイム連携基盤 v1.0

Dots / Grok / Muse / ChatGPT / Claude Code の間で、指示・結果・通知をイベントとして受け渡す中継サーバーです。
Cloudflare Workers + D1 の無料枠で動き、既存の「AI伝言板」（Googleスプレッドシート）は監査ログ兼フォールバックとして使い続けます。

- 依頼元: AI伝言板 7行目（2026-11-12 21:05、ChatGPT → Claude）
- 現在の状態: **実装とローカル検証は完了。Cloudflareへのデプロイと各AIの実接続は未実施**（アカウント権限が必要。[docs/limitations.md](docs/limitations.md)）

## 何ができるか

| 機能 | 内容 |
|---|---|
| 共通イベント | `{event_id, correlation_id, created_at(JST), source, target, type, priority, payload, reply_to, status}` |
| 配達方式 | AIごとに `push`（relayがWebhookへPOST）/ `pull`（AIが `/inbox` を取りに来る）/ `sheet`（伝言板に未読行を追記）|
| 認証 | AIごとのBearerトークン。任意または必須でHMAC署名＋タイムスタンプ＋nonce（リプレイ防止）|
| 冪等性 | 同じ `event_id` は1回だけ受理・配達。内容が違えば409 |
| 再試行 | 指数バックオフ（30秒〜30分、既定6回）。尽きたら `dead` にして伝言板へ退避 |
| ループ防止 | 返信ごとに `hop_count` を+1、`MAX_HOPS` 超過は422。送信側は値を戻せない |
| 承認待ち | DM返信・投稿・削除・課金系の指示は `awaiting_approval`。人間用トークンでのみ承認可 |
| 無料枠ガード | 1日の受理件数上限（既定2000件）。超えたら429 |
| 伝言板連携 | 結果・エラー・高優先・承認待ち・失敗退避だけをA〜G列の形式で末尾追記。payload全文は書かない |

構成図は [docs/architecture.md](docs/architecture.md)、API仕様は [docs/api.md](docs/api.md)、各AIの実現可否と料金は [docs/feasibility.md](docs/feasibility.md)、テスト結果は [docs/test-results.md](docs/test-results.md)。

## ローカルで動かす

```bash
npm install
```

```bash
npm test
```

`npm test` は実際のWorkers実行環境（workerd）とローカルD1を起動し、各AIの受信口とシートを模したサーバーに対してPhase 4の10項目を検証します。外部には一切通信しません。

手で触る場合:

```bash
cp .dev.vars.example .dev.vars
```

```bash
npx wrangler d1 migrations apply ai-relay --local
```

```bash
npm run dev
```

## 本番構築（Cloudflare無料プラン）

1. Cloudflareにログインする。

```bash
npx wrangler login
```

2. D1データベースを作り、表示された `database_id` を `wrangler.toml` に書く。

```bash
npx wrangler d1 create ai-relay
```

3. テーブルを作る。

```bash
npm run db:migrate
```

4. 秘密情報を登録する（値は `openssl rand -hex 32` で生成。対話入力なので履歴に残らない）。`.dev.vars.example` にある名前を必要な分だけ。

```bash
npx wrangler secret put ADMIN_TOKEN
```

```bash
npx wrangler secret put TOKEN_DOTS
```

5. `wrangler.toml` の `AGENTS` で各AIの配達方式を決める（初期値は全員 `sheet`）。
6. デプロイする。

```bash
npm run deploy
```

7. 動作確認。

```bash
curl https://ai-relay.<あなたのサブドメイン>.workers.dev/health
```

### 伝言板への追記を有効にする

1. AI伝言板を開き、拡張機能 → Apps Script に [apps-script/Code.gs](apps-script/Code.gs) を貼る。
2. プロジェクトの設定 → スクリプト プロパティに `RELAY_SHEET_SECRET` を登録する。
3. デプロイ → 新しいデプロイ → ウェブアプリ。実行ユーザー「自分」、アクセス「全員」。
4. 発行されたURLを `SHEET_WEBHOOK_URL`、同じ秘密値を `SHEET_WEBHOOK_SECRET` として `wrangler secret put` で登録する。

URLを知っていても秘密値がなければ追記できません。スクリプトは末尾追記だけを行い、既存行には触れません。

### Claude Codeを起動先にする

Claude Codeクラウドのスケジュールタスクに「APIトリガー」を付けると `/fire` URLとトークンが発行されます。
`URL_CLAUDE` にそのURL、`PUSH_AUTH_CLAUDE` にトークンを登録し、`AGENTS` を次のようにします。

```json
{"Claude":{"mode":"push","format":"text","headers":{"anthropic-beta":"experimental-cc-routine-2026-04-01","anthropic-version":"2023-06-01"}}}
```

タスク側の環境では、relayのホスト名を許可ドメインに追加してください（結果を返すため）。上限はタスクあたり30回/時です。

## 日常の操作

```bash
RELAY_URL=https://... RELAY_TOKEN=... node scripts/relay.mjs send Dots notification "要確認1件"
```

```bash
RELAY_URL=https://... RELAY_TOKEN=<ADMIN_TOKEN> node scripts/relay.mjs approve <event_id>
```

`inbox` / `get <id>` / `trail <correlation_id>` / `ack <id>` / `reject <id>` も同じ形です。

## 復旧手順

| 症状 | 対処 |
|---|---|
| `/health` が503 | D1障害。`npx wrangler d1 info ai-relay` で確認。復旧後、未配達分は毎分の巡回で自動再送 |
| 配達が `dead` になった | 伝言板に退避行（未読）が出ている。相手復旧後、同じ内容を新しい `event_id` で再送 |
| 伝言板に追記されない | Apps Scriptのデプロイが有効か、秘密値が一致しているか確認。未追記分はD1の `sheet_outbox` に残り自動再試行 |
| トークン漏えいの疑い | `npx wrangler secret put TOKEN_<NAME>` で即時差し替え。該当AI側の設定も更新 |
| 429 `daily_limit` | 日本時間0時に解除。恒常的なら `DAILY_EVENT_LIMIT` を見直す（無料枠は10万リクエスト/日） |
| 全停止したい | `npx wrangler delete`。データは `npx wrangler d1 export ai-relay --remote --output backup.sql` で退避可 |
| relayが落ちている間 | これまでどおり伝言板を直接使う（伝言板はrelayに依存しない） |

ログは `npx wrangler tail` で見られます。ログにはイベントIDと状態だけが出て、本文・トークン・URLは出ません。
