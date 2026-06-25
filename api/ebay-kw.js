// POST { title, category, attrs } → { searchKw }
// JAN/Keepa/OpenBD で取得した日本語商品名から eBay 向け英語検索キーワードを生成する。
//
// セキュリティ: ANTHROPIC_API_KEY は Vercel 環境変数のみ。ブラウザには出さない。
// コスト: claude-haiku（最安）を使用。max_tokens=80 で短い応答のみ。

import Anthropic from '@anthropic-ai/sdk';

export const config = { maxDuration: 15 };

// カテゴリ別の生成ヒント（英語KWの方向性）
const HINTS = {
  book:                'Use English title or romaji. Add "Vol.N" for numbered volumes. Append "Japanese Manga" or "Japanese Light Novel".',
  trading_card_box:    'Use English brand (Pokemon/Yu-Gi-Oh/Weiss Schwarz) + set name in English + "Booster Box". Include product code if visible.',
  trading_card_single: 'Use English card/character name + "Japanese" + card number + rarity (CHR/SAR/SR/RR). Example: Pikachu Japanese Pokemon Card 073/071 CHR',
  figure:              'Use English character name + series + "Figure" + maker/scale if known.',
  game_software:       'Use English game title + platform + "Japanese Version".',
  game_console:        'Use English console name + "Japan".',
  beauty:              'Use brand + product name + size or SPF + "Japanese cosmetics".',
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { title, category, attrs } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title required' });

  const hint = HINTS[category] || 'Use English or romaji. Keep it short and searchable on eBay.';
  const attrText = attrs && Object.keys(attrs).length
    ? Object.entries(attrs).filter(([, v]) => v).map(([k, v]) => k + ': ' + v).join(', ')
    : '';

  const prompt = 'Generate an eBay search keyword for this Japanese product.\n'
    + 'Title: ' + title + '\n'
    + 'Category: ' + (category || 'unknown') + '\n'
    + (attrText ? 'Details: ' + attrText + '\n' : '')
    + '\nGuidance: ' + hint
    + '\nRules: English only (romaji if English unknown). Max 60 characters. Output the keyword only, nothing else.';

  try {
    const client = new Anthropic();
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 80,
      messages: [{ role: 'user', content: prompt }]
    });
    const kw = String(response.content[0]?.text || '').trim().replace(/^["'`]|["'`]$/g, '');
    console.log('[ebay-kw] cat=' + category + ' -> "' + kw + '"');
    return res.status(200).json({ searchKw: kw });
  } catch (e) {
    console.error('[ebay-kw] error:', e && e.message);
    return res.status(500).json({ error: String(e?.message || 'unknown') });
  }
}
