/**
 * yamatoyagi.hatenablog.com 専用 実験的プロキシサーバー
 *
 * 【重要な前提】
 * これは実用的なセキュリティ強化を目的としたものではなく、
 * 「多重暗号化の仕組みを体験・理解する」ための実験用実装です。
 * 復号鍵はクライアントにそのまま渡されるため、暗号強度としての
 * 実効性はほぼありません(詳細はREADME.md参照)。
 *
 * 構成:
 *   GET /            -> public/embed.html を返す(iframeに埋め込む対象ページ)
 *   GET /api/page     -> トップページを多重暗号化してJSONで返す
 *   GET /api/page?path=/entry/xxx -> 指定パスのページを多重暗号化して返す
 *   GET /asset*       -> 画像・CSS・JS等の静的アセットをそのまま中継
 *
 * 暗号化の階層 (/api/page が返すデータ):
 *   1層目: HTTPS                          (Render/ブラウザ間で自動的に有効)
 *   2層目: AES-256-GCM (鍵A)              (HTML全体を暗号化)
 *   3層目: AES-256-GCM (鍵B)              (2層目の暗号文をさらに暗号化)
 *   4層目: XORストリーム暗号 (鍵C)         (3層目の暗号文をさらに難読化)
 *
 * ブラウザ側 (public/embed.html) では 4層目→3層目→2層目 の順に復号し、
 * 得られたHTMLを内部iframeに srcdoc として描画します。
 */

const express = require('express');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const crypto = require('crypto');
const path = require('path');

const app = express();
const TARGET_ORIGIN = 'https://yamatoyagi.hatenablog.com';
const PORT = process.env.PORT || 3000;

// ---- 各層の鍵をサーバー起動時に生成 ----
const KEY_A = crypto.randomBytes(32); // 2層目 AES鍵
const KEY_B = crypto.randomBytes(32); // 3層目 AES鍵
const KEY_C = crypto.randomBytes(32); // 4層目 XORストリーム鍵

// ---- AES-256-GCM 暗号化 ----
// 出力形式: iv(12byte) + authTag(16byte) + 暗号文
function aesEncrypt(plainBuffer, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plainBuffer), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]);
}

// ---- XORストリーム暗号 ----
function xorStream(buffer, key) {
  const out = Buffer.alloc(buffer.length);
  for (let i = 0; i < buffer.length; i++) {
    out[i] = buffer[i] ^ key[i % key.length];
  }
  return out;
}

// ---- 対象サイトのHTMLを取得し、リンク/アセットパスを自サーバー経由に書き換え ----
async function fetchAndRewrite(pathAndQuery) {
  const targetUrl = TARGET_ORIGIN + pathAndQuery;
  const res = await fetch(targetUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ExperimentalProxy/1.0)' }
  });
  const html = await res.text();
  const $ = cheerio.load(html);

  // 記事内リンク(相対パス)を /api/page?path=... 経由に書き換え
  $('a[href^="/"]').each((_, el) => {
    const href = $(el).attr('href');
    if (href) $(el).attr('href', '#');
    if (href) $(el).attr('data-nav-path', href);
  });
  $('a[href^="' + TARGET_ORIGIN + '"]').each((_, el) => {
    const full = $(el).attr('href');
    const rel = full.replace(TARGET_ORIGIN, '');
    $(el).attr('href', '#');
    $(el).attr('data-nav-path', rel);
  });

  // 画像・CSS・JSの絶対パスを /asset 経由に書き換え
  $('img[src^="/"]').each((_, el) => {
    $(el).attr('src', '/asset' + $(el).attr('src'));
  });
  $('link[href^="/"]').each((_, el) => {
    $(el).attr('href', '/asset' + $(el).attr('href'));
  });
  $('script[src^="/"]').each((_, el) => {
    $(el).attr('src', '/asset' + $(el).attr('src'));
  });

  // 内部iframe内でリンククリック時に親へメッセージを送る小さなスクリプトを追加
  $('body').append(`
    <script>
      document.addEventListener('click', function(e) {
        var a = e.target.closest('a[data-nav-path]');
        if (a) {
          e.preventDefault();
          window.parent.postMessage({ type: 'navigate', path: a.getAttribute('data-nav-path') }, '*');
        }
      });
    </script>
  `);

  return $.html();
}

// ---- 静的アセット(画像・CSS・JS)はそのまま中継 ----
app.get('/asset*', async (req, res) => {
  try {
    const originalPath = req.originalUrl.replace(/^\/asset/, '');
    const targetUrl = TARGET_ORIGIN + originalPath;
    const upstream = await fetch(targetUrl);
    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    const buf = await upstream.buffer();
    res.set('content-type', contentType);
    res.send(buf);
  } catch (err) {
    res.status(502).send('アセット取得エラー: ' + err.message);
  }
});

// ---- 多重暗号化されたページデータをJSONで返す ----
app.get('/api/page', async (req, res) => {
  try {
    const pathAndQuery = req.query.path || '/';
    const html = await fetchAndRewrite(pathAndQuery);
    const plainBuffer = Buffer.from(html, 'utf-8');

    // 2層目 -> 3層目 -> 4層目 の順に暗号化を重ねる
    const layer2 = aesEncrypt(plainBuffer, KEY_A);
    const layer3 = aesEncrypt(layer2, KEY_B);
    const layer4 = xorStream(layer3, KEY_C);

    res.json({
      encrypted: layer4.toString('base64'),
      keys: {
        keyA: KEY_A.toString('base64'),
        keyB: KEY_B.toString('base64'),
        keyC: KEY_C.toString('base64')
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---- iframeに埋め込む本体ページ ----
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Encrypted proxy running on port ${PORT}`);
});
