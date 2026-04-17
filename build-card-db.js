// 全カード情報を公式サイトから取得してJSONに保存するビルドスクリプト
// 使い方: node build-card-db.js
// 所要時間: 約30-60分（22,000枚のカード）

const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const OUTPUT_DIR = path.join(__dirname, 'data');
const IDS_FILE = path.join(OUTPUT_DIR, 'card-ids.json'); // 途中保存
const CARDS_FILE = path.join(OUTPUT_DIR, 'cards.json'); // 最終出力
const PROGRESS_FILE = path.join(OUTPUT_DIR, 'progress.json');

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

// 軽い並列度で公式サイトに負荷をかけない
const CONCURRENCY = 20;
const DELAY_MS = 50;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// =====================================================
// ステップ1: 全ページから全カードIDとサムネを取得
// =====================================================
async function fetchAllCardIds() {
  if (fs.existsSync(IDS_FILE)) {
    console.log('IDs already fetched, loading from file');
    return JSON.parse(fs.readFileSync(IDS_FILE, 'utf-8'));
  }

  console.log('Step 1: Fetching all card IDs from 445 pages...');
  const allCards = new Map(); // id -> { id, thumbnail }

  // まず1ページ目を取得して最大ページ数確認
  let maxPage = 445;
  {
    const params = new URLSearchParams();
    params.append('keyword', '');
    params.append('keyword_type[]', 'card_name');
    params.append('samename', 'on');
    params.append('pagenum', '1');

    const resp = await fetch('https://dm.takaratomy.co.jp/card/', {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const html = await resp.text();
    const $ = cheerio.load(html);
    let mp = 0;
    $('.wp-pagenavi a').each((i, el) => {
      const p = parseInt($(el).attr('data-page') || $(el).text().replace(/\D/g, '') || '0');
      if (p > mp) mp = p;
    });
    if (mp > 0) maxPage = mp;
    console.log(`Max page: ${maxPage}`);
  }

  for (let page = 1; page <= maxPage; page++) {
    try {
      const params = new URLSearchParams();
      params.append('keyword', '');
      params.append('keyword_type[]', 'card_name');
      params.append('samename', 'on');
      params.append('pagenum', String(page));

      const resp = await fetch('https://dm.takaratomy.co.jp/card/', {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });
      const html = await resp.text();
      const $ = cheerio.load(html);

      let pageCount = 0;
      $('a[href*="/card/detail/?id="]').each((i, el) => {
        const href = $(el).attr('href') || '';
        const m = href.match(/id=([^&'"]+)/);
        if (m) {
          const id = m[1];
          const img = $(el).find('img');
          let thumb = img.attr('src') || '';
          if (thumb && !thumb.startsWith('http')) {
            thumb = `https://dm.takaratomy.co.jp${thumb}`;
          }
          if (!allCards.has(id)) {
            allCards.set(id, { id, thumbnail: thumb });
            pageCount++;
          }
        }
      });

      if (page % 10 === 0 || page === maxPage) {
        console.log(`  Page ${page}/${maxPage}: total ${allCards.size} cards (new: ${pageCount})`);
        // 途中保存
        fs.writeFileSync(IDS_FILE, JSON.stringify([...allCards.values()], null, 2));
      }

      await sleep(DELAY_MS);
    } catch (e) {
      console.error(`Page ${page} error:`, e.message);
      await sleep(1000);
    }
  }

  const cards = [...allCards.values()];
  fs.writeFileSync(IDS_FILE, JSON.stringify(cards, null, 2));
  console.log(`Step 1 complete: ${cards.length} cards`);
  return cards;
}

// =====================================================
// ステップ2: 各カードの詳細を取得
// =====================================================
async function fetchCardDetail(id) {
  try {
    const resp = await fetch(`https://dm.takaratomy.co.jp/card/detail/?id=${encodeURIComponent(id)}`, {
      headers: { 'User-Agent': UA }
    });
    const html = await resp.text();
    const $ = cheerio.load(html);

    // カード名
    const nameEl = $('h3.card-name').first();
    const clone = nameEl.clone();
    clone.find('.packname').remove();
    const name = clone.text().trim();

    // 画像URL
    let imageUrl = '';
    const cardImg = $('.card-img img, img[src*="cardimage"]').first();
    if (cardImg.length) {
      imageUrl = cardImg.attr('src') || '';
    }
    if (imageUrl && !imageUrl.startsWith('http')) {
      imageUrl = `https://dm.takaratomy.co.jp${imageUrl}`;
    }

    // 属性テーブル
    const firstDetail = $('.cardDetail').first();
    let cardType = '', civilization = '', rarity = '', power = '', cost = '', mana = '', race = '';

    firstDetail.find('th').each((i, el) => {
      const key = $(el).text().trim();
      const td = $(el).next('td');
      const v = td.text().trim();
      if (key.includes('カードの種類') && !cardType) cardType = v;
      else if (key.includes('文明') && !civilization) civilization = v;
      else if (key.includes('レアリティ') && !rarity) rarity = v;
      else if (key.includes('パワー') && !power) power = v;
      else if (key.includes('コスト') && !cost) cost = v;
      else if (key.includes('マナ') && !mana) mana = v;
      else if (key.includes('種族') && !race) race = v;
    });

    // 効果テキスト（全面分）
    const effects = [];
    const allDetails = $('.cardDetail');
    const isTwinPact = allDetails.length > 1;
    allDetails.each((detailIdx, detailEl) => {
      if (isTwinPact) {
        const parts = name.split('/').map(s => s.trim());
        if (parts.length > 1 && parts[detailIdx]) {
          effects.push('【' + parts[detailIdx] + ' 側】');
        }
      }
      $(detailEl).find('td.skills li').each((i, el) => {
        let html = $(el).html() || '';
        html = html.replace(/<br\s*\/?>/gi, '\n');
        const text = html.replace(/<[^>]+>/g, '').trim();
        if (text) effects.push(text);
      });
    });

    return {
      id,
      name,
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
  } catch (e) {
    return { id, error: e.message };
  }
}

async function fetchAllCardDetails(cards) {
  console.log(`Step 2: Fetching details for ${cards.length} cards...`);

  // 既存の進捗を読み込み
  let cardDetails = {};
  if (fs.existsSync(CARDS_FILE)) {
    try {
      cardDetails = JSON.parse(fs.readFileSync(CARDS_FILE, 'utf-8'));
      console.log(`Loaded ${Object.keys(cardDetails).length} existing details`);
    } catch (e) {}
  }

  const todo = cards.filter(c => !cardDetails[c.id] || cardDetails[c.id].error);
  console.log(`Remaining: ${todo.length} cards`);

  let done = 0;
  let lastSave = Date.now();

  // 並列処理
  for (let i = 0; i < todo.length; i += CONCURRENCY) {
    const batch = todo.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(c => fetchCardDetail(c.id)));
    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      cardDetails[result.id] = {
        ...batch[j], // thumbnail含む
        ...result,
      };
      done++;
    }

    // 50件ごと or 10秒ごとに保存（ファイルロック対策で一時ファイル経由）
    if (done % 50 === 0 || Date.now() - lastSave > 10000) {
      try {
        const tmpFile = CARDS_FILE + '.tmp';
        fs.writeFileSync(tmpFile, JSON.stringify(cardDetails));
        fs.renameSync(tmpFile, CARDS_FILE);
      } catch (e) {
        console.error('Save error (will retry):', e.message);
        await sleep(500);
        continue;
      }
      const elapsed = Math.round((Date.now() - START_TIME) / 1000);
      const total = Object.keys(cardDetails).length;
      const remaining = cards.length - total;
      const eta = remaining > 0 && done > 0 ? Math.round((Date.now() - START_TIME) / done * remaining / 1000) : 0;
      console.log(`  ${total}/${cards.length} (${Math.round(total/cards.length*100)}%) elapsed ${elapsed}s, ETA ${eta}s`);
      lastSave = Date.now();
    }

    await sleep(DELAY_MS);
  }

  fs.writeFileSync(CARDS_FILE, JSON.stringify(cardDetails));
  console.log(`Step 2 complete: ${Object.keys(cardDetails).length} cards saved`);
  return cardDetails;
}

// =====================================================
// メイン
// =====================================================
const START_TIME = Date.now();

(async () => {
  try {
    const cards = await fetchAllCardIds();
    console.log(`\nTotal unique cards: ${cards.length}\n`);

    const details = await fetchAllCardDetails(cards);
    console.log(`\n✅ Build complete!`);
    console.log(`Total time: ${Math.round((Date.now() - START_TIME) / 60000)} minutes`);
    console.log(`Output: ${CARDS_FILE}`);
    console.log(`File size: ${Math.round(fs.statSync(CARDS_FILE).size / 1024 / 1024 * 10) / 10} MB`);
  } catch (e) {
    console.error('Build failed:', e);
  }
})();
