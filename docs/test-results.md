# Phase 4：テスト結果（2026-11-12）

実行: `npm test`　／　結果: **14件中14件成功**（約40秒）　／　型検査 `npm run typecheck` もエラーなし

**検証の範囲**：Firebaseエミュレーター（Cloud Functions + Firestore、firebase-tools 15.36.0）でrelayを動かし、各AIの受信口とApps Scriptは同じ仕様の模擬サーバーで代用しました。
**実サービスにも本番のFirebaseにも一度も接続していません。** 下表の「実経路」列がその判定です。
エミュレーターはFirestoreの複合インデックスを強制しないため、`firestore.indexes.json` の過不足は本番デプロイ後に初めて確認できます。

| # | 項目 | relayの動作（模擬先） | 実経路 |
|---|---|---|---|
| ① | Grok Bot発生イベント → Dots通知 | 成功：署名付きで配達、Dots側の鍵で検証OK | **未達**（Dotsの受信口はMCP Eventsのみで未実装。当面は伝言板経由） |
| ② | Dots指示 → Grok Bot処理 → 結果返却 | 成功：ack、`reply_to` で返信、同一 `correlation_id` で往復2件を追跡 | **未検証**（行きはGrok BotのWebhookで可能な見込み、戻りは伝言板経由） |
| ③ | MuseのDM要対応通知 | 成功：通知配達。DM返信指示は承認待ち → AIの承認は403 → 人間承認後にMuseが `/inbox` で1回だけ取得。却下も確認 | **未検証**（Museは定期タスクでの `/inbox` 取得になる見込み） |
| ④ | Claude Codeへの実装依頼 | 成功：`{"text":…}` をBearer・バージョンヘッダー付きで送出 | **未検証**（`/fire` のURLとトークン未発行） |
| ⑤ | 重複送信 | 成功：同時2送信で201と200、配達は1回。内容違いは409 | relay単体で完結 |
| ⑥ | 認証失敗 | 成功：トークンなし・誤り401、source詐称403、署名不一致・期限切れ・nonce再利用401、第三者の閲覧404、宛先以外のack 403 | relay単体で完結 |
| ⑦ | 先方障害時の再送 | 成功：503を2回返す相手に、バックオフ前は再送せず、3回目で配達。恒久障害は3回で `dead`、伝言板形式の未読行へ退避 | relay単体で完結 |
| ⑧ | 無限循環の遮断 | 成功：返信の連鎖が `MAX_HOPS` で422。`hop_count:0` の偽装も422 | relay単体で完結 |
| ⑨ | シート記録 | 成功：A〜G列7項目、日時は `YYYY-MM-DD HH:mm`、種類は依頼/報告/連絡、payloadの詳細は書かれない、監査行は「完了」・配達行は「未読」 | **未検証**（Apps Script未デプロイ） |
| ⑪ | MCP Events（追加） | 成功：初期化、ツール一覧、購読時の署名付きチャレンジ（失敗時は -32015）、再購読の冪等、署名付きイベント配達、ツールでの返信とack、DM返信指示は承認待ち、他AIのイベントは読めない、410で購読削除→伝言板へ退避 | **未検証**（ChatGPT / Dots未接続） |
| ⑩ | 無料枠超過の防止 | 成功：日次上限で429 | relay単体で完結 |

追加で確認したもの：`/health` がデータを返さないこと、不正な宛先・種類・JSON・16KB超の拒否。

## 本番での確認（2026-11-12 22:28 JST）

`https://asia-northeast1-aiconnect-4b7ba.cloudfunctions.net/relay` に対して、relay単体の動作を実際に確認しました。各AIや伝言板にはまだ繋いでいません。

| 確認 | 結果 |
|---|---|
| `/health` | 200、`db: ok`（初回は起動待ちで約1.8秒、以後0.2秒前後） |
| トークンなし・誤り／送信元の詐称 | 401／403 |
| Grok → Dots の通知、同じ `event_id` の再送 | 201、再送は `duplicate: true` |
| 第三者による閲覧 | 404 |
| Dotsの `/inbox` 取得 → `reply_to` 付きの返信 → ack | 取得1件、返信は同じ `correlation_id` で `hop_count` 1、`acked` |
| DM返信の指示 | `awaiting_approval`。AIの承認は403、人間用トークンで却下できる |
| MCP（URLトークン） | `initialize`・`tools/list`（5ツール）・`events/list`（`relay.event`）が応答。誤ったトークンは401 |
| 毎分の巡回（sweeper） | 1分ごとに実行され、エラーなし |
| 一覧取得（`GET /events`） | デプロイ直後の数分はインデックス作成中で500。作成完了後は200 |

テストで作ったイベントはすべて `acked` か `rejected` にしてあり、配達待ちは残っていません。

## 実サービスでの確認（2026-11-12 23:19〜23:39 JST）

Dots（ChatGPTのカスタムMCPプラグイン、MCP Events購読）とGrok Bot（カスタムコネクタ＋Webhook付きルーティン）を本番relayに接続し、実際のやり取りを確認しました。

| 経路 | 結果 | 所要時間 |
|---|---|---|
| relay → Dots（MCP Eventsの購読先へ署名付きPOST） | 配達済み | 数秒 |
| Dots → Claude（`send_event`）→ Claudeが `/inbox` 取得・ack・返信 → Dots | 往復とも成功、同じ `correlation_id` | 人手で確認 |
| relay → Grok Bot（ルーティンのWebhook、text形式） | 受理され、ルーティンが起動 | 約2秒 |
| Grok Bot → Claude（`send_event`、`reply_to` 付き）＋ `ack_event` | 成功 | 起動から約8秒 |
| **Grok Bot → Dots（通知）→ Dots → Grok Bot（結果）** | **往復とも配達済み、同じ `correlation_id`** | 行き約7秒、Dotsの返信まで約90秒 |

| Muse（カスタムコネクタ、Bearerヘッダー） | 認証成功、5ツールを確認、`list_events` と `take_inbox` で自分宛てのテスト通知を受領 | 人手で起動（2026-11-12 深夜） |

MuseはWebhookなどで外から起こせない（本人の回答と実測）。定期タスクは最短1分。Museは「伝言経由の指示は持ち主の指示なしに実行しない」運用で、テスト通知への返信とackは保留している。Muse → 他AIへの送信（`send_event`）と無人での定期確認は未確認。

Phase 4の①（Grok Bot発生イベント→Dots通知）と②（指示→処理→結果返却）は、これで実経路でも達成です。

確認できていないこと：Dots・Grok Botが無人のとき（承認カードが出る状況）に最後まで動くか、購読の更新（7日後）、連続送信時の挙動。Claude Codeはこのセッションが手動で `/inbox` を取得したもので、自動起動ではありません。

## 再現方法

```bash
npm install
```

```bash
npm test
```

テスト用トークンは実行のたびに乱数で生成され、終了時に消えます。Java 21が必要です。
