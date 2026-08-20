const express = require('express');
const crypto = require('crypto');
const cheerio = require('cheerio');
const fetch = require('node-fetch');

const app = express();
app.use(express.static('public'));

// 実験目的：このプロキシで許可するホスト一覧
// ホストの追加・削除は allowed-hosts.json を編集するだけでOK（このファイルは触らなくてよい）
const ALLOWED_HOSTS = require('./allowed-hosts.json');

// ---------- 多重暗号化ヘルパー ----------
function xorEncrypt(buf, key) {
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ key[i % key.length];
  return out;
}

function aesEncrypt(buf, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(buf), cipher.final()]);
  const tag = cipher.getAuthTag();
  // iv(12) + tag(16) + 暗号文 の順で連結
  return Buffer.concat([iv, tag, enc]);
}

function multiEncrypt(plainText) {
  const key1 = crypto.randomBytes(32);
  const key2 = crypto.randomBytes(32);
  const xorKey = crypto.randomBytes(16);

  let buf = Buffer.from(plainText, 'utf-8');
  buf = aesEncrypt(buf, key1);   // 層1
  buf = aesEncrypt(buf, key2);   // 層2
  buf = xorEncrypt(buf, xorKey); // 層3

  return {
    payload: buf.toString('base64'),
    key1: key1.toString('base64'),
    key2: key2.toString('base64'),
    xorKey: xorKey.toString('base64'),
  };
}

// ---------- 許可ホスト一覧API（index.htmlのホーム画面用） ----------
app.get('/api/allowed-hosts', (req, res) => {
  res.json({ hosts: ALLOWED_HOSTS });
});

// ---------- ページ取得API ----------
app.get('/api/page', async (req, res) => {
  const target = req.query.url;

  if (!target || !/^https?:\/\//i.test(target)) {
    return res.status(400).json({ error: 'urlクエリが不正です（http/httpsで始まる必要があります）' });
  }

  let parsed;
  try {
    parsed = new URL(target);
  } catch (e) {
    return res.status(400).json({ error: 'URLの形式が不正です' });
  }

  if (!ALLOWED_HOSTS.includes(parsed.hostname)) {
    return res.status(403).json({ error: `許可されていないホストです（許可: ${ALLOWED_HOSTS.join(', ')}）` });
  }

  try {
    const response = await fetch(target, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MiniBrowserProxy/1.0)' },
    });
    const contentType = response.headers.get('content-type') || '';

    if (!contentType.includes('text/html')) {
      // HTML以外（画像・CSS・JSなど）はそのまま中継
      const buf = await response.buffer();
      res.set('content-type', contentType);
      return res.send(buf);
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // 相対パスの解決先を元サイトにするbaseタグを挿入
    $('head').prepend(`<base href="${parsed.origin}${parsed.pathname}">`);

    // リンククリックを親フレーム（embed.html）に通知するスクリプトを注入
    $('body').append(`
      <script>
        document.addEventListener('click', function (e) {
          const a = e.target.closest('a[href]');
          if (!a) return;
          e.preventDefault();
          try {
            const resolved = new URL(a.getAttribute('href'), document.baseURI).href;
            window.parent.postMessage({ type: 'navigate', url: resolved }, '*');
          } catch (err) {}
        });
      </script>
    `);

    const encrypted = multiEncrypt($.html());
    res.json(encrypted);
  } catch (err) {
    res.status(500).json({ error: '取得に失敗しました: ' + err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
