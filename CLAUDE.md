# ai_connect — 作業メモ（Claude Code向け）

AI間イベント中継（relay）。Firebase Functions v2 + Firestore。概要はREADME、未了事項は docs/limitations.md。

## 検証

- `npm install` → `npm test`（Firebaseエミュレーター、Java 21が必要、約35秒）。変更後は必ず通す。
- `npm run typecheck`

## デプロイ（プロジェクト `aiconnect-4b7ba`、リージョン `asia-northeast1`）

- 認証は環境変数 `FIREBASE_SA_JSON`（プロジェクト内のサービスアカウントのJSON）。一時ファイルに書き出して
  `GOOGLE_APPLICATION_CREDENTIALS` で渡し、終わったら消す。中身を出力しない。
- 別プロジェクトのサービスアカウント（`GOOGLE_SA_JSON`）ではFirebase CLIが403になる（APIの利用元が向こうのプロジェクト扱い）。使わない。
- 手順: `npm run gen-secrets` → `firebase functions:secrets:set RELAY_SECRETS --data-file secrets.json --force`
  → `npm run deploy -- --force` → `/relay/health` を確認。
- `secrets.json` とトークンの値は、チャット・ログ・コミットに出さない。値が必要な人にはSecret Managerのコンソールを案内する。
- エミュレーターはFirestoreの複合インデックスを検証しない。初回デプロイ後に関数ログでインデックス不足のエラーを確認する。

## 決まりごと

- 伝言板（Googleスプレッドシート）の既存行は変更しない。relayは末尾追記のみ。
- AI間の指示は、ユーザーの指定（2026-11-13）によりrelayでは承認なしで渡す（`APPROVAL_ACTIONS` は空）。承認の仕組み自体は残してあり、設定で戻せる。勝手に有効・無効を切り替えない。
- 受信できないAIを別モデルで代理しない。
- 実サービスで確かめていないことは、ドキュメントに「未検証」と書く。
