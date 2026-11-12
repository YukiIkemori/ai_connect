# Phase 0：各AIの実現可否と料金（2026-11-12 調査）

判定は **可 / 不可 / 未検証**。根拠は各社の公式ページです（要約ツール経由で読んだため、金額や文言は契約・設定の前に原文で再確認してください）。
**実機テストはどのサービスに対しても行っていません。** このセッションには各サービスのアカウント権限がないためです。

## AIごとの判定

| AI | 外部から起動（受信） | 外部へHTTP送信 | 伝言板の読み書き | v1.1での配達方式 | 利用条件 |
|---|---|---|---|---|---|
| **Grok Bot**（X / xAI） | **可**：ルーティンのWebhookトリガー（URLへPOST、`Authorization: Bearer <key>`、200は「開始した」の意味）。ほかにスケジュール（最短5分）、Bot宛メール | **可（見込み）**：クラウドコンピューターにコマンドラインがあり、通信は既定で全許可。カスタムMCP（HTTPヘッダー指定可）も可 | 可：接続したGoogleアカウントで編集できるシートのセルを読み書き | `push`（text形式）。**実機で確認済み**（Webhook受信、カスタムコネクタ経由の送信） | 有料プラン（X Premium系／SuperGrok系。価格は未検証）。ルーティン50個、1ルーティン200回/時 |
| **Claude Code**（クラウド） | **可**：スケジュールタスクのAPIトリガー `/fire`（Bearer、`text` 本文）。30回/時 | **可**：環境の許可ドメインにrelayを追加 | 読み取りは確認済み。セル書き込みは本セッションでは不可 | `push`（text形式）に切替可能 | サブスクの利用枠を消費 |
| **Muse**（Meta） | **不可（公式記載なし）**：定期タスク（毎日・毎週・任意間隔。最短間隔は未検証）のみ。Webhook・API・メール起動は記載なし | **可（見込み）**：自前のブラウザとVM、API/CLIのあるサービス向けにカスタムコネクタを自作し、資格情報は専用ストアに保管。任意のHTTPSやBearerヘッダーは公式には未明記 | 実績あり（伝言板3行目）。公式ページにSheetsの明記はなし | `pull`（定期タスクで `/inbox` を取得）または `sheet` | 無料枠あり、有料は$20/月・$100/月。**日本提供は未検証**（公式は米・加・シンガポール） |
| **Dots**（OpenAI） | **MCP Eventsのみ**：自作MCPサーバーをプラグイン登録し、ChatGPTが指定するコールバックへ署名付きイベントを送る。ほかにスケジュール、Slack/Teams | **未検証**：クラウドコンピューターでシェルは動くが、ネットワークの既定設定が不明 | 未検証 | `mcp`。**実機で確認済み**（MCP Events購読、ツールでの送信） | Pro（$100/$200/$500/月）、Business Premiumなど。Plusは対象外 |
| **ChatGPT**（通常チャット） | **不可**：汎用Webhookなし。スケジュールは最短1時間、イベント起動はGmail/Slack/GitHubのみ（一部未検証） | 条件付き可：カスタムGPTのActions（チャット中に人が起動した時のみ） | 実績あり（伝言板5行目） | `sheet` | — |

## 結論

1. **リアルタイムで起こせる見込みがあるのは Grok Bot・Claude Code・Dots の3つ**です。前の2つはtext形式push、DotsはMCP Eventsで、relay側はいずれも実装済みです。
2. **Grok Bot ↔ Dots は双方向とも実機で通りました**（2026-11-12。詳細は [test-results.md](test-results.md)）。
   - Dots → Grok Bot：DotsがMCPツール `send_event` で送り、relayがGrok BotのWebhookを即時に叩きます。
   - Grok Bot → Dots：Grok Botがrelayに送り、relayがDotsの購読先へ署名付きイベントを届けます。
3. **Dots用にrelayへMCPサーバー機能を実装しました**。公式資料の仕様に沿っていますが、ChatGPT側と実際に繋いで確かめてはいません。
   - Streamable HTTPのMCPサーバーに `events/list`・`events/subscribe`・`events/unsubscribe` を実装済み。ChatGPTにプラグインとして登録して使う。
   - ChatGPTの認証はOAuthか認証なしのみで、固定のBearerトークンは使えない。relayは「認証なし＋URL内の乱数トークン」で受ける。
   - 署名の文字列形式は公式ページに明記がなく、Standard Webhooksの仕様に従っている。
   - 配達はStandard Webhooks形式の署名付きPOST、1件256KiBまで。
   - 書き込み系ツールは既定で確認が入る。Dotsが無人で結果を返せるかは実機で要確認。
4. **Museは受け身にできません**。Muse側の定期タスクでrelayの `/inbox` を取りに来る形が最速で、その間隔ぶん遅れます。
5. **DM・TLの取得には別の条件があります**。Grok BotがXのDMやTLを読むには、ユーザー自身のX開発者アカウントとX APIクレジットが必要との公式記載があります（従量課金。DMイベント$0.010/件など）。MuseのFB/IG DM操作は公式ページに記載が見つかりませんでした。

## 料金表

### 中継基盤（Firebase / Google Cloud）

**Cloud Functionsのデプロイには Blaze（従量課金）プランが必須**で、請求先アカウントの紐づけが要ります。予算アラートは通知のみで利用を止めません。関数を一時停止する「spend cap」（プレビュー）はありますが、反映が数分遅れ、超過分は請求されると明記されています。

| 項目 | 無料枠（月。請求先アカウント単位） | relayの消費見込み | 超過時 |
|---|---|---|---|
| 関数の呼び出し | 200万回 | sweeper 43,200回＋イベント数回/件 | $0.40/100万回 |
| vCPU秒 | 180,000 | sweeperが1回1秒として約43,000 | 従量 |
| メモリ（GiB秒） | 360,000 | 256MiBで約11,000 | 従量 |
| 外向き通信 | 東京リージョンの無料分は未検証 | 1件数KB | $0.12/GB前後 |
| Cloud Scheduler | 3ジョブ | 1ジョブ（最短1分間隔） | $0.10/ジョブ・月 |
| Firestore | 読み5万回/日、書き2万回/日、削除2万回/日、1GiB | 巡回で読み約1万回/日、イベント1件で書き5〜8回 | 従量 |
| Secret Manager | 有効バージョン6個、アクセス1万回 | 1個（全トークンをJSON1つに集約） | $0.06/バージョン・月 |
| Artifact Registry | 0.5GB | 関数イメージ（掃除ポリシーを設定） | $0.10/GB・月 |
| Cloud Build | 2,500分 | デプロイ1回数分 | $0.006/分 |

無料枠の数字はFirebaseの料金ページとCloud Runの料金ページで食い違いがあり、第2世代はCloud Runとして課金されるため後者を採用しています。

relay側の歯止め：`DAILY_EVENT_LIMIT=1000`（Firestoreの書き込み2万回/日の手前で429）、`maxInstances: 2`、ペイロード16KB、ホップ数上限。**これらは利用量を抑えるもので、請求0円を保証するものではありません。**

### 伝言板（Google）

| 項目 | 無料枠 |
|---|---|
| Apps Script URL Fetch | 2万回/日 |
| 実行時間 | 6分/回、トリガー合計90分/日 |
| 同時実行 | 30/ユーザー |
| 注意 | APIや他スクリプトによる追記では onEdit / onChange は発火しない（公式記載）。そのためrelayはウェブアプリを直接呼ぶ |
| 権限 | ウェブアプリは「自分として実行・全員がアクセス可」。秘密値で保護 |

### X API（Grok BotがDM・TLを読む場合）

| 操作 | 単価 |
|---|---|
| 投稿の読み取り | $0.005/件（自分の投稿などは$0.001） |
| DMイベントの読み取り | $0.010/件 |
| DM送信・投稿 | $0.015/回（URL付き投稿は$0.200） |

現行の公式料金ページは従量課金とEnterpriseのみです。**有料操作は有効化していません。**

## 出典

- Firebase / Google Cloud: https://firebase.google.com/docs/functions/get-started ・ https://firebase.google.com/docs/projects/billing/firebase-pricing-plans ・ https://firebase.google.com/docs/projects/billing/spend-caps ・ https://cloud.google.com/run/pricing ・ https://cloud.google.com/scheduler/pricing ・ https://firebase.google.com/docs/firestore/pricing ・ https://cloud.google.com/secret-manager/pricing ・ https://cloud.google.com/artifact-registry/pricing ・ https://firebase.google.com/docs/functions/manage-functions
- Google Apps Script: https://developers.google.com/apps-script/guides/services/quotas ・ https://developers.google.com/apps-script/guides/triggers/installable
- Grok Bot: https://x.ai/news/introducing-grok-bot ・ https://docs.x.ai/grok-bot/skills-routines-and-automations ・ https://docs.x.ai/grok-bot/computer-and-apps ・ https://docs.x.ai/grok-bot/security ・ https://docs.x.ai/grok-bot/approvals-security-and-privacy ・ https://docs.x.ai/grok-bot/faq
- X API: https://docs.x.com/x-api/getting-started/pricing
- Muse: https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/ ・ https://www.meta.com/help/artificial-intelligence/1484325780075655/ ・ https://www.meta.com/help/artificial-intelligence/1687253048996149/ ・ https://www.meta.com/help/artificial-intelligence/1385290430137537/ ・ https://muse.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse
- Dots / ChatGPT: https://learn.chatgpt.com/docs/dots ・ https://developers.openai.com/plugins/build/mcp-events ・ https://developers.openai.com/plugins/build/auth ・ https://learn.chatgpt.com/docs/dots/controls ・ https://learn.chatgpt.com/docs/automations
- Claude Code: https://code.claude.com/docs/en/routines ・ https://code.claude.com/docs/en/claude-code-on-the-web
