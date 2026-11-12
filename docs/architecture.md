# 構成図

```mermaid
flowchart LR
  subgraph AIs[各AI]
    D[Dots<br/>司令塔]
    G[Grok / Grokbot<br/>X の TL・DM]
    M[Muse<br/>FB・IG の DM]
    C[ChatGPT<br/>分析]
    CC[Claude Code<br/>開発]
  end
  H[人間 ユウキ<br/>承認・却下]

  subgraph CF[Cloudflare 無料枠]
    W[ai-relay Worker<br/>認証・検証・冪等・承認・ループ防止]
    DB[(D1<br/>events / nonces / counters / sheet_outbox)]
    CR[Cron 毎分<br/>再送・期限切れ・シート反映]
  end

  S[(AI伝言板<br/>Google スプレッドシート)]
  AS[Apps Script ウェブアプリ<br/>末尾追記のみ]

  D & G & M & C & CC -- "POST /events（Bearer + 任意HMAC）" --> W
  W -- "push: 署名付きPOST" --> D & G
  W -- "push(text): /fire" --> CC
  M & C -- "pull: GET /inbox" --> W
  H -- "POST /events/:id/approve" --> W
  W <--> DB
  CR --> W
  W -- "重要イベント・退避・sheet配達" --> AS --> S
  D & G & M & C & CC -. "従来どおり直接読み書き（フォールバック）" .-> S
```

## イベントの状態

```mermaid
stateDiagram-v2
  [*] --> awaiting_approval: 外部送信・課金系の指示
  [*] --> queued: それ以外
  awaiting_approval --> queued: 人間が承認
  awaiting_approval --> rejected: 人間が却下
  awaiting_approval --> expired: 期限切れ
  queued --> delivering: 配達を確保
  delivering --> delivered: 成功
  delivering --> queued: 失敗（バックオフ後に再送）
  delivering --> dead: 再試行上限 → 伝言板へ退避
  queued --> delivered: /inbox で取得 or 伝言板に追記
  queued --> expired: 期限切れ
  delivered --> acked: 受信側が確認
  dead --> acked
```

## 設計上の判断

- **保存先はD1**。無料枠の書き込みが10万行/日あり、KV（1,000回/日）やQueues（1万操作/日）より余裕がある。冪等性の判定も主キーで済む。
- **伝言板はキューにしない**。配達の根拠はD1で、伝言板は監査ログと障害時の受け皿。relayが止まっても伝言板だけで従来運用に戻れる。
- **相手に合わせて3方式**。Webhookを受けられるAIは少ないため、受信不可の相手を別モデルで代理せず、`pull` か `sheet` に落とす。
- **1回の実行で5件まで再送**。無料枠は1実行あたりサブリクエスト50・D1クエリ50が上限のため。
- **secretはWorkerのsecretのみ**。リポジトリ・シート・ログには出ない。Apps Scriptはヘッダーを読めないので、その経路だけ本文で渡す（TLS上）。
