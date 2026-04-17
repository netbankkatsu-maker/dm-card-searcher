const express = require('express');
const cheerio = require('cheerio');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

const GOOGLE_VISION_API_KEY = process.env.GOOGLE_VISION_API_KEY || 'AIzaSyBOi7ZL4q0WcydVX4hY60IIcVvJp49vQR4';

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '10mb' }));

// カード詳細キャッシュ（動的に蓄積）
const cardDetailCache = {};
const cardNameCache = {};

// ========================================
// 事前ビルドされたカードDB（data/cards.json）
// ========================================
let cardDb = {}; // id -> { id, name, imageUrl, effects, civilization, ... }
let cardIndex = []; // [{ id, name, nameLower, nameNoDot, thumbnail, imageUrl }]
let cardDbReady = false;

function loadPrebuiltDB() {
  const dbPath = path.join(__dirname, 'data', 'cards.json');
  if (!fs.existsSync(dbPath)) {
    console.log('事前ビルドDBなし。dmwikiから名前リストをロードします');
    return false;
  }
  try {
    const data = JSON.parse(fs.readFileSync(dbPath, 'utf-8'));
    cardDb = data;
    cardIndex = Object.values(data)
      .filter(c => c.name) // 名前のあるカードのみ
      .map(c => ({
        id: c.id,
        name: c.name,
        nameLower: c.name.toLowerCase(),
        nameNoDot: c.name.replace(/・/g, '').toLowerCase(),
        thumbnail: c.thumbnail || c.imageUrl || '',
      }));
    cardDbReady = true;
    console.log(`事前ビルドDBロード完了: ${cardIndex.length}枚のカード`);
    return true;
  } catch (e) {
    console.error('事前ビルドDBのロード失敗:', e.message);
    return false;
  }
}

// フォールバック: dmwiki.netからカード名だけロード
async function loadCardNamesFromWiki() {
  try {
    console.log('dmwikiからカード名DBを読み込み中...');
    const resp = await fetch('https://dmwiki.net/?cmd=list', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    const html = await resp.text();
    const $ = cheerio.load(html);

    const names = new Set();
    $('a').each((i, el) => {
      const text = $(el).text().trim();
      if (text.startsWith('《') && text.endsWith('》')) {
        const name = text.slice(1, -1);
        if (name.length >= 2 && name.length <= 50) names.add(name);
      }
    });

    cardIndex = [...names].map(name => ({
      id: null,
      name,
      nameLower: name.toLowerCase(),
      nameNoDot: name.replace(/・/g, '').toLowerCase(),
      thumbnail: '',
    }));
    cardDbReady = true;
    console.log(`dmwiki DB完了: ${cardIndex.length}枚のカード`);
  } catch (e) {
    console.error('dmwiki読み込み失敗:', e.message);
  }
}

// カードDBをあいまい検索（超高速・メモリ内）
function searchCardDB(keyword, limit = 30) {
  if (!cardDbReady) return [];
  const kw = keyword.toLowerCase();
  const kwNoDot = kw.replace(/・/g, '');

  const exact = [], startsWith = [], contains = [];

  for (const card of cardIndex) {
    if (card.nameLower === kw || card.nameNoDot === kwNoDot) {
      exact.push(card);
    } else if (card.nameLower.startsWith(kw) || card.nameNoDot.startsWith(kwNoDot)) {
      startsWith.push(card);
    } else if (card.nameLower.includes(kw) || card.nameNoDot.includes(kwNoDot)) {
      contains.push(card);
    }
  }

  return [...exact, ...startsWith, ...contains].slice(0, limit);
}

// 起動時にDB読み込み
if (!loadPrebuiltDB()) {
  loadCardNamesFromWiki();
}

// カード名を高速取得（キャッシュ付き）
async function getCardName(cardId) {
  if (cardNameCache[cardId]) return cardNameCache[cardId];
  try {
    const resp = await fetch(`https://dm.takaratomy.co.jp/card/detail/?id=${encodeURIComponent(cardId)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    const html = await resp.text();
    const $ = cheerio.load(html);
    const nameEl = $('h3.card-name').first();
    if (nameEl.length) {
      const clone = nameEl.clone();
      clone.find('.packname').remove();
      const name = clone.text().trim();
      cardNameCache[cardId] = name;
      return name;
    }
  } catch (e) {}
  return '';
}

// キーワードの表記ゆれを補正（中黒あり/なし、スペースなど）
function generateSearchVariants(keyword) {
  const variants = [keyword];

  // 中黒あり → 中黒なしも試す
  if (keyword.includes('・')) {
    variants.push(keyword.replace(/・/g, ''));
  }

  // 中黒なし → カタカナの切れ目に中黒を入れた全パターンを生成
  if (!keyword.includes('・') && /^[ァ-ヶー]+$/.test(keyword) && keyword.length >= 4) {
    // 全ての位置に中黒を入れたパターンを1つずつ試す
    for (let i = 2; i < keyword.length - 1; i++) {
      const withDot = keyword.slice(0, i) + '・' + keyword.slice(i);
      variants.push(withDot);
    }
  }

  // スペース → 中黒に変換
  if (keyword.includes(' ') || keyword.includes('　')) {
    variants.push(keyword.replace(/[\s　]+/g, '・'));
    variants.push(keyword.replace(/[\s　]+/g, ''));
  }

  return [...new Set(variants)];
}

// 公式サイトにPOSTで検索を実行する共通関数
async function searchCards(keyword) {
  const params = new URLSearchParams();
  params.append('keyword', keyword);
  params.append('keyword_type[]', 'card_name');
  params.append('keyword_type[]', 'card_ruby');
  params.append('keyword_type[]', 'card_text');
  params.append('samename', 'on');

  const response = await fetch('https://dm.takaratomy.co.jp/card/', {
    method: 'POST',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'ja,en;q=0.9',
    },
    body: params.toString(),
  });

  const html = await response.text();
  const $ = cheerio.load(html);
  const cards = [];

  $('a[href*="/card/detail/?id="]').each((i, el) => {
    const href = $(el).attr('href') || $(el).attr('data-href') || '';
    const idMatch = href.match(/id=([^&'"]+)/);
    if (idMatch) {
      const id = idMatch[1];
      const img = $(el).find('img');
      let thumbUrl = img.attr('src') || img.attr('data-src') || '';
      if (thumbUrl && !thumbUrl.startsWith('http')) {
        thumbUrl = `https://dm.takaratomy.co.jp${thumbUrl}`;
      }
      if (!cards.find(c => c.id === id)) {
        cards.push({ id, thumbnail: thumbUrl });
      }
    }
  });

  return cards;
}

// カード検索API（高速版：メモリDBで即座にID+名前+サムネを返す）
app.get('/api/search', async (req, res) => {
  try {
    const keyword = req.query.keyword || '';
    if (!keyword.trim()) {
      return res.json({ cards: [] });
    }

    // ステップ1: メモリ内DBで即座に検索（超高速）
    const dbResults = searchCardDB(keyword.trim());

    if (dbResults.length > 0) {
      // ID、名前、サムネ全部即座に返す
      const cards = dbResults.map(c => ({
        id: c.id,
        name: c.name,
        thumbnail: c.thumbnail,
      }));
      return res.json({ cards, source: 'db' });
    }

    // ステップ2: DBに見つからなければ公式サイトで検索（フォールバック）
    const variants = generateSearchVariants(keyword.trim());
    let cards = [];

    for (const variant of variants) {
      cards = await searchCards(variant);
      if (cards.length > 0) break;
    }

    const limitedCards = cards.slice(0, 30);
    for (const card of limitedCards) {
      if (cardNameCache[card.id]) {
        card.name = cardNameCache[card.id];
      }
    }

    res.json({ cards: limitedCards, source: 'official' });

    for (const card of limitedCards) {
      if (!cardNameCache[card.id]) {
        getCardName(card.id).catch(() => {});
      }
    }
  } catch (error) {
    console.error('Search error:', error.message);
    res.status(500).json({ error: '検索に失敗しました' });
  }
});

// カード名から検索してIDを取得するAPI（DBに優先、なければ公式サイト）
app.get('/api/search-by-name', async (req, res) => {
  try {
    const name = req.query.name || '';
    if (!name.trim()) return res.json({ cards: [] });

    // DB検索で完全一致を探す
    const dbResults = searchCardDB(name.trim());
    const exact = dbResults.find(c => c.name === name.trim());
    if (exact && exact.id) {
      return res.json({ id: exact.id, name: exact.name, thumbnail: exact.thumbnail });
    }

    // フォールバック: 公式サイト
    const cards = await searchCards(name.trim());
    if (cards.length > 0) {
      const card = cards[0];
      card.name = name;
      res.json(card);
    } else {
      res.json({ id: null, name });
    }
  } catch (e) {
    res.json({ id: null, name: req.query.name });
  }
});

// カード名だけ高速取得API（キャッシュ付き）
app.get('/api/cardname/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const name = await getCardName(id);
    res.json({ id, name: name || id });
  } catch (e) {
    res.json({ id: req.params.id, name: req.params.id });
  }
});

// カード詳細API - 公式サイトからカード詳細を取得
app.get('/api/card/:id', async (req, res) => {
  try {
    const id = req.params.id;

    // 事前ビルドDBから即返す
    if (cardDb[id] && cardDb[id].name && cardDb[id].effects) {
      return res.json(cardDb[id]);
    }

    // 動的キャッシュから
    if (cardDetailCache[id]) {
      return res.json(cardDetailCache[id]);
    }

    const url = `https://dm.takaratomy.co.jp/card/detail/?id=${encodeURIComponent(id)}`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ja,en;q=0.9',
      }
    });

    const html = await response.text();
    const $ = cheerio.load(html);

    // カード名: 最初の h3.card-name から取得（ツインパクトは2つあるので最初の1つのみ）
    let cardName = '';
    const cardNameEl = $('h3.card-name').first();
    if (cardNameEl.length) {
      const clone = cardNameEl.clone();
      clone.find('.packname').remove();
      cardName = clone.text().trim();
    }

    // フォールバック: h2, h3の最初のテキスト
    if (!cardName) {
      $('h2, h3').each((i, el) => {
        const text = $(el).text().trim();
        if (text && !cardName && !text.includes('カード検索') && !text.includes('関連') && !text.includes('商品')) {
          cardName = text.replace(/\(.*?\)/, '').trim();
        }
      });
    }

    // カード画像URL: .card-img 内のimg、またはsrc*="cardimage"
    let imageUrl = '';
    const cardImg = $('.card-img img, img[src*="cardimage"]').first();
    if (cardImg.length) {
      imageUrl = cardImg.attr('src') || '';
    }
    if (!imageUrl) {
      $('img[src*="cardthumb"]').first().each((i, el) => {
        imageUrl = $(el).attr('src') || '';
      });
    }
    if (imageUrl && !imageUrl.startsWith('http')) {
      imageUrl = `https://dm.takaratomy.co.jp${imageUrl}`;
    }

    // カード属性: 最初の .cardDetail 内のテーブル th -> td
    const cardDetailEls = $('.cardDetail');
    const firstDetail = cardDetailEls.first();
    let cardType = '', civilization = '', rarity = '', power = '', cost = '', mana = '', race = '';

    firstDetail.find('th').each((i, el) => {
      const key = $(el).text().trim();
      const td = $(el).next('td');
      const value = td.text().trim();

      if (key.includes('カードの種類') && !cardType) cardType = value;
      else if (key.includes('文明') && !civilization) civilization = value;
      else if (key.includes('レアリティ') && !rarity) rarity = value;
      else if (key.includes('パワー') && !power) power = value;
      else if (key.includes('コスト') && !cost) cost = value;
      else if (key.includes('マナ') && !mana) mana = value;
      else if (key.includes('種族') && !race) race = value;
    });

    // カード効果テキスト: 全ての .cardDetail から td.skills 内の li 要素を取得
    // ツインパクトカードは2面あるので両方の効果を取得
    const effects = [];
    cardDetailEls.each((detailIdx, detailEl) => {
      // ツインパクトの2面目にはラベルを付ける
      if (detailIdx > 0 && cardDetailEls.length > 1) {
        // 2面目のカード名を取得
        const secondName = $(detailEl).find('h3.card-name').first();
        if (secondName.length) {
          const clone = secondName.clone();
          clone.find('.packname').remove();
          const name2 = clone.text().trim();
          // カード名の / 以降の部分
          const parts = cardName.split('/').map(s => s.trim());
          if (parts.length > 1) {
            effects.push('【' + parts[1] + ' 側】');
          }
        }
      } else if (cardDetailEls.length > 1) {
        const parts = cardName.split('/').map(s => s.trim());
        if (parts.length > 1) {
          effects.push('【' + parts[0] + ' 側】');
        }
      }

      $(detailEl).find('td.skills li').each((i, el) => {
        let effectHtml = $(el).html() || '';
        effectHtml = effectHtml.replace(/<br\s*\/?>/gi, '\n');
        const text = effectHtml.replace(/<[^>]+>/g, '').trim();
        if (text) {
          effects.push(text);
        }
      });

      // skills が見つからない場合のフォールバック
      if (effects.length === 0 || (detailIdx === 0 && $(detailEl).find('td.skills li').length === 0)) {
        $(detailEl).find('td.skills').each((i, el) => {
          const text = $(el).text().trim();
          if (text) {
            text.split('\n').forEach(line => {
              const trimmed = line.trim();
              if (trimmed) effects.push(trimmed);
            });
          }
        });
      }
    });

    const cardData = {
      id,
      name: cardName,
      imageUrl,
      civilization,
      cardType,
      cost,
      power,
      race,
      rarity,
      mana,
      effects,
    };

    // 動的キャッシュに保存
    cardDetailCache[id] = cardData;
    res.json(cardData);
  } catch (error) {
    console.error('Card detail error:', error.message);
    res.status(500).json({ error: 'カード詳細の取得に失敗しました' });
  }
});

// デッキ製品一覧
const DECK_PRODUCTS = [
  // 公式サイトから取得した正式名称
  { code: 'dm25bd1', name: 'ドリーム英雄譚デッキ ボルシャックの書', type: '構築済みデッキ', year: 2025 },
  { code: 'dm25bd2', name: 'ドリーム英雄譚デッキ アルカディアスの書', type: '構築済みデッキ', year: 2025 },
  { code: 'dm25bd3', name: 'ドリーム英雄譚デッキ グレンモルトの書', type: '構築済みデッキ', year: 2025 },
  { code: 'dm25sd1', name: 'いきなりつよいデッキ 技の王道', type: 'スタートデッキ', year: 2025 },
  { code: 'dm25sd2', name: 'いきなりつよいデッキ 力の王道', type: 'スタートデッキ', year: 2025 },
  { code: 'dm24bd1', name: 'ドリーム英雄譚デッキ ドギラゴンの書', type: '構築済みデッキ', year: 2024 },
  { code: 'dm24bd2', name: 'ドリーム英雄譚デッキ ジョニーの書', type: '構築済みデッキ', year: 2024 },
  { code: 'dm24bd3', name: 'ドリーム英雄譚デッキ モモキングの書', type: '構築済みデッキ', year: 2024 },
  { code: 'dm24bd4', name: 'ナイトメア黙示録デッキ バロムの章', type: '構築済みデッキ', year: 2024 },
  { code: 'dm24sd1', name: 'いきなりつよいデッキ 攻めの王道', type: 'スタートデッキ', year: 2024 },
  { code: 'dm24sd2', name: 'いきなりつよいデッキ 守りの王道', type: 'スタートデッキ', year: 2024 },
  { code: 'dm23bd1', name: 'レジェンドスーパーデッキ 禁王創来', type: '構築済みデッキ', year: 2023 },
  { code: 'dm23bd2', name: '開発部セレクションデッキ 火闇邪王門', type: '構築済みデッキ', year: 2023 },
  { code: 'dm23bd3', name: '開発部セレクションデッキ 水闇自然ハンデス', type: '構築済みデッキ', year: 2023 },
];

// デッキ製品一覧API
app.get('/api/decks', (req, res) => {
  res.json({ decks: DECK_PRODUCTS });
});

// デッキ内カード一覧API - 製品ページからカードリストを取得
app.get('/api/deck/:code', async (req, res) => {
  try {
    const code = req.params.code;
    const product = DECK_PRODUCTS.find(p => p.code === code);
    if (!product) {
      return res.status(404).json({ error: 'デッキが見つかりません' });
    }

    const url = `https://dm.takaratomy.co.jp/product/${code}/`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ja,en;q=0.9',
      }
    });

    const html = await response.text();
    const $ = cheerio.load(html);

    // カードリンクを全て取得
    const cards = [];
    const seen = new Set();
    $('a[href*="card/detail"]').each((i, el) => {
      const href = $(el).attr('href') || '';
      const match = href.match(/id=([^&'"]+)/);
      if (match) {
        const id = match[1];
        // STARやF付き（ホイル版）は基本カードIDに正規化
        const baseId = id.replace(/STAR$/, '').replace(/F$/, '');
        if (!seen.has(baseId)) {
          seen.add(baseId);
          const img = $(el).find('img');
          let thumbUrl = img.attr('src') || '';
          if (thumbUrl && !thumbUrl.startsWith('http')) {
            thumbUrl = `https://dm.takaratomy.co.jp${thumbUrl}`;
          }
          cards.push({ id: baseId, thumbnail: thumbUrl });
        }
      }
    });

    res.json({
      code: product.code,
      name: product.name,
      type: product.type,
      cards,
    });
  } catch (error) {
    console.error('Deck error:', error.message);
    res.status(500).json({ error: 'デッキ情報の取得に失敗しました' });
  }
});

// Google Cloud Vision OCR API
app.post('/api/ocr', async (req, res) => {
  try {
    const { image } = req.body; // base64 image data
    if (!image) {
      return res.status(400).json({ error: '画像データがありません' });
    }

    // base64のプレフィックスを除去
    const base64Data = image.replace(/^data:image\/[^;]+;base64,/, '');

    const visionResp = await fetch(
      `https://vision.googleapis.com/v1/images:annotate?key=${GOOGLE_VISION_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: [{
            image: { content: base64Data },
            features: [{ type: 'TEXT_DETECTION', maxResults: 10 }],
            imageContext: { languageHints: ['ja'] }
          }]
        })
      }
    );

    const visionData = await visionResp.json();

    if (visionData.error) {
      return res.status(500).json({ error: visionData.error.message || 'Vision APIエラー' });
    }

    const annotations = visionData.responses?.[0]?.textAnnotations || [];
    const fullText = annotations[0]?.description || '';

    // テキストからカード名候補を抽出
    const lines = fullText.split(/[\n\r]+/).map(l => l.trim()).filter(l => l.length >= 2 && l.length <= 40);

    res.json({ text: fullText, lines });
  } catch (error) {
    console.error('OCR error:', error.message);
    res.status(500).json({ error: 'OCR処理に失敗しました' });
  }
});

// カード画像プロキシ
app.get('/api/image', async (req, res) => {
  try {
    const imageUrl = req.query.url;
    if (!imageUrl || !imageUrl.includes('dm.takaratomy.co.jp')) {
      return res.status(400).json({ error: 'Invalid image URL' });
    }

    const response = await fetch(imageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://dm.takaratomy.co.jp/',
      }
    });

    const contentType = response.headers.get('content-type') || 'image/jpeg';
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=86400');

    const buffer = await response.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch (error) {
    console.error('Image proxy error:', error.message);
    res.status(500).json({ error: '画像の取得に失敗しました' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`デュエマカード検索くん起動中:`);
  console.log(`  PC:     http://localhost:${PORT}`);
  console.log(`  スマホ: http://${getLocalIP()}:${PORT}`);
  console.log('同じWiFiに接続したスマホから上のURLを開いてください');
});

function getLocalIP() {
  const os = require('os');
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}
