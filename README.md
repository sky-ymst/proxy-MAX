# yamatoyagi.hatenablog.com 専用 実験的多重暗号化プロキシ

## これは何か

`https://yamatoyagi.hatenablog.com` の内容を取得し、サーバー側で3段階の暗号化
(AES-256-GCM → AES-256-GCM → XORストリーム暗号)をかけたうえでブラウザに送信、
ブラウザ側のJavaScript(WebCrypto API)で逆順に復号して画面に表示する、
iframe埋め込み用の実験的プロキシです。

**重要**: これは実用的なセキュリティ対策ではありません。復号に使う鍵は
`/api/page` のレスポンスにそのまま含まれており、ブラウザの開発者ツールを
開けば誰でも読める状態です。「多重暗号化の仕組みを体験する」ための学習・
実験目的の実装であり、本番運用や機密情報の保護には使用しないでください。

## 暗号化の階層

```
1層目: HTTPS                         (Render/ブラウザ間、常時自動で有効)
2層目: AES-256-GCM (鍵A)             (取得したHTML全体を暗号化)
3層目: AES-256-GCM (鍵B)             (2層目の暗号文をさらに暗号化)
4層目: XORストリーム暗号 (鍵C)        (3層目の暗号文をさらに難読化)
```

ブラウザは `/api/page` から受け取ったペイロードに対して
4層目 → 3層目 → 2層目 の順で復号し、最終的に得られたHTMLを
内部iframeに `srcdoc` として描画します。

## ファイル構成

```
hatena-proxy/
├── server.js          サーバー本体(取得・書き換え・暗号化・配信)
├── package.json
└── public/
    └── embed.html      iframeに埋め込む対象ページ(復号処理を含む)
```

## デプロイ手順 (Render)

1. このフォルダの内容をGitHubリポジトリにpushする
2. Renderにログイン → 「New +」→「Web Service」
3. GitHubリポジトリを選択して連携
4. 設定:
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Instance Type**: Free で動作確認可能(一定時間アクセスがないとスリープします)
5. デプロイ完了後、発行されたURL (例: `https://your-app.onrender.com`) にアクセス

## ローカルでの動作確認

```bash
npm install
node server.js
# ブラウザで http://localhost:3000 を開く
```

## iframeへの埋め込み方

自分の別サイトなどに埋め込む場合は、以下のように記述します。

```html
<iframe
  src="https://your-app.onrender.com"
  width="100%"
  height="800"
  style="border:none;">
</iframe>
```

## 動作確認のポイント

- ブラウザの開発者ツール → Networkタブを開いた状態でアクセスすると、
  `/api/page` のレスポンスが意味不明な文字列(Base64化された暗号文)に
  なっていることが確認できます。
- ページ上部のステータス表示が「層4(XOR)を復号中...」→
  「層3(AES-256-GCM)を復号中...」→「層2(AES-256-GCM)を復号中...」→
  「復号完了・表示中」と変化し、各層の復号処理を体験できます。
- Consoleタブでエラーが出ていないか確認できます。

## 制約・既知の注意点

- 対象サイトが `yamatoyagi.hatenablog.com` に固定されています(著作権上の配慮)。
- 記事内リンクをクリックすると、内部iframeから親フレーム(embed.html)へ
  `postMessage` でパスを伝え、そのパスを再度 `/api/page` に問い合わせて
  ページ遷移する仕組みです。
- はてなブログ側のレイアウトやパス構造が変わった場合、リンク書き換えの
  ロジック (`server.js` の `fetchAndRewrite` 関数) の調整が必要になる場合があります。
- Renderの無料プランはスリープ復帰に時間がかかるため、久しぶりにアクセス
  すると初回表示に数十秒かかることがあります。
