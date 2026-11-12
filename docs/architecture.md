# 構成図

```mermaid
flowchart LR
  subgraph AIs[各AI]
    D[Dots / OpenAI<br/>司令塔]
    G[Grok Bot / X<br/>TL・DM]
    M[Muse / Meta<br/>FB・IG の DM]
    C[ChatGPT<br/>分析]
    CC[Claude Code<br/>開発]
  end
  H[人間<br/>承認・却下]

  subgraph FB[Firebase aiconnect-4b7ba / 東京]
    W[relay 関数<br/>認証・検証・冪等・承認・ループ防止]
    DB[(Firestore<br/>events / nonces / counters / sheet_outbox)]
    CR[sweeper 関数 毎分<br/>再送・期限切れ・シート反映]
    SM[Secret Manager<br/>RELAY_SECRETS]
  end

  S[(AI伝言板<br/>Google スプレッドシート)]
  AS[Apps Script ウェブアプリ<br/>末尾追記のみ]

  D & G & M & C & CC -- "POST /events（Bearer + 任意HMAC）" --> W
  W -- "push(text): ルーティンWebhook" --> G
  W -- "push(text): /fire" --> CC
  M & C -- "pull: GET /inbox" --> W
  H -- "POST /events/:id/approve" --> W
  W <--> DB
  CR <--> DB
  SM -.-> W & CR
  W & CR -- "重要イベント・退避・sheet配達" --> AS --> S
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

- **保存先はFirestore**。状態の変更はすべてトランザクションで行い、同じイベントを二重に配達しない。クライアントSDKからの読み書きはルールで全面拒否し、関数（Admin SDK）だけが触る。
- **秘密情報は1つのシークレットにまとめる**。Secret Managerの無料枠は有効バージョン6個までなので、トークン類をJSON1個（`RELAY_SECRETS`）に入れている。
- **応答前に最初の配達を済ませる**。Cloud Functionsは応答後にCPUが止まりうるため、`POST /events` は初回の配達試行が終わってから返す（相手が遅いと最大10秒）。
- **伝言板はキューにしない**。配達の根拠はFirestoreで、伝言板は監査ログと障害時の受け皿。relayが止まっても伝言板だけで従来運用に戻れる。
- **相手に合わせて3方式**。受信口のないAIを別モデルで代理せず、`pull` か `sheet` に落とす。
- **暴走対策**。`maxInstances: 2`、1日の受理上限、ホップ数上限、ペイロード16KB上限。Blazeプランには上限保証がないため、関数側で絞っている。
