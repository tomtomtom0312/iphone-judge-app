# 引き継ぎメモ（直近作業用）

最終更新: 2026-06-12

## 現状
越境販売 判断アプリ。単一 `index.html`（静的・サーバー不要・データは localStorage）。
Phase 1「静的 eBay 版の仕上げ」を進行中。長期計画は **ROADMAP.md が正本**。

## Phase 1 進捗
- ✅ #1 状態選択（新品・未使用品を追加）
- ✅ #2 利益率判定（利益額＋利益率の複合）
- ✅ #3 送料編集（⚙️設定で発送方法ごとの送料を編集・販路ごと保存・初期値に戻すボタン付き）
- ✅ #4 CSV 出力（履歴を CSV 書き出し。UTF-8 BOM付き・CRLF・カンマ自動クォート）
- 🟡 #5 現場テスト 実施中

## 現場テスト フィードバック（2026-06-11）と対応
- 👍 計算が早い（静的・端末内計算が好評）
- 💡 写真から商品名を推定したい → **Phase 2（AI認識）への需要を確認**（未着手）
- ✅ 判定を5段階化（★積極推奨/推奨/要検討/低利益/見送り）＋判定理由の自動表示を実装
- ✅ 履歴タップで詳細モーダル（写真/判定/売価/利益/利益率/判定理由/日時）を実装
- ✅ 履歴編集（詳細→編集ボタン）：商品名/状態/売価/原価/発送方法/送料を編集→利益・判定を再計算。キャンセルで戻る
- レイアウト改善：想定売価を写真直下に特大表示、商品名/メモと一体化（AI自動入力を見据え）

## データ構造メモ（編集の再計算用）
履歴エントリに rate/feeRate/thOk/thNg/marginOk/marginNg を保存（追加フィールド・非破壊）。
編集時はこれで正確に再計算。旧エントリに無ければ販路の現設定でフォールバック（getSettings）。

## Phase 2 MVP（AI商品認識）— コード実装済み・未デプロイ
構成: 静的フロント + Vercel サーバーレス関数。前提はモバイル回線あり（ケースA）。
- ✅ `api/recognize.js`：写真→Claude Vision(`claude-opus-4-8`)→構造化出力で `{productName, category, storage, color, condition, estimatedRank, confidence, notes}` を返す。`max_tokens:400`。フロントは productName＋容量・色を商品名欄へ、estimatedRank(S/A/B/C/D/ジャンク)を状態セレクトへマップ、condition/notes をステータス表示
- ✅ `package.json`（`@anthropic-ai/sdk`）/ `.gitignore` 追加
- ✅ フロント：写真撮影後「🤖 AIで商品名を提案」→ 商品名/メモ欄に自動入力＋信頼度バッジ。人が上書き可
- APIキーは関数の環境変数 `ANTHROPIC_API_KEY` のみ（フロントに一切無し）。AI用は768px・履歴用は400px
- ✅ 中央の主役だけ認識：プロンプトで背景/周辺物を無視・中央の最大1点に限定。撮影案内＋プレビューにガイド枠（トリミングはPhase2.5+）
- ✅ タイムアウト30秒（フロントAbortController / Vercel maxDuration）。ローカルの501/404は「未デプロイ」表示
- まだ未実装: eBay相場取得 / 関数URLの簡易認証（共有トークン） / 画像トリミング(Phase2.5+)

## Phase 2 追加（2026-06-12）— 連続撮影＋カテゴリ別認識（コード実装済み・未デプロイ）
- ✅ 認識スキーマをカテゴリ別に拡張: `category` enum = `iPhone/trading_card_single/trading_card_box/figure/other`。`brand/series/setName/cardName/boxName/storage/color/condition/estimatedRank/notes` を返す（無関係項目は空文字）。`max_tokens:400`。任意 `categoryHint` でカテゴリをバイアス可。
- ✅ 連続撮影モード: 撮影カードに「単品判定／連続撮影」トグル。連続モードは1枚ごとにAI認識→**ドラフト履歴へ自動保存**（売価0=未計算）。撮影枚数・直近認識をステータス表示。
- ✅ 履歴エントリに `category/estimatedRank/ai/draft` を追加（非破壊・旧データ互換）。`draft` は `recompute` が売価≤0で立て、編集で売価を入れると利益確定。
- ✅ 履歴一覧: 撮影日時/カテゴリ/状態ランク/商品名/利益＋「編集」「削除」ボタン。ドラフトは利益「—」表示。
- ✅ 編集モーダルにカテゴリ・状態ランクを追加。売価/原価/送料/メモを後入力→利益再計算。CSVにカテゴリ・ランク列追加。
- 検証: `node --check`（両ファイル）＋ DOMシムで全スクリプト読込＆ recompute/ドラフト遷移の単体テスト（17件PASS）。実機・AI動作はデプロイ後に確認。

### 次にやること（デプロイ＝ユーザー作業）
1. Anthropic APIキー取得＋**Spend limit 設定**
2. GitHub に push → Vercel 連携 → 環境変数 `ANTHROPIC_API_KEY` 登録 → デプロイ
3. iPhone（モバイル回線）で撮影→提案→上書きを実機確認
（ローカル `python3 -m http.server` では `/api` が無く AI は動かない。UIのみ確認可）

## 動作確認
`python3 -m http.server 8000` → iPhone Safari で `http://192.168.1.2:8000`（AI以外）

## 運用ルール
長期計画＝ROADMAP.md、直近作業＝本メモ。大きな方針変更時は ROADMAP.md も更新する。
