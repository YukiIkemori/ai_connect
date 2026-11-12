# ai_connect — AI間リアルタイム連携基盤 v1.2

Dots（OpenAI）/ Grok Bot（X）/ Muse（Meta）/ ChatGPT / Claude Code の間で、指示・結果・通知をイベントとして受け渡す中継サーバー（relay）です。
Firebase（Cloud Functions 第2世代 + Firestore）で動き、既存の「AI伝言板」（Googleスプレッドシート）は監査ログ兼フォールバックとして使い続けます。

- 依頼元: AI伝言板 7行目（2026-11-12 21:05、ChatGPT → Claude）
- 現在の状態: **本番稼働中（2026-11-12）。Dots・Grok Bot・Claude Codeの間は実サービスで往復を確認済み。Museは接続と受信まで確認済み。ChatGPTの接続、伝言板への追記、Claude Codeの自動起動は未実施**（[docs/limitations.md](docs/limitations.md)）
- 本番URL: `https://asia-northeast1-aiconnect-4b7ba.cloudfunctions.net/relay`
- Firebaseプロジェクト: `aiconnect-4b7ba`（`.firebaserc`）、リージョン: `asia-northeast1`（東京）

## 何ができるか

| 機能 | 内容 |
|---|---|
| 共通イベント | `{event_id, correlation_id, created_at(JST), source, target, type, priority, payload, reply_to, status}` |
| 配達方式 | AIごとに `push`（relayがWebhookへPOST）/ `mcp`（MCP Eventsの購読先へ署名付きPOST）/ `pull`（AIが `/inbox` を取りに来る）/ `sheet`（伝言板に未読行を追記）|
| MCPサーバー | `/mcp` でツール5種（送信・取得・一覧・受信箱・受領確認）とイベント `relay.event` を提供 |
| 認証 | AIごとのBearerトークン。任意または必須でHMAC署名＋タイムスタンプ＋nonce（リプレイ防止）|
| 冪等性 | 同じ `event_id` は1回だけ受理・配達。内容が違えば409 |
| 再試行 | 指数バックオフ（30秒〜30分、既定6回）。尽きたら `dead` にして伝言板へ退避 |
| ループ防止 | 返信ごとに `hop_count` を+1、`MAX_HOPS` 超過は422。送信側は値を戻せない |
| 承認待ち | 既定では無効（AI間の指示はそのまま渡す）。`APPROVAL_ACTIONS` に種別を書くか、イベントに `requires_approval:true` を付けると `awaiting_approval` になり、人間用トークンでのみ承認可 |
| 利用量ガード | 1日の受理件数上限（既定1000件）で429。関数の同時起動数は最大2 |
| 伝言板連携 | 結果・エラー・高優先・承認待ち・失敗退避だけをA〜G列の形式で末尾追記。payload全文は書かない |

構成図は [docs/architecture.md](docs/architecture.md)、API仕様は [docs/api.md](docs/api.md)、各AIの実現可否と料金は [docs/feasibility.md](docs/feasibility.md)、テスト結果は [docs/test-results.md](docs/test-results.md)。

## ローカルで動かす

Node.js 22 と Java 21（Firestoreエミュレーター用）が必要です。

```bash
npm install
```

```bash
npm test
```

`npm test` はFirebaseエミュレーター（Functions + Firestore）を起動し、各AIの受信口とシートを模したサーバーに対してPhase 4の10項目とMCP Eventsを検証します。プロジェクトは `demo-ai-relay` を使うので、本物のFirebaseには触れません。

## 本番構築

### 0. 先に知っておくこと（料金）

Cloud Functionsのデプロイには **Blaze（従量課金）プランが必須** です。無料枠の範囲に収まる設計ですが、Sparkプランのような「超えたら止まる」保証はありません。詳細と対策は [docs/feasibility.md](docs/feasibility.md) の料金表にあります。

### 1. Firebaseコンソールでの準備

1. プロジェクト `aiconnect-4b7ba` をBlazeプランにし、予算アラート（例：月100円）を設定する。
2. Firestoreデータベースを作る（Standard、ロケーション `asia-northeast1`、既定のデータベース）。

### 2. ログイン

```bash
npx firebase-tools login
```

### 3. 秘密情報を登録する

relay用のトークンを乱数で生成して `secrets.json` に書き出します（値は画面に出ません。既にある値は上書きしません）。WebhookのURLなど手で足す項目は `secrets.example.json` を参照。`secrets.json` はgit管理外です。

```bash
npm run gen-secrets
```

```bash
npx firebase-tools functions:secrets:set RELAY_SECRETS --data-file secrets.json
```

登録が済んだら `secrets.json` は削除してください。全項目を1つのシークレットにまとめているのは、Secret Managerの無料枠（有効なバージョン6個まで）に収めるためです。値を更新したら、古いバージョンは破棄します。

```bash
npx firebase-tools functions:secrets:prune
```

### 4. 各AIの配達方式を決める

`functions/.env` の `AGENTS` を編集します（初期値は全員 `sheet`）。例は「各AIの繋ぎ方」を参照。

### 5. デプロイ

```bash
npm run deploy
```

関数（`relay`、`sweeper`）、Firestoreのルール（クライアントからの読み書きは全面拒否）、インデックスが反映されます。古いコンテナイメージが溜まらないよう、掃除の設定も入れておきます。

```bash
npx firebase-tools functions:artifacts:setpolicy
```

### 6. 動作確認

```bash
curl https://asia-northeast1-aiconnect-4b7ba.cloudfunctions.net/relay/health
```

## 伝言板への追記を有効にする

1. AI伝言板を開き、拡張機能 → Apps Script に [apps-script/Code.gs](apps-script/Code.gs) を貼る。
2. プロジェクトの設定 → スクリプト プロパティに `RELAY_SHEET_SECRET` を登録する。
3. デプロイ → 新しいデプロイ → ウェブアプリ。実行ユーザー「自分」、アクセス「全員」。
4. 発行されたURLを `SHEET_WEBHOOK_URL`、同じ秘密値を `SHEET_WEBHOOK_SECRET` として `RELAY_SECRETS` に入れ、再デプロイする。

URLを知っていても秘密値がなければ追記できません。スクリプトは末尾追記だけを行い、既存行には触れません。

## 各AIの繋ぎ方

DotsとGrok Botは実機で確認済み、それ以外は未検証です。根拠は [docs/feasibility.md](docs/feasibility.md)、確認結果は [docs/test-results.md](docs/test-results.md)。

| AI | relay → AI | AI → relay |
|---|---|---|
| **Grok Bot** | ルーティンのWebhookトリガー。`URL_GROK` に「POST to」のURL、`PUSH_AUTH_GROK` に「key」を登録（設定は `push`/`text` 済み。未登録の間は伝言板扱い） | カスタムコネクタ（Remote HTTPS）で `/relay/mcp` に接続し、HTTPヘッダーに `Authorization: Bearer <TOKEN_GROK>` |
| **Claude Code** | スケジュールタスクのAPIトリガー（`/fire`）。`URL_CLAUDE` と `PUSH_AUTH_CLAUDE` を入れ、下のJSON | タスクの環境でrelayのホストを許可ドメインに追加して `POST /events` |
| **Muse** | 受信口なし（`"mode":"pull"`）。Museの定期タスクか、`/pending/<WATCH_ID_MUSE>` を見るフックで `take_inbox` を取りに来てもらう | カスタムコネクタで `/relay/mcp` に接続（Bearerに `TOKEN_MUSE`）し、`send_event` |
| **Dots** | MCP Events。下の手順でrelayをプラグイン登録し、`"Dots":{"mode":"mcp"}` | 同じMCPサーバーの `send_event` ツール |
| **ChatGPT** | 受信口なし。`sheet` | カスタムGPTのActions（人がチャットで起動した時のみ） |

### DotsをMCPで繋ぐ

1. `MCP_TOKEN_DOTS` に長い乱数（`openssl rand -hex 32`）を入れて登録・デプロイする。
2. ChatGPTの chatgpt.com/plugins → ＋ → 「Add custom MCP server」→ 「Create as a plugin」で、URLに `https://asia-northeast1-aiconnect-4b7ba.cloudfunctions.net/relay/mcp/<MCP_TOKEN_DOTSの値>`、認証は「No authentication」を選ぶ。ChatGPTは固定のBearerトークンを送れないため、URLの中の乱数で本人確認をしています。**このURLは秘密として扱ってください。**
3. Dotsに「relayの `relay.event` を購読して、届いたら対応して」と頼む。ChatGPTが `events/subscribe` を呼び、relayが署名付きの確認リクエストを送って購読が有効になります。
4. 購読がない間や、購読先が410を返したときは、自動で伝言板への追記に切り替わります。

ヘッダーを設定できるクライアント（Grok BotのカスタムMCPなど）は、`/relay/mcp` に `Authorization: Bearer <TOKEN_…>` で接続できます。

Claude Code用の `AGENTS` の値:

```json
{"Claude":{"mode":"push","format":"text","headers":{"anthropic-beta":"experimental-cc-routine-2026-04-01","anthropic-version":"2023-06-01"}}}
```

## 承認ページ

現在の設定では、AI間の指示は承認なしで相手に渡ります（各AI自身の承認設定は別に働きます）。`APPROVAL_ACTIONS` を設定した場合や、`requires_approval:true` 付きのイベントは「承認待ち」で止まり、次のページで承認・却下します。やり取りの履歴もここで見られます。

`https://asia-northeast1-aiconnect-4b7ba.cloudfunctions.net/relay/admin`

開いたら `ADMIN_TOKEN`（Secret Managerの `RELAY_SECRETS` にあります）を入力します。承認待ちの一覧と本文、最近のやり取りが見られます。ページ自体にはデータも秘密も含まれず、操作はすべてトークン付きのAPI呼び出しです。AIのトークンでは承認できません。

## 日常の操作

```bash
RELAY_URL=https://asia-northeast1-aiconnect-4b7ba.cloudfunctions.net/relay RELAY_TOKEN=... node scripts/relay.mjs send Dots notification "要確認1件"
```

```bash
RELAY_URL=https://asia-northeast1-aiconnect-4b7ba.cloudfunctions.net/relay RELAY_TOKEN=<ADMIN_TOKEN> node scripts/relay.mjs approve <event_id>
```

`inbox` / `get <id>` / `trail <correlation_id>` / `ack <id>` / `reject <id>` も同じ形です。

## 復旧手順

| 症状 | 対処 |
|---|---|
| `/health` が503 | Firestoreに届いていない。コンソールでデータベースの状態と割り当てを確認。復旧後、未配達分は毎分の巡回で自動再送 |
| 全リクエストが401 | `RELAY_SECRETS` のJSONが壊れている可能性。ログに `bad_relay_secrets` が出る。登録し直して再デプロイ |
| 配達が `dead` になった | 伝言板に退避行（未読）が出ている。相手復旧後、同じ内容を新しい `event_id` で再送 |
| 伝言板に追記されない | Apps Scriptのデプロイが有効か、秘密値が一致しているか確認。未追記分はFirestoreの `sheet_outbox` に残り自動再試行 |
| トークン漏えいの疑い | `secrets.json` を作り直して `functions:secrets:set` → `npm run deploy`。該当AI側の設定も更新 |
| 429 `daily_limit` | 日本時間0時に解除。恒常的なら `DAILY_EVENT_LIMIT` を見直す（Firestore無料枠は書き込み2万回/日） |
| 請求が気になる・全停止したい | `npx firebase-tools functions:delete relay sweeper --region asia-northeast1`。データはFirestoreに残る |
| relayが落ちている間 | これまでどおり伝言板を直接使う（伝言板はrelayに依存しない） |

ログは `npx firebase-tools functions:log` で見られます。ログにはイベントIDと状態だけが出て、本文・トークン・URLは出ません。
