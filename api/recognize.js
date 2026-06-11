// Vercel サーバーレス関数：写真から商品名候補を返す（Phase 2 MVP）
//
// セキュリティ:
//   - ANTHROPIC_API_KEY は Vercel の環境変数からのみ読み込む（ブラウザには絶対に出さない）。
//   - この関数URLは公開される。Anthropic 側の Spend limit を前提に運用すること。
//   - 本格運用時は共有トークン等の簡易認証を追加する（ROADMAP の Phase 2 残課題）。
//
// 返却: { productName, category, confidence } もしくは { error }

import Anthropic from '@anthropic-ai/sdk';

// Vercel: 関数の最大実行時間（秒）。Vision 呼び出しに余裕を持たせる（既定の短い上限で切られないように）
export const config = { maxDuration: 30 };

// 不用品回収で扱う主なカテゴリ（後で増やせる）
const CATEGORIES = [
  'スマートフォン', 'タブレット', 'ノートPC', 'デスクトップPC',
  'カメラ', '腕時計', 'ゲーム機', 'オーディオ', '家電', 'その他'
];

// 構造化出力で返答の形を固定する
const SCHEMA = {
  type: 'object',
  properties: {
    productName: {
      type: 'string',
      description: '出品タイトルに使える商品名。メーカー名と機種/型番を含める（例: Apple iPhone 13 128GB / CASIO G-SHOCK DW-5600）。'
    },
    category: { type: 'string', enum: CATEGORIES },
    confidence: {
      type: 'number',
      description: '推定の確信度 0.0〜1.0。型番まで読み取れたら高め、判別が難しければ低め。'
    }
  },
  required: ['productName', 'category', 'confidence'],
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

    const client = new Anthropic(); // ANTHROPIC_API_KEY を環境変数から自動読込

    const response = await client.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 300, // 小さく絞ってコスト抑制
      output_config: { format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          {
            type: 'text',
            text: 'この写真には、ゴミ袋・家具・段ボール・周辺の雑多な物など複数の物が写っている可能性があります。'
              + ' それら背景・周辺物は無視し、画像の中央に最も大きく写っている主要な商品「1点だけ」を特定してください。'
              + ' 複数の商品が写っている場合も、最も中央で大きい1点のみを対象にします。'
              + ' フリマ/eBay 出品を想定し、productName はメーカー名と機種/型番を含む簡潔な商品名（日本語可）。'
              + ' 型番まで確証が持てない場合や、中央の対象がはっきり判別できない場合は confidence を低くしてください。'
          }
        ]
      }]
    });

    if (response.stop_reason === 'refusal') {
      res.status(200).json({ error: 'この画像は認識できませんでした。別の角度で撮り直してください。' });
      return;
    }

    const textBlock = response.content.find(b => b.type === 'text');
    if (!textBlock) {
      res.status(502).json({ error: 'AI 応答の解析に失敗しました。' });
      return;
    }

    const data = JSON.parse(textBlock.text);
    res.status(200).json({
      productName: String(data.productName || ''),
      category: String(data.category || 'その他'),
      confidence: Number(data.confidence) || 0
    });
  } catch (err) {
    const msg = err && err.message ? err.message : 'unknown';
    res.status(500).json({ error: 'サーバーエラー: ' + msg });
  }
}
