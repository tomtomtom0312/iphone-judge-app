// Vercel サーバーレス関数：写真から商品名候補を返す（Phase 2 MVP）
//
// セキュリティ:
//   - ANTHROPIC_API_KEY は Vercel の環境変数からのみ読み込む（ブラウザには絶対に出さない）。
//   - この関数URLは公開される。Anthropic 側の Spend limit を前提に運用すること。
//   - 本格運用時は共有トークン等の簡易認証を追加する（ROADMAP の Phase 2 残課題）。
//
// 返却: { productName, category, brand, series, setName, cardName, boxName,
//        storage, color, condition, estimatedRank, confidence, notes } もしくは { error }

import Anthropic from '@anthropic-ai/sdk';

// Vercel: 関数の最大実行時間（秒）。Vision 呼び出しに余裕を持たせる（既定の短い上限で切られないように）
export const config = { maxDuration: 30 };

// 取り扱いカテゴリ（機械値）。フロント CATEGORIES のキーと一致させること。
const CATEGORY_VALUES = ['iPhone', 'trading_card_single', 'trading_card_box', 'figure', 'book', 'other'];

// 状態ランク（外観グレード）。フロントの状態セレクトへマッピングして使う
const RANKS = ['S', 'A', 'B', 'C', 'D', 'ジャンク'];

// 構造化出力で返答の形を固定する。カテゴリ別の項目を1スキーマに集約し、
// 関係しない項目は空文字を返させる（例: iPhone のとき cardName は空）。
const SCHEMA = {
  type: 'object',
  properties: {
    productName: {
      type: 'string',
      description: '出品タイトルに使える簡潔な商品名（日本語可）。iPhoneなら機種名、トレカ単品ならカード名、BOXならBOX名、フィギュアなら作品＋キャラ名、本・漫画なら検索しやすいタイトル＋レーベル/文庫名/出版社/シリーズ名（例: 超かぐや姫! ファミ通文庫。巻数が明確に見える場合は「タイトル ◯巻」）など。'
    },
    category: {
      type: 'string',
      enum: CATEGORY_VALUES,
      description: 'iPhone=Apple iPhone本体 / trading_card_single=トレカ1枚（スリーブ・1枚撮り・PSA鑑定品）/ trading_card_box=トレカ・カードゲームの未開封BOX・パック箱・シュリンク付き / figure=フィギュア・プライズ・プラモ完成品・ガチャ / book=本・漫画・雑誌・文庫・単行本・書籍・写真集 / other=ゲーム機・ゲームソフト・スニーカー・アパレル・家電・ホビー・その他すべて。'
    },
    brand: {
      type: 'string',
      description: 'ブランド/メーカー/IP（例: Apple, ポケモン, BANDAI, 鬼滅の刃, 一番くじ）。不明なら空文字。'
    },
    series: {
      type: 'string',
      description: 'シリーズ/作品名（例: ワンピース, ポケモンカード, ドラゴンボール）。不明なら空文字。'
    },
    setName: {
      type: 'string',
      description: 'トレカの弾/セット名（例: 強化拡張パック 黒炎の支配者）。トレカ以外や不明なら空文字。'
    },
    cardName: {
      type: 'string',
      description: 'トレカ単品のカード名（例: リザードンex SAR）。trading_card_single 以外や不明なら空文字。'
    },
    boxName: {
      type: 'string',
      description: 'トレカBOXの商品名（例: スカーレットex BOX）。trading_card_box 以外や不明なら空文字。'
    },
    obi: {
      type: 'string',
      enum: ['あり', 'なし', '不明'],
      description: '本・漫画の帯の有無。写真で帯が見えれば「あり」、明らかに帯が無いと判断できる場合だけ「なし」、判断できない/本以外なら「不明」。'
    },
    jan: {
      type: 'string',
      description: '画像内に JANコード/バーコード/ISBN が明確に読み取れる場合のみ、その数字（ハイフン・スペース無しの数字のみ）。読み取れない/不確実なら空文字。推測で創作しない。商品名やカテゴリの推定には使わない。'
    },
    storage: {
      type: 'string',
      description: 'iPhoneのストレージ容量（例: 256GB）。読み取れなければ、またはiPhone以外なら空文字。'
    },
    color: {
      type: 'string',
      description: 'iPhoneの本体色（例: Graphite）。読み取れなければ、またはiPhone以外なら空文字。'
    },
    condition: {
      type: 'string',
      description: '写真から実際に見える外観状態の説明（例: 画面割れなし背面小傷あり / 未開封シュリンク有 / 箱に潰れ）。憶測は書かず見える範囲のみ。'
    },
    estimatedRank: {
      type: 'string',
      enum: RANKS,
      description: '外観の状態ランク。S=新品同様・未開封 / A=美品 / B=良品（目立たない小傷）/ C=難あり（目立つ傷・割れ・箱潰れ）/ D=ジャンク相当 / ジャンク=破損・動作不可の疑い。'
    },
    confidence: {
      type: 'number',
      description: '推定の確信度 0.0〜1.0。型番/カード名まで読み取れたら高め、判別が難しければ低め。'
    },
    notes: {
      type: 'string',
      description: '確証が持てない懸念点・追加で確認したい点（例: カメラ周りに傷の可能性 / 偽物の可能性）。無ければ空文字。'
    },
    searchKw: {
      type: 'string',
      description: 'メルカリ・eBay・スニダン向けの検索キーワード（短め）。英語名・型番が分かる場合は英語優先。'
        + 'トレカBOXは「ブランド英語名 + セット英語名 + Booster Box」（例: Pokemon Mega Dream ex Booster Box / Yu-Gi-Oh Blazing Dominion Box）。'
        + 'トレカ単品は「ブランド + カード名 + レアリティ」（例: Pokemon Charizard ex SAR）。'
        + '本・漫画は英語タイトル+巻数+edition（例: ONE PIECE Vol.66 manga / Demon Slayer Vol.1 first edition）、英語不明なら日本語タイトル。'
        + 'フィギュアは「作品名 + キャラ名 + メーカー」（英語名があれば英語）。'
        + 'スニーカーは「ブランド + モデル名 + カラー/サイズ」（例: Nike Air Jordan 1 Retro High OG）。'
        + 'ゲームは「タイトル + 機種 + 地域」（例: Pokemon Scarlet Nintendo Switch JP）。'
        + '英語名が全く不明なら productName をそのまま使う。60文字以内目安。空文字可。'
    }
  },
  required: [
    'productName', 'category', 'brand', 'series', 'setName', 'cardName', 'boxName',
    'obi', 'jan', 'storage', 'color', 'condition', 'estimatedRank', 'confidence', 'notes', 'searchKw'
  ],
  additionalProperties: false
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST のみ対応しています。' });
    return;
  }

  try {
    const body = req.body || {};
    const image = body.image;
    if (!image || typeof image !== 'string') {
      res.status(400).json({ error: '画像データがありません。' });
      return;
    }

    // dataURL を media_type と base64 に分解
    const m = image.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!m) {
      res.status(400).json({ error: '画像形式が不正です。' });
      return;
    }
    const mediaType = m[1];
    const base64 = m[2];

    // フロントからの任意カテゴリヒント（連続撮影で同種をまとめ撮りするとき用）。
    // 既知の値のときだけプロンプトに反映する。矛盾する画像なら無視させる。
    const hint = CATEGORY_VALUES.indexOf(String(body.categoryHint || '')) >= 0
      ? String(body.categoryHint)
      : '';

    const client = new Anthropic(); // ANTHROPIC_API_KEY を環境変数から自動読込

    // tool_choice で特定ツールを強制呼び出し → 全 SDK バージョンで安定動作するJSON出力方式
    const response = await client.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 1024,
      tools: [{
        name: 'recognize_product',
        description: '写真から判断した商品情報を報告する。画像内で最も大きく写っている主要商品1点を特定し、すべてのフィールドを埋めること。',
        input_schema: SCHEMA
      }],
      tool_choice: { type: 'tool', name: 'recognize_product' },
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          {
            type: 'text',
            text: 'この写真には、背景・周辺の雑多な物が一緒に写っている可能性があります。'
              + ' それら背景・周辺物は無視し、画像の中央に最も大きく写っている主要な商品「1点だけ」を特定してください。'
              + ' フリマ/eBay 出品を想定し、まず category を判定し、そのカテゴリに関係する項目だけを埋めてください（関係しない項目は空文字）。'
              + ' トレカ単品なら cardName/series/setName、トレカBOXなら boxName/series/setName、iPhoneなら storage/color を優先的に読み取ります。'
              + ' 文庫・漫画・単行本・雑誌・書籍と判断できる画像は category=book とします。'
              + ' 本・漫画の productName は検索しやすい商品名にし、表紙のタイトルに加え、レーベル/文庫名/出版社/シリーズ名が見える場合はそれも含めます（例: 超かぐや姫! ファミ通文庫。巻数が明確に見える場合は「タイトル ◯巻」）。'
              + ' series にはレーベル/文庫名/出版社/シリーズ名（例: ファミ通文庫）を入れます。'
              + ' obi は写真で帯が見えていれば「あり」、明らかに帯が無いと判断できる場合だけ「なし」、判断できない場合は「不明」にします。'
              + ' 本・漫画では condition に表紙の傷・汚れ・折れ・日焼け・帯の傷みなど写真から見える範囲だけを簡潔に書き、裏面・小口・背表紙が写っていない場合は「裏面/背表紙は未確認」のように確認できない旨も記します。'
              + ' 初版/重版・特典の有無は写真だけで断定できないため、明確に分かる場合のみ言及し、迷う場合は触れないでください（憶測で断定しない）。'
              + ' 画像内にJANコード/バーコード/ISBNが明確に読み取れる場合のみ jan にその数字（数字のみ）を入れ、読めない/不確実なら空文字にします（推測で創作しない）。jan は商品名やカテゴリの判定には使いません。'
              + ' productName はそのカテゴリで出品タイトルに使える日本語の簡潔な商品名にします（例: ポケモンカードゲーム MEGA ハイクラスパック MEGAドリームex BOX / 遊戯王OCG BLAZING DOMINION BOX）。'
              + ' searchKw はメルカリ・eBay・スニダン検索向けの短いキーワードで、英語名・型番が分かる場合は英語を優先します（例: Pokemon Mega Dream ex Booster Box / Yu-Gi-Oh Blazing Dominion Box / ONE PIECE Vol.66 manga）。英語名が不明なら productName をそのまま入れてください。'
              + ' condition は写真から実際に見える外観状態のみを記述し（割れ・傷・汚れ・未開封か否か）、見えない部分を憶測で断定しないでください。'
              + ' estimatedRank は外観から推定した状態ランク（S/A/B/C/D/ジャンク）です。'
              + ' 確証が持てない懸念点（例: 角度的に確認できない傷、真贋の不安）は notes に書いてください。'
              + ' 型番/カード名まで確証が持てない場合や、中央の対象がはっきり判別できない場合は confidence を低くしてください。'
              + (hint ? ' なお、ユーザーはこの商品のカテゴリを「' + hint + '」と申告しています。画像と明らかに矛盾しない限り、その category を採用してください。' : '')
          }
        ]
      }]
    });

    // tool_choice: { type: 'tool' } で強制呼び出し → tool_use ブロックが必ず返る
    const toolBlock = response.content.find(b => b.type === 'tool_use' && b.name === 'recognize_product');
    if (!toolBlock || !toolBlock.input) {
      const stopReason = response.stop_reason || 'unknown';
      res.status(502).json({ error: 'AI 応答の解析に失敗しました。（stop_reason=' + stopReason + '）' });
      return;
    }

    const data = toolBlock.input; // 既にパース済み JS オブジェクト（JSON.parse 不要）
    const category = CATEGORY_VALUES.indexOf(String(data.category)) >= 0
      ? String(data.category)
      : 'other';
    res.status(200).json({
      productName: String(data.productName || ''),
      category: category,
      brand: String(data.brand || ''),
      series: String(data.series || ''),
      setName: String(data.setName || ''),
      cardName: String(data.cardName || ''),
      boxName: String(data.boxName || ''),
      obi: (data.obi === 'あり' || data.obi === 'なし') ? data.obi : '', // あり/なし が明確な場合のみ。不明/未判定は空＝フロントで「不明」
      jan: String(data.jan || '').replace(/[^0-9]/g, ''), // 数字のみ。桁の妥当性はフロントで判定
      storage: String(data.storage || ''),
      color: String(data.color || ''),
      condition: String(data.condition || ''),
      estimatedRank: String(data.estimatedRank || ''),
      confidence: Number(data.confidence) || 0,
      notes: String(data.notes || ''),
      searchKw: String(data.searchKw || '')
    });
  } catch (err) {
    const msg = err && err.message ? err.message : 'unknown';
    res.status(500).json({ error: 'サーバーエラー: ' + msg });
  }
}
