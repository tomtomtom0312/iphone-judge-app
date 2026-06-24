// Vercel サーバーレス関数: JAN(EAN) または ASIN → Keepa 商品情報
// 受付: ?jan={8/13桁} または ?asin={10桁英数字}
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
  const jan  = (req.query.jan  || '').replace(/[^0-9]/g, '');
  const asin = (req.query.asin || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
  const validJan  = jan.length === 8 || jan.length === 13;
  const validAsin = /^[A-Z0-9]{10}$/.test(asin);
  if (!validJan && !validAsin) {
    return res.status(400).json({ error: 'jan（8/13桁）またはasin（10桁英数字）が必要です' });
  }

  const key = process.env.KEEPA_API_KEY;
  if (!key) {
    console.error('[keepa] KEEPA_API_KEY が未設定');
    return res.status(500).json({ error: 'APIキー未設定' });
  }

  let data;
  try {
    const lookupParam = validJan
      ? ('&code=' + jan)    // JAN/EAN コードで検索
      : ('&asin=' + asin);  // ASIN で検索（キーワード検索結果から渡す場合）
    const url = 'https://api.keepa.com/product'
      + '?key=' + encodeURIComponent(key)
      + '&domain=5'         // Amazon.co.jp
      + lookupParam
      + '&stats=90';        // 月間販売数取得に必要
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

  // 売れ筋ランキング: csv[3] = Sales Rank 履歴から最新値を取得
  // （p.salesRankReference はカテゴリIDであり順位数値ではないため使わない）
  const salesRank = latestFromCsv(p.csv && p.csv[3]);

  // 月間販売数（優先1）: p.monthlySold = Keepa 推計の月販個数（Keepa画面の黄色線に相当）
  // -1 は未推計（商品種別・データ不足）→ null
  const monthlySoldUnits = (typeof p.monthlySold === 'number' && p.monthlySold >= 0)
    ? p.monthlySold : null;

  // 月間販売数（優先2）: stats.salesRankDrops30 = 30日間 BSR 下降回数（ドロップ/月）
  // Keepa UI で「N ドロップ/月」と表示される値。-1 は未計測 → null
  const dropsPerMonth = (p.stats && typeof p.stats.salesRankDrops30 === 'number' && p.stats.salesRankDrops30 >= 0)
    ? p.stats.salesRankDrops30 : null;

  // monthlySoldType: 'units'（個数）/ 'drops'（ドロップ）/ null（未取得）
  const monthlySold     = monthlySoldUnits !== null ? monthlySoldUnits : dropsPerMonth;
  const monthlySoldType = monthlySoldUnits !== null ? 'units'
    : dropsPerMonth !== null ? 'drops' : null;

  // デバッグログ（Vercel Functions ログで確認。問題解消後に削除可）
  console.log('[keepa] basic'
    + ' lookup=' + (validJan ? 'jan:' + jan : 'asin:' + asin)
    + ' result_asin=' + p.asin
    + ' newPrice=' + newPrice
    + ' salesRank=' + salesRank
    + ' p.monthlySold=' + p.monthlySold
    + ' monthlySoldType=' + monthlySoldType
    + ' tokensLeft=' + data.tokensLeft
  );
  console.log('[keepa] csv_last'
    + ' csv[0]=' + (p.csv && p.csv[0] && p.csv[0][p.csv[0].length - 1])
    + ' csv[1]=' + (p.csv && p.csv[1] && p.csv[1][p.csv[1].length - 1])
    + ' csv[3]=' + (p.csv && p.csv[3] && p.csv[3][p.csv[3].length - 1])
  );
  // stats の全キーと salesRankDrops 関連フィールドを全て出力
  console.log('[keepa] stats_keys=' + (p.stats ? Object.keys(p.stats).join(',') : 'null'));
  if (p.stats) {
    var dropKeys = Object.keys(p.stats).filter(function(k) {
      return k.toLowerCase().indexOf('drop') !== -1 || k.toLowerCase().indexOf('sold') !== -1 || k.toLowerCase().indexOf('sales') !== -1;
    });
    console.log('[keepa] stats_drop_related=' + JSON.stringify(dropKeys.reduce(function(acc, k) { acc[k] = p.stats[k]; return acc; }, {})));
  }

  return res.status(200).json({
    title:          p.title || '',
    asin:           p.asin  || '',
    category:       category,
    newPrice:       newPrice,
    salesRank:      salesRank,
    monthlySold:    monthlySold,
    monthlySoldType: monthlySoldType,  // 'units' | 'drops' | null
    tokensLeft:     data.tokensLeft
  });
}
