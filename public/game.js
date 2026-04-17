// ============================================================
// デュエマ対戦ゲーム - デッキ構築 + AI対戦
// ============================================================

// ========== 定数 ==========
const DECK_SIZE = 40;
const MAX_COPIES = 4;
const INITIAL_HAND = 5;
const INITIAL_SHIELDS = 5;

// ========== キーワード能力パーサー ==========
// カードの効果テキストから能力を自動抽出
function parseKeywords(card) {
  const text = (card.effects || []).join('\n');
  const keywords = {
    blocker: false,
    speedAttacker: false,
    breaker: 1,
    shieldTrigger: false,
    slayer: false,
    cannotAttackPlayer: false,
    cannotAttackCreature: false,
    poweredBreaker: false,
    muteCreature: false, // マッハファイター
  };

  if (/ブロッカー/.test(text)) keywords.blocker = true;
  if (/スピードアタッカー/.test(text)) keywords.speedAttacker = true;
  if (/S・トリガー|シールド・トリガー/.test(text)) keywords.shieldTrigger = true;
  if (/スレイヤー/.test(text)) keywords.slayer = true;

  if (/Q・ブレイカー|クワトロ・ブレイカー/.test(text)) keywords.breaker = 4;
  else if (/T・ブレイカー|トリプル・ブレイカー/.test(text)) keywords.breaker = 3;
  else if (/W・ブレイカー|ダブル・ブレイカー/.test(text)) keywords.breaker = 2;
  else if (/ワールド・ブレイカー/.test(text)) keywords.breaker = 99; // 全シールド
  else if (/パワード・ブレイカー/.test(text)) keywords.poweredBreaker = true;

  if (/このクリーチャーは、?プレイヤーを攻撃できない|プレイヤーは攻撃できない/.test(text)) keywords.cannotAttackPlayer = true;
  if (/クリーチャーを攻撃できない/.test(text)) keywords.cannotAttackCreature = true;
  if (/マッハファイター/.test(text)) keywords.muteCreature = true;

  return keywords;
}

// パワーブレイカー数を計算
function getBreakCount(card) {
  if (card.keywords.breaker === 99) return 99;
  let count = card.keywords.breaker;
  if (card.keywords.poweredBreaker) {
    count = Math.max(count, Math.floor((card.power || 0) / 6000) + 1);
  }
  return count;
}

// ========== デッキ管理 ==========
const DECK_STORAGE_KEY = 'dm_my_decks';

function getDecks() {
  return JSON.parse(localStorage.getItem(DECK_STORAGE_KEY) || '[]');
}

function saveDecks(decks) {
  localStorage.setItem(DECK_STORAGE_KEY, JSON.stringify(decks));
}

function saveDeck(deck) {
  const decks = getDecks();
  const idx = decks.findIndex(d => d.id === deck.id);
  if (idx >= 0) decks[idx] = deck;
  else decks.push(deck);
  saveDecks(decks);
}

// ========== デッキ構築UI ==========
let currentDeck = { id: null, name: '', cards: [] }; // cards: [{id, count}]
let deckSearchResults = [];
let deckAllCardsCache = {};

async function initDeckBuilder() {
  const area = document.getElementById('resultsArea');
  area.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:12px;height:100%;">
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
        <input type="text" id="deckNameInput" placeholder="デッキ名" style="flex:1;min-width:150px;padding:8px;background:var(--bg-card);border:1px solid var(--border-color);border-radius:6px;color:var(--text-primary);">
        <button onclick="saveCurrentDeck()" style="padding:8px 16px;background:var(--accent-water);border:none;color:white;border-radius:6px;cursor:pointer;">💾 保存</button>
        <button onclick="showMyDecks()" style="padding:8px 16px;background:var(--bg-hover);border:1px solid var(--border-color);color:var(--text-primary);border-radius:6px;cursor:pointer;">📂 デッキ一覧</button>
        <button onclick="clearCurrentDeck()" style="padding:8px 16px;background:var(--bg-hover);border:1px solid var(--border-color);color:var(--text-secondary);border-radius:6px;cursor:pointer;">🗑 クリア</button>
      </div>
      <div id="deckStatus" style="font-size:0.85rem;color:var(--text-secondary);"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;flex:1;min-height:0;">
        <div style="display:flex;flex-direction:column;gap:8px;min-height:0;">
          <div style="font-weight:bold;color:var(--accent-water);">カード検索</div>
          <input type="text" id="deckSearchInput" placeholder="カード名で検索..." oninput="searchDeckCards(this.value)" style="padding:8px;background:var(--bg-card);border:1px solid var(--border-color);border-radius:6px;color:var(--text-primary);">
          <div id="deckSearchArea" style="flex:1;overflow-y:auto;padding:4px;"></div>
        </div>
        <div style="display:flex;flex-direction:column;gap:8px;min-height:0;">
          <div style="font-weight:bold;color:var(--accent-light);">現在のデッキ <span id="deckCount">(0/40)</span></div>
          <div id="deckListArea" style="flex:1;overflow-y:auto;padding:4px;"></div>
        </div>
      </div>
    </div>
  `;

  // 既存デッキがあれば読み込み
  if (currentDeck.cards.length > 0) {
    document.getElementById('deckNameInput').value = currentDeck.name;
    renderDeckList();
    updateDeckCount();
  }
  updateDeckStatus();
}

let searchDebounce = null;
function searchDeckCards(keyword) {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(async () => {
    if (!keyword.trim()) {
      document.getElementById('deckSearchArea').innerHTML = '<div style="color:var(--text-secondary);font-size:0.85rem;padding:10px;">カード名を入力してください</div>';
      return;
    }
    const resp = await fetch('/api/search?keyword=' + encodeURIComponent(keyword));
    const data = await resp.json();
    deckSearchResults = data.cards || [];
    renderDeckSearchResults();
  }, 300);
}

function renderDeckSearchResults() {
  const area = document.getElementById('deckSearchArea');
  if (!deckSearchResults.length) {
    area.innerHTML = '<div style="color:var(--text-secondary);font-size:0.85rem;padding:10px;">見つかりません</div>';
    return;
  }
  area.innerHTML = deckSearchResults.map(c => {
    const count = currentDeck.cards.find(d => d.id === c.id)?.count || 0;
    const canAdd = currentDeck.cards.reduce((s, d) => s + d.count, 0) < DECK_SIZE && count < MAX_COPIES && c.id;
    return `
      <div style="display:flex;align-items:center;gap:6px;padding:4px;background:var(--bg-card);border-radius:6px;margin-bottom:4px;">
        ${c.thumbnail ? `<img src="${c.thumbnail}" style="width:30px;height:42px;object-fit:cover;border-radius:3px;" onerror="this.style.display='none'">` : ''}
        <div style="flex:1;min-width:0;font-size:0.85rem;">${c.name || c.id}</div>
        ${count > 0 ? `<span style="background:var(--accent-water);color:white;padding:2px 6px;border-radius:10px;font-size:0.7rem;">×${count}</span>` : ''}
        <button onclick="addCardToDeck('${c.id}', '${encodeURIComponent(c.name || '')}', '${encodeURIComponent(c.thumbnail || '')}')" ${canAdd ? '' : 'disabled'} style="padding:4px 10px;background:${canAdd ? 'var(--accent-nature)' : 'var(--bg-hover)'};border:none;color:white;border-radius:4px;cursor:${canAdd ? 'pointer' : 'not-allowed'};font-size:0.85rem;">追加</button>
      </div>
    `;
  }).join('');
}

async function addCardToDeck(id, nameEnc, thumbEnc) {
  if (!id) return;
  const name = decodeURIComponent(nameEnc);
  const thumbnail = decodeURIComponent(thumbEnc);
  const total = currentDeck.cards.reduce((s, d) => s + d.count, 0);
  if (total >= DECK_SIZE) return;

  const existing = currentDeck.cards.find(c => c.id === id);
  if (existing) {
    if (existing.count >= MAX_COPIES) return;
    existing.count++;
  } else {
    currentDeck.cards.push({ id, name, thumbnail, count: 1 });
  }

  // カード詳細を先読みキャッシュ
  if (!deckAllCardsCache[id]) {
    fetch('/api/card/' + encodeURIComponent(id)).then(r => r.json()).then(d => {
      deckAllCardsCache[id] = d;
    }).catch(() => {});
  }

  renderDeckList();
  renderDeckSearchResults();
  updateDeckCount();
  updateDeckStatus();
}

function removeCardFromDeck(id) {
  const existing = currentDeck.cards.find(c => c.id === id);
  if (!existing) return;
  existing.count--;
  if (existing.count <= 0) {
    currentDeck.cards = currentDeck.cards.filter(c => c.id !== id);
  }
  renderDeckList();
  renderDeckSearchResults();
  updateDeckCount();
  updateDeckStatus();
}

function renderDeckList() {
  const area = document.getElementById('deckListArea');
  if (!currentDeck.cards.length) {
    area.innerHTML = '<div style="color:var(--text-secondary);font-size:0.85rem;padding:10px;">カードを追加してデッキを作ろう</div>';
    return;
  }
  area.innerHTML = currentDeck.cards.map(c => `
    <div style="display:flex;align-items:center;gap:6px;padding:4px;background:var(--bg-card);border-radius:6px;margin-bottom:4px;">
      ${c.thumbnail ? `<img src="${c.thumbnail}" style="width:30px;height:42px;object-fit:cover;border-radius:3px;" onerror="this.style.display='none'">` : ''}
      <div style="flex:1;min-width:0;font-size:0.85rem;">${c.name || c.id}</div>
      <span style="background:var(--accent-light);color:#000;padding:2px 6px;border-radius:10px;font-size:0.7rem;">×${c.count}</span>
      <button onclick="removeCardFromDeck('${c.id}')" style="padding:4px 10px;background:var(--accent-fire);border:none;color:white;border-radius:4px;cursor:pointer;font-size:0.85rem;">−</button>
    </div>
  `).join('');
}

function updateDeckCount() {
  const total = currentDeck.cards.reduce((s, c) => s + c.count, 0);
  const el = document.getElementById('deckCount');
  if (el) {
    el.textContent = `(${total}/${DECK_SIZE})`;
    el.style.color = total === DECK_SIZE ? 'var(--accent-nature)' : 'var(--text-secondary)';
  }
}

function updateDeckStatus() {
  const el = document.getElementById('deckStatus');
  if (!el) return;
  const total = currentDeck.cards.reduce((s, c) => s + c.count, 0);
  if (total < DECK_SIZE) {
    el.textContent = `あと${DECK_SIZE - total}枚必要です`;
    el.style.color = 'var(--text-secondary)';
  } else if (total === DECK_SIZE) {
    el.textContent = '✅ デッキ完成！保存してデュエル開始';
    el.style.color = 'var(--accent-nature)';
  } else {
    el.textContent = `⚠ ${total - DECK_SIZE}枚オーバー`;
    el.style.color = 'var(--accent-fire)';
  }
}

function clearCurrentDeck() {
  if (!confirm('現在のデッキをクリアしますか？')) return;
  currentDeck = { id: null, name: '', cards: [] };
  document.getElementById('deckNameInput').value = '';
  renderDeckList();
  updateDeckCount();
  updateDeckStatus();
}

function saveCurrentDeck() {
  const name = document.getElementById('deckNameInput').value.trim();
  if (!name) { alert('デッキ名を入力してください'); return; }
  const total = currentDeck.cards.reduce((s, c) => s + c.count, 0);
  if (total !== DECK_SIZE) { alert(`デッキは${DECK_SIZE}枚必要です（現在${total}枚）`); return; }

  if (!currentDeck.id) currentDeck.id = 'deck_' + Date.now();
  currentDeck.name = name;
  saveDeck(currentDeck);
  alert('保存しました！');
}

async function showMyDecks() {
  const decks = getDecks();
  const area = document.getElementById('resultsArea');
  area.innerHTML = `
    <div style="padding:16px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:8px;">
        <h2>⚔ 対戦</h2>
        <button onclick="newDeck()" style="padding:8px 16px;background:var(--accent-water);border:none;color:white;border-radius:6px;cursor:pointer;">+ 新規デッキ作成</button>
      </div>

      <div style="margin-bottom:18px;">
        <h3 style="font-size:1rem;color:var(--accent-light);margin-bottom:8px;">📂 マイデッキ</h3>
        ${decks.length === 0 ? '<div style="color:var(--text-secondary);font-size:0.85rem;">自作デッキがまだありません</div>' : ''}
        <div style="display:flex;flex-direction:column;gap:8px;">
          ${decks.map(d => `
            <div style="background:var(--bg-card);border:1px solid var(--border-color);border-radius:10px;padding:12px;">
              <div style="font-weight:bold;">${d.name}</div>
              <div style="color:var(--text-secondary);font-size:0.8rem;margin-top:2px;">${d.cards.reduce((s,c)=>s+c.count,0)}枚</div>
              <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;">
                <button onclick='editDeck("${d.id}")' style="padding:5px 12px;background:var(--bg-hover);border:1px solid var(--border-color);color:var(--text-primary);border-radius:6px;cursor:pointer;font-size:0.85rem;">✏ 編集</button>
                <button onclick='startDuelWithDeck("${d.id}")' style="padding:5px 12px;background:var(--accent-fire);border:none;color:white;border-radius:6px;cursor:pointer;font-size:0.85rem;">⚔ デュエル</button>
                <button onclick='deleteDeck("${d.id}")' style="padding:5px 12px;background:var(--bg-hover);border:1px solid var(--accent-fire);color:var(--accent-fire);border-radius:6px;cursor:pointer;margin-left:auto;font-size:0.85rem;">削除</button>
              </div>
            </div>
          `).join('')}
        </div>
      </div>

      <div>
        <h3 style="font-size:1rem;color:var(--accent-light);margin-bottom:8px;">🏆 公式デッキですぐ対戦</h3>
        <div style="color:var(--text-secondary);font-size:0.75rem;margin-bottom:8px;">40枚未満のデッキは不足分を自動補完します</div>
        <div id="officialDeckList" style="display:flex;flex-direction:column;gap:8px;">
          <div class="loading" style="padding:20px;"><div class="loading-spinner"></div><div class="loading-text">公式デッキを読込中...</div></div>
        </div>
      </div>
    </div>
  `;

  try {
    const resp = await fetch('/api/decks');
    const data = await resp.json();
    const html = (data.decks || []).map(d => `
      <div style="background:var(--bg-card);border:1px solid var(--border-color);border-radius:10px;padding:12px;">
        <div style="font-weight:bold;">${d.name}</div>
        <div style="color:var(--text-secondary);font-size:0.8rem;margin-top:2px;">${d.type} / ${d.year}</div>
        <div style="display:flex;gap:6px;margin-top:8px;">
          <button onclick='startDuelWithOfficialDeck("${d.code}", "${(d.name||'').replace(/"/g,'&quot;')}")' style="padding:5px 12px;background:var(--accent-fire);border:none;color:white;border-radius:6px;cursor:pointer;font-size:0.85rem;">⚔ デュエル</button>
          <button onclick='importOfficialDeck("${d.code}")' style="padding:5px 12px;background:var(--accent-water);border:none;color:white;border-radius:6px;cursor:pointer;font-size:0.85rem;">📥 マイデッキに取込</button>
        </div>
      </div>
    `).join('');
    document.getElementById('officialDeckList').innerHTML = html;
  } catch (e) {
    document.getElementById('officialDeckList').innerHTML = '<div style="color:var(--text-secondary);">公式デッキの取得に失敗しました</div>';
  }
}

// 公式デッキのカードIDを取得してDuelに使う
async function startDuelWithOfficialDeck(code, name) {
  const area = document.getElementById('resultsArea');
  area.innerHTML = `<div class="loading"><div class="loading-spinner"></div><div class="loading-text">「${name}」を読込中...</div></div>`;

  try {
    const resp = await fetch('/api/deck/' + encodeURIComponent(code));
    const data = await resp.json();
    if (!data.cards || data.cards.length === 0) { alert('デッキが読み込めません'); showMyDecks(); return; }

    // 40枚未満の場合は同じカードを繰り返して埋める（シンプル戦略）
    let cards = data.cards.map(c => ({ id: c.id, name: '', thumbnail: c.thumbnail, count: 1 }));
    const total = cards.length;
    if (total < DECK_SIZE) {
      // 不足分を補完（循環）
      let i = 0;
      while (cards.reduce((s, c) => s + c.count, 0) < DECK_SIZE) {
        if (cards[i].count < MAX_COPIES) cards[i].count++;
        i = (i + 1) % cards.length;
        if (i === 0 && cards.every(c => c.count >= MAX_COPIES)) break;
      }
    }

    const fakeDeck = { id: 'official_' + code, name, cards };
    // 難易度選択→デュエル開始
    const difficulty = await selectDifficulty();
    if (!difficulty) { showMyDecks(); return; }

    area.innerHTML = `<div class="loading"><div class="loading-spinner"></div><div class="loading-text">デッキを準備中...</div></div>`;
    const playerCards = await loadDeckCards(fakeDeck);
    if (!playerCards || playerCards.length === 0) { alert('カード読み込み失敗'); showMyDecks(); return; }
    const aiCards = JSON.parse(JSON.stringify(playerCards));
    // インスタンスIDをAI用に振り直し
    aiCards.forEach(c => c.instanceId = Math.random().toString(36).substr(2, 9));

    initDuel(playerCards, aiCards, difficulty);
  } catch (e) {
    alert('エラー: ' + e.message);
    showMyDecks();
  }
}

// 公式デッキをマイデッキにインポート
async function importOfficialDeck(code) {
  try {
    const resp = await fetch('/api/deck/' + encodeURIComponent(code));
    const data = await resp.json();
    if (!data.cards || data.cards.length === 0) { alert('デッキが読み込めません'); return; }

    // カード名を取得
    const nameFetches = await Promise.all(data.cards.slice(0, 40).map(async c => {
      try {
        const r = await fetch('/api/cardname/' + encodeURIComponent(c.id));
        const j = await r.json();
        return { id: c.id, name: j.name || c.id, thumbnail: c.thumbnail, count: 1 };
      } catch (e) {
        return { id: c.id, name: c.id, thumbnail: c.thumbnail, count: 1 };
      }
    }));

    // 40枚未満は繰り返し
    let cards = nameFetches;
    let i = 0;
    while (cards.reduce((s, c) => s + c.count, 0) < DECK_SIZE && cards.length > 0) {
      if (cards[i].count < MAX_COPIES) cards[i].count++;
      i = (i + 1) % cards.length;
      if (cards.every(c => c.count >= MAX_COPIES)) break;
    }

    currentDeck = {
      id: 'deck_' + Date.now(),
      name: data.name,
      cards,
    };
    saveDeck(currentDeck);
    alert(`「${data.name}」をマイデッキに取り込みました`);
    showMyDecks();
  } catch (e) {
    alert('エラー: ' + e.message);
  }
}

function newDeck() {
  currentDeck = { id: null, name: '', cards: [] };
  initDeckBuilder();
}

function editDeck(deckId) {
  const decks = getDecks();
  const d = decks.find(x => x.id === deckId);
  if (!d) return;
  currentDeck = JSON.parse(JSON.stringify(d));
  initDeckBuilder();
}

function deleteDeck(deckId) {
  if (!confirm('このデッキを削除しますか？')) return;
  const decks = getDecks().filter(d => d.id !== deckId);
  saveDecks(decks);
  showMyDecks();
}

// ============================================================
// デュエル - ゲームエンジン
// ============================================================
let game = null;

async function startDuelWithDeck(deckId) {
  const decks = getDecks();
  const deck = decks.find(d => d.id === deckId);
  if (!deck) return;

  // AI難易度選択
  const difficulty = await selectDifficulty();
  if (!difficulty) return;

  const area = document.getElementById('resultsArea');
  area.innerHTML = `<div class="loading"><div class="loading-spinner"></div><div class="loading-text">デッキを読み込み中...</div></div>`;

  // プレイヤーデッキのカード詳細を取得
  const playerCards = await loadDeckCards(deck);
  if (!playerCards) { alert('デッキの読み込みに失敗しました'); return; }

  // AI用のデッキも同じデッキを使う（シンプルな実装）
  // 難易度に応じて勝敗傾向を調整するのはAIのロジック側で行う
  const aiDeckSrc = deck;
  const aiCards = JSON.parse(JSON.stringify(playerCards)); // ディープコピー

  initDuel(playerCards, aiCards, difficulty);
}

function selectDifficulty() {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.8);z-index:400;display:flex;justify-content:center;align-items:center;padding:16px;';
    overlay.innerHTML = `
      <div style="background:var(--bg-card);border:2px solid var(--border-color);border-radius:14px;padding:24px;max-width:400px;width:100%;">
        <h2 style="text-align:center;margin-bottom:20px;">⚔ AI難易度</h2>
        <div style="display:flex;flex-direction:column;gap:10px;">
          <button data-diff="easy" style="padding:16px;background:var(--accent-nature);border:none;color:white;border-radius:10px;cursor:pointer;font-size:1.1rem;">🌱 弱い<br><span style="font-size:0.8rem;opacity:0.9;">最初の練習に</span></button>
          <button data-diff="normal" style="padding:16px;background:var(--accent-water);border:none;color:white;border-radius:10px;cursor:pointer;font-size:1.1rem;">⚖ 普通<br><span style="font-size:0.8rem;opacity:0.9;">バランス良い戦い</span></button>
          <button data-diff="hard" style="padding:16px;background:var(--accent-fire);border:none;color:white;border-radius:10px;cursor:pointer;font-size:1.1rem;">🔥 強い<br><span style="font-size:0.8rem;opacity:0.9;">本気モード</span></button>
          <button data-diff="" style="padding:8px;background:none;border:1px solid var(--border-color);color:var(--text-secondary);border-radius:6px;cursor:pointer;">キャンセル</button>
        </div>
      </div>
    `;
    overlay.querySelectorAll('button').forEach(b => {
      b.onclick = () => {
        document.body.removeChild(overlay);
        resolve(b.dataset.diff || null);
      };
    });
    document.body.appendChild(overlay);
  });
}

async function loadDeckCards(deck) {
  // 全カードの詳細を並列取得
  const allIds = [];
  for (const c of deck.cards) {
    for (let i = 0; i < c.count; i++) allIds.push(c.id);
  }
  const uniqueIds = [...new Set(allIds)];

  const detailMap = {};
  const batch = 10;
  for (let i = 0; i < uniqueIds.length; i += batch) {
    const slice = uniqueIds.slice(i, i + batch);
    await Promise.all(slice.map(async id => {
      try {
        const resp = await fetch('/api/card/' + encodeURIComponent(id));
        const data = await resp.json();
        if (!data.error) detailMap[id] = data;
      } catch (e) {}
    }));
  }

  const cards = [];
  for (const id of allIds) {
    const detail = detailMap[id];
    if (!detail) continue;
    const card = { ...detail };
    card.cost = parseInt(detail.cost) || 0;
    card.power = parseInt((detail.power || '').replace(/[+-]/g, '')) || 0;
    card.keywords = parseKeywords(card);
    card.instanceId = Math.random().toString(36).substr(2, 9);
    cards.push(card);
  }
  return cards;
}

// ========== ゲーム初期化 ==========
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function initDuel(playerCards, aiCards, difficulty) {
  const playerDeck = shuffle(playerCards);
  const aiDeck = shuffle(aiCards);

  game = {
    turn: Math.random() < 0.5 ? 'player' : 'ai',
    turnNumber: 1,
    phase: 'start',
    hasCharged: false,
    hasDrawn: false,
    selectedAttacker: null,
    selectedBlocker: null,
    winner: null,
    pendingTrigger: null, // S・トリガー処理中
    difficulty,
    log: [],
    player: {
      deck: playerDeck.slice(5 + INITIAL_SHIELDS),
      hand: playerDeck.slice(0, INITIAL_HAND),
      shields: playerDeck.slice(INITIAL_HAND, INITIAL_HAND + INITIAL_SHIELDS).map(c => ({ ...c, faceDown: true })),
      mana: [],
      battleZone: [],
      graveyard: [],
    },
    ai: {
      deck: aiDeck.slice(INITIAL_HAND + INITIAL_SHIELDS),
      hand: aiDeck.slice(0, INITIAL_HAND),
      shields: aiDeck.slice(INITIAL_HAND, INITIAL_HAND + INITIAL_SHIELDS).map(c => ({ ...c, faceDown: true })),
      mana: [],
      battleZone: [],
      graveyard: [],
    },
  };

  addLog(`対戦開始！${game.turn === 'player' ? 'あなた' : 'AI'}のターン`);
  renderDuelUI();
  startTurn();
}

function addLog(msg) {
  game.log.push(msg);
  if (game.log.length > 20) game.log.shift();
}

// ========== フェーズ処理 ==========
function startTurn() {
  if (game.winner) return;
  game.phase = 'start';
  game.hasCharged = false;
  game.hasDrawn = false;
  game.selectedAttacker = null;

  const player = game[game.turn];
  // アンタップ
  player.mana.forEach(m => m.tapped = false);
  player.battleZone.forEach(c => {
    c.tapped = false;
    c.summoningSickness = false; // ターン開始時に解除
  });

  // 最初のターンはドローしない
  if (game.turnNumber > 1 || (game.turnNumber === 1 && game.turn !== (game.firstTurn || game.turn))) {
    // ドロー
    drawCard(game.turn);
  } else if (game.turnNumber === 1) {
    // 先攻1ターン目はドローなし
  }

  game.phase = 'main';
  renderDuelUI();

  if (game.turn === 'ai') {
    setTimeout(() => aiTakeTurn(), 800);
  }
}

function drawCard(who) {
  const p = game[who];
  if (p.deck.length === 0) {
    // 山札切れで負け
    game.winner = who === 'player' ? 'ai' : 'player';
    addLog(`${who === 'player' ? 'あなた' : 'AI'}の山札が0枚！${game.winner === 'player' ? 'あなた' : 'AI'}の勝ち！`);
    renderDuelUI();
    return null;
  }
  const card = p.deck.shift();
  p.hand.push(card);
  addLog(`${who === 'player' ? 'あなた' : 'AI'}がカードをドロー`);
  return card;
}

function chargeMana(handIdx) {
  if (game.turn !== 'player' || game.hasCharged || game.winner) return;
  const player = game.player;
  const card = player.hand[handIdx];
  if (!card) return;
  player.hand.splice(handIdx, 1);
  player.mana.push({ ...card, tapped: false });
  game.hasCharged = true;
  addLog(`マナをチャージ: ${card.name}`);
  renderDuelUI();
}

function canPaySummonCost(who, card) {
  const p = game[who];
  const untappedMana = p.mana.filter(m => !m.tapped);
  if (untappedMana.length < card.cost) return false;
  // 文明チェック: カードの文明のマナが1枚以上タップされる必要がある
  const cardCivs = (card.civilization || '').split(/[\/／・]/).map(s => s.trim()).filter(Boolean);
  if (cardCivs.length === 0) return untappedMana.length >= card.cost;
  // 簡易版: 必要文明が少なくとも1つ含まれていればOK
  const hasCiv = untappedMana.some(m => {
    const mCivs = (m.civilization || '').split(/[\/／・]/).map(s => s.trim()).filter(Boolean);
    return mCivs.some(mc => cardCivs.includes(mc));
  });
  return hasCiv;
}

function paySummonCost(who, card) {
  const p = game[who];
  const cardCivs = (card.civilization || '').split(/[\/／・]/).map(s => s.trim()).filter(Boolean);
  const untapped = p.mana.filter(m => !m.tapped);

  // まず文明が合うマナを1枚タップ
  let civTapped = null;
  if (cardCivs.length > 0) {
    civTapped = untapped.find(m => {
      const mCivs = (m.civilization || '').split(/[\/／・]/).map(s => s.trim()).filter(Boolean);
      return mCivs.some(mc => cardCivs.includes(mc));
    });
    if (civTapped) {
      civTapped.tapped = true;
    }
  }

  // 残りを適当にタップ
  let tapped = civTapped ? 1 : 0;
  for (const m of untapped) {
    if (tapped >= card.cost) break;
    if (!m.tapped) {
      m.tapped = true;
      tapped++;
    }
  }
}

async function summonCreature(who, handIdx) {
  const p = game[who];
  const card = p.hand[handIdx];
  if (!card) return false;
  if (card.cardType === '呪文') {
    // 呪文はキャスト
    return await castSpell(who, handIdx);
  }
  if (card.cardType !== 'クリーチャー') return false;
  if (!canPaySummonCost(who, card)) return false;

  paySummonCost(who, card);
  p.hand.splice(handIdx, 1);
  const instance = {
    ...card,
    tapped: false,
    summoningSickness: !card.keywords.speedAttacker,
  };
  p.battleZone.push(instance);
  addLog(`${who === 'player' ? 'あなた' : 'AI'}が${card.name}を召喚`);
  renderDuelUI();

  // cip効果発動
  await triggerEffect(card, 'cip', who);
  return true;
}

async function castSpell(who, handIdx) {
  const p = game[who];
  const card = p.hand[handIdx];
  if (!card) return false;
  if (!canPaySummonCost(who, card)) return false;

  paySummonCost(who, card);
  p.hand.splice(handIdx, 1);
  addLog(`${who === 'player' ? 'あなた' : 'AI'}が${card.name}を唱えた`);
  renderDuelUI();

  // 呪文効果発動
  await triggerEffect(card, 'cast', who);

  // 墓地へ
  p.graveyard.push(card);
  renderDuelUI();
  return true;
}

async function playerSummon(handIdx) {
  if (game.turn !== 'player' || game.winner) return;
  if (await summonCreature('player', handIdx)) {
    renderDuelUI();
  }
}

// ========== AI効果解釈エンジン ==========
let effectCache = {}; // クライアント側キャッシュ

async function triggerEffect(card, trigger, owner) {
  if (!card.effects || card.effects.length === 0) return;
  // 解釈不要なほど単純なカードをスキップ（キーワードのみのケース）
  const effectsText = card.effects.join('\n');
  const simpleOnly = /^(ブロッカー|スピードアタッカー|W・ブレイカー|T・ブレイカー|Q・ブレイカー|スレイヤー|シールド・トリガー|S・トリガー|[　\s,、]+)+$/.test(effectsText.trim());
  if (simpleOnly) return;

  // キャッシュキー
  const cacheKey = (card.id || card.name) + '::' + trigger;
  let result = effectCache[cacheKey];

  if (!result) {
    try {
      const resp = await fetch('/api/interpret-effect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          card: {
            id: card.id,
            name: card.name,
            cardType: card.cardType,
            civilization: card.civilization,
            cost: card.cost,
            power: card.power,
            effects: card.effects,
          },
          trigger,
        }),
      });
      result = await resp.json();
      if (!/選ぶ|選んで|1体|1枚/.test(effectsText)) {
        effectCache[cacheKey] = result;
      }
    } catch (e) {
      addLog(`効果解釈エラー: ${e.message}`);
      return;
    }
  }

  if (!result || !result.actions) return;
  if (result.note) addLog(`[${card.name}の効果] ${result.note}`);

  for (const action of result.actions) {
    await executeAction(action, owner, card);
    renderDuelUI();
    await wait(300);
  }
}

async function executeAction(action, owner, sourceCard) {
  const opponent = owner === 'player' ? 'ai' : 'player';
  const me = game[owner];
  const opp = game[opponent];

  const resolveSide = (side) => {
    if (side === 'self' || side === 'my') return owner;
    if (side === 'enemy' || side === 'opponent') return opponent;
    return owner;
  };

  try {
    switch (action.type) {
      case 'draw': {
        const who = resolveSide(action.who || 'self');
        for (let i = 0; i < (action.count || 1); i++) drawCard(who);
        break;
      }
      case 'mill': {
        const who = resolveSide(action.who || 'enemy');
        for (let i = 0; i < (action.count || 1); i++) {
          const c = game[who].deck.shift();
          if (c) game[who].graveyard.push(c);
        }
        addLog(`${action.count || 1}枚を墓地へ`);
        break;
      }
      case 'destroy_choose': {
        const side = action.side || 'enemy';
        const who = side === 'any' ? null : resolveSide(side);
        const targets = collectTargets(who, action.criteria || {}, 'creature');
        await chooseAndDestroy(targets, action.count || 1, owner);
        break;
      }
      case 'destroy_all': {
        const side = action.side || 'enemy';
        const ownersToCheck = side === 'all' ? ['player', 'ai'] : [resolveSide(side)];
        for (const o of ownersToCheck) {
          const matches = game[o].battleZone.filter(c => matchCriteria(c, action.criteria || {}));
          for (const m of matches) destroyCreature(o, m);
        }
        break;
      }
      case 'bounce_choose': {
        const side = action.side || 'enemy';
        const targets = collectTargets(resolveSide(side), action.criteria || {}, 'creature');
        await chooseAndBounce(targets, action.count || 1, owner);
        break;
      }
      case 'to_mana_choose': {
        const side = action.side || 'enemy';
        const targets = collectTargets(resolveSide(side), action.criteria || {}, 'creature');
        await chooseAndToMana(targets, action.count || 1, owner);
        break;
      }
      case 'power_boost': {
        const targets = action.target === 'all_self' ? [...me.battleZone]
          : action.target === 'self' ? (sourceCard ? me.battleZone.filter(c => c.instanceId === sourceCard.instanceId) : [])
          : [];
        for (const t of targets) {
          t.powerMod = (t.powerMod || 0) + (action.amount || 0);
          t.power = (t.power || 0) + (action.amount || 0);
        }
        if (targets.length > 0) addLog(`パワー+${action.amount || 0}`);
        break;
      }
      case 'power_reduce': {
        const targets = collectTargets(opponent, action.criteria || {}, 'creature');
        await chooseAndReducePower(targets, action.amount || 0, owner);
        break;
      }
      case 'tap_choose': {
        const side = action.side || 'enemy';
        const targets = collectTargets(resolveSide(side), action.criteria || {}, 'creature').filter(t => !t.tapped);
        await chooseAndTap(targets, action.count || 1, owner);
        break;
      }
      case 'tap_all': {
        const side = action.side || 'enemy';
        const ownersToCheck = side === 'all' ? ['player', 'ai'] : [resolveSide(side)];
        for (const o of ownersToCheck) {
          game[o].battleZone.forEach(c => c.tapped = true);
        }
        break;
      }
      case 'untap_choose': {
        const side = action.side || 'self';
        const targets = collectTargets(resolveSide(side), action.criteria || {}, 'creature').filter(t => t.tapped);
        await chooseAndUntap(targets, action.count || 1, owner);
        break;
      }
      case 'summon_from_grave': {
        const candidates = me.graveyard.filter(c => c.cardType === 'クリーチャー' && matchCriteria(c, action.criteria || {}));
        await chooseAndSummonFromGrave(candidates, 1, owner);
        break;
      }
      case 'search_deck': {
        // 山札から条件合致を探す（簡易版: 最初に見つかったものを手札へ）
        const dest = action.destination || 'hand';
        const criteria = action.criteria || {};
        const idx = me.deck.findIndex(c => matchCriteria(c, criteria));
        if (idx >= 0) {
          const card = me.deck.splice(idx, 1)[0];
          if (dest === 'hand') me.hand.push(card);
          else if (dest === 'mana') me.mana.push({ ...card, tapped: false });
          else if (dest === 'battle' && card.cardType === 'クリーチャー') {
            me.battleZone.push({ ...card, tapped: false, summoningSickness: true });
          }
          shuffleDeck(owner);
          addLog(`山札から${card.name}を${dest === 'hand' ? '手札' : dest === 'mana' ? 'マナ' : 'バトルゾーン'}に`);
        }
        break;
      }
      case 'grant_keyword': {
        const targets = action.target === 'all_self' ? me.battleZone : (sourceCard ? me.battleZone.filter(c => c.instanceId === sourceCard.instanceId) : []);
        for (const t of targets) {
          if (!t.keywords) t.keywords = {};
          if (action.keyword === 'blocker') t.keywords.blocker = true;
          if (action.keyword === 'speed_attacker') { t.keywords.speedAttacker = true; t.summoningSickness = false; }
          if (action.keyword === 'slayer') t.keywords.slayer = true;
          if (action.keyword === 'w_breaker') t.keywords.breaker = Math.max(t.keywords.breaker || 1, 2);
          if (action.keyword === 't_breaker') t.keywords.breaker = Math.max(t.keywords.breaker || 1, 3);
          if (action.keyword === 'q_breaker') t.keywords.breaker = Math.max(t.keywords.breaker || 1, 4);
        }
        if (targets.length > 0) addLog(`能力付与: ${action.keyword}`);
        break;
      }
      case 'break_extra_shields': {
        // 次の攻撃時に追加ブレイク（簡易版: sourceCardのブレイカーを上げる）
        if (sourceCard) {
          const inBZ = me.battleZone.find(c => c.instanceId === sourceCard.instanceId);
          if (inBZ) {
            inBZ.keywords.breaker = Math.max(inBZ.keywords.breaker, (action.count || 1) + 1);
          }
        }
        break;
      }
      case 'no_effect':
        break;
      case 'require_player_choice':
        // 簡易版: プロンプトをログに出すだけ
        addLog(`[選択効果] ${action.prompt || ''}`);
        break;
      default:
        addLog(`(未対応: ${action.type})`);
    }
  } catch (e) {
    console.error('executeAction error:', e);
  }
}

function shuffleDeck(who) {
  game[who].deck = shuffle(game[who].deck);
}

function collectTargets(who, criteria, kind = 'creature') {
  const ownersToCheck = who ? [who] : ['player', 'ai'];
  const targets = [];
  for (const o of ownersToCheck) {
    for (const c of game[o].battleZone) {
      if (matchCriteria(c, criteria)) targets.push({ card: c, owner: o });
    }
  }
  return targets;
}

function matchCriteria(card, criteria) {
  if (!criteria) return true;
  if (criteria.cost_max !== undefined && (card.cost || 0) > criteria.cost_max) return false;
  if (criteria.cost_min !== undefined && (card.cost || 0) < criteria.cost_min) return false;
  if (criteria.power_max !== undefined && (card.power || 0) > criteria.power_max) return false;
  if (criteria.power_min !== undefined && (card.power || 0) < criteria.power_min) return false;
  if (criteria.civilization && criteria.civilization.length > 0) {
    const cc = (card.civilization || '').split(/[\/／・]/).map(s => s.trim());
    if (!criteria.civilization.some(x => cc.includes(x))) return false;
  }
  if (criteria.card_type && card.cardType && !card.cardType.includes(criteria.card_type)) return false;
  if (criteria.race && !(card.race || '').includes(criteria.race)) return false;
  return true;
}

// ========== 対象選択UI ==========
async function chooseTargets(targets, count, owner, prompt) {
  if (targets.length === 0) return [];
  if (targets.length <= count) return targets;
  if (owner === 'ai') {
    return aiChooseTargets(targets, count);
  }
  return await askPlayerChooseTargets(targets, count, prompt);
}

function aiChooseTargets(targets, count) {
  // 弱い相手から順に（パワー低い順）
  const sorted = [...targets].sort((a, b) => (b.card.power || 0) - (a.card.power || 0));
  return sorted.slice(0, count);
}

function askPlayerChooseTargets(targets, count, prompt) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.85);z-index:500;display:flex;justify-content:center;align-items:center;padding:16px;';
    const selected = [];
    const render = () => {
      overlay.innerHTML = `
        <div style="background:var(--bg-card);border:2px solid var(--border-color);border-radius:12px;padding:16px;max-width:500px;width:100%;max-height:90vh;overflow-y:auto;">
          <h3 style="margin-bottom:10px;">🎯 ${prompt || '選択してください'}</h3>
          <div style="color:var(--text-secondary);margin-bottom:10px;font-size:0.85rem;">${selected.length}/${count}枚選択中</div>
          <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px;">
            ${targets.map((t, i) => {
              const sel = selected.includes(i);
              return `<div data-i="${i}" style="background:${sel ? 'var(--accent-water)' : 'var(--bg-hover)'};padding:8px;border-radius:6px;cursor:pointer;font-size:0.85rem;border:2px solid ${sel ? 'var(--accent-light)' : 'transparent'};">
                <div style="font-weight:bold;">${t.card.name}</div>
                <div style="font-size:0.7rem;opacity:0.8;">${t.owner === 'player' ? '自分' : '相手'} / P${t.card.power || '-'}</div>
              </div>`;
            }).join('')}
          </div>
          <div style="display:flex;gap:8px;">
            <button id="confirmChoice" ${selected.length === 0 ? 'disabled' : ''} style="flex:1;padding:8px;background:${selected.length > 0 ? 'var(--accent-water)' : 'var(--bg-hover)'};border:none;color:white;border-radius:6px;cursor:pointer;">決定</button>
            <button id="cancelChoice" style="padding:8px 16px;background:var(--bg-hover);border:1px solid var(--border-color);color:var(--text-primary);border-radius:6px;cursor:pointer;">効果なしで終了</button>
          </div>
        </div>
      `;
      overlay.querySelectorAll('[data-i]').forEach(el => {
        el.onclick = () => {
          const i = parseInt(el.dataset.i);
          const pos = selected.indexOf(i);
          if (pos >= 0) selected.splice(pos, 1);
          else if (selected.length < count) selected.push(i);
          render();
        };
      });
      overlay.querySelector('#confirmChoice').onclick = () => {
        document.body.removeChild(overlay);
        resolve(selected.map(i => targets[i]));
      };
      overlay.querySelector('#cancelChoice').onclick = () => {
        document.body.removeChild(overlay);
        resolve([]);
      };
    };
    render();
    document.body.appendChild(overlay);
  });
}

async function chooseAndDestroy(targets, count, owner) {
  const chosen = await chooseTargets(targets, count, owner, `破壊するクリーチャーを${count}体選んでください`);
  for (const t of chosen) destroyCreature(t.owner, t.card);
}

async function chooseAndBounce(targets, count, owner) {
  const chosen = await chooseTargets(targets, count, owner, `手札に戻すクリーチャーを${count}体選んでください`);
  for (const t of chosen) {
    const idx = game[t.owner].battleZone.findIndex(c => c.instanceId === t.card.instanceId);
    if (idx >= 0) {
      const c = game[t.owner].battleZone.splice(idx, 1)[0];
      game[t.owner].hand.push(c);
      addLog(`${c.name}を手札に戻す`);
    }
  }
}

async function chooseAndToMana(targets, count, owner) {
  const chosen = await chooseTargets(targets, count, owner, `マナゾーンに送るクリーチャーを${count}体選んでください`);
  for (const t of chosen) {
    const idx = game[t.owner].battleZone.findIndex(c => c.instanceId === t.card.instanceId);
    if (idx >= 0) {
      const c = game[t.owner].battleZone.splice(idx, 1)[0];
      game[t.owner].mana.push({ ...c, tapped: false });
      addLog(`${c.name}をマナに送る`);
    }
  }
}

async function chooseAndTap(targets, count, owner) {
  const chosen = await chooseTargets(targets, count, owner, `タップするクリーチャーを${count}体選んでください`);
  for (const t of chosen) t.card.tapped = true;
}

async function chooseAndUntap(targets, count, owner) {
  const chosen = await chooseTargets(targets, count, owner, `アンタップするクリーチャーを${count}体選んでください`);
  for (const t of chosen) t.card.tapped = false;
}

async function chooseAndReducePower(targets, amount, owner) {
  const chosen = await chooseTargets(targets, 1, owner, `パワー-${amount}するクリーチャーを選んでください`);
  for (const t of chosen) {
    t.card.power = Math.max(0, (t.card.power || 0) - amount);
    if (t.card.power <= 0) destroyCreature(t.owner, t.card);
  }
}

async function chooseAndSummonFromGrave(candidates, count, owner) {
  if (candidates.length === 0) return;
  if (owner === 'ai') {
    // AI: 一番強いクリーチャーを選ぶ
    candidates.sort((a, b) => (b.power || 0) - (a.power || 0));
    const toSummon = candidates.slice(0, count);
    for (const c of toSummon) {
      const idx = game[owner].graveyard.findIndex(x => x.instanceId === c.instanceId);
      if (idx >= 0) {
        const card = game[owner].graveyard.splice(idx, 1)[0];
        game[owner].battleZone.push({ ...card, tapped: false, summoningSickness: true });
        addLog(`墓地から${card.name}を召喚`);
      }
    }
  } else {
    const targets = candidates.map(c => ({ card: c, owner }));
    const chosen = await chooseTargets(targets, count, owner, `墓地から召喚するクリーチャーを選んでください`);
    for (const t of chosen) {
      const idx = game[owner].graveyard.findIndex(x => x.instanceId === t.card.instanceId);
      if (idx >= 0) {
        const card = game[owner].graveyard.splice(idx, 1)[0];
        game[owner].battleZone.push({ ...card, tapped: false, summoningSickness: true });
        addLog(`墓地から${card.name}を召喚`);
      }
    }
  }
}

function playerChargeMana(handIdx) {
  chargeMana(handIdx);
}

// ========== 攻撃 ==========
function canAttack(who, creature) {
  if (game.turn !== who) return false;
  if (creature.tapped) return false;
  if (creature.summoningSickness && !creature.keywords.speedAttacker) return false;
  return true;
}

function selectAttacker(instanceId) {
  if (game.turn !== 'player' || game.winner) return;
  const creature = game.player.battleZone.find(c => c.instanceId === instanceId);
  if (!creature) return;
  if (!canAttack('player', creature)) return;
  game.selectedAttacker = game.selectedAttacker === instanceId ? null : instanceId;
  renderDuelUI();
}

function attackShield(shieldIdx) {
  if (!game.selectedAttacker || game.turn !== 'player' || game.winner) return;
  const attacker = game.player.battleZone.find(c => c.instanceId === game.selectedAttacker);
  if (!attacker) return;
  if (attacker.keywords.cannotAttackPlayer) {
    alert('このクリーチャーはプレイヤーを攻撃できません');
    return;
  }
  executeAttack('player', attacker, 'shield', shieldIdx);
}

function attackCreature(instanceId) {
  if (!game.selectedAttacker || game.turn !== 'player' || game.winner) return;
  const attacker = game.player.battleZone.find(c => c.instanceId === game.selectedAttacker);
  const defender = game.ai.battleZone.find(c => c.instanceId === instanceId);
  if (!attacker || !defender) return;
  if (!defender.tapped) {
    // タップされていない相手は攻撃できない（ブロッカー除く）
    alert('タップされていないクリーチャーは攻撃できません');
    return;
  }
  if (attacker.keywords.cannotAttackCreature) {
    alert('このクリーチャーはクリーチャーを攻撃できません');
    return;
  }
  executeAttack('player', attacker, 'creature', instanceId);
}

function attackPlayer() {
  if (!game.selectedAttacker || game.turn !== 'player' || game.winner) return;
  const attacker = game.player.battleZone.find(c => c.instanceId === game.selectedAttacker);
  if (!attacker) return;
  if (game.ai.shields.length > 0) { alert('シールドが残っています'); return; }
  if (attacker.keywords.cannotAttackPlayer) return;
  executeAttack('player', attacker, 'direct');
}

function executeAttack(attackerOwner, attacker, targetType, targetIdx) {
  const defenderOwner = attackerOwner === 'player' ? 'ai' : 'player';
  attacker.tapped = true;
  addLog(`${attacker.name}が攻撃`);

  // ブロッカー処理（防御側）
  if (targetType !== 'creature') {
    const blocker = findBlocker(defenderOwner);
    if (blocker) {
      if (attackerOwner === 'ai' && defenderOwner === 'player') {
        // AIの攻撃をプレイヤーがブロックするか確認
        askBlockerChoice(attacker, blocker, () => processBlock(attacker, blocker, attackerOwner, defenderOwner));
        return;
      } else if (attackerOwner === 'player' && defenderOwner === 'ai') {
        // AIが自動でブロックするか判断
        if (shouldAiBlock(attacker, blocker)) {
          processBlock(attacker, blocker, attackerOwner, defenderOwner);
          return;
        }
      }
    }
  }

  if (targetType === 'shield') {
    breakShields(defenderOwner, attacker);
  } else if (targetType === 'creature') {
    const defender = game[defenderOwner].battleZone.find(c => c.instanceId === targetIdx);
    if (defender) battle(attacker, defender, attackerOwner, defenderOwner);
  } else if (targetType === 'direct') {
    game.winner = attackerOwner;
    addLog(`🎉 ${attackerOwner === 'player' ? 'あなた' : 'AI'}の勝利！`);
  }

  game.selectedAttacker = null;
  renderDuelUI();
  checkWin();
}

function findBlocker(who) {
  return game[who].battleZone.find(c => c.keywords.blocker && !c.tapped);
}

function shouldAiBlock(attacker, blocker) {
  // AIのブロック判断
  if (game.difficulty === 'easy') return Math.random() < 0.3;
  // バトルに勝てるなら必ずブロック
  if (blocker.power >= attacker.power) return true;
  // 相手の攻撃で負ける状況なら道連れブロック
  const shieldsLeft = game.ai.shields.length;
  if (shieldsLeft <= 1) return true;
  if (game.difficulty === 'normal') return Math.random() < 0.4;
  if (game.difficulty === 'hard') return Math.random() < 0.7;
  return false;
}

function askBlockerChoice(attacker, blocker, noBlockCallback) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.8);z-index:400;display:flex;justify-content:center;align-items:center;padding:16px;';
  overlay.innerHTML = `
    <div style="background:var(--bg-card);border:2px solid var(--border-color);border-radius:14px;padding:20px;max-width:400px;">
      <h2 style="text-align:center;margin-bottom:12px;">🛡 ブロッカー</h2>
      <div style="margin-bottom:14px;text-align:center;">
        <div>${attacker.name}の攻撃</div>
        <div style="color:var(--accent-water);margin-top:6px;">${blocker.name}でブロックしますか？</div>
      </div>
      <div style="display:flex;gap:8px;">
        <button id="blockYes" style="flex:1;padding:10px;background:var(--accent-water);border:none;color:white;border-radius:6px;cursor:pointer;">ブロック</button>
        <button id="blockNo" style="flex:1;padding:10px;background:var(--bg-hover);border:1px solid var(--border-color);color:var(--text-primary);border-radius:6px;cursor:pointer;">通過</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector('#blockYes').onclick = () => {
    document.body.removeChild(overlay);
    processBlock(attacker, blocker, 'ai', 'player');
  };
  overlay.querySelector('#blockNo').onclick = () => {
    document.body.removeChild(overlay);
    noBlockCallback();
  };
}

function processBlock(attacker, blocker, attackerOwner, defenderOwner) {
  addLog(`${blocker.name}でブロック`);
  blocker.tapped = true;
  battle(attacker, blocker, attackerOwner, defenderOwner);
  renderDuelUI();
  if (game.turn === 'ai' && !game.winner) {
    setTimeout(() => aiContinueAttack(), 800);
  }
}

function battle(a, b, aOwner, bOwner) {
  addLog(`${a.name}(${a.power}) vs ${b.name}(${b.power})`);
  const aP = a.power, bP = b.power;
  if (aP > bP) {
    destroyCreature(bOwner, b);
    if (a.keywords.slayer || b.keywords.slayer) destroyCreature(aOwner, a);
  } else if (bP > aP) {
    destroyCreature(aOwner, a);
    if (b.keywords.slayer || a.keywords.slayer) destroyCreature(bOwner, b);
  } else {
    destroyCreature(aOwner, a);
    destroyCreature(bOwner, b);
  }
}

function destroyCreature(who, creature) {
  const p = game[who];
  const idx = p.battleZone.findIndex(c => c.instanceId === creature.instanceId);
  if (idx >= 0) {
    p.battleZone.splice(idx, 1);
    p.graveyard.push(creature);
    addLog(`${creature.name}が破壊された`);
    // pig効果（非同期、ゲーム進行は待たない）
    triggerEffect(creature, 'pig', who).catch(() => {});
  }
}

function breakShields(who, attacker) {
  const p = game[who];
  let count = getBreakCount(attacker);
  if (count === 99 || count > p.shields.length) count = p.shields.length;
  const broken = p.shields.splice(0, count);
  addLog(`シールドを${broken.length}枚ブレイク`);
  // S・トリガー処理
  const triggers = broken.filter(s => s.keywords?.shieldTrigger);
  for (const s of broken) {
    s.faceDown = false;
  }
  // 手札に加える（S・トリガーの使用選択は簡易的に、今回は無料で使用しない）
  for (const s of broken) {
    p.hand.push(s);
    // TODO: S・トリガー使用の確認UI（現時点では手札に加えるのみ）
  }
}

function checkWin() {
  if (game.winner) {
    renderDuelUI();
  }
}

function endTurn() {
  if (game.winner) return;
  // 手札上限（7枚）- 簡易版
  game.turn = game.turn === 'player' ? 'ai' : 'player';
  if (game.turn === 'player') game.turnNumber++;
  startTurn();
}

// ========== AI ==========
async function aiTakeTurn() {
  if (game.winner) return;
  const ai = game.ai;

  // 1. マナチャージ: 状況に応じて
  if (!game.hasCharged && ai.hand.length > 0) {
    const manaIdx = chooseAiManaCharge();
    if (manaIdx >= 0) {
      const card = ai.hand[manaIdx];
      ai.hand.splice(manaIdx, 1);
      ai.mana.push({ ...card, tapped: false });
      game.hasCharged = true;
      addLog(`AIがマナをチャージ`);
      renderDuelUI();
      await wait(600);
    }
  }

  // 2. クリーチャー召喚: できるだけ多く
  let summoned = true;
  while (summoned && !game.winner) {
    summoned = false;
    const playableIdx = findBestCreatureToPlay();
    if (playableIdx >= 0) {
      await summonCreature('ai', playableIdx);
      renderDuelUI();
      summoned = true;
      await wait(600);
    }
  }

  // 3. 攻撃
  await aiAttackPhase();

  if (!game.winner) {
    addLog('AIのターン終了');
    await wait(500);
    endTurn();
  }
}

function chooseAiManaCharge() {
  const hand = game.ai.hand;
  if (hand.length === 0) return -1;
  // 難易度別
  if (game.difficulty === 'easy') {
    return Math.floor(Math.random() * hand.length);
  }
  // 今使えるカードがあれば、それ以外からマナチャージ
  const canPlay = hand.map((c, i) => ({ c, i, can: canPaySummonCost('ai', c) && c.cardType === 'クリーチャー' }));
  const cantPlay = canPlay.filter(x => !x.can);
  // 使えないカードがあればその中で一番コストが低いものをマナに
  if (cantPlay.length > 0) {
    cantPlay.sort((a, b) => a.c.cost - b.c.cost);
    return cantPlay[0].i;
  }
  // 全部使えるなら一番コストの低いものをマナに
  const sorted = canPlay.slice().sort((a, b) => a.c.cost - b.c.cost);
  return sorted[0].i;
}

function findBestCreatureToPlay() {
  const hand = game.ai.hand;
  // クリーチャーと呪文の両方を候補に
  const playable = hand
    .map((c, i) => ({ c, i }))
    .filter(x => (x.c.cardType === 'クリーチャー' || x.c.cardType === '呪文') && canPaySummonCost('ai', x.c));
  if (playable.length === 0) return -1;
  if (game.difficulty === 'easy') {
    return playable[Math.floor(Math.random() * playable.length)].i;
  }
  // 普通/強い: 一番コストが高い=強いカードを優先
  playable.sort((a, b) => b.c.cost - a.c.cost);
  return playable[0].i;
}

async function aiAttackPhase() {
  if (game.winner) return;
  const attackers = game.ai.battleZone.filter(c => canAttack('ai', c));
  if (attackers.length === 0) return;

  for (const attacker of attackers) {
    if (game.winner) break;
    // 難易度別の判断
    const action = decideAiAttack(attacker);
    if (!action) continue;
    await wait(700);
    if (action.target === 'direct') {
      executeAttack('ai', attacker, 'direct');
    } else if (action.target === 'shield') {
      executeAttack('ai', attacker, 'shield', 0);
    } else if (action.target === 'creature') {
      executeAttack('ai', attacker, 'creature', action.instanceId);
    }
    renderDuelUI();
    await wait(400);
  }
}

async function aiContinueAttack() {
  // ブロックされた後の続行処理
  if (game.winner) return;
  await aiAttackPhase();
  if (!game.winner) {
    addLog('AIのターン終了');
    await wait(500);
    endTurn();
  }
}

function decideAiAttack(attacker) {
  if (attacker.keywords.cannotAttackPlayer && attacker.keywords.cannotAttackCreature) return null;
  const canAttackP = !attacker.keywords.cannotAttackPlayer;
  const canAttackC = !attacker.keywords.cannotAttackCreature;
  const tappedEnemies = game.player.battleZone.filter(c => c.tapped);
  const playerShields = game.player.shields.length;

  if (game.difficulty === 'easy') {
    // ランダムな判断
    if (canAttackP && playerShields === 0) return { target: 'direct' };
    if (canAttackP && Math.random() < 0.7) return { target: 'shield' };
    if (canAttackC && tappedEnemies.length > 0) {
      const target = tappedEnemies[Math.floor(Math.random() * tappedEnemies.length)];
      return { target: 'creature', instanceId: target.instanceId };
    }
    if (canAttackP) return { target: 'shield' };
    return null;
  }

  if (game.difficulty === 'normal' || game.difficulty === 'hard') {
    // ダイレクトアタック可能なら勝ち
    if (canAttackP && playerShields === 0) return { target: 'direct' };

    // タップされた強い相手を優先破壊
    const beatable = tappedEnemies.filter(t => t.power < attacker.power && canAttackC);
    if (beatable.length > 0) {
      beatable.sort((a, b) => b.power - a.power);
      return { target: 'creature', instanceId: beatable[0].instanceId };
    }

    // シールドを積極的に攻撃
    if (canAttackP && playerShields > 0) {
      return { target: 'shield' };
    }

    if (canAttackC && tappedEnemies.length > 0) {
      return { target: 'creature', instanceId: tappedEnemies[0].instanceId };
    }
    if (canAttackP) return { target: 'shield' };
  }

  return null;
}

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

// ========== UI描画 ==========
function renderDuelUI() {
  const area = document.getElementById('resultsArea');
  if (!area || !game) return;
  const isPlayerTurn = game.turn === 'player';

  area.innerHTML = `
    <div class="duel-field">
      ${renderPlayerArea('ai', false)}
      <div class="duel-center">
        ${game.winner ? `<div class="duel-winner">${game.winner === 'player' ? '🎉 勝利！' : '😔 敗北...'}</div>` : ''}
        ${game.winner ? `<button onclick="showMyDecks()" style="padding:10px 20px;background:var(--accent-water);border:none;color:white;border-radius:8px;cursor:pointer;font-size:1rem;">デッキ一覧に戻る</button>` : ''}
        ${!game.winner && isPlayerTurn ? `<button class="duel-end-btn" onclick="endTurn()">ターン終了</button>` : ''}
        <div class="duel-turn-indicator">${isPlayerTurn ? '🟢 あなたのターン' : '🔴 AIのターン'} (T${game.turnNumber})</div>
        <div class="duel-log">${game.log.slice(-4).map(l => `<div>${l}</div>`).join('')}</div>
      </div>
      ${renderPlayerArea('player', true)}
    </div>
  `;
}

function renderPlayerArea(who, isMe) {
  const p = game[who];
  const label = isMe ? 'あなた' : 'AI';
  const bz = p.battleZone.map(c => renderBattleCard(c, who)).join('');
  const shields = p.shields.map((s, i) => `<div class="shield-card" onclick="${isMe ? 'javascript:void(0)' : `attackShield(${i})`}">🛡</div>`).join('');
  const mana = p.mana.map(m => {
    const c = (m.civilization || '').split(/[\/／・]/)[0].trim();
    const civClass = civClassOf(c);
    return `<div class="mana-card ${m.tapped ? 'tapped' : ''} ${civClass}">${c || '?'}</div>`;
  }).join('');

  const handHtml = isMe
    ? p.hand.map((c, i) => renderHandCard(c, i)).join('')
    : p.hand.map(() => '<div class="hand-card-back">🂠</div>').join('');

  return `
    <div class="player-area ${isMe ? 'me' : 'opponent'}">
      <div class="player-info">
        <span>${label}</span>
        <span>山札: ${p.deck.length}</span>
        <span>手札: ${p.hand.length}</span>
        <span>墓地: ${p.graveyard.length}</span>
      </div>
      <div class="zone shield-zone">${shields || '<div style="color:var(--text-secondary);font-size:0.8rem;">シールドなし</div>'}</div>
      <div class="zone battle-zone" ${game.selectedAttacker && !isMe ? 'data-targetable="true"' : ''}>${bz || '<div style="color:var(--text-secondary);font-size:0.75rem;padding:10px;">バトルゾーン</div>'}</div>
      <div class="zone mana-zone">${mana || '<div style="color:var(--text-secondary);font-size:0.75rem;">マナゾーン</div>'}</div>
      <div class="zone hand-zone">${handHtml || '<div style="color:var(--text-secondary);font-size:0.75rem;">手札</div>'}</div>
    </div>
  `;
}

function renderBattleCard(c, who) {
  const selected = game.selectedAttacker === c.instanceId;
  const clickable = who === 'player'
    ? canAttack('player', c) && game.turn === 'player'
    : game.selectedAttacker !== null;
  const onclick = who === 'player' ? `selectAttacker('${c.instanceId}')` : (game.selectedAttacker ? `attackCreature('${c.instanceId}')` : '');
  const civ = (c.civilization || '').split(/[\/／・]/)[0].trim();
  const civClass = civClassOf(civ);
  return `
    <div class="battle-card ${civClass} ${c.tapped ? 'tapped' : ''} ${c.summoningSickness && !c.keywords.speedAttacker ? 'sick' : ''} ${selected ? 'selected' : ''} ${clickable ? 'clickable' : ''}" ${onclick ? `onclick="${onclick}"` : ''}>
      <div class="bc-name">${c.name}</div>
      <div class="bc-power">${c.power}</div>
      ${c.keywords.blocker ? '<div class="bc-kw">🛡</div>' : ''}
      ${c.keywords.speedAttacker ? '<div class="bc-kw">⚡</div>' : ''}
      ${c.keywords.breaker > 1 ? `<div class="bc-breaker">${c.keywords.breaker === 99 ? 'W!' : c.keywords.breaker}</div>` : ''}
    </div>
  `;
}

function renderHandCard(c, i) {
  const isCreature = c.cardType === 'クリーチャー';
  const isSpell = c.cardType === '呪文';
  const canPlay = game.turn === 'player' && !game.winner && (isCreature || isSpell) && canPaySummonCost('player', c);
  const canCharge = game.turn === 'player' && !game.hasCharged && !game.winner;
  const civ = (c.civilization || '').split(/[\/／・]/)[0].trim();
  const civClass = civClassOf(civ);
  const playLabel = isCreature ? '召喚' : (isSpell ? '唱える' : '使用');
  return `
    <div class="hand-card ${civClass}">
      <div class="hc-cost">${c.cost}</div>
      <div class="hc-name">${c.name}</div>
      <div class="hc-power">${c.power || (isSpell ? '呪文' : '')}</div>
      <div class="hc-actions">
        ${canPlay ? `<button onclick="playerSummon(${i})">${playLabel}</button>` : ''}
        ${canCharge ? `<button onclick="playerChargeMana(${i})">マナ</button>` : ''}
      </div>
    </div>
  `;
}

function civClassOf(civ) {
  return {
    '火': 'civ-fire',
    '水': 'civ-water',
    '自然': 'civ-nature',
    '光': 'civ-light',
    '闇': 'civ-darkness',
  }[civ] || 'civ-zero';
}

// 設定メニューから対戦タブを切り替え時の初期化
function initBattleTab() {
  const area = document.getElementById('resultsArea');
  if (!area) return;
  // デッキがあればマイデッキを表示、なければ新規作成
  const decks = getDecks();
  if (decks.length > 0) {
    showMyDecks();
  } else {
    area.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:30px;gap:16px;">
        <div style="font-size:3rem;">⚔</div>
        <h2>デュエル</h2>
        <p style="color:var(--text-secondary);text-align:center;">まずはデッキを作ろう！<br>カードを40枚集めてAIと対戦できます。</p>
        <button onclick="newDeck()" style="padding:12px 24px;background:var(--accent-water);border:none;color:white;border-radius:8px;cursor:pointer;font-size:1.05rem;">+ 新規デッキ作成</button>
      </div>
    `;
  }
}
