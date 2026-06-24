// Vercel サーバーレス関数: JAN(EAN) → Keepa 商品情報
// 返却: { title, asin, category, newPrice, salesRank, monthlySold, tokensLeft } | { error }
// セキュリティ: KEEPA_API_KEY は Vercel 環境変数のみ。ブラウザには出さない
// 中古価格は取得・返却しない（csv[2]以降の中古インデックスは無視）

export const config = { maxDuration: 15 };

// Keepa csv 形式: [keepaMinute1, value1, keepaMinute2, value2, ...]
// 末尾ペアが最新。-1 = 在庫なし / 取り扱いなし → null として扱う
// JPY は整数通貨のため実円価格をそのまま格納（÷100 不要）
function latestFromCsv(arr) {
  if (!Array.isArray(arr) || arr.length < 2) return null;
  for (let i = arr.length - 1; i >= 1; i -= 2) {
    if (arr[i] > 0) return arr[i];  // JPY: ÷100 しない
  }
  return null;
}

export default async function handler(req, res) {
  const jan = (req.query.jan || '').replace(/[^0-9]/g, '');
  if (!jan || (jan.length !== 8 && jan.length !== 13)) {
    return res.status(400).json({ error: 'JANコードが不正です（8桁または13桁）' });
  }

  const key = process.env.KEEPA_API_KEY;
  if (!key) {
    console.error('[keepa] KEEPA_API_KEY が未設定');
    return res.status(500).json({ error: 'APIキー未設定' });
  }

  let data;
  try {
    const url = 'https://api.keepa.com/product'
      + '?key=' + encodeURIComponent(key)
      + '&domain=5'     // Amazon.co.jp
      + '&code=' + jan  // EAN/JAN コード
      + '&stats=90';    // 月間販売数(monthlySold)取得に必要
    const r = await fetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    data = await r.json();
  } catch (e) {
    console.error('[keepa] fetch error:', e && e.message);
    return res.status(502).json({ error: 'Keepa接続エラー: ' + (e && e.message || '') });
  }

  if (data.error) {
    console.error('[keepa] API error:', data.error.type, data.error.message);
    return res.status(502).json({ error: 'Keepa APIエラー: ' + (data.error.message || '') });
  }

  const products = data.products;
  if (!products || products.length === 0) {
    return res.status(404).json({ error: 'not found' });
  }

  const p = products[0];

  // 新品最安値: Amazon直売(csv[0])・MP新品最安値(csv[1])・BuyBox(csv[18]) の中で最小の有効値
  // 中古(csv[2]〜csv[16], csv[17]) は取得しない
  const prices = [
    latestFromCsv(p.csv && p.csv[0]),    // Amazon.co.jp 直売
    latestFromCsv(p.csv && p.csv[1]),    // マーケットプレイス新品最安値
    latestFromCsv(p.csv && p.csv[18])    // カートボックス（Buy Box）価格
  ].filter(function(v) { return v != null && v > 0; });
  const newPrice = prices.length > 0 ? Math.min.apply(null, prices) : null;

  // Amazonカテゴリ: categoryTree 優先（日本語パンくず）、なければ productGroup
  let category = null;
  if (p.categoryTree && p.categoryTree.length > 0) {
    category = p.categoryTree.slice(0, 2).map(function(c) { return c.name; }).join(' > ');
  } else if (p.productGroup) {
    category = p.productGroup;
  }

  // 月間販売数: product 直下の monthlySold が正しい位置（stats オブジェクトではない）
  // -1 は「推定不可」なので null 扱い
  const rawMonthlySold = p.monthlySold != null ? p.monthlySold
    : (p.stats && p.stats.monthlySold != null ? p.stats.monthlySold : null);
  const monthlySold = (rawMonthlySold != null && rawMonthlySold >= 0) ? rawMonthlySold : null;

  // デバッグログ（Vercel Functions ログで確認。本番確認後に削除可）
  console.log('[keepa] jan=' + jan
    + ' asin=' + p.asin
    + ' tokensConsumed=' + data.tokensConsumed
    + ' p.monthlySold=' + p.monthlySold
    + ' p.stats.monthlySold=' + (p.stats && p.stats.monthlySold)
    + ' newPrice(raw csv[0]末尾)=' + (p.csv && p.csv[0] && p.csv[0][p.csv[0].length - 1])
    + ' newPrice(computed)=' + newPrice
  );

  return res.status(200).json({
    title:       p.title || '',
    asin:        p.asin  || '',
    category:    category,
    newPrice:    newPrice,
    salesRank:   (p.salesRankReference > 0) ? p.salesRankReference : null,
    monthlySold: monthlySold,
    tokensLeft:  data.tokensLeft   // デバッグ用（フロントでは表示しない）
  });
}
