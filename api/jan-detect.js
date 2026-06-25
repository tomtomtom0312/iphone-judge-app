// バーコード（EAN-13/JAN/ISBN）を写真から読み取る軽量エンドポイント
// POST body: { image: "data:image/jpeg;base64,..." }
// Response: { jan: "4521329431932" } | { jan: "" } | { error: "..." }
// セキュリティ: ANTHROPIC_API_KEY は Vercel 環境変数のみ。ブラウザには出さない。

import Anthropic from '@anthropic-ai/sdk';

export const config = { maxDuration: 15 };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST のみ対応' });
  }

  const image = (req.body || {}).image;
  if (!image || typeof image !== 'string') {
    return res.status(400).json({ error: 'image が必要です' });
  }

  const m = image.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!m) {
    return res.status(400).json({ error: '画像形式が不正です' });
  }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    console.error('[jan-detect] ANTHROPIC_API_KEY 未設定');
    return res.status(500).json({ error: 'APIキー未設定' });
  }

  try {
    const client = new Anthropic();
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 30,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: m[1], data: m[2] }
          },
          {
            type: 'text',
            text: 'この画像に写っているバーコード（JAN/EAN-13/ISBN/EAN-8）を1つ読み取り、'
              + '13桁または8桁の数字だけを返してください。'
              + 'バーコードが明確に読み取れない場合は空文字を返してください。'
              + '数字以外の文字は一切出力しないでください。推測・創作は厳禁です。'
          }
        ]
      }]
    });

    const raw = String(response.content[0]?.text || '').replace(/[^0-9]/g, '');
    console.log('[jan-detect] raw="' + raw + '"');
    return res.status(200).json({ jan: raw });
  } catch (e) {
    console.error('[jan-detect] error:', e && e.message);
    return res.status(500).json({ error: String(e && e.message || 'unknown') });
  }
}
