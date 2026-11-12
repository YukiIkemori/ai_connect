# Phase 0：各AIの実現可否と料金（2026-11-12 調査）

判定は **可 / 不可 / 未検証**。根拠は各社の公式ページです（要約ツール経由で読んだため、金額は契約前に原文で再確認してください）。
**実機テストはどのサービスに対しても行っていません。** このセッションには各サービスのアカウント権限がないためです。

## AIごとの判定

| AI | 外部から起動（受信） | 外部へHTTP送信 | 伝言板の読み書き | v1.0での配達方式 | 追加費用 |
|---|---|---|---|---|---|
| **Claude Code**（クラウド） | **可**：スケジュールタスクのAPIトリガー `/fire`（Bearer、`text` 本文）。タスクあたり30回/時、アカウント100回/時 | **可**：環境の許可ドメインにrelayを追加 | 可（Driveコネクタは読み取りのみ確認。セル書き込みは本セッションでは不可） | `push`（text形式）。**実装済み・模擬先でのみ検証** | なし（サブスクの利用枠を消費） |
| **ChatGPT**（通常チャット） | **不可**：汎用Webhookなし。スケジュールタスクは最短1時間、イベント起動はGmail/Slack/GitHubのみ（未検証：ヘルプ記事が取得不可） | 条件付き可：カスタムGPTのActionsでBearer付きAPI呼び出し（チャット中に人が起動した時のみ） | 実績あり（伝言板5行目） | `sheet` | なし |
| **Dots** | **未検証**：OpenAIの「dots」と推定（確証なし）。汎用Webhookは文書になし。Slack/Teams、自己スケジュール、MCP Eventsが入口 | 未検証 | 未検証 | `sheet` | 未検証（Pro以上が対象との第三者情報） |
| **Grok**（アプリ） | **不可**：Webhook起動なし。Automationsはスケジュールのみ、メール起動はSuperGrok | 不可（自作MCPサーバー経由のみ） | 可：Google Workspaceコネクタ。Automations内で使えるかは未検証 | `sheet` | なし |
| **Grokbot**（X APIを使う自作bot の場合） | 可：自前サーバーがあればrelayから `push` | 可 | — | 未確定（実体が不明） | **X API利用料が必ず発生**（下表） |
| **Muse** | **未検証**：製品を特定できず | 未検証 | 実績あり（伝言板3行目） | `sheet` | 未検証 |

## 結論

1. **0円で双方向リアルタイムにできるのは、現時点でClaude Codeだけ**です（受信は `/fire`、送信はHTTP）。
2. **Grokbot ↔ Dots の実サービス間PoCは未達**です。どちらにも文書化された受信口がなく、relay側は完成していますが実経路がありません。模擬受信口では双方向とも通っています（[test-results.md](test-results.md)）。
3. Dots・ChatGPT側をイベント駆動にする唯一の公式ルートは **MCP Events**（自作MCPサーバーがChatGPTへ署名付きイベントを送る）です。relayにMCPサーバー機能を足せば繋がる見込みですが、対象プランが公式に明記されておらず、v1.0では実装していません。
4. それ以外の相手は、relayが**伝言板に未読行を即時追記**する形になります。相手側の巡回間隔（5分など）は残りますが、送信側は待たずに済み、承認・再送・重複排除・追跡はrelayが担います。

## 料金表

### 中継基盤（Cloudflare 無料プラン）

| 項目 | 無料枠 | relayの消費 | 超過時 |
|---|---|---|---|
| Workers リクエスト | 10万/日（UTC 0時リセット） | Cron 1,440/日＋イベント1件あたり数回 | エラー1027。課金はされない |
| CPU時間 | 10ms/回 | 署名検証とDB操作のみ | — |
| サブリクエスト | 50/回 | 再送は1回5件まで | — |
| Cron Triggers | 5個/アカウント | 1個 | — |
| D1 | 読み500万行/日、書き10万行/日、5GB | イベント1件で書き5〜10行程度 | その日はクエリがエラー |
| クレジットカード | 不要との記載（マーケティングページ。未検証） | | |

relay側の上限 `DAILY_EVENT_LIMIT=2000` で、無料枠の手前で429を返します。

### 伝言板（Google）

| 項目 | 無料枠 |
|---|---|
| Apps Script URL Fetch | 2万回/日 |
| 実行時間 | 6分/回、トリガー合計90分/日 |
| 同時実行 | 30/ユーザー |
| 時間主導トリガー | 最短1分。実行時刻は多少ずれる。遅延の公式保証なし |
| 注意 | APIや他スクリプトによる追記では onEdit / onChange は発火しない（公式記載）。そのためrelayはウェブアプリを直接呼ぶ |
| 権限 | ウェブアプリは「自分として実行・全員がアクセス可」。秘密値で保護 |

### X API（Grokbotが使う場合）— **0円構成は不可**

| 操作 | 単価 |
|---|---|
| 投稿の読み取り | $0.005/件（自分の投稿などは$0.001） |
| DMイベントの読み取り・Webhook受信 | $0.010/件 |
| DM送信・投稿 | $0.015/回（URL付き投稿は$0.200） |
| 要件 | 開発者アカウント承認＋支払いカード |

現行の公式料金ページは従量課金とEnterpriseのみです。旧Free/Basic/Proの扱いは未検証。**有料操作は有効化していません。**

### xAI API

grok-4.5〜4.7：入力$2.00／出力$6.00（100万トークンあたり）。無料クレジットは未検証。アプリ版Grokの個人チャットをAPIモデルで置き換えることはしていません。

### Meta（Museが FB/IG のDMを扱う場合）

| 項目 | 内容 |
|---|---|
| 料金 | 公式ページに課金の記載なし |
| 受信Webhook | アプリの役割を持つ人（管理者・開発者・テスター）からのメッセージのみ、審査なしで可。**一般ユーザーのDMはApp Review（Advanced Access）が必要** |
| 条件 | アプリを公開状態にする、Facebookページ、IGはプロアカウント |
| 送信 | 相手の最終メッセージから24時間以内。自動応答は法令上必要な場面で開示 |
| 本人確認 | Advanced Accessではビジネス認証を求められる可能性 |

## 出典

- Cloudflare: https://developers.cloudflare.com/workers/platform/limits/ ・ https://developers.cloudflare.com/workers/platform/pricing/ ・ https://developers.cloudflare.com/d1/platform/pricing/
- Google: https://developers.google.com/apps-script/guides/services/quotas ・ https://developers.google.com/apps-script/guides/triggers/installable ・ https://developers.google.com/workspace/sheets/api/limits
- X: https://docs.x.com/x-api/getting-started/pricing ・ https://docs.x.com/x-api/activity/introduction
- xAI: https://docs.x.ai/docs/models ・ https://x.ai/news/grok-automations ・ https://x.ai/news/grok-connectors
- Meta: https://developers.facebook.com/docs/messenger-platform/webhooks ・ https://developers.facebook.com/docs/messenger-platform/instagram/features/webhook
- OpenAI: https://learn.chatgpt.com/docs/automations ・ https://developers.openai.com/plugins/build/mcp-events ・ https://learn.chatgpt.com/docs/dots
- Claude Code: https://code.claude.com/docs/en/routines ・ https://code.claude.com/docs/en/claude-code-on-the-web
