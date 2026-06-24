// Vercel サーバーレス関数: キーワード → Keepa 商品候補検索
// 返却: { results: [{asin, title, category}], total, tokensLeft } | { error }
// セキュリティ: KEEPA_API_KEY は Vercel 環境変数のみ。ブラウザには出さない
// 用途: AI認識で得た商品名からKeepa候補を取得（JANなし商品のAmazon照会補助）

export const config = { maxDuration: 15 };

export default async function handler(req, res) {
  const q = (req.query.q || '').trim();
  if (!q) {
    return res.status(400).json({ error: '検索ワード（q）が必要です' });
  }

  const key = process.env.KEEPA_API_KEY;
  if (!key) {
    console.error('[keepa-search] KEEPA_API_KEY が未設定');
    return res.status(500).json({ error: 'APIキー未設定' });
  }

  let data;
  try {
    // Keepa キーワード検索。type=product で商品を対象にする
    const url = 'https://api.keepa.com/search'
      + '?key='    + encodeURIComponent(key)
      + '&domain=5'         // Amazon.co.jp
      + '&type=product'     // 商品検索（カテゴリ/ブランド検索ではない）
      + '&term='   + encodeURIComponent(q);
    const r = await fetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    data = await r.json();
  } catch (e) {
    console.error('[keepa-search] fetch error:', e && e.message);
    return res.status(502).json({ error: 'Keepa接続エラー: ' + (e && e.message || '') });
  }

  if (data.error) {
    console.error('[keepa-search] API error:', JSON.stringify(data.error));
    return res.status(502).json({
      error: 'Keepa APIエラー: ' + (data.error.message || JSON.stringify(data.error))
    });
  }

  const products = Array.isArray(data.products) ? data.products : [];

  // 上位5件を返す。カテゴリは productGroup（検索結果は categoryTree を持たない）
  const results = products.slice(0, 5).map(p => ({
    asin:     p.asin        || '',
    title:    p.title       || '',
    category: p.productGroup || ''
  }));

  console.log('[keepa-search] q="' + q + '" hits=' + products.length
    + ' returned=' + results.length + ' tokensLeft=' + data.tokensLeft);

  return res.status(200).json({
    results,
    total:     products.length,
    tokensLeft: data.tokensLeft
  });
}
