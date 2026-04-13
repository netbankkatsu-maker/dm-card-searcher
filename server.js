const express = require('express');
const cheerio = require('cheerio');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// カード名キャッシュ（サーバーメモリ上）
const cardNameCache = {};

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

// カード検索API
app.get('/api/search', async (req, res) => {
  try {
    const keyword = req.query.keyword || '';
    if (!keyword.trim()) {
      return res.json({ cards: [] });
    }

    // 表記ゆれを考慮して複数パターンで検索
    const variants = generateSearchVariants(keyword.trim());
    let cards = [];

    for (const variant of variants) {
      cards = await searchCards(variant);
      if (cards.length > 0) break;
    }

    const limitedCards = cards.slice(0, 30);

    // キャッシュにある分だけ名前を付ける（即座に返すため待たない）
    for (const card of limitedCards) {
      if (cardNameCache[card.id]) {
        card.name = cardNameCache[card.id];
      }
    }

    res.json({ cards: limitedCards });

    // バックグラウンドでキャッシュを温める（次回以降が速くなる）
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

    res.json(cardData);
  } catch (error) {
    console.error('Card detail error:', error.message);
    res.status(500).json({ error: 'カード詳細の取得に失敗しました' });
  }
});

// デッキ製品一覧
const DECK_PRODUCTS = [
  // dm26sd1 は25種ランダムデッキのため個別デッキとしては不適切、除外
  { code: 'dm25bd1', name: 'ドリーム英雄譚デッキ ボルシャックの書', type: '構築済みデッキ', year: 2025 },
  { code: 'dm25bd2', name: 'ドリーム英雄譚デッキ モモキングの書', type: '構築済みデッキ', year: 2025 },
  { code: 'dm25bd3', name: 'グレンモルトの書', type: '構築済みデッキ', year: 2025 },
  { code: 'dm25sd1', name: 'いきなりつよいデッキ 竜皇天翔', type: 'スタートデッキ', year: 2025 },
  { code: 'dm25sd2', name: 'いきなりつよいデッキ 深淵黒魔', type: 'スタートデッキ', year: 2025 },
  { code: 'dm24bd1', name: '超英雄譚デッキ 「聖霊王の救世主」', type: '構築済みデッキ', year: 2024 },
  { code: 'dm24bd2', name: '超英雄譚デッキ 「鬼丸覇の極限龍」', type: '構築済みデッキ', year: 2024 },
  { code: 'dm24bd3', name: '英雄譚デッキ 「ガイアッシュの天命」', type: '構築済みデッキ', year: 2024 },
  { code: 'dm24bd4', name: '英雄譚デッキ 「デドダムの禁断闘」', type: '構築済みデッキ', year: 2024 },
  { code: 'dm24sd1', name: 'いきなりつよいデッキ 邪幽の覚醒者', type: 'スタートデッキ', year: 2024 },
  { code: 'dm24sd2', name: 'いきなりつよいデッキ 正義の天秤', type: 'スタートデッキ', year: 2024 },
  { code: 'dm23bd1', name: '頂上デッキ 「カイザー刃鬼」', type: '構築済みデッキ', year: 2023 },
  { code: 'dm23bd2', name: '頂上デッキ 「月下卍壊」', type: '構築済みデッキ', year: 2023 },
  { code: 'dm23bd3', name: '頂上デッキ 「切札勝太&カツキング」', type: '構築済みデッキ', year: 2023 },
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
