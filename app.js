const STORAGE_KEY = "kabu-watchlist";

const listEl = document.getElementById("list");
const emptyEl = document.getElementById("empty");
const form = document.getElementById("addForm");
const input = document.getElementById("symbolInput");
const refreshBtn = document.getElementById("refreshBtn");
const indexStripEl = document.getElementById("indexStrip");
const n225MarketsEl = document.getElementById("n225Markets");
const n225SectorsEl = document.getElementById("n225Sectors");
const n225UpEl = document.getElementById("n225Up");
const n225DownEl = document.getElementById("n225Down");
const n225HeatmapEl = document.getElementById("n225Heatmap");
const dowMarketsEl = document.getElementById("dowMarkets");
const dowSectorsEl = document.getElementById("dowSectors");
const dowUpEl = document.getElementById("dowUp");
const dowDownEl = document.getElementById("dowDown");
const dowHeatmapEl = document.getElementById("dowHeatmap");
const ndxMarketsEl = document.getElementById("ndxMarkets");
const ndxSectorsEl = document.getElementById("ndxSectors");
const ndxUpEl = document.getElementById("ndxUp");
const ndxDownEl = document.getElementById("ndxDown");
const ndxHeatmapEl = document.getElementById("ndxHeatmap");
const heatmapEl = document.getElementById("heatmapView");
const newsListEl = document.getElementById("newsList");

// 主要指数
const INDICES = [
  { symbol: "^IXIC", label: "NASDAQ" },
  { symbol: "^GSPC", label: "S&P 500" },
  { symbol: "^DJI",  label: "Dow Jones" },
  { symbol: "^N225", label: "日経225" },
];

// 取得済み価格のキャッシュ（セクター・ヒートマップで共有）
const quoteCache = new Map();
// ウォッチリスト各銘柄の最新価格（アラート判定用）
const lastPrice = new Map();
const watchData = new Map(); // ウォッチリスト各銘柄の最新データ（並び替え用）
let usdJpyRate = null;       // ドル円レート（円換算表示用）

let heatmapBuilt = false;
let n225Built = false;
let dowBuilt = false;
let ndxBuilt = false;
let heatmapMode = "sectors";
let newsRegion = "US";
let newsLoaded = false;
const newsPage   = { US: 0, JP: 0 };
const newsSeen   = { US: new Set(), JP: new Set() };
let newsLoadingMore = false;
let usSectorsSorted = false;
let jpSectorsSorted = false;
let irLoaded = false;
let irFilter = "important";
const ALERT_KEY = "kabu-alerts";
let alerts = loadAlerts();
const alertFired = {}; // {symbol: {above:bool, below:bool}} 連続通知の抑制用
// IR新着通知
const IR_NOTIFY_KEY = "kabu-ir-notify";
let irNotifyEnabled = localStorage.getItem(IR_NOTIFY_KEY) === "1";
const seenIR = new Set();      // 既に確認済みの開示ID
let irNotifySeeded = false;    // 初回は通知せず既存分を覚えるだけ

let symbols = loadSymbols();

function loadSymbols() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveSymbols() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(symbols));
}

function addSymbol(raw) {
  const symbol = raw.trim().toUpperCase();
  if (!symbol) return;
  if (symbols.includes(symbol)) {
    flashCard(symbol);
    return;
  }
  symbols.push(symbol);
  saveSymbols();
  createCard(symbol);
  updateEmpty();
  fetchOne(symbol);
  loadWatchMetrics();
  if (symbol.endsWith(".T")) irNotifySeeded = false; // 新しい日本株の既存開示で通知が殺到しないよう覚え直す
  if (typeof syncPushSymbols === "function") syncPushSymbols(); // 通知の監視銘柄を更新
}

/* ===== 銘柄名 → コード解決（日本株を「名前」で追加できるように） ===== */
let _jpNameList = null;
function normName(s) {
  // 比較用に正規化：空白・中点・カンマ等を除去し、よくある表記ゆれを統一
  return String(s)
    .replace(/[\s\u3000・,，.]/g, "")
    .replace(/ホールディングス/g, "HD")
    .replace(/グループ/g, "G")
    .toLowerCase();
}
function jpNameList() {
  if (_jpNameList) return _jpNameList;
  const list = [];
  const seen = new Set();
  const add = (code, name) => {
    if (!code || !name || !String(code).endsWith(".T")) return;
    const key = normName(name);
    const id = key + "|" + code;
    if (!key || seen.has(id)) return;
    seen.add(id);
    list.push({ key, name, code });
  };
  // 既存の日本株データから名前→コード辞書を構築
  try { N225_CONSTITUENTS.forEach(([c, n]) => add(c, n)); } catch (e) {}
  try { [...JP_SECTORS, ...SEMI_GROUPS].forEach((s) => (s.stocks || []).forEach(([c, n]) => add(c, n))); } catch (e) {}
  try { JP_MARKETS.forEach((m) => add(m.symbol, m.label)); } catch (e) {}
  _jpNameList = list;
  return list;
}
// 入力（コード or 日本語名）を Yahoo シンボルへ解決。辞書で見つからなければ null。
function resolveLocalSymbol(raw) {
  const t = String(raw || "").trim();
  if (!t) return null;
  const hasJa = /[ぁ-んァ-ヶ一-龠ーａ-ｚＡ-Ｚ]/.test(t);
  if (!hasJa) {
    if (/^[0-9]{4}[A-Za-z]?$/.test(t)) return t.toUpperCase() + ".T"; // 4桁コード→東証(.T)を自動付与
    if (/^\^?[A-Za-z0-9][A-Za-z0-9.\-=]{0,9}$/.test(t)) return t.toUpperCase(); // 通常ティッカー/指数/為替
    return null; // 英語の社名などは Yahoo 検索に回す
  }
  // 日本語名 → コード（完全一致 → 前方一致 → 部分一致。複数あれば最短名を優先）
  const list = jpNameList();
  const n = normName(t);
  const pickShortest = (arr) => arr.reduce((a, b) => (b.key.length < a.key.length ? b : a));
  let hit = list.find((e) => e.key === n);
  if (!hit) { const c = list.filter((e) => e.key.startsWith(n)); if (c.length) hit = pickShortest(c); }
  if (!hit) { const c = list.filter((e) => e.key.includes(n)); if (c.length) hit = pickShortest(c); }
  return hit ? hit.code : null;
}
// オートコンプリート用：ローカル辞書から名前で前方/部分一致の候補を返す（漢字社名にも対応）
function localSearchMatches(q, limit = 6) {
  const n = normName(q);
  if (!n) return [];
  const list = jpNameList();
  const starts = [], incl = [];
  for (const e of list) {
    if (e.key === n || e.key.startsWith(n)) starts.push(e);
    else if (e.key.includes(n)) incl.push(e);
  }
  const seen = new Set(), out = [];
  for (const e of [...starts, ...incl]) {
    if (seen.has(e.code)) continue;
    seen.add(e.code);
    out.push({ symbol: e.code, name: e.name, exch: "東証", type: "EQUITY" });
    if (out.length >= limit) break;
  }
  return out;
}

// 辞書で解決できなければ Yahoo 検索でフォールバック
async function smartResolveSymbol(raw) {
  const t = String(raw || "").trim();
  if (!t) return null;
  const local = resolveLocalSymbol(t);
  if (local) return local;
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(t)}`);
    const d = await res.json();
    const q = (d.quotes || []).find((x) => x.symbol);
    if (q) return q.symbol;
  } catch (e) {}
  return null;
}

function removeSymbol(symbol) {
  symbols = symbols.filter((s) => s !== symbol);
  saveSymbols();
  const card = document.getElementById(cardId(symbol));
  if (card) card.remove();
  updateEmpty();
  if (typeof syncPushSymbols === "function") syncPushSymbols();
}

function updateEmpty() {
  emptyEl.style.display = symbols.length ? "none" : "block";
}

function cardId(symbol) {
  return "card-" + symbol.replace(/[^A-Z0-9]/g, "_");
}

function createCard(symbol) {
  const card = document.createElement("div");
  card.className = "card loading";
  card.id = cardId(symbol);
  card.innerHTML = `
    <button class="remove" title="削除">×</button>
    <button class="bell" title="価格アラートを設定">🔔</button>
    <div class="name">${symbol}</div>
    <div class="symbol">${symbol}</div>
    <div class="alert-badge"></div>
    <div class="price">— 読み込み中</div>
    <div class="price-jpy"></div>
    <div class="change flat">&nbsp;</div>
    <div class="after-hours" hidden></div>
    <svg class="spark" viewBox="0 0 300 56" preserveAspectRatio="none"></svg>
    <div class="metrics" hidden>
      <span class="m"><b>PER</b><span data-k="per">—</span></span>
      <span class="m"><b>PBR</b><span data-k="pbr">—</span></span>
      <span class="m"><b>利回り</b><span data-k="yield">—</span></span>
      <span class="m"><b>出来高</b><span data-k="vol">—</span></span>
      <span class="m"><b>時価総額</b><span data-k="cap">—</span></span>
    </div>
  `;
  card.querySelector(".remove").addEventListener("click", (e) => {
    e.stopPropagation();
    removeSymbol(symbol);
  });
  card.querySelector(".bell").addEventListener("click", (e) => {
    e.stopPropagation();
    openAlertModal(symbol);
  });
  card.addEventListener("click", () => openChart(symbol));
  listEl.appendChild(card);
  updateAlertBadge(symbol);
  return card;
}

function renderAll() {
  updateEmpty();
  listEl.innerHTML = "";
  for (const symbol of symbols) createCard(symbol);
}

let sortMode = "added";

// ウォッチリストのカードを並び替える（値動き・名前など）
function sortWatchlist() {
  if (sortMode === "added") {
    for (const sym of symbols) {
      const card = document.getElementById(cardId(sym));
      if (card) listEl.appendChild(card);
    }
    return;
  }
  const arr = symbols.slice();
  arr.sort((a, b) => {
    const da = watchData.get(a), db = watchData.get(b);
    if (sortMode === "name") {
      const na = (da?.name || a), nb = (db?.name || b);
      return na.localeCompare(nb, "ja");
    }
    const pa = da?.changePct, pb = db?.changePct;
    if (pa == null && pb == null) return 0;
    if (pa == null) return 1;
    if (pb == null) return -1;
    return sortMode === "gain" ? pb - pa : pa - pb;
  });
  for (const sym of arr) {
    const card = document.getElementById(cardId(sym));
    if (card) listEl.appendChild(card);
  }
}

function flashCard(symbol) {
  const card = document.getElementById(cardId(symbol));
  if (!card) return;
  card.animate(
    [{ outline: "2px solid var(--accent)" }, { outline: "2px solid transparent" }],
    { duration: 800 }
  );
}

// 米国株などの外貨価格を「およそ◯円」に換算した文字列を返す（日本円・レート不明なら空）
function jpyApprox(value, currency) {
  if (value == null || currency === "JPY" || !currency) return "";
  if (currency !== "USD" || !usdJpyRate) return "";
  const yen = value * usdJpyRate;
  return "≈ ¥" + yen.toLocaleString("ja-JP", { maximumFractionDigits: 0 });
}

function fmtPrice(value, currency) {
  if (value == null) return "—";
  const symbolMap = { USD: "$", JPY: "¥", EUR: "€" };
  const prefix = symbolMap[currency] || "";
  const digits = currency === "JPY" ? 0 : 2;
  return prefix + value.toLocaleString("ja-JP", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

async function fetchOne(symbol) {
  const card = document.getElementById(cardId(symbol));
  if (!card) return;
  card.classList.add("loading");
  try {
    const res = await fetch(`/api/quote?symbol=${encodeURIComponent(symbol)}`);
    const data = await res.json();
    if (data.error) {
      renderError(card, data.error);
      return;
    }
    renderQuote(card, data);
  } catch (e) {
    renderError(card, "サーバーに接続できません（server.py は動いていますか？）");
  }
}

function renderError(card, message) {
  card.classList.remove("loading");
  card.querySelector(".price").textContent = "—";
  card.querySelector(".change").innerHTML = "&nbsp;";
  let err = card.querySelector(".err");
  if (!err) {
    err = document.createElement("div");
    err.className = "err";
    card.appendChild(err);
  }
  err.textContent = "⚠ " + message;
}

function renderQuote(card, data) {
  card.classList.remove("loading");
  const existingErr = card.querySelector(".err");
  if (existingErr) existingErr.remove();

  watchData.set(data.symbol, data);
  card.querySelector(".name").textContent = data.name || data.symbol;
  card.querySelector(".symbol").textContent = data.symbol;
  card.querySelector(".price").textContent = fmtPrice(data.price, data.currency);

  const jpyEl = card.querySelector(".price-jpy");
  if (jpyEl) jpyEl.textContent = jpyApprox(data.price, data.currency);

  const changeEl = card.querySelector(".change");
  if (data.change == null) {
    changeEl.className = "change flat";
    changeEl.innerHTML = "&nbsp;";
  } else {
    const up = data.change >= 0;
    changeEl.className = "change " + (data.change === 0 ? "flat" : up ? "up" : "down");
    const arrow = up ? "▲" : "▼";
    const sign = up ? "+" : "";
    changeEl.textContent = `${arrow} ${sign}${data.change.toFixed(2)} (${sign}${data.changePct.toFixed(2)}%)`;
  }

  drawSpark(card.querySelector(".spark"), data.closes, data.change);
  lastPrice.set(data.symbol, data.price);
  checkAlerts(data.symbol, data.price, data.changePct);
}

function drawSpark(svg, closes, change) {
  svg.innerHTML = "";
  if (!closes || closes.length < 2) return;
  const W = 300, H = 56, pad = 3;
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const span = max - min || 1;
  const stepX = (W - pad * 2) / (closes.length - 1);
  const points = closes.map((c, i) => {
    const x = pad + i * stepX;
    const y = pad + (H - pad * 2) * (1 - (c - min) / span);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const color = change == null || change >= 0 ? "var(--up)" : "var(--down)";

  const area = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
  area.setAttribute("points", `${pad},${H} ${points.join(" ")} ${W - pad},${H}`);
  area.setAttribute("fill", color);
  area.setAttribute("opacity", "0.12");
  svg.appendChild(area);

  const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  line.setAttribute("points", points.join(" "));
  line.setAttribute("fill", "none");
  line.setAttribute("stroke", color);
  line.setAttribute("stroke-width", "2");
  line.setAttribute("stroke-linejoin", "round");
  line.setAttribute("stroke-linecap", "round");
  svg.appendChild(line);
}

function refreshAll() {
  refreshBtn.disabled = true;
  Promise.all(symbols.map(fetchOne)).finally(() => {
    refreshBtn.disabled = false;
    sortWatchlist();
  });
  loadWatchMetrics();
}

/* ===== カードの指標（PER/PBR/配当利回り/出来高/時価総額） ===== */
// 桁が大きい数を「兆/億/万」や「B/M」で短く表示
function fmtCap(v, currency) {
  if (v == null || !(v > 0)) return "—";
  if (currency === "JPY") {
    if (v >= 1e12) return (v / 1e12).toFixed(2) + "兆円";
    if (v >= 1e8) return Math.round(v / 1e8).toLocaleString("ja-JP") + "億円";
    return Math.round(v).toLocaleString("ja-JP") + "円";
  }
  // 米ドルなど
  const pre = currency === "USD" ? "$" : "";
  if (v >= 1e12) return pre + (v / 1e12).toFixed(2) + "T";
  if (v >= 1e9) return pre + (v / 1e9).toFixed(1) + "B";
  if (v >= 1e6) return pre + (v / 1e6).toFixed(1) + "M";
  return pre + Math.round(v).toLocaleString();
}
function fmtVolJa(v) {
  if (v == null || !(v >= 0)) return "—";
  if (v >= 1e8) return (v / 1e8).toFixed(2) + "億";
  if (v >= 1e4) return Math.round(v / 1e4).toLocaleString("ja-JP") + "万";
  return Math.round(v).toLocaleString("ja-JP");
}
function fillMetrics(symbol, q) {
  const card = document.getElementById(cardId(symbol));
  if (!card) return;
  const box = card.querySelector(".metrics");
  if (!box) return;
  const set = (k, val) => { const el = box.querySelector(`[data-k="${k}"]`); if (el) el.textContent = val; };
  set("per", q.per != null && q.per > 0 ? q.per.toFixed(1) + "倍" : "—");
  set("pbr", q.pbr != null && q.pbr > 0 ? q.pbr.toFixed(2) + "倍" : "—");
  set("yield", q.divYield != null && q.divYield > 0 ? (q.divYield * 100).toFixed(2) + "%" : "—");
  set("vol", fmtVolJa(q.volume));
  set("cap", fmtCap(q.marketCap, q.currency));
  box.hidden = false;
  // 米国株の時間外（プレ/アフター）。該当しなければ非表示。
  const ahEl = card.querySelector(".after-hours");
  if (ahEl) {
    const ah = afterHoursInfo(q);
    if (ah) {
      const sign = ah.pct >= 0 ? "+" : "";
      ahEl.textContent = `🌙 ${ah.label} ${fmtPrice(ah.price, ah.currency)} (${sign}${ah.pct.toFixed(2)}%)`;
      ahEl.className = "after-hours " + (ah.pct >= 0 ? "up" : "down");
      ahEl.hidden = false;
    } else {
      ahEl.hidden = true;
    }
  }
}
let metricsTimer = null;
function loadWatchMetrics() {
  clearTimeout(metricsTimer);
  metricsTimer = setTimeout(async () => {
    if (!symbols.length) return;
    try {
      const res = await fetch(`/api/quotes?symbols=${encodeURIComponent(symbols.join(","))}`);
      const d = await res.json();
      (d.quotes || []).forEach((q) => { if (q.symbol) fillMetrics(q.symbol, q); });
    } catch {}
  }, 120);
}

// 米国株の時間外（プレ/アフターマーケット）情報。該当しなければ null。
// marketState: PRE=寄り前 / REGULAR=取引中 / POST,POSTPOST=引け後 / CLOSED=休場
function afterHoursInfo(q) {
  const ms = q.marketState;
  if (ms === "PRE" && q.preMarketPrice != null && q.preMarketChangePercent != null) {
    return { label: "プレ", price: q.preMarketPrice, pct: q.preMarketChangePercent, currency: q.currency };
  }
  if ((ms === "POST" || ms === "POSTPOST" || ms === "CLOSED") &&
      q.postMarketPrice != null && q.postMarketChangePercent != null) {
    return { label: "時間外", price: q.postMarketPrice, pct: q.postMarketChangePercent, currency: q.currency };
  }
  return null;
}
function afterHoursText(q) {
  const ah = afterHoursInfo(q);
  if (!ah) return "";
  const sign = ah.pct >= 0 ? "+" : "";
  return `🌙${ah.label} ${fmtPrice(ah.price, ah.currency)} (${sign}${ah.pct.toFixed(2)}%)`;
}

// 行（セクター/ランキング）用のコンパクトな指標1行
function compactMetrics(q) {
  const parts = [];
  if (q.per != null && q.per > 0) parts.push(`PER ${q.per.toFixed(1)}倍`);
  if (q.pbr != null && q.pbr > 0) parts.push(`PBR ${q.pbr.toFixed(2)}倍`);
  if (q.divYield != null && q.divYield > 0) parts.push(`利回り ${(q.divYield * 100).toFixed(2)}%`);
  if (q.volume != null && q.volume >= 0) parts.push(`出来高 ${fmtVolJa(q.volume)}`);
  if (q.marketCap != null && q.marketCap > 0) parts.push(`時価 ${fmtCap(q.marketCap, q.currency)}`);
  return parts.join(" ・ ");
}

// 指定シンボル群の指標を一括取得し、root内の .row-metrics[data-mk=SYM] に流し込む
async function fillRowMetrics(syms, root) {
  const uniq = [...new Set((syms || []).filter(Boolean))];
  if (!uniq.length) return;
  const scope = root || document;
  for (let i = 0; i < uniq.length; i += 50) {
    const chunk = uniq.slice(i, i + 50);
    try {
      const res = await fetch(`/api/quotes?symbols=${encodeURIComponent(chunk.join(","))}`);
      const d = await res.json();
      (d.quotes || []).forEach((q) => {
        if (!q.symbol) return;
        const txt = compactMetrics(q);
        const ah = afterHoursInfo(q);
        if (!txt && !ah) return;
        let html = "";
        if (ah) {
          const sign = ah.pct >= 0 ? "+" : "";
          const cls = ah.pct >= 0 ? "up" : "down";
          html += `<span class="ah ${cls}">🌙${ah.label} ${fmtPrice(ah.price, ah.currency)} (${sign}${ah.pct.toFixed(2)}%)</span>`;
        }
        if (txt) html += (ah ? ` <span class="ah-sep">/</span> ` : "") + txt;
        scope.querySelectorAll(`.row-metrics[data-mk="${CSS.escape(q.symbol)}"]`).forEach((el) => {
          el.innerHTML = html;
          el.hidden = false;
        });
      });
    } catch {}
  }
}

document.querySelectorAll(".sort-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    sortMode = btn.dataset.sort;
    document.querySelectorAll(".sort-btn").forEach((b) => b.classList.toggle("active", b === btn));
    sortWatchlist();
  });
});

// 更新ボタン: 表示中の画面に合わせて最新価格を取り直す
function handleRefresh() {
  if (currentView === "portfolio") {
    quoteCache.clear();
    loadPortfolio();
  } else if (currentView === "earnings") {
    loadEarnings(true);
  } else if (currentView === "sectors-us" || currentView === "sectors-jp") {
    refreshSectors();
  } else if (currentView === "n225") {
    reloadN225();
  } else if (currentView === "dow") {
    reloadDow();
  } else if (currentView === "ndx") {
    reloadNdx();
  } else if (currentView === "heatmap") {
    reloadHeatmap();
  } else {
    refreshAll();
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const raw = input.value;
  input.value = "";
  input.focus();
  hideSearch();
  smartResolveSymbol(raw).then((sym) => {
    if (sym) addSymbol(sym);
    else if (raw.trim()) showToast(`「${raw.trim()}」に一致する銘柄が見つかりませんでした`);
  });
});

document.querySelectorAll(".chip").forEach((chip) => {
  chip.addEventListener("click", () => addSymbol(chip.dataset.symbol));
});

/* ===== 銘柄検索オートコンプリート（ウォッチリスト・ポートフォリオ共通） ===== */
function typeJa(t) {
  const m = { EQUITY: "株式", ETF: "ETF", INDEX: "指数", MUTUALFUND: "投信", CURRENCY: "為替", CRYPTOCURRENCY: "暗号資産", FUTURE: "先物" };
  return m[t] || t || "";
}

// 任意の入力欄に Yahoo 検索のオートコンプリートを付ける。候補選択時に onPick(symbol) を呼ぶ。
function attachAutocomplete(inputEl, resultsEl, onPick) {
  let timer = null, seq = 0;
  const hide = () => { resultsEl.hidden = true; resultsEl.innerHTML = ""; };
  async function run(q) {
    const s = ++seq;
    const localHits = localSearchMatches(q); // 漢字社名など、辞書から即時候補
    let quotes = [];
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      const d = await res.json();
      quotes = d.quotes || [];
    } catch {}
    if (s !== seq) return; // 古い結果は捨てる
    // ローカル候補を先に、Yahoo候補を後に。シンボル重複は除去
    const seen = new Set(), merged = [];
    for (const it of [...localHits, ...quotes]) {
      if (!it.symbol || seen.has(it.symbol)) continue;
      seen.add(it.symbol);
      merged.push(it);
    }
    {
      if (!merged.length) { hide(); return; }
      resultsEl.innerHTML = "";
      merged.forEach((it) => {
        const row = document.createElement("div");
        row.className = "search-item";
        const meta = [typeJa(it.type), it.exch].filter(Boolean).join(" · ");
        row.innerHTML = `
          <span class="si-sym">${it.symbol}</span>
          <span class="si-name">${it.name || ""}</span>
          <span class="si-meta">${meta}</span>`;
        // blur より先に拾えるよう mousedown を使う
        row.addEventListener("mousedown", (e) => { e.preventDefault(); onPick(it.symbol); hide(); });
        resultsEl.appendChild(row);
      });
      resultsEl.hidden = false;
    }
  }
  inputEl.addEventListener("input", () => {
    const q = inputEl.value.trim();
    clearTimeout(timer);
    if (q.length < 1) { hide(); return; }
    timer = setTimeout(() => run(q), 250);
  });
  inputEl.addEventListener("blur", () => setTimeout(hide, 150));
  document.addEventListener("click", (e) => {
    if (!resultsEl.contains(e.target) && e.target !== inputEl) hide();
  });
  return { hide };
}

const watchSearch = attachAutocomplete(input, document.getElementById("searchResults"), (sym) => {
  addSymbol(sym);
  input.value = "";
});
function hideSearch() { watchSearch.hide(); }

refreshBtn.addEventListener("click", handleRefresh);

/* ===== テーマ（ライト/ダーク）切替 ===== */
const THEME_KEY = "kabu-theme";
const themeToggleBtn = document.getElementById("themeToggle");
function applyTheme(theme) {
  if (theme === "light") {
    document.documentElement.setAttribute("data-theme", "light");
    if (themeToggleBtn) themeToggleBtn.textContent = "☀️";
  } else {
    document.documentElement.removeAttribute("data-theme");
    if (themeToggleBtn) themeToggleBtn.textContent = "🌙";
  }
}
applyTheme(localStorage.getItem(THEME_KEY) || "dark");
if (themeToggleBtn) {
  themeToggleBtn.addEventListener("click", () => {
    const next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
  });
}

/* ===== バックアップ（書き出し／取り込み） ===== */
// この端末内にしか無いデータ（ウォッチリスト・保有株・アラート等）をファイルに保存／復元する
function exportBackup() {
  const data = {};
  // kabu- で始まる保存データを丸ごと収集（将来の追加機能も自動で含める）
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith("kabu-")) data[k] = localStorage.getItem(k);
  }
  const payload = {
    app: "kabu-app",
    type: "backup",
    version: 1,
    exportedAt: new Date().toISOString(),
    data,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const a = document.createElement("a");
  a.href = url;
  a.download = `kabu-backup-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  const n = (() => { try { return (JSON.parse(data[STORAGE_KEY] || "[]") || []).length; } catch { return 0; } })();
  const p = (() => { try { return (JSON.parse(data[PF_KEY] || "[]") || []).length; } catch { return 0; } })();
  showToast(`バックアップを保存しました（ウォッチ${n}件・保有${p}件）`);
}

function importBackup(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let payload;
    try {
      payload = JSON.parse(reader.result);
    } catch {
      showToast("ファイルを読み込めませんでした（JSON形式ではありません）");
      return;
    }
    const data = payload && payload.data && typeof payload.data === "object" ? payload.data : null;
    if (!data || payload.app !== "kabu-app") {
      showToast("このアプリのバックアップファイルではないようです");
      return;
    }
    const wl = (() => { try { return (JSON.parse(data[STORAGE_KEY] || "[]") || []).length; } catch { return 0; } })();
    const pf = (() => { try { return (JSON.parse(data[PF_KEY] || "[]") || []).length; } catch { return 0; } })();
    const ok = window.confirm(
      `バックアップを復元します。\n・ウォッチリスト: ${wl}件\n・保有株: ${pf}件\n\n` +
      `今のデータは上書きされます。よろしいですか？`
    );
    if (!ok) return;
    // 通知ON/OFFは「その端末ごとの設定」なので、バックアップでは上書きしない
    // （別端末で書き出したファイルを読んでも、この端末の通知設定は維持する）
    const KEEP = [NOTIFY_KEY];
    // kabu- の既存キーを消してから復元（クリーンに置き換え）
    const toRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("kabu-") && !KEEP.includes(k)) toRemove.push(k);
    }
    toRemove.forEach((k) => localStorage.removeItem(k));
    Object.entries(data).forEach(([k, v]) => {
      if (k.startsWith("kabu-") && !KEEP.includes(k) && typeof v === "string") localStorage.setItem(k, v);
    });
    showToast("復元しました。画面を更新します…");
    // 再読み込み後、起動時の同期処理（通知ONなら全銘柄をサーバーへ再送）が走る
    setTimeout(() => location.reload(), 800);
  };
  reader.onerror = () => showToast("ファイルの読み込みに失敗しました");
  reader.readAsText(file);
}

const exportBtn = document.getElementById("exportBtn");
const importBtn = document.getElementById("importBtn");
const importFileEl = document.getElementById("importFile");
if (exportBtn) exportBtn.addEventListener("click", exportBackup);
if (importBtn && importFileEl) {
  importBtn.addEventListener("click", () => importFileEl.click());
  importFileEl.addEventListener("change", () => {
    const f = importFileEl.files && importFileEl.files[0];
    if (f) importBackup(f);
    importFileEl.value = ""; // 同じファイルを連続で選べるようにリセット
  });
}

/* ===== レーティング通知（Web Push / B方式：アプリを閉じても届く） ===== */
const NOTIFY_KEY = "kabu-push-on";
const notifyBtn = document.getElementById("notifyBtn");

// 監視対象 = ウォッチリスト ＋ 保有株（重複除去）
function monitoredSymbols() {
  const set = new Set();
  try { symbols.forEach((s) => set.add(s)); } catch (e) {}
  try { (loadHoldings() || []).forEach((h) => set.add(h.symbol)); } catch (e) {}
  return [...set];
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

let swReg = null;
async function ensureServiceWorker() {
  if (!("serviceWorker" in navigator)) return null;
  if (swReg) return swReg;
  try {
    swReg = await navigator.serviceWorker.register("sw.js");
    await navigator.serviceWorker.ready;
    return swReg;
  } catch (e) {
    console.warn("SW登録失敗", e);
    return null;
  }
}

// 現在の購読を取り出す（あれば）
async function getPushSubscription() {
  const reg = await ensureServiceWorker();
  if (!reg) return null;
  return reg.pushManager.getSubscription();
}

// サーバーへ「この購読＋監視銘柄」を登録（銘柄が変わるたび呼ぶ）
async function syncPushSymbols() {
  if (localStorage.getItem(NOTIFY_KEY) !== "1") return;
  const sub = await getPushSubscription();
  if (!sub) return;
  try {
    await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscription: sub, symbols: monitoredSymbols() }),
    });
  } catch (e) { /* オフライン時は次回同期 */ }
}

async function enablePush() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    showToast("お使いのブラウザは通知に対応していません");
    return false;
  }
  // 公開鍵をサーバーから取得
  let key;
  try {
    const r = await fetch("/api/push/publicKey");
    const d = await r.json();
    if (!d.available || !d.key) {
      showToast("サーバー側の通知設定が未完了です（公開後に有効になります）");
      return false;
    }
    key = d.key;
  } catch {
    showToast("サーバーに接続できません");
    return false;
  }
  // 通知の許可をリクエスト
  const perm = await Notification.requestPermission();
  if (perm !== "granted") {
    showToast("通知が許可されませんでした");
    return false;
  }
  const reg = await ensureServiceWorker();
  if (!reg) { showToast("通知の準備に失敗しました"); return false; }
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key),
    });
  }
  await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subscription: sub, symbols: monitoredSymbols() }),
  });
  // テスト通知を送って動作確認
  try {
    await fetch("/api/push/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscription: sub }),
    });
  } catch (e) {}
  localStorage.setItem(NOTIFY_KEY, "1");
  updateNotifyBtn();
  showToast("通知をONにしました（テスト通知を送りました）");
  return true;
}

async function disablePush() {
  const sub = await getPushSubscription();
  if (sub) {
    try {
      await fetch("/api/push/unsubscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      });
    } catch (e) {}
    try { await sub.unsubscribe(); } catch (e) {}
  }
  localStorage.removeItem(NOTIFY_KEY);
  updateNotifyBtn();
  showToast("通知をOFFにしました");
}

function updateNotifyBtn() {
  if (!notifyBtn) return;
  const on = localStorage.getItem(NOTIFY_KEY) === "1";
  notifyBtn.textContent = on ? "🔔 通知ON" : "🔔 通知";
  notifyBtn.classList.toggle("active", on);
  notifyBtn.title = on
    ? "レーティング・目標株価の通知がON（タップでOFF）"
    : "レーティング・目標株価の変化をスマホに通知（タップでON）";
}

if (notifyBtn) {
  notifyBtn.addEventListener("click", () => {
    if (localStorage.getItem(NOTIFY_KEY) === "1") disablePush();
    else enablePush();
  });
  updateNotifyBtn();
  // 既にONなら、起動時にSWを用意して監視銘柄を同期しておく
  if (localStorage.getItem(NOTIFY_KEY) === "1") {
    ensureServiceWorker().then(syncPushSymbols);
  }
}

/* ===== セクター（米国株）ビュー ===== */

const SECTORS = [
  // 上昇・下落注目: 全静的セクターから前日比で自動ソート
  { name: "上昇注目", icon: "📈", dynamic: "UP",   stocks: [] },
  { name: "下落注目", icon: "📉", dynamic: "DOWN", stocks: [] },
  { name: "ハイパースケーラ", icon: "☁️", stocks: [
    ["MSFT", "Microsoft (Azure)"], ["AMZN", "Amazon (AWS)"], ["GOOGL", "Alphabet (Google Cloud)"],
    ["META", "Meta"], ["ORCL", "Oracle (OCI)"], ["NVDA", "NVIDIA (AI基盤)"],
    ["AVGO", "Broadcom"], ["CRWV", "CoreWeave"],
  ]},
  { name: "宇宙", icon: "🚀", stocks: [
    ["RKLB", "Rocket Lab (打上げ)"], ["ASTS", "AST SpaceMobile (衛星通信)"], ["LUNR", "Intuitive Machines (月面)"],
    ["RDW", "Redwire (宇宙インフラ)"], ["PL", "Planet Labs (衛星画像)"], ["KTOS", "Kratos (防衛・宇宙)"],
    ["LMT", "Lockheed Martin"], ["NOC", "Northrop Grumman"], ["BA", "Boeing"],
  ]},
  { name: "ゲーム", icon: "🎮", stocks: [
    ["RBLX", "Roblox"], ["EA", "Electronic Arts"], ["TTWO", "Take-Two (GTA)"],
    ["APP", "AppLovin"], ["U", "Unity"], ["NTES", "NetEase (中)"],
    ["SE", "Sea (Garena)"], ["BILI", "Bilibili (中)"],
  ]},
  { name: "電線・ケーブル", icon: "🔌", stocks: [
    ["PRYMY", "Prysmian"], ["BDC", "Belden"], ["GLW", "Corning (光ファイバー)"],
    ["APH", "Amphenol"], ["NVT", "nVent"], ["ATKR", "Atkore"],
  ]},
  { name: "テクノロジー", icon: "💻", stocks: [
    ["AAPL", "Apple"], ["MSFT", "Microsoft"], ["NVDA", "NVIDIA"],
    ["AVGO", "Broadcom"], ["ORCL", "Oracle"], ["CRM", "Salesforce"],
    ["AMD", "AMD"], ["ADBE", "Adobe"], ["NOW", "ServiceNow"],
    ["INTC", "Intel"], ["QCOM", "Qualcomm"], ["TXN", "Texas Instr."],
  ]},
  { name: "通信・メディア", icon: "📡", stocks: [
    ["GOOGL", "Alphabet"], ["META", "Meta"], ["NFLX", "Netflix"],
    ["DIS", "Disney"], ["T", "AT&T"], ["VZ", "Verizon"],
    ["TMUS", "T-Mobile"], ["SPOT", "Spotify"],
  ]},
  { name: "一般消費財", icon: "🛍️", stocks: [
    ["AMZN", "Amazon"], ["TSLA", "Tesla"], ["HD", "Home Depot"],
    ["MCD", "McDonald's"], ["NKE", "Nike"], ["SBUX", "Starbucks"],
    ["ABNB", "Airbnb"], ["UBER", "Uber"],
  ]},
  { name: "生活必需品", icon: "🛒", stocks: [
    ["PG", "P&G"], ["KO", "Coca-Cola"], ["PEP", "PepsiCo"],
    ["COST", "Costco"], ["WMT", "Walmart"],
  ]},
  { name: "ヘルスケア", icon: "🏥", stocks: [
    ["UNH", "UnitedHealth"], ["JNJ", "J&J"], ["LLY", "Eli Lilly"],
    ["PFE", "Pfizer"], ["ABBV", "AbbVie"], ["MRK", "Merck"],
  ]},
  { name: "金融", icon: "🏦", stocks: [
    ["JPM", "JPMorgan"], ["BAC", "Bank of America"], ["V", "Visa"],
    ["MA", "Mastercard"], ["GS", "Goldman Sachs"], ["WFC", "Wells Fargo"],
    ["COIN", "Coinbase"], ["HOOD", "Robinhood"], ["PYPL", "PayPal"],
  ]},
  { name: "エネルギー", icon: "🛢️", stocks: [
    ["XOM", "ExxonMobil"], ["CVX", "Chevron"], ["COP", "ConocoPhillips"],
    ["OXY", "Occidental"], ["SLB", "SLB"], ["MPC", "Marathon Petroleum"],
  ]},
  { name: "資本財", icon: "🏗️", stocks: [
    ["CAT", "Caterpillar"], ["BA", "Boeing"], ["GE", "GE Aerospace"],
    ["HON", "Honeywell"], ["UPS", "UPS"], ["FDX", "FedEx"], ["DE", "Deere"],
  ]},
  { name: "半導体", icon: "🔬", stocks: [
    ["NVDA", "NVIDIA"], ["AMD", "AMD"], ["AVGO", "Broadcom"],
    ["QCOM", "Qualcomm"], ["TXN", "Texas Instr."], ["INTC", "Intel"],
    ["MU", "Micron"], ["AMAT", "Applied Materials"], ["LRCX", "Lam Research"],
    ["KLAC", "KLA Corp"], ["ARM", "Arm Holdings"], ["ASML", "ASML"],
  ]},
  { name: "量子コンピューティング", icon: "⚛️", stocks: [
    ["IONQ", "IonQ"], ["RGTI", "Rigetti Computing"], ["QUBT", "Quantum Computing"],
    ["QBTS", "D-Wave Quantum"], ["IBM", "IBM"], ["GOOGL", "Alphabet"],
    ["MSFT", "Microsoft"], ["HON", "Honeywell"],
  ]},
  { name: "蓄電池・エネルギー貯蔵", icon: "🔋", stocks: [
    ["TSLA", "Tesla"], ["ENPH", "Enphase Energy"], ["QS", "QuantumScape"],
    ["SLDP", "Solid Power"], ["STEM", "Stem Inc"], ["FLNC", "Fluence Energy"],
    ["ALB", "Albemarle"], ["SQM", "SQM"], ["BE", "Bloom Energy"],
    ["PLUG", "Plug Power"], ["RIVN", "Rivian"], ["LCID", "Lucid"],
  ]},
  { name: "不動産・REIT", icon: "🏠", stocks: [
    ["SPG", "Simon Property"], ["AMT", "American Tower"], ["PLD", "Prologis"],
    ["EQIX", "Equinix"], ["O", "Realty Income"], ["PSA", "Public Storage"],
    ["DLR", "Digital Realty"], ["VICI", "VICI Properties"], ["AVB", "AvalonBay"],
  ]},
  { name: "AI・クラウドSaaS", icon: "🤖", stocks: [
    ["PLTR", "Palantir"], ["SNOW", "Snowflake"], ["NET", "Cloudflare"],
    ["DDOG", "Datadog"], ["MDB", "MongoDB"], ["AI", "C3.ai"],
    ["GTLB", "GitLab"], ["HUBS", "HubSpot"], ["BILL", "Bill.com"],
    ["ZI", "ZoomInfo"],
  ]},
  { name: "サイバーセキュリティ", icon: "🔐", stocks: [
    ["CRWD", "CrowdStrike"], ["PANW", "Palo Alto"], ["FTNT", "Fortinet"],
    ["ZS", "Zscaler"], ["OKTA", "Okta"], ["S", "SentinelOne"],
    ["CYBR", "CyberArk"], ["QLYS", "Qualys"],
  ]},
  { name: "航空宇宙・防衛", icon: "✈️", stocks: [
    ["LMT", "Lockheed Martin"], ["RTX", "RTX Corp"], ["NOC", "Northrop Grumman"],
    ["GD", "General Dynamics"], ["TDG", "TransDigm"], ["HEI", "HEICO"],
    ["LDOS", "Leidos"], ["BAH", "Booz Allen"],
  ]},
  { name: "バイオテック", icon: "🧬", stocks: [
    ["MRNA", "Moderna"], ["BNTX", "BioNTech"], ["GILD", "Gilead"],
    ["REGN", "Regeneron"], ["BIIB", "Biogen"], ["VRTX", "Vertex"],
    ["ILMN", "Illumina"], ["SRPT", "Sarepta"],
  ]},
  { name: "EV・モビリティ", icon: "🚘", stocks: [
    ["TSLA", "Tesla"], ["RIVN", "Rivian"], ["LCID", "Lucid"],
    ["F", "Ford"], ["GM", "General Motors"], ["NIO", "NIO"],
    ["XPEV", "XPeng"], ["LI", "Li Auto"],
  ]},
  { name: "クリーンエネルギー", icon: "🌱", stocks: [
    ["FSLR", "First Solar"], ["NEE", "NextEra Energy"], ["ENPH", "Enphase"],
    ["RUN", "Sunrun"], ["SEDG", "SolarEdge"], ["AES", "AES Corp"],
    ["BEP", "Brookfield Renew."], ["CWEN", "Clearway Energy"],
    ["ORA", "Ormat Tech"], ["BE", "Bloom Energy"],
  ]},
  { name: "eコマース", icon: "🛒", stocks: [
    ["AMZN", "Amazon"], ["SHOP", "Shopify"], ["ETSY", "Etsy"],
    ["EBAY", "eBay"], ["MELI", "MercadoLibre"], ["PDD", "PDD Holdings"],
    ["BABA", "Alibaba"], ["JD", "JD.com"], ["WISH", "ContextLogic"],
  ]},
  { name: "医療機器", icon: "🩺", stocks: [
    ["ISRG", "Intuitive Surgical"], ["MDT", "Medtronic"], ["SYK", "Stryker"],
    ["ZBH", "Zimmer Biomet"], ["BSX", "Boston Scientific"],
    ["EW", "Edwards Lifesciences"], ["BAX", "Baxter"], ["COO", "CooperSurgical"],
  ]},
  { name: "米国銀行", icon: "🏛️", stocks: [
    ["JPM", "JPMorgan Chase"], ["BAC", "Bank of America"], ["WFC", "Wells Fargo"],
    ["C", "Citigroup"], ["GS", "Goldman Sachs"], ["MS", "Morgan Stanley"],
    ["USB", "US Bancorp"], ["PNC", "PNC Financial"], ["TFC", "Truist"],
    ["CFG", "Citizens Financial"], ["KEY", "KeyCorp"], ["FITB", "Fifth Third"],
  ]},
  { name: "フィンテック", icon: "💳", stocks: [
    ["SQ", "Block"], ["AFRM", "Affirm"], ["UPST", "Upstart"],
    ["SOFI", "SoFi"], ["HOOD", "Robinhood"], ["COIN", "Coinbase"],
    ["PYPL", "PayPal"], ["AAPL", "Apple Pay/Wallet"],
  ]},

  // ===== 東証33業種 対応（米国株） =====
  { name: "石油・石炭製品", icon: "🛢️", stocks: [
    ["XOM", "ExxonMobil"], ["CVX", "Chevron"], ["COP", "ConocoPhillips"],
    ["MPC", "Marathon Petroleum"], ["PSX", "Phillips 66"], ["VLO", "Valero"],
  ]},
  { name: "鉱業", icon: "⛏️", stocks: [
    ["OXY", "Occidental"], ["DVN", "Devon Energy"], ["FANG", "Diamondback"],
    ["EOG", "EOG Resources"], ["HAL", "Halliburton"],
  ]},
  { name: "輸送用機器", icon: "🚗", stocks: [
    ["TSLA", "Tesla"], ["F", "Ford"], ["GM", "General Motors"],
    ["RIVN", "Rivian"], ["LCID", "Lucid"], ["APTV", "Aptiv"],
  ]},
  { name: "建設業", icon: "🏗️", stocks: [
    ["DHI", "D.R. Horton"], ["LEN", "Lennar"], ["PHM", "PulteGroup"],
    ["PWR", "Quanta Services"], ["VMC", "Vulcan Materials"],
  ]},
  { name: "不動産業", icon: "🏢", stocks: [
    ["SPG", "Simon Property"], ["PLD", "Prologis"], ["AMT", "American Tower"],
    ["O", "Realty Income"], ["EQIX", "Equinix"], ["PSA", "Public Storage"],
  ]},
  { name: "陸運業", icon: "🚆", stocks: [
    ["UNP", "Union Pacific"], ["CSX", "CSX"], ["NSC", "Norfolk Southern"],
    ["ODFL", "Old Dominion"], ["JBHT", "J.B. Hunt"], ["CHRW", "C.H. Robinson"],
  ]},
  { name: "パルプ・紙", icon: "📄", stocks: [
    ["IP", "Intl Paper"], ["PKG", "Packaging Corp"], ["SW", "Smurfit WestRock"], ["SON", "Sonoco"],
  ]},
  { name: "食料品（33業種）", icon: "🍱", stocks: [
    ["KO", "Coca-Cola"], ["PEP", "PepsiCo"], ["MDLZ", "Mondelez"],
    ["GIS", "General Mills"], ["KHC", "Kraft Heinz"], ["HSY", "Hershey"],
  ]},
  { name: "水産・農林業", icon: "🐟", stocks: [
    ["ADM", "Archer-Daniels"], ["BG", "Bunge"], ["TSN", "Tyson Foods"],
    ["CALM", "Cal-Maine Foods"], ["MOS", "Mosaic"],
  ]},
  { name: "卸売業", icon: "🌐", stocks: [
    ["SYY", "Sysco"], ["GWW", "W.W. Grainger"], ["FAST", "Fastenal"],
    ["WSO", "Watsco"], ["POOL", "Pool Corp"],
  ]},
  { name: "倉庫・運輸関連", icon: "📦", stocks: [
    ["UPS", "UPS"], ["FDX", "FedEx"], ["EXPD", "Expeditors"],
    ["GXO", "GXO Logistics"], ["PLD", "Prologis"],
  ]},
  { name: "銀行業", icon: "🏦", stocks: [
    ["JPM", "JPMorgan"], ["BAC", "Bank of America"], ["WFC", "Wells Fargo"],
    ["C", "Citigroup"], ["USB", "US Bancorp"], ["PNC", "PNC Financial"],
  ]},
  { name: "空運業", icon: "✈️", stocks: [
    ["DAL", "Delta Air Lines"], ["UAL", "United Airlines"], ["AAL", "American Airlines"],
    ["LUV", "Southwest"], ["ALK", "Alaska Air"],
  ]},
  { name: "保険業", icon: "🛡️", stocks: [
    ["BRK-B", "Berkshire H."], ["PGR", "Progressive"], ["ALL", "Allstate"],
    ["TRV", "Travelers"], ["AIG", "AIG"], ["CB", "Chubb"],
  ]},
  { name: "ゴム製品", icon: "🛞", stocks: [
    ["GT", "Goodyear"], ["CSL", "Carlisle Cos"], ["GPC", "Genuine Parts"],
  ]},
  { name: "金属製品", icon: "🔩", stocks: [
    ["SWK", "Stanley B&D"], ["AOS", "A.O. Smith"], ["ALLE", "Allegion"],
    ["MAS", "Masco"], ["FBIN", "Fortune Brands"],
  ]},
  { name: "証券・商品先物", icon: "📊", stocks: [
    ["GS", "Goldman Sachs"], ["MS", "Morgan Stanley"], ["SCHW", "Charles Schwab"],
    ["IBKR", "Interactive Brokers"], ["RJF", "Raymond James"],
  ]},
  { name: "医薬品（33業種）", icon: "💊", stocks: [
    ["LLY", "Eli Lilly"], ["JNJ", "J&J"], ["PFE", "Pfizer"],
    ["MRK", "Merck"], ["ABBV", "AbbVie"], ["BMY", "Bristol-Myers"],
  ]},
  { name: "小売業", icon: "🛍️", stocks: [
    ["WMT", "Walmart"], ["COST", "Costco"], ["HD", "Home Depot"],
    ["TGT", "Target"], ["LOW", "Lowe's"], ["DG", "Dollar General"],
  ]},
  { name: "鉄鋼", icon: "🏭", stocks: [
    ["NUE", "Nucor"], ["STLD", "Steel Dynamics"], ["CLF", "Cleveland-Cliffs"],
    ["X", "US Steel"], ["RS", "Reliance"],
  ]},
  { name: "海運業", icon: "🚢", stocks: [
    ["KEX", "Kirby"], ["MATX", "Matson"], ["ZIM", "ZIM Shipping"],
    ["SBLK", "Star Bulk"], ["GNK", "Genco Shipping"],
  ]},
  { name: "その他金融業", icon: "💰", stocks: [
    ["V", "Visa"], ["MA", "Mastercard"], ["AXP", "American Express"],
    ["BLK", "BlackRock"], ["BX", "Blackstone"], ["COF", "Capital One"],
  ]},
  { name: "電気・ガス業", icon: "💡", stocks: [
    ["NEE", "NextEra Energy"], ["DUK", "Duke Energy"], ["SO", "Southern Co"],
    ["D", "Dominion"], ["AEP", "American Electric"], ["EXC", "Exelon"],
  ]},
  { name: "サービス業", icon: "🛎️", stocks: [
    ["ACN", "Accenture"], ["ADP", "ADP"], ["MMC", "Marsh McLennan"],
    ["CTAS", "Cintas"], ["RSG", "Republic Services"], ["VRSK", "Verisk"],
  ]},
  { name: "繊維製品", icon: "🧵", stocks: [
    ["NKE", "Nike"], ["LULU", "Lululemon"], ["RL", "Ralph Lauren"],
    ["PVH", "PVH"], ["VFC", "VF Corp"], ["UAA", "Under Armour"],
  ]},
  { name: "精密機器（33業種）", icon: "🔭", stocks: [
    ["TMO", "Thermo Fisher"], ["DHR", "Danaher"], ["A", "Agilent"],
    ["MTD", "Mettler-Toledo"], ["KEYS", "Keysight"], ["GRMN", "Garmin"],
  ]},
  { name: "化学", icon: "🧪", stocks: [
    ["LIN", "Linde"], ["SHW", "Sherwin-Williams"], ["APD", "Air Products"],
    ["ECL", "Ecolab"], ["DD", "DuPont"], ["DOW", "Dow"],
  ]},
  { name: "その他製品", icon: "🎨", stocks: [
    ["MMM", "3M"], ["MAT", "Mattel"], ["HAS", "Hasbro"],
    ["NWL", "Newell Brands"], ["WHR", "Whirlpool"],
  ]},
  { name: "機械（33業種）", icon: "⚙️", stocks: [
    ["CAT", "Caterpillar"], ["DE", "Deere"], ["ETN", "Eaton"],
    ["EMR", "Emerson"], ["PH", "Parker Hannifin"], ["ITW", "Illinois Tool"],
  ]},
  { name: "ガラス・土石製品", icon: "🏺", stocks: [
    ["GLW", "Corning"], ["VMC", "Vulcan Materials"], ["MLM", "Martin Marietta"],
    ["OC", "Owens Corning"], ["EXP", "Eagle Materials"],
  ]},
  { name: "電気機器（33業種）", icon: "🔌", stocks: [
    ["AAPL", "Apple"], ["HON", "Honeywell"], ["ROK", "Rockwell Auto."],
    ["GEV", "GE Vernova"], ["HUBB", "Hubbell"], ["AME", "AMETEK"],
  ]},
  { name: "情報・通信業", icon: "📡", stocks: [
    ["GOOGL", "Alphabet"], ["META", "Meta"], ["NFLX", "Netflix"],
    ["VZ", "Verizon"], ["TMUS", "T-Mobile"], ["CMCSA", "Comcast"],
  ]},
  { name: "非鉄金属", icon: "🪙", stocks: [
    ["FCX", "Freeport-McMoRan"], ["AA", "Alcoa"], ["SCCO", "Southern Copper"],
    ["NEM", "Newmont"], ["CENX", "Century Aluminum"], ["MP", "MP Materials"],
  ]},
];

// ===== 半導体・AI 詳細ヒートマップ（サブセクター別・多銘柄） =====
const SEMI_GROUPS = [
  { name: "GPU・AIアクセラレータ", icon: "🧠", stocks: [
    ["NVDA", "NVIDIA"], ["AMD", "AMD"], ["AVGO", "Broadcom"], ["TSM", "TSMC"],
    ["QCOM", "Qualcomm"], ["MRVL", "Marvell"], ["INTC", "Intel"], ["ARM", "Arm"],
    ["TSEM", "Tower Semi"], ["6526.T", "ソシオネクスト"],
  ]},
  { name: "ファブレス・設計", icon: "✏️", stocks: [
    ["QCOM", "Qualcomm"], ["AVGO", "Broadcom"], ["MRVL", "Marvell"], ["NXPI", "NXP"],
    ["LSCC", "Lattice"], ["RMBS", "Rambus"], ["ALGM", "Allegro"], ["MXL", "MaxLinear"],
    ["AMBA", "Ambarella"], ["INDI", "indie Semi"], ["SMTC", "Semtech"], ["SYNA", "Synaptics"],
    ["CRUS", "Cirrus Logic"], ["SITM", "SiTime"], ["MTSI", "MACOM"], ["CEVA", "CEVA"],
    ["6723.T", "ルネサス"], ["6526.T", "ソシオネクスト"],
  ]},
  { name: "製造装置（米国・欧）", icon: "🛠️", stocks: [
    ["ASML", "ASML"], ["AMAT", "Applied Mat."], ["LRCX", "Lam Research"], ["KLAC", "KLA"],
    ["ACLS", "Axcelis"], ["ONTO", "Onto Innov."], ["AEIS", "Advanced Energy"],
    ["KLIC", "Kulicke&Soffa"], ["COHU", "Cohu"], ["FORM", "FormFactor"],
    ["UCTT", "Ultra Clean"], ["VECO", "Veeco"], ["ICHR", "Ichor"], ["NVMI", "Nova(イスラエル)"],
    ["CAMT", "Camtek(イスラエル)"], ["ASYS", "Amtech"],
  ]},
  { name: "製造装置（日本）", icon: "🗾", stocks: [
    ["8035.T", "東京エレク"], ["6920.T", "レーザーテック"], ["6857.T", "アドバンテスト"],
    ["6525.T", "KOKUSAIエレク"],
    ["7731.T", "ニコン"], ["6146.T", "ディスコ"], ["6728.T", "アルバック"], ["6315.T", "TOWA"],
    ["7729.T", "東京精密"], ["6951.T", "日本電子"], ["6080.T", "ハーモニック"],
    ["7701.T", "島津製作所"], ["7735.T", "SCREEN"], ["6890.T", "フェローテック"],
  ]},
  { name: "ファウンドリ・OSAT", icon: "🏭", stocks: [
    ["TSM", "TSMC"], ["GFS", "GlobalFoundries"], ["UMC", "UMC"], ["ASX", "ASE"],
    ["AMKR", "Amkor"], ["TSEM", "Tower Semi"], ["2330.TW", "TSMC(台)"], ["2303.TW", "UMC(台)"],
    ["3711.TW", "ASE(台)"], ["005930.KS", "サムスン電子(韓)"], ["000660.KS", "SKハイニックス(韓)"],
  ]},
  { name: "メモリ・ストレージ", icon: "💾", stocks: [
    ["MU", "Micron"], ["WDC", "Western Digital"], ["STX", "Seagate"], ["SNDK", "SanDisk"],
    ["3436.T", "SUMCO"], ["285A.T", "キオクシア"], ["005930.KS", "サムスン電子(韓)"],
    ["000660.KS", "SKハイニックス(韓)"], ["2408.TW", "Nanya(台)"],
  ]},
  { name: "アナログ・電源IC", icon: "🔌", stocks: [
    ["TXN", "Texas Instr."], ["ADI", "Analog Dev."], ["MCHP", "Microchip"], ["ON", "ON Semi"],
    ["MPWR", "Monolithic"], ["STM", "STMicro"], ["NXPI", "NXP"], ["DIOD", "Diodes"],
    ["POWI", "Power Integ."], ["SLAB", "Silicon Labs"], ["AOSL", "Alpha&Omega"],
    ["VICR", "Vicor"], ["SGH", "SMART Global"], ["6963.T", "ローム"], ["6976.T", "新日本無線"],
  ]},
  { name: "パワー・SiC/GaN", icon: "⚡", stocks: [
    ["WOLF", "Wolfspeed"], ["ON", "ON Semi"], ["STM", "STMicro"], ["NVTS", "Navitas"],
    ["IFNNY", "Infineon"], ["6963.T", "ローム"], ["6504.T", "富士電機"], ["6707.T", "サンケン電気"],
    ["6502.T", "東芝"], ["6594.T", "ニデック"],
  ]},
  { name: "通信・RF", icon: "📶", stocks: [
    ["QCOM", "Qualcomm"], ["SWKS", "Skyworks"], ["QRVO", "Qorvo"], ["AVGO", "Broadcom"],
    ["MTSI", "MACOM"], ["SLAB", "Silicon Labs"], ["MXL", "MaxLinear"], ["SITM", "SiTime"],
    ["6963.T", "ローム"], ["6762.T", "TDK"],
  ]},
  { name: "光通信・フォトニクス", icon: "💡", stocks: [
    ["COHR", "Coherent"], ["LITE", "Lumentum"], ["POET", "POET Tech"], ["AAOI", "Applied Opto"],
    ["MTSI", "MACOM"], ["IIVI", "II-VI"], ["5802.T", "住友電工"], ["6965.T", "浜松ホト"],
    ["6841.T", "横河電機"], ["7741.T", "HOYA"],
  ]},
  { name: "EDA・半導体IP", icon: "🧩", stocks: [
    ["SNPS", "Synopsys"], ["CDNS", "Cadence"], ["ARM", "Arm"], ["CEVA", "CEVA"],
    ["RMBS", "Rambus"],
  ]},
  { name: "半導体材料", icon: "🧪", stocks: [
    ["ENTG", "Entegris"], ["4063.T", "信越化学"], ["4091.T", "日本酸素"], ["5201.T", "AGC"],
    ["4005.T", "住友化学"], ["4188.T", "三菱ケミカル"], ["4042.T", "東ソー"], ["3407.T", "旭化成"],
    ["4061.T", "デンカ"], ["4901.T", "富士フイルム"], ["6988.T", "日東電工"], ["3402.T", "東レ"],
    ["4109.T", "ステラケミファ"], ["4369.T", "トリケミカル"], ["6890.T", "フェローテック"],
  ]},
  { name: "MLCC・コンデンサ", icon: "🔲", stocks: [
    ["6981.T", "村田製作所"], ["6976.T", "太陽誘電"], ["6762.T", "TDK"], ["6971.T", "京セラ"],
    ["6752.T", "パナソニック"], ["6997.T", "日本ケミコン"], ["6996.T", "ニチコン"],
    ["6994.T", "指月電機"], ["6989.T", "北陸電気工業"], ["2327.TW", "ヤゲオ(台)"],
    ["2492.TW", "Walsin(台)"], ["009150.KS", "サムスン電機(韓)"], ["VSH", "Vishay(米)"], ["KEM", "KEMET"],
  ]},
  { name: "電子部品（日本）", icon: "🔧", stocks: [
    ["6981.T", "村田製作所"], ["6762.T", "TDK"], ["6976.T", "太陽誘電"], ["6779.T", "日本電波"],
    ["6988.T", "日東電工"], ["6770.T", "アルプスアル"], ["6806.T", "ヒロセ電機"],
    ["6967.T", "新光電気"], ["4062.T", "イビデン"], ["6841.T", "横河電機"],
    ["6724.T", "エプソン"], ["6798.T", "SMK"], ["6995.T", "東海理化"],
  ]},
  { name: "基板・パッケージ", icon: "🧱", stocks: [
    ["4062.T", "イビデン"], ["6967.T", "新光電気"], ["3105.T", "日清紡"],
    ["3110.T", "日東紡"], ["4216.T", "旭有機材"], ["3402.T", "東レ"],
  ]},
  { name: "AIサーバー・DC電力", icon: "🖥️", stocks: [
    ["SMCI", "Supermicro"], ["DELL", "Dell"], ["HPE", "HPE"], ["VRT", "Vertiv"],
    ["ANET", "Arista"], ["PSTG", "Pure Storage"], ["CRDO", "Credo"], ["ALAB", "Astera Labs"],
    ["MOD", "Modine"], ["6594.T", "ニデック"], ["6503.T", "三菱電機"],
  ]},
  { name: "電線・ケーブル", icon: "🔌", stocks: [
    ["PRYMY", "Prysmian"], ["BDC", "Belden"], ["GLW", "Corning(光ファイバー)"],
    ["APH", "Amphenol"], ["NVT", "nVent"], ["ATKR", "Atkore"],
  ]},
];

// ===== NASDAQ-100 主要銘柄ヒートマップ（業界別） =====
const NASDAQ_GROUPS = [
  { name: "半導体", icon: "🔬", stocks: [
    ["NVDA", "NVIDIA"], ["AVGO", "Broadcom"], ["AMD", "AMD"], ["QCOM", "Qualcomm"],
    ["INTC", "Intel"], ["TXN", "Texas Instr."], ["MU", "Micron"], ["ADI", "Analog Dev."],
    ["MRVL", "Marvell"], ["NXPI", "NXP"], ["MCHP", "Microchip"], ["ASML", "ASML"],
    ["AMAT", "Applied Mat."], ["LRCX", "Lam Research"], ["KLAC", "KLA"],
  ]},
  { name: "ソフトウェア・IT", icon: "💻", stocks: [
    ["MSFT", "Microsoft"], ["AAPL", "Apple"], ["ADBE", "Adobe"], ["CRM", "Salesforce"],
    ["ORCL", "Oracle"], ["CSCO", "Cisco"], ["INTU", "Intuit"], ["NOW", "ServiceNow"],
    ["PANW", "Palo Alto"], ["CRWD", "CrowdStrike"], ["FTNT", "Fortinet"], ["ADSK", "Autodesk"],
    ["WDAY", "Workday"], ["TEAM", "Atlassian"], ["DDOG", "Datadog"], ["SNPS", "Synopsys"], ["CDNS", "Cadence"],
  ]},
  { name: "通信サービス", icon: "📡", stocks: [
    ["GOOGL", "Alphabet"], ["META", "Meta"], ["NFLX", "Netflix"], ["CMCSA", "Comcast"],
    ["TMUS", "T-Mobile"], ["CHTR", "Charter"], ["WBD", "Warner Bros"], ["EA", "Elec. Arts"], ["TTWO", "Take-Two"],
  ]},
  { name: "一般消費財", icon: "🛍️", stocks: [
    ["AMZN", "Amazon"], ["TSLA", "Tesla"], ["MELI", "MercadoLibre"], ["BKNG", "Booking"],
    ["SBUX", "Starbucks"], ["MAR", "Marriott"], ["ABNB", "Airbnb"], ["ORLY", "O'Reilly"],
    ["ROST", "Ross Stores"], ["LULU", "Lululemon"], ["PDD", "PDD Holdings"], ["DASH", "DoorDash"],
  ]},
  { name: "ヘルスケア", icon: "🏥", stocks: [
    ["AMGN", "Amgen"], ["GILD", "Gilead"], ["VRTX", "Vertex"], ["REGN", "Regeneron"],
    ["ISRG", "Intuitive Surg."], ["MRNA", "Moderna"], ["DXCM", "Dexcom"], ["IDXX", "Idexx"],
    ["BIIB", "Biogen"], ["ILMN", "Illumina"],
  ]},
  { name: "生活必需品", icon: "🛒", stocks: [
    ["COST", "Costco"], ["PEP", "PepsiCo"], ["MDLZ", "Mondelez"], ["KDP", "Keurig DrP"],
    ["MNST", "Monster"], ["KHC", "Kraft Heinz"],
  ]},
  { name: "資本財・その他", icon: "🏗️", stocks: [
    ["HON", "Honeywell"], ["PCAR", "Paccar"], ["CSX", "CSX"], ["FAST", "Fastenal"],
    ["ODFL", "Old Dominion"], ["PAYX", "Paychex"], ["CTAS", "Cintas"], ["ADP", "ADP"],
  ]},
];

// SBI証券などで使われる東証の業種分類に基づく日本株セクター
const JP_SECTORS = [
  // 上昇・下落注目: 全静的JPセクターから前日比で自動ソート
  { name: "上昇注目", icon: "📈", dynamic: "JP_UP",   stocks: [] },
  { name: "下落注目", icon: "📉", dynamic: "JP_DOWN", stocks: [] },
  { name: "自動車・輸送機器", icon: "🚗", stocks: [
    ["7203.T", "トヨタ自動車"], ["7267.T", "ホンダ"], ["7201.T", "日産自動車"],
    ["7269.T", "スズキ"], ["7270.T", "SUBARU"], ["6902.T", "デンソー"],
  ]},
  { name: "電気機器", icon: "🔌", stocks: [
    ["6758.T", "ソニーG"], ["6861.T", "キーエンス"], ["6501.T", "日立製作所"],
    ["6981.T", "村田製作所"], ["6752.T", "パナソニックHD"], ["6594.T", "ニデック"],
  ]},
  { name: "情報・通信", icon: "📡", stocks: [
    ["9984.T", "ソフトバンクG"], ["9432.T", "NTT"], ["9433.T", "KDDI"],
    ["9434.T", "ソフトバンク"], ["4689.T", "LINEヤフー"], ["4751.T", "サイバーエージェント"],
  ]},
  { name: "銀行", icon: "🏦", stocks: [
    ["8306.T", "三菱UFJ"], ["8316.T", "三井住友FG"], ["8411.T", "みずほFG"],
    ["8308.T", "りそなHD"],
  ]},
  { name: "卸売・商社", icon: "🌐", stocks: [
    ["8058.T", "三菱商事"], ["8031.T", "三井物産"], ["8001.T", "伊藤忠商事"],
    ["8053.T", "住友商事"], ["8002.T", "丸紅"],
  ]},
  { name: "医薬品", icon: "💊", stocks: [
    ["4502.T", "武田薬品"], ["4503.T", "アステラス製薬"], ["4568.T", "第一三共"],
    ["4519.T", "中外製薬"],
  ]},
  { name: "小売", icon: "🛍️", stocks: [
    ["9983.T", "ファーストリテイリング"], ["3382.T", "セブン&アイ"], ["8267.T", "イオン"],
    ["9843.T", "ニトリHD"],
  ]},
  { name: "機械", icon: "⚙️", stocks: [
    ["6301.T", "コマツ"], ["6367.T", "ダイキン工業"], ["6954.T", "ファナック"],
    ["6273.T", "SMC"],
  ]},
  { name: "食料品", icon: "🍱", stocks: [
    ["2914.T", "JT"], ["2502.T", "アサヒGHD"], ["2503.T", "キリンHD"],
    ["2802.T", "味の素"],
  ]},
  { name: "化学・素材", icon: "🧪", stocks: [
    ["4063.T", "信越化学"], ["4452.T", "花王"], ["3407.T", "旭化成"],
    ["5401.T", "日本製鉄"],
  ]},
  { name: "保険・その他金融", icon: "💰", stocks: [
    ["8766.T", "東京海上HD"], ["8591.T", "オリックス"], ["8604.T", "野村HD"],
  ]},
  { name: "ゲーム・エンタメ", icon: "🎮", stocks: [
    ["7974.T", "任天堂"], ["9697.T", "カプコン"], ["7832.T", "バンナムHD"],
    ["9684.T", "スクエニHD"], ["9766.T", "コナミG"], ["6460.T", "セガサミーHD"],
    ["3635.T", "コーエーテクモ"], ["3765.T", "ガンホー"], ["3659.T", "ネクソン"],
    ["2432.T", "DeNA"],
  ]},
  { name: "半導体", icon: "🔬", stocks: [
    ["8035.T", "東京エレクトロン"], ["6920.T", "レーザーテック"], ["6857.T", "アドバンテスト"],
    ["6146.T", "ディスコ"], ["7735.T", "SCREENホールディングス"], ["4063.T", "信越化学"],
    ["3436.T", "SUMCO"], ["6963.T", "ローム"], ["6526.T", "ソシオネクスト"],
    ["6723.T", "ルネサスエレクトロニクス"], ["4062.T", "イビデン"], ["6981.T", "村田製作所"],
  ]},
  { name: "不動産", icon: "🏠", stocks: [
    ["8801.T", "三井不動産"], ["8830.T", "住友不動産"], ["8802.T", "三菱地所"],
    ["1925.T", "大和ハウス工業"], ["1928.T", "積水ハウス"], ["3003.T", "ヒューリック"],
  ]},
  { name: "航空・海運", icon: "✈️", stocks: [
    ["9201.T", "JAL"], ["9202.T", "ANAHD"], ["9101.T", "日本郵船"],
    ["9104.T", "商船三井"], ["9107.T", "川崎汽船"],
  ]},
  { name: "電力・ガス", icon: "💡", stocks: [
    ["9501.T", "東京電力HD"], ["9502.T", "中部電力"], ["9503.T", "関西電力"],
    ["9531.T", "東京ガス"], ["9532.T", "大阪ガス"],
  ]},
  { name: "建設", icon: "🏗️", stocks: [
    ["1801.T", "大成建設"], ["1802.T", "大林組"], ["1803.T", "清水建設"],
    ["1808.T", "長谷工"], ["1812.T", "鹿島建設"],
  ]},
  { name: "ITサービス", icon: "🖥️", stocks: [
    ["4307.T", "野村総研"], ["9613.T", "NTTデータG"], ["4704.T", "トレンドマイクロ"],
    ["2432.T", "DeNA"], ["3659.T", "ネクソン"],
  ]},
  { name: "鉄道・交通", icon: "🚂", stocks: [
    ["9020.T", "JR東日本"], ["9022.T", "JR東海"], ["9021.T", "JR西日本"],
    ["9005.T", "東急"], ["9007.T", "小田急電鉄"], ["9048.T", "名鉄"],
  ]},
  { name: "精密機器", icon: "🔭", stocks: [
    ["7741.T", "HOYA"], ["4543.T", "テルモ"], ["7731.T", "ニコン"],
    ["6506.T", "安川電機"], ["6315.T", "TOWA"], ["7762.T", "シチズン時計"],
  ]},
  { name: "鉄鋼・非鉄金属", icon: "⚙️", stocks: [
    ["5401.T", "日本製鉄"], ["5411.T", "JFE HD"], ["5713.T", "住友金属鉱山"],
    ["5706.T", "三菱マテリアル"], ["5108.T", "ブリヂストン"],
  ]},
  { name: "クリーンエネルギー", icon: "🌱", stocks: [
    ["6988.T", "日東電工"], ["6674.T", "GSユアサ"], ["7735.T", "SCREEN HD"],
    ["5334.T", "日本特殊陶業"], ["6981.T", "村田製作所"], ["4901.T", "富士フイルム"],
  ]},

  // ===== 東証33業種（公式分類） =====
  { name: "石油・石炭製品", icon: "🛢️", stocks: [
    ["5020.T", "ENEOS"], ["5019.T", "出光興産"], ["5021.T", "コスモエネHD"], ["5017.T", "富士石油"],
  ]},
  { name: "鉱業", icon: "⛏️", stocks: [
    ["1605.T", "INPEX"], ["1662.T", "石油資源開発"], ["1515.T", "日鉄鉱業"], ["3315.T", "日本コークス"],
  ]},
  { name: "輸送用機器", icon: "🚗", stocks: [
    ["7203.T", "トヨタ自動車"], ["7267.T", "ホンダ"], ["7201.T", "日産自動車"],
    ["7269.T", "スズキ"], ["7270.T", "SUBARU"], ["7211.T", "三菱自動車"],
  ]},
  { name: "建設業", icon: "🏗️", stocks: [
    ["1801.T", "大成建設"], ["1802.T", "大林組"], ["1803.T", "清水建設"],
    ["1812.T", "鹿島建設"], ["1928.T", "積水ハウス"], ["1925.T", "大和ハウス工業"],
  ]},
  { name: "不動産業", icon: "🏢", stocks: [
    ["8801.T", "三井不動産"], ["8802.T", "三菱地所"], ["8830.T", "住友不動産"],
    ["3289.T", "東急不動産HD"], ["3003.T", "ヒューリック"],
  ]},
  { name: "陸運業", icon: "🚆", stocks: [
    ["9020.T", "JR東日本"], ["9022.T", "JR東海"], ["9021.T", "JR西日本"],
    ["9064.T", "ヤマトHD"], ["9143.T", "SGホールディングス"], ["9001.T", "東武鉄道"],
  ]},
  { name: "パルプ・紙", icon: "📄", stocks: [
    ["3861.T", "王子HD"], ["3863.T", "日本製紙"], ["3880.T", "大王製紙"], ["3865.T", "北越コーポ"],
  ]},
  { name: "食料品（33業種）", icon: "🍱", stocks: [
    ["2914.T", "JT"], ["2502.T", "アサヒGHD"], ["2503.T", "キリンHD"],
    ["2802.T", "味の素"], ["2269.T", "明治HD"], ["2801.T", "キッコーマン"],
  ]},
  { name: "水産・農林業", icon: "🐟", stocks: [
    ["1332.T", "ニッスイ"], ["1333.T", "マルハニチロ"], ["1379.T", "ホクト"], ["1377.T", "サカタのタネ"],
  ]},
  { name: "卸売業", icon: "🌐", stocks: [
    ["8058.T", "三菱商事"], ["8031.T", "三井物産"], ["8001.T", "伊藤忠商事"],
    ["8053.T", "住友商事"], ["8002.T", "丸紅"], ["2768.T", "双日"],
  ]},
  { name: "倉庫・運輸関連", icon: "📦", stocks: [
    ["9301.T", "三菱倉庫"], ["9302.T", "三井倉庫HD"], ["9364.T", "上組"], ["9303.T", "住友倉庫"],
  ]},
  { name: "銀行業", icon: "🏦", stocks: [
    ["8306.T", "三菱UFJ"], ["8316.T", "三井住友FG"], ["8411.T", "みずほFG"],
    ["8308.T", "りそなHD"], ["7182.T", "ゆうちょ銀行"],
  ]},
  { name: "空運業", icon: "✈️", stocks: [
    ["9201.T", "JAL"], ["9202.T", "ANAHD"], ["9204.T", "スカイマーク"],
  ]},
  { name: "保険業", icon: "🛡️", stocks: [
    ["8766.T", "東京海上HD"], ["8725.T", "MS&AD"], ["8630.T", "SOMPO HD"], ["8795.T", "T&D HD"],
  ]},
  { name: "ゴム製品", icon: "🛞", stocks: [
    ["5108.T", "ブリヂストン"], ["5101.T", "横浜ゴム"], ["5110.T", "住友ゴム"], ["5105.T", "TOYO TIRE"],
  ]},
  { name: "金属製品", icon: "🔩", stocks: [
    ["5938.T", "LIXIL"], ["5947.T", "リンナイ"], ["5991.T", "ニッパツ"], ["5929.T", "三和HD"],
  ]},
  { name: "証券・商品先物", icon: "📊", stocks: [
    ["8604.T", "野村HD"], ["8601.T", "大和証券G"], ["8628.T", "松井証券"], ["8473.T", "SBI HD"],
  ]},
  { name: "医薬品（33業種）", icon: "💊", stocks: [
    ["4502.T", "武田薬品"], ["4503.T", "アステラス製薬"], ["4568.T", "第一三共"],
    ["4519.T", "中外製薬"], ["4523.T", "エーザイ"], ["4578.T", "大塚HD"],
  ]},
  { name: "小売業", icon: "🛍️", stocks: [
    ["9983.T", "ファーストリテイリング"], ["3382.T", "セブン&アイ"], ["8267.T", "イオン"],
    ["9843.T", "ニトリHD"], ["3092.T", "ZOZO"], ["7453.T", "良品計画"],
  ]},
  { name: "鉄鋼", icon: "🏭", stocks: [
    ["5401.T", "日本製鉄"], ["5411.T", "JFE HD"], ["5406.T", "神戸製鋼所"],
    ["5440.T", "共英製鋼"], ["5471.T", "大同特殊鋼"],
  ]},
  { name: "海運業", icon: "🚢", stocks: [
    ["9101.T", "日本郵船"], ["9104.T", "商船三井"], ["9107.T", "川崎汽船"], ["9110.T", "NSユナイテッド海運"],
  ]},
  { name: "その他金融業", icon: "💰", stocks: [
    ["8591.T", "オリックス"], ["8593.T", "三菱HCキャピタル"], ["8572.T", "アコム"],
    ["8570.T", "イオンFS"], ["7164.T", "全国保証"],
  ]},
  { name: "電気・ガス業", icon: "💡", stocks: [
    ["9501.T", "東京電力HD"], ["9503.T", "関西電力"], ["9502.T", "中部電力"],
    ["9531.T", "東京ガス"], ["9532.T", "大阪ガス"], ["9533.T", "東邦ガス"],
  ]},
  { name: "サービス業", icon: "🛎️", stocks: [
    ["4661.T", "オリエンタルランド"], ["6098.T", "リクルートHD"], ["4324.T", "電通グループ"],
    ["2413.T", "エムスリー"], ["9735.T", "セコム"], ["4307.T", "野村総研"],
  ]},
  { name: "繊維製品", icon: "🧵", stocks: [
    ["3402.T", "東レ"], ["3401.T", "帝人"], ["3105.T", "日清紡HD"],
    ["3591.T", "ワコールHD"], ["3116.T", "トヨタ紡織"],
  ]},
  { name: "精密機器（33業種）", icon: "🔭", stocks: [
    ["7741.T", "HOYA"], ["4543.T", "テルモ"], ["7731.T", "ニコン"],
    ["7733.T", "オリンパス"], ["6849.T", "日本光電"], ["7762.T", "シチズン時計"],
  ]},
  { name: "化学", icon: "🧪", stocks: [
    ["4063.T", "信越化学"], ["4452.T", "花王"], ["3407.T", "旭化成"],
    ["4188.T", "三菱ケミカルG"], ["4005.T", "住友化学"], ["4901.T", "富士フイルム"],
  ]},
  { name: "その他製品", icon: "🎨", stocks: [
    ["7974.T", "任天堂"], ["7832.T", "バンナムHD"], ["7912.T", "大日本印刷"],
    ["7911.T", "TOPPAN HD"], ["7951.T", "ヤマハ"], ["7936.T", "アシックス"],
  ]},
  { name: "機械（33業種）", icon: "⚙️", stocks: [
    ["6301.T", "コマツ"], ["6367.T", "ダイキン工業"], ["6954.T", "ファナック"],
    ["6273.T", "SMC"], ["6326.T", "クボタ"], ["6471.T", "日本精工"],
  ]},
  { name: "ガラス・土石製品", icon: "🏺", stocks: [
    ["5201.T", "AGC"], ["5333.T", "日本碍子"], ["5332.T", "TOTO"],
    ["5334.T", "日本特殊陶業"], ["5233.T", "太平洋セメント"],
  ]},
  { name: "電気機器（33業種）", icon: "🔌", stocks: [
    ["6758.T", "ソニーG"], ["6861.T", "キーエンス"], ["6501.T", "日立製作所"],
    ["6981.T", "村田製作所"], ["6752.T", "パナソニックHD"], ["8035.T", "東京エレクトロン"],
  ]},
  { name: "情報・通信業", icon: "📡", stocks: [
    ["9984.T", "ソフトバンクG"], ["9432.T", "NTT"], ["9433.T", "KDDI"],
    ["9434.T", "ソフトバンク"], ["4689.T", "LINEヤフー"], ["9613.T", "NTTデータG"],
  ]},
  { name: "非鉄金属", icon: "🪙", stocks: [
    ["5713.T", "住友金属鉱山"], ["5711.T", "三菱マテリアル"], ["5706.T", "三井金属鉱業"],
    ["5802.T", "住友電気工業"], ["5803.T", "フジクラ"], ["5714.T", "DOWA HD"],
  ]},
];

const usSectorListEl = document.getElementById("sectorList");
const jpSectorListEl = document.getElementById("sectorListJp");

// 銘柄コード → 業種名 の対応表（注目セクターのタグ付けに使う）
const SECTOR_TAG = {};
[...SECTORS, ...JP_SECTORS].forEach((s) => {
  if (s.dynamic) return;
  (s.stocks || []).forEach((row) => {
    const sym = row[0];
    if (sym && !SECTOR_TAG[sym]) SECTOR_TAG[sym] = s.name;
  });
});

function tagFor(symbol) {
  if (symbol.endsWith("-USD")) return "暗号資産";
  return SECTOR_TAG[symbol] || "";
}

function typeLabel(t) {
  return { CRYPTOCURRENCY: "暗号資産", ETF: "ETF", INDEX: "指数", CURRENCY: "為替", FUTURE: "先物" }[t] || "";
}

function buildSectorGroup(sectors, container) {
  const loaded = new Set();
  sectors.forEach((sector, i) => {
    const block = document.createElement("div");
    block.className = "sector";
    const countText = sector.dynamic ? "自動集計TOP12" : `${sector.stocks.length}銘柄`;
    const dynAttr = sector.dynamic ? ` data-dynamic-type="${sector.dynamic}"` : "";
    block.dataset.sectorName = sector.name;
    block.innerHTML = `
      <button class="sector-head" aria-expanded="false">
        <span class="sector-title">${sector.icon} ${sector.name}</span>
        <span class="sector-count" data-base="${countText}">${countText}</span>
        <span class="sector-arrow">▾</span>
      </button>
      <div class="sector-body"${dynAttr} hidden></div>
    `;
    const head = block.querySelector(".sector-head");
    const body = block.querySelector(".sector-body");
    head.addEventListener("click", () => toggleSector(sector, head, body, loaded, i));
    container.appendChild(block);
  });
}

function toggleSector(sector, head, body, loaded, index) {
  const open = body.hasAttribute("hidden");
  if (open) {
    body.removeAttribute("hidden");
    head.setAttribute("aria-expanded", "true");
    head.classList.add("open");
    if (!loaded.has(index)) {
      loaded.add(index);
      if (sector.dynamic) {
        loadTrendingQuotes(body, sector.dynamic);
      } else {
        loadSectorQuotes(sector, body);
      }
    }
  } else {
    body.setAttribute("hidden", "");
    head.setAttribute("aria-expanded", "false");
    head.classList.remove("open");
  }
}

function makeSectorRow(symbol, name, tag, dynamic) {
  const row = document.createElement("div");
  row.className = "srow loading";
  row.dataset.symbol = symbol;
  if (dynamic) row.dataset.dynamic = "1";
  const tagHtml = tag ? `<span class="srow-tag">${tag}</span>` : "";
  row.innerHTML = `
    <button class="star" title="ウォッチリストに追加">☆</button>
    <span class="srow-symbol">${symbol}</span>
    <span class="srow-name"><span class="nm">${name || symbol}</span>${tagHtml}</span>
    <span class="srow-price">…</span>
    <span class="srow-change">&nbsp;</span>
    <span class="row-metrics" data-mk="${symbol}" hidden></span>
  `;
  row.querySelector(".star").addEventListener("click", (e) => {
    e.stopPropagation();
    addSymbol(symbol);
    switchView("watchlist");
  });
  row.addEventListener("click", () => openChart(symbol));
  return row;
}

function loadSectorQuotes(sector, body) {
  body.innerHTML = "";
  for (const [symbol, name, tag] of sector.stocks) {
    const row = makeSectorRow(symbol, name, tag, false);
    body.appendChild(row);
    fetchSectorRow(row, symbol);
  }
  fillRowMetrics(sector.stocks.map(([sym]) => sym), body);
}

// dynamicType: "UP"|"DOWN" (US) または "JP_UP"|"JP_DOWN" (JP)
async function loadTrendingQuotes(body, dynamicType) {
  const isJP   = dynamicType && dynamicType.startsWith("JP");
  const isDown = dynamicType && dynamicType.endsWith("DOWN");
  const label  = isDown ? "下落" : "上昇";
  body.innerHTML = `<div class="trend-note">全セクターから${label}銘柄を集計中…</div>`;

  const sourceList = isJP ? JP_SECTORS : SECTORS;
  const allStocks = [...new Map(
    sourceList
      .filter((s) => !s.dynamic)
      .flatMap((s) => s.stocks.map(([sym, name]) => ({ sym, name, sectorName: s.name })))
      .map((item) => [item.sym, item])
  ).values()];

  const results = await Promise.all(
    allStocks.map(async (item) => ({ ...item, data: await fetchAndCache(item.sym) }))
  );

  const filtered = results.filter((r) => r.data && r.data.changePct != null);
  const top = filtered
    .sort((a, b) => isDown
      ? a.data.changePct - b.data.changePct
      : b.data.changePct - a.data.changePct)
    .slice(0, 12);

  body.innerHTML = "";
  if (!top.length) {
    body.innerHTML = `<div class="trend-note">データを取得できませんでした。更新ボタンでもう一度お試しください。</div>`;
    return;
  }

  for (const { sym, name, sectorName } of top) {
    const row = makeSectorRow(sym, name, sectorName, false);
    body.appendChild(row);
    fetchSectorRow(row, sym);
  }
  fillRowMetrics(top.map((t) => t.sym), body);
}

const quoteFetching = new Map(); // 同一銘柄の並列リクエストを1本に集約

async function fetchAndCache(symbol) {
  if (quoteCache.has(symbol)) return quoteCache.get(symbol);
  if (quoteFetching.has(symbol)) return quoteFetching.get(symbol);
  const p = (async () => {
    try {
      const res = await fetch(`/api/quote?symbol=${encodeURIComponent(symbol)}`);
      const d = await res.json();
      if (!d.error) quoteCache.set(symbol, d);
      return d.error ? null : d;
    } catch { return null; }
    finally { quoteFetching.delete(symbol); }
  })();
  quoteFetching.set(symbol, p);
  return p;
}

async function sortSectorsByPerformance(container, sectors) {
  const staticSectors = sectors.filter((s) => !s.dynamic);
  const sectorData = await Promise.all(
    staticSectors.map(async (sector) => {
      const results = await Promise.all(sector.stocks.map(([sym]) => fetchAndCache(sym)));
      const valid = results.filter((d) => d && d.changePct != null);
      const avg = valid.length
        ? valid.reduce((sum, d) => sum + d.changePct, 0) / valid.length
        : null;
      return { name: sector.name, count: sector.stocks.length, avg };
    })
  );
  sectorData.sort((a, b) => (b.avg ?? -Infinity) - (a.avg ?? -Infinity));
  for (const { name, count, avg } of sectorData) {
    const block = container.querySelector(`.sector[data-sector-name="${CSS.escape(name)}"]`);
    if (!block) continue;
    container.appendChild(block);
    const countEl = block.querySelector(".sector-count");
    if (countEl && avg != null) {
      const sign = avg >= 0 ? "+" : "";
      const arrow = avg >= 0 ? "▲" : "▼";
      const cls = avg > 0 ? "up" : "down";
      countEl.innerHTML = `${count}銘柄 <span class="sector-avg ${cls}">${arrow} ${sign}${avg.toFixed(2)}%</span>`;
    }
  }
}

async function fetchSectorRow(row, symbol) {
  try {
    const data = await fetchAndCache(symbol);
    row.classList.remove("loading");
    if (!data) {
      row.querySelector(".srow-price").textContent = "—";
      return;
    }
    // 注目セクターの行は、銘柄名と（タグが無ければ）種別タグを取得後に埋める
    if (row.dataset.dynamic === "1") {
      const nm = row.querySelector(".nm");
      if (nm) nm.textContent = data.name || symbol;
      if (!row.querySelector(".srow-tag")) {
        const label = typeLabel(data.type);
        if (label) {
          const span = document.createElement("span");
          span.className = "srow-tag";
          span.textContent = label;
          row.querySelector(".srow-name").appendChild(span);
        }
      }
    }
    row.querySelector(".srow-price").textContent = fmtPrice(data.price, data.currency);
    const changeEl = row.querySelector(".srow-change");
    if (data.change == null) {
      changeEl.innerHTML = "&nbsp;";
    } else {
      const up = data.change >= 0;
      changeEl.className = "srow-change " + (data.change === 0 ? "flat" : up ? "up" : "down");
      changeEl.textContent = `${up ? "▲" : "▼"} ${up ? "+" : ""}${data.changePct.toFixed(2)}%`;
    }
  } catch {
    row.classList.remove("loading");
    row.querySelector(".srow-price").textContent = "—";
  }
}

// 開いているセクターの現在価格を取り直す（表示中の画面のみ）
function refreshSectors() {
  const container = currentView === "sectors-jp" ? jpSectorListEl : usSectorListEl;
  const openBodies = container.querySelectorAll(".sector-body:not([hidden])");
  if (!openBodies.length) return;
  refreshBtn.disabled = true;
  const jobs = [];
  openBodies.forEach((body) => {
    if (body.dataset.dynamicType) {
      jobs.push(loadTrendingQuotes(body, body.dataset.dynamicType));
    } else {
      body.querySelectorAll(".srow").forEach((row) => {
        row.classList.add("loading");
        const priceEl = row.querySelector(".srow-price");
        if (priceEl) priceEl.textContent = "…";
        jobs.push(fetchSectorRow(row, row.dataset.symbol));
      });
    }
  });
  Promise.all(jobs).finally(() => {
    refreshBtn.disabled = false;
  });
}

/* ===== 主要指数ストリップ ===== */

async function refreshIndexStrip() {
  const results = await Promise.all(
    INDICES.map(({ symbol }) => fetchAndCache(symbol))
  );
  indexStripEl.innerHTML = "";
  results.forEach((data, i) => {
    const { label } = INDICES[i];
    const tile = document.createElement("div");
    tile.className = "idx-tile";
    if (!data) {
      tile.innerHTML = `<span class="idx-label">${label}</span><span class="idx-price">—</span>`;
    } else {
      const up = (data.change ?? 0) >= 0;
      const cls = data.change == null ? "flat" : up ? "up" : "down";
      const sign = up ? "+" : "";
      const chg = data.changePct != null
        ? `${up ? "▲" : "▼"} ${sign}${data.changePct.toFixed(2)}%`
        : "—";
      tile.innerHTML = `
        <span class="idx-label">${label}</span>
        <span class="idx-price">${fmtPrice(data.price, data.currency)}</span>
        <span class="idx-change ${cls}">${chg}</span>`;
    }
    indexStripEl.appendChild(tile);
  });
}

/* ===== セクターヒートマップ ===== */

function changeToColor(pct) {
  if (pct == null) return "var(--panel-2)";
  const t = Math.min(1, Math.abs(pct) / 5);
  const sat = Math.round(25 + 55 * t);
  const lit = Math.round(13 + 14 * t);
  return pct >= 0 ? `hsl(142,${sat}%,${lit}%)` : `hsl(0,${sat}%,${lit}%)`;
}

function currentHmGroups() {
  if (heatmapMode === "semi") return SEMI_GROUPS;
  if (heatmapMode === "nasdaq") return NASDAQ_GROUPS;
  return SECTORS.filter((s) => !s.dynamic);
}

function buildHeatmap() {
  heatmapEl.innerHTML = "";
  const staticSectors = currentHmGroups();
  staticSectors.forEach((sector) => {
    const group = document.createElement("div");
    group.className = "hm-group";

    const head = document.createElement("div");
    head.className = "hm-head";
    head.dataset.icon = sector.icon;
    head.dataset.name = sector.name;
    head.textContent = `${sector.icon} ${sector.name}`;
    group.appendChild(head);

    const grid = document.createElement("div");
    grid.className = "hm-grid";

    sector.stocks.forEach(([symbol, name]) => {
      const tile = document.createElement("div");
      tile.className = "hm-tile loading";
      tile.dataset.symbol = symbol;
      tile.innerHTML = `<span class="hm-sym">${symbol}</span><span class="hm-pct">…</span><span class="hm-tag">${sector.name}</span><span class="hm-name">${name}</span>`;
      tile.addEventListener("click", () => openChart(symbol));
      grid.appendChild(tile);

      const cached = quoteCache.get(symbol);
      if (cached) {
        renderHmTile(tile, cached);
        updateHmHead(head, grid);
      } else {
        fetchAndCache(symbol).then((data) => {
          if (data) {
            renderHmTile(tile, data);
            updateHmHead(head, grid);
          } else {
            tile.classList.remove("loading");
            tile.querySelector(".hm-pct").textContent = "—";
          }
        });
      }
    });

    group.appendChild(grid);
    heatmapEl.appendChild(group);
  });
  heatmapBuilt = true;
}

function renderHmTile(tile, data) {
  tile.classList.remove("loading");
  tile.style.background = changeToColor(data.changePct);
  tile.dataset.pct = data.changePct ?? "";
  const pctEl = tile.querySelector(".hm-pct");
  if (data.changePct != null) {
    const sign = data.changePct >= 0 ? "+" : "";
    pctEl.textContent = `${sign}${data.changePct.toFixed(2)}%`;
    pctEl.className = "hm-pct " + (data.changePct > 0 ? "up" : data.changePct < 0 ? "down" : "flat");
  } else {
    pctEl.textContent = "—";
    pctEl.className = "hm-pct flat";
  }
}

function updateHmHead(head, grid) {
  const vals = [...grid.querySelectorAll(".hm-tile[data-pct]")]
    .map((t) => parseFloat(t.dataset.pct))
    .filter((v) => !isNaN(v));
  const total = grid.querySelectorAll(".hm-tile").length;
  if (!vals.length) return;
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  const sign = avg >= 0 ? "+" : "";
  const cls = avg > 0 ? "up" : avg < 0 ? "down" : "flat";
  head.style.borderLeft = `4px solid ${avg >= 0 ? "var(--up)" : "var(--down)"}`;
  head.innerHTML =
    `${head.dataset.icon} ${head.dataset.name} ` +
    `<span class="hm-avg ${cls}">${sign}${avg.toFixed(2)}%</span> ` +
    `<span class="hm-count">${vals.length}/${total}</span>`;
}

function reloadHeatmap() {
  quoteCache.clear();
  heatmapBuilt = false;
  buildHeatmap();
}

/* ===== 日経225ダッシュボード ===== */

// 日経平均の除数（おおよそ）。寄与度(円→指数ポイント)の換算に使う。
const N225_DIVISOR = 26.5;

// 上部マーケットストリップ
const N225_MARKETS = [
  { symbol: "^N225",  label: "日経平均" },
  { symbol: "NIY=F",  label: "日経先物(夜間)" },
  { symbol: "1306.T", label: "TOPIX連動(1306)" },
  { symbol: "JPY=X",  label: "ドル円" },
  { symbol: "^DJI",   label: "NYダウ" },
  { symbol: "^IXIC",  label: "NASDAQ" },
];

// 日経平均の主要構成銘柄（値がさ・高ウェイト中心）
const N225_CONSTITUENTS = [
  ["9983.T", "ファーストリテイリング"],
  ["8035.T", "東京エレクトロン"],
  ["6857.T", "アドバンテスト"],
  ["6954.T", "ファナック"],
  ["9984.T", "ソフトバンクG"],
  ["6098.T", "リクルートHD"],
  ["4063.T", "信越化学工業"],
  ["6367.T", "ダイキン工業"],
  ["6758.T", "ソニーG"],
  ["6861.T", "キーエンス"],
  ["4543.T", "テルモ"],
  ["6645.T", "オムロン"],
  ["7741.T", "HOYA"],
  ["4503.T", "アステラス製薬"],
  ["4519.T", "中外製薬"],
  ["4523.T", "エーザイ"],
  ["6762.T", "TDK"],
  ["6971.T", "京セラ"],
  ["6981.T", "村田製作所"],
  ["6920.T", "レーザーテック"],
  ["6594.T", "ニデック"],
  ["6902.T", "デンソー"],
  ["7203.T", "トヨタ自動車"],
  ["7267.T", "ホンダ"],
  ["7269.T", "スズキ"],
  ["7011.T", "三菱重工業"],
  ["7012.T", "川崎重工業"],
  ["7013.T", "IHI"],
  ["8306.T", "三菱UFJ"],
  ["8316.T", "三井住友FG"],
  ["8411.T", "みずほFG"],
  ["8766.T", "東京海上HD"],
  ["8058.T", "三菱商事"],
  ["8031.T", "三井物産"],
  ["8001.T", "伊藤忠商事"],
  ["8053.T", "住友商事"],
  ["2914.T", "JT"],
  ["4502.T", "武田薬品工業"],
  ["4661.T", "オリエンタルランド"],
  ["9433.T", "KDDI"],
  ["9432.T", "NTT"],
  ["9434.T", "ソフトバンク"],
  ["4452.T", "花王"],
  ["2802.T", "味の素"],
  ["3382.T", "セブン&アイ"],
  ["9020.T", "JR東日本"],
  ["9022.T", "JR東海"],
  ["9101.T", "日本郵船"],
  ["5401.T", "日本製鉄"],
  ["5108.T", "ブリヂストン"],
  ["7751.T", "キヤノン"],
  ["6501.T", "日立製作所"],
  ["6503.T", "三菱電機"],
  ["6702.T", "富士通"],
  ["8801.T", "三井不動産"],
  ["1605.T", "INPEX"],
  ["5020.T", "ENEOS"],
  ["4901.T", "富士フイルム"],
  ["6273.T", "SMC"],
  ["7974.T", "任天堂"],
];

// 寄与度ポイント = 前日比(円) / 除数
function n225Contribution(data) {
  if (!data || data.change == null) return null;
  return data.change / N225_DIVISOR;
}

async function buildN225() {
  n225Built = true;
  refreshN225Markets();
  buildN225Sectors();

  // 構成銘柄をまとめて取得
  const rows = await Promise.all(
    N225_CONSTITUENTS.map(async ([sym, name]) => {
      const data = await fetchAndCache(sym);
      return { sym, name, data, contrib: n225Contribution(data) };
    })
  );

  // 値上がり率／値下がり率（％）の大きい順に並べる（直感に合う順番）
  const valid = rows.filter((r) => r.data && r.data.changePct != null);
  const ups = valid.filter((r) => r.data.changePct > 0).sort((a, b) => b.data.changePct - a.data.changePct).slice(0, 15);
  const downs = valid.filter((r) => r.data.changePct < 0).sort((a, b) => a.data.changePct - b.data.changePct).slice(0, 15);

  renderN225Rank(n225UpEl, ups, "up");
  renderN225Rank(n225DownEl, downs, "down");
  renderN225Heatmap(rows);
}

function renderN225Rank(container, list, dir) {
  container.innerHTML = "";
  if (!list.length) {
    container.innerHTML = `<div class="n225-empty">データ取得中…</div>`;
    return;
  }
  list.forEach((r, i) => {
    const row = document.createElement("div");
    row.className = "n225-row";
    const pts = Math.abs(r.contrib);
    const sign = r.contrib >= 0 ? "+" : "−";
    const pctTxt = r.data.changePct != null
      ? `${r.data.changePct >= 0 ? "+" : ""}${r.data.changePct.toFixed(2)}%`
      : "—";
    row.innerHTML = `
      <span class="n225-rk">${i + 1}</span>
      <span class="n225-info">
        <span class="n225-nm">${r.name}</span>
        <span class="n225-code">${r.sym.replace(".T", "")}</span>
      </span>
      <span class="n225-vals">
        <span class="n225-pts ${dir}">${sign}${pts.toFixed(1)}円</span>
        <span class="n225-chg ${dir}">${pctTxt}</span>
      </span>
      <span class="row-metrics" data-mk="${r.sym}" hidden></span>`;
    row.addEventListener("click", () => openChart(r.sym));
    container.appendChild(row);
  });
  fillRowMetrics(list.map((r) => r.sym), container);
}

function renderN225Heatmap(rows) {
  n225HeatmapEl.innerHTML = "";
  // タイルの大きさは株価の高さ（指数への影響度の目安）でランク分け
  const withPrice = rows.filter((r) => r.data && r.data.price != null);
  withPrice.sort((a, b) => b.data.price - a.data.price);
  withPrice.forEach((r, idx) => {
    const tile = document.createElement("div");
    let sizeCls = "sz-s";
    if (idx < 6) sizeCls = "sz-l";
    else if (idx < 18) sizeCls = "sz-m";
    tile.className = `n225-tile ${sizeCls}`;
    tile.style.background = changeToColor(r.data.changePct);
    const pct = r.data.changePct;
    const pctTxt = pct != null ? `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%` : "—";
    tile.innerHTML = `
      <span class="n225-tnm">${r.name}</span>
      <span class="n225-tpct">${pctTxt}</span>`;
    tile.addEventListener("click", () => openChart(r.sym));
    n225HeatmapEl.appendChild(tile);
  });
}

async function refreshN225Markets() {
  const results = await Promise.all(N225_MARKETS.map(({ symbol }) => fetchAndCache(symbol)));
  n225MarketsEl.innerHTML = "";
  results.forEach((data, i) => {
    const { label } = N225_MARKETS[i];
    const tile = document.createElement("div");
    tile.className = "n225-mk";
    if (!data) {
      tile.innerHTML = `<span class="n225-mk-label">${label}</span><span class="n225-mk-price">—</span>`;
    } else {
      const up = (data.change ?? 0) >= 0;
      const cls = data.change == null ? "flat" : up ? "up" : "down";
      const sign = up ? "+" : "";
      const chg = data.changePct != null
        ? `${up ? "▲" : "▼"} ${sign}${data.changePct.toFixed(2)}%`
        : "—";
      tile.innerHTML = `
        <span class="n225-mk-label">${label}</span>
        <span class="n225-mk-price">${fmtPrice(data.price, data.currency)}</span>
        <span class="n225-mk-change ${cls}">${chg}</span>`;
    }
    n225MarketsEl.appendChild(tile);
  });
}

// 業種別の騰落（日本セクターの主要銘柄の平均前日比）
async function buildN225Sectors() {
  const groups = JP_SECTORS.filter((s) => !s.dynamic);
  n225SectorsEl.innerHTML = `<div class="n225-empty">業種データ取得中…</div>`;
  const rows = await Promise.all(
    groups.map(async (g) => {
      const results = await Promise.all(g.stocks.map(([sym]) => fetchAndCache(sym)));
      const valid = results.filter((d) => d && d.changePct != null);
      const avg = valid.length
        ? valid.reduce((s, d) => s + d.changePct, 0) / valid.length
        : null;
      return { name: g.name, icon: g.icon, avg, count: valid.length, total: g.stocks.length };
    })
  );
  const valid = rows.filter((r) => r.avg != null).sort((a, b) => b.avg - a.avg);
  const maxAbs = Math.max(0.1, ...valid.map((r) => Math.abs(r.avg)));
  n225SectorsEl.innerHTML = "";
  valid.forEach((r) => {
    const up = r.avg >= 0;
    const w = Math.min(100, (Math.abs(r.avg) / maxAbs) * 100);
    const row = document.createElement("div");
    row.className = "n225-sec-row";
    row.innerHTML = `
      <span class="n225-sec-name">${r.icon} ${r.name}</span>
      <span class="n225-sec-bar"><span class="n225-sec-fill ${up ? "up" : "down"}" style="width:${w}%"></span></span>
      <span class="n225-sec-val ${up ? "up" : "down"}">${up ? "+" : ""}${r.avg.toFixed(2)}%</span>`;
    n225SectorsEl.appendChild(row);
  });
}

function reloadN225() {
  quoteCache.clear();
  n225Built = false;
  buildN225();
}

/* ===== 米国市場ダッシュボード（ダウ30） ===== */

// ダウ平均の除数（おおよそ）。寄与度(ドル→指数ポイント)の換算に使う。
const DOW_DIVISOR = 0.163;

// 上部マーケットストリップ
const DOW_MARKETS = [
  { symbol: "^DJI",  label: "NYダウ" },
  { symbol: "^GSPC", label: "S&P 500" },
  { symbol: "^IXIC", label: "NASDAQ" },
  { symbol: "^VIX",  label: "VIX(恐怖指数)" },
  { symbol: "^TNX",  label: "米10年債利回り" },
  { symbol: "JPY=X", label: "ドル円" },
];

// ダウ30 構成銘柄（全30銘柄）
const DOW_CONSTITUENTS = [
  ["GS",   "ゴールドマン・サックス"],
  ["UNH",  "ユナイテッドヘルス"],
  ["MSFT", "マイクロソフト"],
  ["HD",   "ホーム・デポ"],
  ["CAT",  "キャタピラー"],
  ["SHW",  "シャーウィン・ウィリアムズ"],
  ["V",    "ビザ"],
  ["AXP",  "アメリカン・エキスプレス"],
  ["MCD",  "マクドナルド"],
  ["CRM",  "セールスフォース"],
  ["AMGN", "アムジェン"],
  ["TRV",  "トラベラーズ"],
  ["JPM",  "JPモルガン・チェース"],
  ["AAPL", "アップル"],
  ["IBM",  "IBM"],
  ["HON",  "ハネウェル"],
  ["AMZN", "アマゾン"],
  ["BA",   "ボーイング"],
  ["JNJ",  "ジョンソン&ジョンソン"],
  ["PG",   "P&G"],
  ["CVX",  "シェブロン"],
  ["NVDA", "エヌビディア"],
  ["MMM",  "スリーエム"],
  ["DIS",  "ディズニー"],
  ["MRK",  "メルク"],
  ["WMT",  "ウォルマート"],
  ["NKE",  "ナイキ"],
  ["KO",   "コカ・コーラ"],
  ["CSCO", "シスコシステムズ"],
  ["VZ",   "ベライゾン"],
];

// 米国セクター（業種別騰落用）。SECTORSの静的グループを使う。
function dowContribution(data) {
  if (!data || data.change == null) return null;
  return data.change / DOW_DIVISOR;
}

async function buildDow() {
  dowBuilt = true;
  refreshDowMarkets();
  buildDowSectors();

  const rows = await Promise.all(
    DOW_CONSTITUENTS.map(async ([sym, name]) => {
      const data = await fetchAndCache(sym);
      return { sym, name, data, contrib: dowContribution(data) };
    })
  );

  // 値上がり率／値下がり率（％）の大きい順に並べる（直感に合う順番）
  const valid = rows.filter((r) => r.data && r.data.changePct != null);
  const ups = valid.filter((r) => r.data.changePct > 0).sort((a, b) => b.data.changePct - a.data.changePct).slice(0, 15);
  const downs = valid.filter((r) => r.data.changePct < 0).sort((a, b) => a.data.changePct - b.data.changePct).slice(0, 15);

  renderDowRank(dowUpEl, ups, "up");
  renderDowRank(dowDownEl, downs, "down");
  renderDowHeatmap(rows);
}

function renderDowRank(container, list, dir) {
  container.innerHTML = "";
  if (!list.length) {
    container.innerHTML = `<div class="n225-empty">データ取得中…</div>`;
    return;
  }
  list.forEach((r, i) => {
    const row = document.createElement("div");
    row.className = "n225-row";
    const pts = Math.abs(r.contrib);
    const sign = r.contrib >= 0 ? "+" : "−";
    const pctTxt = r.data.changePct != null
      ? `${r.data.changePct >= 0 ? "+" : ""}${r.data.changePct.toFixed(2)}%`
      : "—";
    row.innerHTML = `
      <span class="n225-rk">${i + 1}</span>
      <span class="n225-info">
        <span class="n225-nm">${r.name}</span>
        <span class="n225-code">${r.sym}</span>
      </span>
      <span class="n225-vals">
        <span class="n225-pts ${dir}">${sign}${pts.toFixed(1)}pt</span>
        <span class="n225-chg ${dir}">${pctTxt}</span>
      </span>
      <span class="row-metrics" data-mk="${r.sym}" hidden></span>`;
    row.addEventListener("click", () => openChart(r.sym));
    container.appendChild(row);
  });
  fillRowMetrics(list.map((r) => r.sym), container);
}

function renderDowHeatmap(rows) {
  dowHeatmapEl.innerHTML = "";
  const withPrice = rows.filter((r) => r.data && r.data.price != null);
  withPrice.sort((a, b) => b.data.price - a.data.price);
  withPrice.forEach((r, idx) => {
    const tile = document.createElement("div");
    let sizeCls = "sz-s";
    if (idx < 6) sizeCls = "sz-l";
    else if (idx < 18) sizeCls = "sz-m";
    tile.className = `n225-tile ${sizeCls}`;
    tile.style.background = changeToColor(r.data.changePct);
    const pct = r.data.changePct;
    const pctTxt = pct != null ? `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%` : "—";
    tile.innerHTML = `
      <span class="n225-tnm">${r.name}</span>
      <span class="n225-tpct">${pctTxt}</span>`;
    tile.addEventListener("click", () => openChart(r.sym));
    dowHeatmapEl.appendChild(tile);
  });
}

async function refreshDowMarkets() {
  const results = await Promise.all(DOW_MARKETS.map(({ symbol }) => fetchAndCache(symbol)));
  dowMarketsEl.innerHTML = "";
  results.forEach((data, i) => {
    const { label } = DOW_MARKETS[i];
    const tile = document.createElement("div");
    tile.className = "n225-mk";
    if (!data) {
      tile.innerHTML = `<span class="n225-mk-label">${label}</span><span class="n225-mk-price">—</span>`;
    } else {
      const up = (data.change ?? 0) >= 0;
      const cls = data.change == null ? "flat" : up ? "up" : "down";
      const sign = up ? "+" : "";
      const chg = data.changePct != null
        ? `${up ? "▲" : "▼"} ${sign}${data.changePct.toFixed(2)}%`
        : "—";
      tile.innerHTML = `
        <span class="n225-mk-label">${label}</span>
        <span class="n225-mk-price">${fmtPrice(data.price, data.currency)}</span>
        <span class="n225-mk-change ${cls}">${chg}</span>`;
    }
    dowMarketsEl.appendChild(tile);
  });
}

// 業種別の騰落（米国セクターの主要銘柄の平均前日比）
async function buildDowSectors() {
  const groups = SECTORS.filter((s) => !s.dynamic);
  dowSectorsEl.innerHTML = `<div class="n225-empty">業種データ取得中…</div>`;
  const rows = await Promise.all(
    groups.map(async (g) => {
      const results = await Promise.all(g.stocks.map(([sym]) => fetchAndCache(sym)));
      const valid = results.filter((d) => d && d.changePct != null);
      const avg = valid.length
        ? valid.reduce((s, d) => s + d.changePct, 0) / valid.length
        : null;
      return { name: g.name, icon: g.icon, avg };
    })
  );
  const valid = rows.filter((r) => r.avg != null).sort((a, b) => b.avg - a.avg);
  const maxAbs = Math.max(0.1, ...valid.map((r) => Math.abs(r.avg)));
  dowSectorsEl.innerHTML = "";
  valid.forEach((r) => {
    const up = r.avg >= 0;
    const w = Math.min(100, (Math.abs(r.avg) / maxAbs) * 100);
    const row = document.createElement("div");
    row.className = "n225-sec-row";
    row.innerHTML = `
      <span class="n225-sec-name">${r.icon} ${r.name}</span>
      <span class="n225-sec-bar"><span class="n225-sec-fill ${up ? "up" : "down"}" style="width:${w}%"></span></span>
      <span class="n225-sec-val ${up ? "up" : "down"}">${up ? "+" : ""}${r.avg.toFixed(2)}%</span>`;
    dowSectorsEl.appendChild(row);
  });
}

function reloadDow() {
  quoteCache.clear();
  dowBuilt = false;
  buildDow();
}

/* ===== NASDAQ100ダッシュボード（時価総額加重） ===== */

const NDX_MARKETS = [
  { symbol: "^IXIC", label: "NASDAQ総合" },
  { symbol: "^NDX",  label: "NASDAQ100" },
  { symbol: "^GSPC", label: "S&P 500" },
  { symbol: "^SOX",  label: "半導体(SOX)" },
  { symbol: "^DJI",  label: "NYダウ" },
  { symbol: "JPY=X", label: "ドル円" },
];

// NASDAQ100 構成銘柄（時価総額の大きい順・主要約100銘柄）
const NDX_CONSTITUENTS = [
  "AAPL","MSFT","NVDA","AMZN","AVGO","META","NFLX","TSLA","COST","GOOGL",
  "GOOG","PLTR","CSCO","TMUS","AMD","LIN","INTU","PEP","TXN","BKNG",
  "QCOM","ISRG","ADBE","AMGN","HON","AMAT","GILD","CMCSA","ADP","VRTX",
  "PANW","MU","ADI","LRCX","MELI","KLAC","CRWD","SBUX","INTC","CEG",
  "APP","CDNS","MDLZ","ORLY","SNPS","MAR","CTAS","FTNT","DASH","ABNB",
  "PYPL","REGN","ADSK","MNST","ROP","AEP","NXPI","PCAR","CPRT","AXON",
  "ROST","FAST","KDP","PAYX","CHTR","TTD","DDOG","EXC","VRSK","KHC",
  "XEL","EA","CSGP","LULU","IDXX","BKR","FANG","TTWO","CTSH","GEHC",
  "ON","CDW","BIIB","GFS","MRVL","WBD","DXCM","ANSS","ZS","ARM",
  "SMCI","MDB","WDAY","TEAM","MCHP","ODFL","PDD","NOW","ORCL",
];

let ndxCapData = []; // バッチ取得した時価総額つきデータ

async function buildNdx() {
  ndxBuilt = true;
  refreshNdxMarkets();
  buildNdxSectors();
  await buildNdxRanking();
}

async function buildNdxRanking() {
  ndxUpEl.innerHTML = `<div class="n225-empty">データ取得中…</div>`;
  ndxDownEl.innerHTML = `<div class="n225-empty">データ取得中…</div>`;
  ndxHeatmapEl.innerHTML = "";

  // 時価総額つきでまとめて取得 ＆ 指数本体（^NDX）の水準を取得
  let quotes = [];
  try {
    const res = await fetch(`/api/quotes?symbols=${encodeURIComponent(NDX_CONSTITUENTS.join(","))}`);
    const d = await res.json();
    quotes = d.quotes || [];
  } catch { quotes = []; }
  ndxCapData = quotes;

  const ndxData = await fetchAndCache("^NDX");
  const ndxLevel = ndxData?.price || 0;

  const valid = quotes.filter((q) => q.marketCap && q.changePct != null);
  const totalCap = valid.reduce((s, q) => s + q.marketCap, 0) || 1;

  // 寄与度(指数ポイント) ≒ 指数水準 × ウェイト × 前日比/100
  const rows = valid.map((q) => {
    const weight = q.marketCap / totalCap;
    const contrib = ndxLevel * weight * (q.changePct / 100);
    return { sym: q.symbol, name: q.name, data: q, weight, contrib, cap: q.marketCap, changePct: q.changePct };
  });

  // 値上がり率／値下がり率（％）の大きい順に並べる（直感に合う順番）
  const ups = rows.filter((r) => r.changePct > 0).sort((a, b) => b.changePct - a.changePct).slice(0, 15);
  const downs = rows.filter((r) => r.changePct < 0).sort((a, b) => a.changePct - b.changePct).slice(0, 15);

  renderNdxRank(ndxUpEl, ups, "up");
  renderNdxRank(ndxDownEl, downs, "down");
  renderNdxHeatmap(rows);
}

function renderNdxRank(container, list, dir) {
  container.innerHTML = "";
  if (!list.length) {
    container.innerHTML = `<div class="n225-empty">データなし</div>`;
    return;
  }
  list.forEach((r, i) => {
    const row = document.createElement("div");
    row.className = "n225-row";
    const pts = Math.abs(r.contrib);
    const sign = r.contrib >= 0 ? "+" : "−";
    const pctTxt = r.changePct != null
      ? `${r.changePct >= 0 ? "+" : ""}${r.changePct.toFixed(2)}%`
      : "—";
    row.innerHTML = `
      <span class="n225-rk">${i + 1}</span>
      <span class="n225-info">
        <span class="n225-nm">${r.name}</span>
        <span class="n225-code">${r.sym} · ${(r.weight * 100).toFixed(1)}%</span>
      </span>
      <span class="n225-vals">
        <span class="n225-pts ${dir}">${sign}${pts.toFixed(1)}pt</span>
        <span class="n225-chg ${dir}">${pctTxt}</span>
      </span>
      <span class="row-metrics" data-mk="${r.sym}" hidden></span>`;
    row.addEventListener("click", () => openChart(r.sym));
    container.appendChild(row);
  });
  fillRowMetrics(list.map((r) => r.sym), container);
}

function renderNdxHeatmap(rows) {
  ndxHeatmapEl.innerHTML = "";
  // タイルの大きさは時価総額（指数への影響度）でランク分け
  const withCap = rows.filter((r) => r.cap).sort((a, b) => b.cap - a.cap);
  withCap.forEach((r, idx) => {
    const tile = document.createElement("div");
    let sizeCls = "sz-s";
    if (idx < 8) sizeCls = "sz-l";
    else if (idx < 24) sizeCls = "sz-m";
    tile.className = `n225-tile ${sizeCls}`;
    tile.style.background = changeToColor(r.changePct);
    const pctTxt = r.changePct != null ? `${r.changePct >= 0 ? "+" : ""}${r.changePct.toFixed(2)}%` : "—";
    tile.innerHTML = `
      <span class="n225-tnm">${r.sym}</span>
      <span class="n225-tpct">${pctTxt}</span>`;
    tile.addEventListener("click", () => openChart(r.sym));
    ndxHeatmapEl.appendChild(tile);
  });
}

async function refreshNdxMarkets() {
  const results = await Promise.all(NDX_MARKETS.map(({ symbol }) => fetchAndCache(symbol)));
  ndxMarketsEl.innerHTML = "";
  results.forEach((data, i) => {
    const { label } = NDX_MARKETS[i];
    const tile = document.createElement("div");
    tile.className = "n225-mk";
    if (!data) {
      tile.innerHTML = `<span class="n225-mk-label">${label}</span><span class="n225-mk-price">—</span>`;
    } else {
      const up = (data.change ?? 0) >= 0;
      const cls = data.change == null ? "flat" : up ? "up" : "down";
      const sign = up ? "+" : "";
      const chg = data.changePct != null
        ? `${up ? "▲" : "▼"} ${sign}${data.changePct.toFixed(2)}%`
        : "—";
      tile.innerHTML = `
        <span class="n225-mk-label">${label}</span>
        <span class="n225-mk-price">${fmtPrice(data.price, data.currency)}</span>
        <span class="n225-mk-change ${cls}">${chg}</span>`;
    }
    ndxMarketsEl.appendChild(tile);
  });
}

// 業種別の騰落（NASDAQの業種グループの平均前日比）
async function buildNdxSectors() {
  ndxSectorsEl.innerHTML = `<div class="n225-empty">業種データ取得中…</div>`;
  const rows = await Promise.all(
    NASDAQ_GROUPS.map(async (g) => {
      const results = await Promise.all(g.stocks.map(([sym]) => fetchAndCache(sym)));
      const valid = results.filter((d) => d && d.changePct != null);
      const avg = valid.length
        ? valid.reduce((s, d) => s + d.changePct, 0) / valid.length
        : null;
      return { name: g.name, icon: g.icon, avg };
    })
  );
  const valid = rows.filter((r) => r.avg != null).sort((a, b) => b.avg - a.avg);
  const maxAbs = Math.max(0.1, ...valid.map((r) => Math.abs(r.avg)));
  ndxSectorsEl.innerHTML = "";
  valid.forEach((r) => {
    const up = r.avg >= 0;
    const w = Math.min(100, (Math.abs(r.avg) / maxAbs) * 100);
    const row = document.createElement("div");
    row.className = "n225-sec-row";
    row.innerHTML = `
      <span class="n225-sec-name">${r.icon} ${r.name}</span>
      <span class="n225-sec-bar"><span class="n225-sec-fill ${up ? "up" : "down"}" style="width:${w}%"></span></span>
      <span class="n225-sec-val ${up ? "up" : "down"}">${up ? "+" : ""}${r.avg.toFixed(2)}%</span>`;
    ndxSectorsEl.appendChild(row);
  });
}

function reloadNdx() {
  quoteCache.clear();
  ndxBuilt = false;
  buildNdx();
}

/* ===== チャートモーダル（銘柄クリックで表示） ===== */

const modalEl = document.getElementById("chartModal");
const modalNameEl = modalEl.querySelector(".modal-name");
const modalSymbolEl = modalEl.querySelector(".modal-symbol");
const modalPriceEl = modalEl.querySelector(".modal-price");
const modalChangeEl = modalEl.querySelector(".modal-change");
const modalChartEl = modalEl.querySelector(".modal-chart");
const modalChartWrap = modalEl.querySelector(".modal-chart-wrap");
const modalTooltip = modalEl.querySelector(".modal-tooltip");
const modalAxis = modalEl.querySelector(".modal-axis");
const modalStatus = modalEl.querySelector(".modal-status");
const modalOhlc = modalEl.querySelector(".modal-ohlc");
const modalMaLegend = modalEl.querySelector(".modal-ma-legend");
const rangeBtns = modalEl.querySelectorAll(".range-btn");

let chartSymbol = null;
let chartCurrency = "";
let chartPoints = [];      // 描画した点の座標 {x, y, value, ts}
let chartReqId = 0;        // 古いリクエストの結果を無視するための番号

function openChart(symbol) {
  chartSymbol = symbol;
  modalEl.hidden = false;
  modalNameEl.textContent = symbol;
  modalSymbolEl.textContent = symbol;
  modalPriceEl.textContent = "—";
  modalChangeEl.className = "modal-change flat";
  modalChangeEl.innerHTML = "&nbsp;";
  // 既定の期間（1ヶ月）を選択した状態にする
  rangeBtns.forEach((b) => b.classList.toggle("active", b.dataset.range === "1mo"));
  // 最初の読み込みで上部の「前日比」も確定させる（以後は期間を変えても固定）
  loadChart("1mo", "1d", true);
}

function closeChart() {
  modalEl.hidden = true;
  chartSymbol = null;
  modalTooltip.hidden = true;
}

async function loadChart(range, interval, updateHeadline) {
  const symbol = chartSymbol;
  const reqId = ++chartReqId;
  modalChartEl.innerHTML = "";
  modalAxis.innerHTML = "";
  modalTooltip.hidden = true;
  if (modalMaLegend) modalMaLegend.innerHTML = "";
  chartPoints = [];
  modalStatus.textContent = "読み込み中…";
  try {
    const res = await fetch(
      `/api/quote?symbol=${encodeURIComponent(symbol)}&range=${range}&interval=${interval}`
    );
    const data = await res.json();
    if (reqId !== chartReqId) return; // 新しい操作が入ったので破棄
    if (data.error) {
      modalStatus.textContent = "⚠ " + data.error;
      return;
    }
    modalStatus.textContent = "";
    modalNameEl.textContent = data.name || symbol;
    modalSymbolEl.textContent = data.symbol;
    chartCurrency = data.currency;
    // 価格は常に現在値、騰落表示は「選んだ期間」に合わせて計算し直す
    modalPriceEl.textContent = fmtPrice(data.price, data.currency);
    updateHeadlineChange(range, data);
    // 25日・75日移動平均は表示期間が短い（例：1ヶ月＝約22本）と計算できないので、
    // 日足のときは別途1年分の日足を取って移動平均だけ長い系列から計算する
    let maSeries = null;
    if (interval === "1d") {
      try {
        const r2 = await fetch(
          `/api/quote?symbol=${encodeURIComponent(symbol)}&range=1y&interval=1d`
        );
        const d2 = await r2.json();
        if (reqId === chartReqId && !d2.error && Array.isArray(d2.candles)) {
          maSeries = d2.candles;
        }
      } catch {}
      if (reqId !== chartReqId) return;
    }
    drawBigChart(data.candles, maSeries);
  } catch {
    if (reqId !== chartReqId) return;
    modalStatus.textContent = "⚠ サーバーに接続できません";
  }
}

// 上部の騰落表示を「選んだ期間」に合わせて計算（1日=前日比、それ以外=期間内の変化）
const RANGE_LABELS = { "1d": "本日", "5d": "1週間", "1mo": "1ヶ月", "6mo": "6ヶ月", "1y": "1年", "5y": "5年" };
function updateHeadlineChange(range, data) {
  let change = null, pct = null, label = "";
  if (range === "1d" && data.change != null) {
    // 1日表示は通常の「前日比」
    change = data.change; pct = data.changePct; label = "前日比";
  } else {
    // 期間内の最初の価格→最後の価格で騰落を計算
    const candles = data.candles || [];
    let first = null, last = null;
    for (const c of candles) {
      const v = (c.c != null) ? c.c : c.o;
      if (v == null) continue;
      if (first === null) first = v;
      last = v;
    }
    if (first != null && last != null && first !== 0) {
      change = last - first;
      pct = (change / first) * 100;
      label = (RANGE_LABELS[range] || "期間") + "の変化";
    }
  }
  if (change == null) {
    modalChangeEl.className = "modal-change flat";
    modalChangeEl.innerHTML = "&nbsp;";
    return;
  }
  const up = change >= 0;
  modalChangeEl.className = "modal-change " + (change === 0 ? "flat" : up ? "up" : "down");
  const sign = up ? "+" : "";
  modalChangeEl.textContent = `${label} ${up ? "▲" : "▼"} ${sign}${change.toFixed(2)} (${sign}${pct.toFixed(2)}%)`;
}

const NS = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs) {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
}
function fmtVol(v) {
  if (v == null) return "—";
  if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
  return String(v);
}

// TradingView風ローソク足チャート
function drawBigChart(candles, maSeries) {
  const svg = modalChartEl;
  svg.innerHTML = "";
  modalAxis.innerHTML = "";
  chartPoints = [];
  if (!candles || candles.length < 2) {
    modalStatus.textContent = "この期間のデータがありません";
    if (modalOhlc) modalOhlc.innerHTML = "";
    return;
  }

  const W = 640, H = 300, padX = 6;
  const priceTop = 10, priceBottom = 222;   // ローソク足エリア
  const volTop = 244, volBottom = 294;        // 出来高エリア

  let min = Math.min(...candles.map((c) => c.l));
  let max = Math.max(...candles.map((c) => c.h));
  const rawSpan = (max - min) || 1;
  min -= rawSpan * 0.04;
  max += rawSpan * 0.04;
  const span = (max - min) || 1;
  const yOf = (v) => priceTop + (priceBottom - priceTop) * (1 - (v - min) / span);

  const n = candles.length;
  const slot = (W - padX * 2) / n;
  const bodyW = Math.max(1, Math.min(16, slot * 0.7));
  const maxVol = Math.max(...candles.map((c) => c.v || 0), 1);
  const volH = (v) => ((v || 0) / maxVol) * (volBottom - volTop);

  const UP = "#26a69a", DOWN = "#ef5350";

  // 横グリッド + 右側の価格ラベル
  const LEVELS = 5;
  for (let i = 0; i < LEVELS; i++) {
    const v = max - (span * i) / (LEVELS - 1);
    const y = yOf(v);
    svg.appendChild(svgEl("line", { x1: padX, x2: W - padX, y1: y, y2: y, stroke: "var(--border)", "stroke-width": 1, opacity: 0.35 }));
    const label = document.createElement("div");
    label.className = "axis-label";
    label.textContent = fmtPrice(v, chartCurrency);
    label.style.top = (y / H) * 100 + "%";
    modalAxis.appendChild(label);
  }
  // 縦グリッド（約6本）
  const VLINES = 6;
  for (let i = 1; i < VLINES; i++) {
    const x = padX + ((W - padX * 2) * i) / VLINES;
    svg.appendChild(svgEl("line", { x1: x, x2: x, y1: priceTop, y2: priceBottom, stroke: "var(--border)", "stroke-width": 1, opacity: 0.18 }));
  }

  // ローソク足 + 出来高
  const coords = [];
  candles.forEach((c, i) => {
    const xc = padX + slot * (i + 0.5);
    const up = c.c >= c.o;
    const col = up ? UP : DOWN;
    // ヒゲ
    svg.appendChild(svgEl("line", { x1: xc, x2: xc, y1: yOf(c.h), y2: yOf(c.l), stroke: col, "stroke-width": 1 }));
    // 実体
    const yo = yOf(c.o), yc = yOf(c.c);
    let top = Math.min(yo, yc), hgt = Math.abs(yc - yo);
    if (hgt < 1) hgt = 1;
    svg.appendChild(svgEl("rect", { x: xc - bodyW / 2, y: top, width: bodyW, height: hgt, fill: col }));
    // 出来高バー
    const vh = volH(c.v);
    svg.appendChild(svgEl("rect", { x: xc - bodyW / 2, y: volBottom - vh, width: bodyW, height: vh, fill: col, opacity: 0.4 }));
    coords.push({ x: xc, y: yc, value: c.c, ts: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v });
  });
  chartPoints = coords;

  // 移動平均線（5日 / 25日 / 75日）— 終値ベースの単純移動平均
  // 表示期間が短いと25/75日線が計算できないため、長い系列(maSeries)があればそれで計算し、
  // 表示中のローソク足には日付(タイムスタンプ)で突き合わせて重ねる
  const longer = maSeries && maSeries.length > candles.length ? maSeries : candles;
  const lcloses = longer.map((c) => c.c);
  const smaFull = (period) => {
    const out = [];
    let sum = 0;
    for (let i = 0; i < lcloses.length; i++) {
      sum += lcloses[i];
      if (i >= period) sum -= lcloses[i - period];
      out.push(i >= period - 1 ? sum / period : null);
    }
    return out;
  };
  const drawMA = (period, color) => {
    const vals = smaFull(period);
    // タイムスタンプ → 移動平均値 のマップを作り、表示中の足に合わせて描く
    const byTs = new Map();
    longer.forEach((c, i) => {
      if (vals[i] != null) byTs.set(c.t, vals[i]);
    });
    let dpath = "";
    let any = false;
    candles.forEach((c, i) => {
      const v = byTs.get(c.t);
      if (v == null) return;
      any = true;
      const x = padX + slot * (i + 0.5);
      const y = yOf(v);
      dpath += (dpath ? " L" : "M") + x.toFixed(1) + " " + y.toFixed(1);
    });
    if (dpath) {
      svg.appendChild(svgEl("path", { d: dpath, fill: "none", stroke: color, "stroke-width": 1.4, opacity: 0.9 }));
    }
    return any;
  };
  const MA5 = "#42a5f5", MA25 = "#f5a623", MA75 = "#7c5cff";
  const has5 = drawMA(5, MA5);
  const has25 = drawMA(25, MA25);
  const has75 = drawMA(75, MA75);
  // 移動平均線の凡例
  if (modalMaLegend) {
    let lg = "";
    if (has5) lg += `<span class="ma-leg"><i style="background:${MA5}"></i>5日線</span>`;
    if (has25) lg += `<span class="ma-leg"><i style="background:${MA25}"></i>25日線</span>`;
    if (has75) lg += `<span class="ma-leg"><i style="background:${MA75}"></i>75日線</span>`;
    modalMaLegend.innerHTML = lg;
  }

  // 十字カーソル（縦・横）と点
  const crossV = svgEl("line", { class: "chart-cross", y1: 0, y2: H, stroke: "var(--muted)", "stroke-width": 1, "stroke-dasharray": "4 4", opacity: 0 });
  const crossH = svgEl("line", { class: "chart-cross", x1: padX, x2: W - padX, stroke: "var(--muted)", "stroke-width": 1, "stroke-dasharray": "4 4", opacity: 0 });
  const dot = svgEl("circle", { class: "chart-dot", r: "3.5", fill: "#fff", stroke: "#000", "stroke-width": "1", opacity: 0 });
  svg.appendChild(crossV);
  svg.appendChild(crossH);
  svg.appendChild(dot);
  svg._crossV = crossV;
  svg._crossH = crossH;
  svg._dot = dot;

  // OHLCレジェンド（既定は最新の足）
  updateOhlcLegend(coords[coords.length - 1]);
}

function updateOhlcLegend(c) {
  if (!modalOhlc || !c) return;
  const up = c.c >= c.o;
  const cls = up ? "up" : "down";
  const chg = c.o ? ((c.c - c.o) / c.o) * 100 : 0;
  const sign = chg >= 0 ? "+" : "";
  modalOhlc.innerHTML =
    `<span class="ol-pair"><i>始</i>${fmtPrice(c.o, chartCurrency)}</span>` +
    `<span class="ol-pair"><i>高</i>${fmtPrice(c.h, chartCurrency)}</span>` +
    `<span class="ol-pair"><i>安</i>${fmtPrice(c.l, chartCurrency)}</span>` +
    `<span class="ol-pair"><i>終</i><b class="${cls}">${fmtPrice(c.c, chartCurrency)}</b></span>` +
    `<span class="ol-chg ${cls}">${sign}${chg.toFixed(2)}%</span>` +
    `<span class="ol-vol">出来高 ${fmtVol(c.v)}</span>`;
}

function fmtChartDate(ts) {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const mo = d.getMonth() + 1;
  const day = d.getDate();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  // 当日内（時刻が0:00以外）は時刻も表示
  if (hh !== "00" || mm !== "00") return `${mo}/${day} ${hh}:${mm}`;
  return `${d.getFullYear()}/${mo}/${day}`;
}

function handleChartHover(e) {
  if (!chartPoints.length) return;
  const svgRect = modalChartEl.getBoundingClientRect();
  const relX = (e.clientX - svgRect.left) / svgRect.width;
  let idx = Math.round(relX * (chartPoints.length - 1));
  idx = Math.max(0, Math.min(chartPoints.length - 1, idx));
  const p = chartPoints[idx];
  const svg = modalChartEl;
  if (svg._crossV) {
    svg._crossV.setAttribute("x1", p.x);
    svg._crossV.setAttribute("x2", p.x);
    svg._crossV.setAttribute("opacity", "1");
  }
  if (svg._crossH) {
    svg._crossH.setAttribute("y1", p.y);
    svg._crossH.setAttribute("y2", p.y);
    svg._crossH.setAttribute("opacity", "1");
  }
  if (svg._dot) {
    svg._dot.setAttribute("cx", p.x);
    svg._dot.setAttribute("cy", p.y);
    svg._dot.setAttribute("opacity", "1");
  }
  // 上部のOHLCレジェンドをホバー中の足に更新
  updateOhlcLegend(p);
  modalTooltip.hidden = false;
  modalTooltip.innerHTML = `<div class="tt-date">${fmtChartDate(p.ts)}</div>`;
  const pxX = (p.x / 640) * svgRect.width;
  const wrapW = modalChartWrap.getBoundingClientRect().width;
  modalTooltip.style.left = Math.max(40, Math.min(wrapW - 40, pxX)) + "px";
}

function hideChartHover() {
  modalTooltip.hidden = true;
  const svg = modalChartEl;
  if (svg._crossV) svg._crossV.setAttribute("opacity", "0");
  if (svg._crossH) svg._crossH.setAttribute("opacity", "0");
  if (svg._dot) svg._dot.setAttribute("opacity", "0");
  // レジェンドを最新の足に戻す
  if (chartPoints.length) updateOhlcLegend(chartPoints[chartPoints.length - 1]);
}

rangeBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    rangeBtns.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    loadChart(btn.dataset.range, btn.dataset.interval, false);
  });
});

modalEl.querySelector(".modal-close").addEventListener("click", closeChart);
modalEl.querySelector(".modal-backdrop").addEventListener("click", closeChart);
modalChartWrap.addEventListener("mousemove", handleChartHover);
modalChartWrap.addEventListener("mouseleave", hideChartHover);
// スマホ（タッチ）対応：指でなぞると十字カーソルとOHLCが追従
modalChartWrap.addEventListener("touchstart", (e) => {
  if (e.touches[0]) handleChartHover(e.touches[0]);
}, { passive: true });
modalChartWrap.addEventListener("touchmove", (e) => {
  if (e.touches[0]) { handleChartHover(e.touches[0]); e.preventDefault(); }
}, { passive: false });
modalChartWrap.addEventListener("touchend", hideChartHover);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !modalEl.hidden) closeChart();
});

/* ===== タブ切り替え ===== */

let currentView = "watchlist";

// ===== 🇯🇵 日本市場 全体ダッシュボード =====
let jpBuilt = false;
const jpMarketsEl = document.getElementById("jpMarkets");
const jpSectorsEl = document.getElementById("jpSectors");
const jpUpEl = document.getElementById("jpUp");
const jpDownEl = document.getElementById("jpDown");
const jpHeatmapEl = document.getElementById("jpHeatmap");
const jpReloadBtn = document.getElementById("jpReload");

// 上部マーケットストリップ（日本中心＋グローバルの参考指数）
const JP_MARKETS = [
  { symbol: "^N225",     label: "日経平均" },
  { symbol: "NIY=F",     label: "日経先物(夜間)" },
  { symbol: "1306.T",    label: "TOPIX(ETF)" },
  { symbol: "2516.T",    label: "東証グロース250" },
  { symbol: "JPY=X",     label: "ドル円" },
  { symbol: "^DJI",      label: "NYダウ" },
  { symbol: "000001.SS", label: "上海総合" },
];

async function buildJp() {
  jpBuilt = true;
  refreshJpMarkets();
  buildJpSectors();
  loadJpRanking();
  buildJpHeatmap();
}

async function refreshJpMarkets() {
  const results = await Promise.all(JP_MARKETS.map(({ symbol }) => fetchAndCache(symbol)));
  jpMarketsEl.innerHTML = "";
  results.forEach((data, i) => {
    const { label } = JP_MARKETS[i];
    const tile = document.createElement("div");
    tile.className = "n225-mk";
    if (!data) {
      tile.innerHTML = `<span class="n225-mk-label">${label}</span><span class="n225-mk-price">—</span>`;
    } else {
      const up = (data.change ?? 0) >= 0;
      const cls = data.change == null ? "flat" : up ? "up" : "down";
      const sign = up ? "+" : "";
      const chg = data.changePct != null
        ? `${up ? "▲" : "▼"} ${sign}${data.changePct.toFixed(2)}%`
        : "—";
      tile.innerHTML = `
        <span class="n225-mk-label">${label}</span>
        <span class="n225-mk-price">${fmtPrice(data.price, data.currency)}</span>
        <span class="n225-mk-change ${cls}">${chg}</span>`;
    }
    jpMarketsEl.appendChild(tile);
  });
}

async function buildJpSectors() {
  const groups = JP_SECTORS.filter((s) => !s.dynamic);
  jpSectorsEl.innerHTML = `<div class="n225-empty">業種データ取得中…</div>`;
  const rows = await Promise.all(
    groups.map(async (g) => {
      const results = await Promise.all(g.stocks.map(([sym]) => fetchAndCache(sym)));
      const valid = results.filter((d) => d && d.changePct != null);
      const avg = valid.length
        ? valid.reduce((s, d) => s + d.changePct, 0) / valid.length
        : null;
      return { name: g.name, icon: g.icon, avg };
    })
  );
  const valid = rows.filter((r) => r.avg != null).sort((a, b) => b.avg - a.avg);
  const maxAbs = Math.max(0.1, ...valid.map((r) => Math.abs(r.avg)));
  jpSectorsEl.innerHTML = "";
  valid.forEach((r) => {
    const up = r.avg >= 0;
    const w = Math.min(100, (Math.abs(r.avg) / maxAbs) * 100);
    const row = document.createElement("div");
    row.className = "n225-sec-row";
    row.innerHTML = `
      <span class="n225-sec-name">${r.icon} ${r.name}</span>
      <span class="n225-sec-bar"><span class="n225-sec-fill ${up ? "up" : "down"}" style="width:${w}%"></span></span>
      <span class="n225-sec-val ${up ? "up" : "down"}">${up ? "+" : ""}${r.avg.toFixed(2)}%</span>`;
    jpSectorsEl.appendChild(row);
  });
}

// 市場全体の値上がり率/値下がり率ランキング（全市場のリアルデータ）
async function loadJpRanking() {
  jpUpEl.innerHTML = `<div class="n225-empty">市場全体から取得中…</div>`;
  jpDownEl.innerHTML = `<div class="n225-empty">市場全体から取得中…</div>`;
  const [up, down] = await Promise.all([fetchJpRank("up"), fetchJpRank("down")]);
  renderJpRank(jpUpEl, up, "up");
  renderJpRank(jpDownEl, down, "down");
}

async function fetchJpRank(dir) {
  try {
    const res = await fetch(`/api/kabutan?dir=${dir}`);
    const d = await res.json();
    return d.rows || [];
  } catch { return []; }
}

function renderJpRank(container, rows, dir) {
  container.innerHTML = "";
  if (!rows.length) {
    container.innerHTML = `<div class="n225-empty">取得できませんでした。少し待って🔄更新を押してください。</div>`;
    return;
  }
  rows.slice(0, 20).forEach((r, i) => {
    const row = document.createElement("div");
    row.className = "n225-row";
    row.innerHTML = `
      <span class="n225-rk">${i + 1}</span>
      <span class="n225-info">
        <span class="n225-nm">${r.name}</span>
        <span class="n225-code">${r.code} · ${r.market}</span>
      </span>
      <span class="n225-vals">
        <span class="n225-pts ${dir}">${r.price}円</span>
        <span class="n225-chg ${dir}">${r.changePct}</span>
      </span>
      <span class="row-metrics" data-mk="${r.code}.T" hidden></span>`;
    row.addEventListener("click", () => openChart(`${r.code}.T`));
    container.appendChild(row);
  });
  fillRowMetrics(rows.slice(0, 20).map((r) => `${r.code}.T`), container);
}

// 主要銘柄ヒートマップ（日経225主要銘柄を流用）
async function buildJpHeatmap() {
  jpHeatmapEl.innerHTML = `<div class="n225-empty">ヒートマップ取得中…</div>`;
  const rows = await Promise.all(
    N225_CONSTITUENTS.map(async ([sym, name]) => {
      const data = await fetchAndCache(sym);
      return { sym, name, data };
    })
  );
  jpHeatmapEl.innerHTML = "";
  const withPrice = rows.filter((r) => r.data && r.data.price != null);
  withPrice.sort((a, b) => b.data.price - a.data.price);
  withPrice.forEach((r, idx) => {
    const tile = document.createElement("div");
    let sizeCls = "sz-s";
    if (idx < 6) sizeCls = "sz-l";
    else if (idx < 18) sizeCls = "sz-m";
    tile.className = `n225-tile ${sizeCls}`;
    tile.style.background = changeToColor(r.data.changePct);
    const pct = r.data.changePct;
    const pctTxt = pct != null ? `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%` : "—";
    tile.innerHTML = `
      <span class="n225-tnm">${r.name}</span>
      <span class="n225-tpct">${pctTxt}</span>`;
    tile.addEventListener("click", () => openChart(r.sym));
    jpHeatmapEl.appendChild(tile);
  });
}

function reloadJp() {
  quoteCache.clear();
  jpBuilt = false;
  buildJp();
}

if (jpReloadBtn) {
  jpReloadBtn.addEventListener("click", () => reloadJp());
}

function switchView(view) {
  currentView = view;
  document.querySelectorAll(".tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.view === view);
  });
  document.getElementById("view-watchlist").hidden = view !== "watchlist";
  document.getElementById("view-portfolio").hidden = view !== "portfolio";
  document.getElementById("view-sectors-us").hidden = view !== "sectors-us";
  document.getElementById("view-sectors-jp").hidden = view !== "sectors-jp";
  document.getElementById("view-jp").hidden = view !== "jp";
  document.getElementById("view-n225").hidden = view !== "n225";
  document.getElementById("view-dow").hidden = view !== "dow";
  document.getElementById("view-ndx").hidden = view !== "ndx";
  document.getElementById("view-heatmap").hidden = view !== "heatmap";
  document.getElementById("view-earnings").hidden = view !== "earnings";
  if (view === "portfolio") loadPortfolio();
  if (view === "earnings") loadEarnings();
  if (view === "jp" && !jpBuilt) buildJp();
  if (view === "n225" && !n225Built) buildN225();
  if (view === "dow" && !dowBuilt) buildDow();
  if (view === "ndx" && !ndxBuilt) buildNdx();
  if (view === "heatmap" && !heatmapBuilt) buildHeatmap();
  if (view === "sectors-us" && !usSectorsSorted) { usSectorsSorted = true; sortSectorsByPerformance(usSectorListEl, SECTORS); }
  if (view === "sectors-jp" && !jpSectorsSorted) { jpSectorsSorted = true; sortSectorsByPerformance(jpSectorListEl, JP_SECTORS); }
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => switchView(tab.dataset.view));
});

// ドル円レートを取得して、米国株の「およそ◯円」換算に使う
async function refreshUsdJpy() {
  try {
    const res = await fetch("/api/quote?symbol=JPY=X");
    const d = await res.json();
    if (d && d.price) {
      usdJpyRate = d.price;
      // 既に描画済みのカードに円換算を反映
      for (const [sym, data] of watchData) {
        const card = document.getElementById(cardId(sym));
        const jpyEl = card && card.querySelector(".price-jpy");
        if (jpyEl) jpyEl.textContent = jpyApprox(data.price, data.currency);
      }
    }
  } catch {}
}

buildSectorGroup(SECTORS, usSectorListEl);
buildSectorGroup(JP_SECTORS, jpSectorListEl);
renderAll();
refreshUsdJpy();
refreshAll();
refreshIndexStrip();

/* ===== 自動リフレッシュ（5分ごと） ===== */
const lastUpdatedEl = document.getElementById("lastUpdated");

function markUpdated() {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  lastUpdatedEl.textContent = `最終更新 ${hh}:${mm}`;
}

refreshBtn.addEventListener("click", markUpdated);
markUpdated();

setInterval(() => {
  quoteCache.clear();
  quoteFetching.clear();
  usSectorsSorted = false;
  jpSectorsSorted = false;
  handleRefresh();
  refreshIndexStrip();
  markUpdated();
}, 5 * 60 * 1000);

/* ===== ニュース ===== */

function timeAgo(epochSec) {
  const diff = Math.floor(Date.now() / 1000) - epochSec;
  if (diff < 60) return "たった今";
  if (diff < 3600) return `${Math.floor(diff / 60)}分前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}時間前`;
  return `${Math.floor(diff / 86400)}日前`;
}

function makeNewsCard(item) {
  const card = document.createElement("a");
  card.className = "news-card";
  card.href = item.link || "#";
  card.target = "_blank";
  card.rel = "noopener noreferrer";
  card.addEventListener("click", (e) => {
    if (item.link) { e.preventDefault(); window.open(item.link, "_blank"); }
  });
  const meta = `<span class="news-pub">${item.publisher || ""}</span>` +
    (item.time ? ` · ${timeAgo(item.time)}` : "");
  card.innerHTML =
    `<div class="news-body">` +
      `<div class="news-title">${item.title || "(タイトルなし)"}</div>` +
      `<div class="news-meta">${meta}</div>` +
    `</div>` +
    (item.thumb ? `<img class="news-thumb" src="${item.thumb}" alt="" loading="lazy">` : "");
  return card;
}

async function loadNews(region) {
  newsLoaded = true;
  newsPage[region] = 0;
  newsSeen[region] = new Set();
  newsListEl.innerHTML = Array(6).fill('<div class="news-skeleton"></div>').join("");
  try {
    const res = await fetch(`/api/news?region=${encodeURIComponent(region)}&page=0`);
    const data = await res.json();
    newsListEl.innerHTML = "";
    if (!data.items || !data.items.length) {
      newsListEl.innerHTML = '<div class="news-empty">ニュースを取得できませんでした</div>';
      return;
    }
    for (const item of data.items) {
      const key = item.uuid || item.title;
      newsSeen[region].add(key);
      newsListEl.appendChild(makeNewsCard(item));
    }
    appendLoadMoreBtn(region);
  } catch {
    newsListEl.innerHTML = '<div class="news-empty">サーバーに接続できません</div>';
  }
}

async function loadMoreNews(region) {
  if (newsLoadingMore) return;
  newsLoadingMore = true;
  const btn = newsListEl.querySelector(".news-load-more");
  if (btn) { btn.textContent = "読み込み中…"; btn.disabled = true; }
  newsPage[region]++;
  try {
    const res = await fetch(`/api/news?region=${encodeURIComponent(region)}&page=${newsPage[region]}`);
    const data = await res.json();
    if (btn) btn.remove();
    let added = 0;
    for (const item of (data.items || [])) {
      const key = item.uuid || item.title;
      if (!newsSeen[region].has(key)) {
        newsSeen[region].add(key);
        newsListEl.appendChild(makeNewsCard(item));
        added++;
      }
    }
    if (added > 0) appendLoadMoreBtn(region);
  } catch {
    if (btn) { btn.textContent = "⟳ もっと見る"; btn.disabled = false; }
  } finally {
    newsLoadingMore = false;
  }
}

function appendLoadMoreBtn(region) {
  const btn = document.createElement("button");
  btn.className = "news-load-more ghost";
  btn.textContent = "⟳ もっと見る";
  btn.addEventListener("click", () => loadMoreNews(region));
  newsListEl.appendChild(btn);
}

document.querySelectorAll(".news-region-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".news-region-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    newsRegion = btn.dataset.region;
    loadNews(newsRegion);
  });
});

/* ===== ヒートマップのモード切替（セクター / 半導体 / NASDAQ） ===== */
document.querySelectorAll(".hm-mode-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.dataset.mode === heatmapMode) return;
    document.querySelectorAll(".hm-mode-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    heatmapMode = btn.dataset.mode;
    heatmapBuilt = false;
    buildHeatmap();
  });
});

/* ===== 適時開示 (IR) ===== */

const irListEl = document.getElementById("irList");

function irCategoryClass(cat) {
  if (["上方修正", "増配", "自己株買い", "TOB", "M&A", "提携", "株式分割", "配当", "決算"].includes(cat)) return "ir-pos";
  if (["下方修正", "減配", "特別損失", "増資", "MBO", "株式併合"].includes(cat)) return "ir-neg";
  return "ir-neu";
}

function makeIRCard(item) {
  const card = document.createElement("div");
  card.className = "ir-card" + (item.important ? " important" : "");
  const badge = item.category
    ? `<span class="ir-badge ${irCategoryClass(item.category)}">${item.category}</span>` : "";
  const time = item.time ? timeAgo(item.time) : "";
  const metaParts = [item.market, time].filter(Boolean).join(" · ");
  card.innerHTML =
    `<div class="ir-main">` +
      `<div class="ir-head">` +
        (item.code ? `<span class="ir-code">${item.code}</span>` : "") +
        `<span class="ir-company">${item.company || ""}</span>` +
        badge +
      `</div>` +
      `<div class="ir-title">${item.title || ""}</div>` +
      (metaParts ? `<div class="ir-meta">${metaParts}</div>` : "") +
    `</div>` +
    `<div class="ir-actions">` +
      (item.code ? `<button class="ir-star" title="ウォッチリストに追加">☆</button>` : "") +
      (item.pdf ? `<a class="ir-pdf" href="${item.pdf}" target="_blank" rel="noopener noreferrer">PDF</a>` : "") +
    `</div>`;
  if (item.code) {
    card.querySelector(".ir-star").addEventListener("click", (e) => {
      e.stopPropagation();
      addSymbol(item.code + ".T");
    });
  }
  if (item.pdf) {
    card.querySelector(".ir-pdf").addEventListener("click", (e) => e.stopPropagation());
    card.style.cursor = "pointer";
    card.addEventListener("click", () => window.open(item.pdf, "_blank"));
  }
  return card;
}

async function loadIR(filter) {
  irLoaded = true;
  irFilter = filter || irFilter;
  irListEl.innerHTML = Array(6).fill('<div class="news-skeleton"></div>').join("");
  try {
    const q = irFilter === "important" ? "?important=1&limit=100" : "?limit=60";
    const res = await fetch(`/api/ir${q}`);
    const data = await res.json();
    irListEl.innerHTML = "";
    if (!data.items || !data.items.length) {
      irListEl.innerHTML = '<div class="news-empty">開示情報を取得できませんでした</div>';
      return;
    }
    for (const item of data.items) irListEl.appendChild(makeIRCard(item));
  } catch {
    irListEl.innerHTML = '<div class="news-empty">サーバーに接続できません</div>';
  }
}

document.querySelectorAll(".ir-filter-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".ir-filter-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    loadIR(btn.dataset.filter);
  });
});

/* ===== IR 新着通知 ===== */

// 通知文用に HTML エンティティ（&amp; など）をふつうの文字に戻す
function decodeEntities(s) {
  const el = document.createElement("textarea");
  el.innerHTML = s || "";
  return el.value;
}

// ウォッチリストの日本株（末尾 .T）を 4桁コードの集合にする
function watchlistJPCodes() {
  const codes = new Set();
  for (const sym of symbols) {
    if (sym.endsWith(".T")) {
      const code = sym.slice(0, -2).replace(/[^0-9]/g, "");
      if (code) codes.add(code);
    }
  }
  return codes;
}

// ウォッチ中の日本株に重要な開示が出ていないか確認。初回は通知せず既存分を記録するだけ。
async function checkIRAlerts() {
  if (!irNotifyEnabled) return;
  const codes = watchlistJPCodes();
  if (!codes.size) { irNotifySeeded = true; return; }
  try {
    const res = await fetch("/api/ir?important=1&limit=100");
    const data = await res.json();
    const items = (data.items || []).filter((it) => it.code && codes.has(it.code));
    if (!irNotifySeeded) {
      for (const it of items) { const k = it.id || it.pdf; if (k) seenIR.add(k); }
      irNotifySeeded = true;
      return;
    }
    for (const it of items) {
      const id = it.id || it.pdf;
      if (!id || seenIR.has(id)) continue;
      seenIR.add(id);
      const label = it.category ? `【${it.category}】` : "";
      fireAlert(it.code + ".T", `${it.company}${label} ${decodeEntities(it.title)}`);
    }
  } catch {}
}

/* ===== 価格アラート ===== */

function loadAlerts() {
  try { return JSON.parse(localStorage.getItem(ALERT_KEY)) || {}; }
  catch { return {}; }
}
function saveAlerts() { localStorage.setItem(ALERT_KEY, JSON.stringify(alerts)); }

function fmtNum(v) {
  return v == null ? "—" : v.toLocaleString("ja-JP", { maximumFractionDigits: 2 });
}

function requestNotifyPermission() {
  if (typeof Notification !== "undefined" && Notification.permission === "default") {
    Notification.requestPermission().catch(() => {});
  }
}

function updateAlertBadge(symbol) {
  const card = document.getElementById(cardId(symbol));
  if (!card) return;
  const badge = card.querySelector(".alert-badge");
  const bell = card.querySelector(".bell");
  const a = alerts[symbol];
  if (a && (a.above != null || a.below != null || a.pctUp != null || a.pctDown != null)) {
    const parts = [];
    if (a.above != null) parts.push(`≥ ${fmtNum(a.above)}`);
    if (a.below != null) parts.push(`≤ ${fmtNum(a.below)}`);
    if (a.pctUp != null) parts.push(`+${fmtNum(a.pctUp)}%`);
    if (a.pctDown != null) parts.push(`−${fmtNum(a.pctDown)}%`);
    badge.textContent = "🔔 " + parts.join(" / ");
    badge.style.display = "inline-block";
    if (bell) bell.classList.add("active");
  } else {
    badge.textContent = "";
    badge.style.display = "none";
    if (bell) bell.classList.remove("active");
  }
}

function checkAlerts(symbol, price, changePct) {
  const a = alerts[symbol];
  if (!a || price == null) return;
  if (!alertFired[symbol]) alertFired[symbol] = {};
  const fired = alertFired[symbol];
  const card = document.getElementById(cardId(symbol));
  const name = (card && card.querySelector(".name")?.textContent) || symbol;
  if (a.above != null && price >= a.above) {
    if (!fired.above) { fired.above = true; fireAlert(symbol, `${name} が ${fmtNum(price)} に到達（${fmtNum(a.above)} 以上）📈`); }
  } else { fired.above = false; }
  if (a.below != null && price <= a.below) {
    if (!fired.below) { fired.below = true; fireAlert(symbol, `${name} が ${fmtNum(price)} まで下落（${fmtNum(a.below)} 以下）📉`); }
  } else { fired.below = false; }
  if (changePct != null) {
    if (a.pctUp != null && changePct >= a.pctUp) {
      if (!fired.pctUp) { fired.pctUp = true; fireAlert(symbol, `${name} が前日比 +${changePct.toFixed(2)}% 上昇（+${fmtNum(a.pctUp)}% 以上）📈`); }
    } else { fired.pctUp = false; }
    if (a.pctDown != null && changePct <= -a.pctDown) {
      if (!fired.pctDown) { fired.pctDown = true; fireAlert(symbol, `${name} が前日比 ${changePct.toFixed(2)}% 下落（−${fmtNum(a.pctDown)}% 以下）📉`); }
    } else { fired.pctDown = false; }
  }
}

function fireAlert(symbol, message) {
  showToast(message);
  if (typeof Notification !== "undefined" && Notification.permission === "granted") {
    try { new Notification("🔔 株アラート", { body: message }); } catch {}
  }
  const card = document.getElementById(cardId(symbol));
  if (card) card.animate(
    [{ boxShadow: "0 0 0 2px var(--accent)" }, { boxShadow: "0 0 0 2px transparent" }],
    { duration: 1400, iterations: 2 }
  );
}

let toastTimer = null;
function showToast(message) {
  let toast = document.getElementById("toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "toast";
    toast.className = "toast";
    document.body.appendChild(toast);
  }
  toast.textContent = "🔔 " + message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 6000);
}

const alertModalEl = document.getElementById("alertModal");
const alertAboveInput = document.getElementById("alertAbove");
const alertBelowInput = document.getElementById("alertBelow");
const alertPctUpInput = document.getElementById("alertPctUp");
const alertPctDownInput = document.getElementById("alertPctDown");
let alertSymbol = null;

function openAlertModal(symbol) {
  alertSymbol = symbol;
  alertModalEl.hidden = false;
  alertModalEl.querySelector(".alert-sym").textContent = symbol;
  const a = alerts[symbol] || {};
  alertAboveInput.value = a.above != null ? a.above : "";
  alertBelowInput.value = a.below != null ? a.below : "";
  alertPctUpInput.value = a.pctUp != null ? a.pctUp : "";
  alertPctDownInput.value = a.pctDown != null ? a.pctDown : "";
  requestNotifyPermission();
}

function closeAlertModal() {
  alertModalEl.hidden = true;
  alertSymbol = null;
}

document.getElementById("alertSave").addEventListener("click", () => {
  if (!alertSymbol) return;
  const above = parseFloat(alertAboveInput.value);
  const below = parseFloat(alertBelowInput.value);
  const pctUp = parseFloat(alertPctUpInput.value);
  const pctDown = parseFloat(alertPctDownInput.value);
  const obj = {};
  if (!isNaN(above)) obj.above = above;
  if (!isNaN(below)) obj.below = below;
  if (!isNaN(pctUp)) obj.pctUp = Math.abs(pctUp);
  if (!isNaN(pctDown)) obj.pctDown = Math.abs(pctDown);
  if (obj.above == null && obj.below == null && obj.pctUp == null && obj.pctDown == null) {
    delete alerts[alertSymbol];
  } else {
    alerts[alertSymbol] = obj;
  }
  alertFired[alertSymbol] = {};
  saveAlerts();
  const sym = alertSymbol;
  updateAlertBadge(sym);
  closeAlertModal();
  const d = watchData.get(sym);
  const price = lastPrice.has(sym) ? lastPrice.get(sym) : quoteCache.get(sym)?.price;
  if (price != null) checkAlerts(sym, price, d?.changePct);
});

document.getElementById("alertClear").addEventListener("click", () => {
  if (!alertSymbol) return;
  const sym = alertSymbol;
  delete alerts[sym];
  delete alertFired[sym];
  saveAlerts();
  updateAlertBadge(sym);
  closeAlertModal();
});

alertModalEl.querySelector(".modal-close").addEventListener("click", closeAlertModal);
alertModalEl.querySelector(".modal-backdrop").addEventListener("click", closeAlertModal);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !alertModalEl.hidden) closeAlertModal();
});

/* ===== ポートフォリオ（保有株の損益） ===== */
const PF_KEY = "kabu-portfolio";
const pfListEl = document.getElementById("pfList");
const pfEmptyEl = document.getElementById("pfEmpty");
const pfSummaryEl = document.getElementById("pfSummary");
const pfChartEl = document.getElementById("pfChart");
const holdingForm = document.getElementById("holdingForm");
const hSymbolInput = document.getElementById("hSymbol");
const hSharesInput = document.getElementById("hShares");
const hCostInput = document.getElementById("hCost");

function loadHoldings() {
  try { return JSON.parse(localStorage.getItem(PF_KEY)) || []; }
  catch { return []; }
}
function saveHoldings(list) { localStorage.setItem(PF_KEY, JSON.stringify(list)); }
let holdings = loadHoldings();

function addHolding(symbol, shares, cost) {
  symbol = symbol.trim().toUpperCase();
  if (!symbol || !(shares > 0) || !(cost >= 0)) return;
  const existing = holdings.find((h) => h.symbol === symbol);
  if (existing) {
    // 平均取得単価を加重平均で更新
    const totalShares = existing.shares + shares;
    existing.cost = (existing.cost * existing.shares + cost * shares) / totalShares;
    existing.shares = totalShares;
  } else {
    holdings.push({ symbol, shares, cost });
  }
  saveHoldings(holdings);
  loadPortfolio();
  if (typeof syncPushSymbols === "function") syncPushSymbols();
}

function removeHolding(symbol) {
  holdings = holdings.filter((h) => h.symbol !== symbol);
  saveHoldings(holdings);
  loadPortfolio();
  if (typeof syncPushSymbols === "function") syncPushSymbols();
}

// 価格をJPYに概算換算（USDのみレート換算、その他はそのまま）
function toJpy(value, currency) {
  if (value == null) return null;
  if (currency === "JPY") return value;
  if (currency === "USD" && usdJpyRate) return value * usdJpyRate;
  return null; // 換算不能
}

function fmtSignedJpy(v) {
  if (v == null) return "—";
  const sign = v >= 0 ? "+" : "−";
  return sign + "¥" + Math.abs(v).toLocaleString("ja-JP", { maximumFractionDigits: 0 });
}

// ポートフォリオカード用の指標行（PER/PBR/利回り/出来高/時価総額）
function pfMetricsHtml(q, currency) {
  if (!q) return "";
  const per = q.per != null && q.per > 0 ? q.per.toFixed(1) + "倍" : "—";
  const pbr = q.pbr != null && q.pbr > 0 ? q.pbr.toFixed(2) + "倍" : "—";
  const yld = q.divYield != null && q.divYield > 0 ? (q.divYield * 100).toFixed(2) + "%" : "—";
  const vol = fmtVolJa(q.volume);
  const cap = fmtCap(q.marketCap, q.currency || currency);
  return `<div class="metrics">
    <span class="m"><b>PER</b><span>${per}</span></span>
    <span class="m"><b>PBR</b><span>${pbr}</span></span>
    <span class="m"><b>利回り</b><span>${yld}</span></span>
    <span class="m"><b>出来高</b><span>${vol}</span></span>
    <span class="m"><b>時価総額</b><span>${cap}</span></span>
  </div>`;
}

// 保有銘柄の配当利回りなどを一括取得（/api/quotes）
async function fetchPortfolioYields(symbols) {
  const map = new Map();
  if (!symbols.length) return map;
  try {
    const res = await fetch(`/api/quotes?symbols=${encodeURIComponent(symbols.join(","))}`);
    const d = await res.json();
    (d.quotes || []).forEach((q) => map.set(q.symbol, q));
  } catch { /* 取得失敗時は配当なし扱い */ }
  return map;
}

// 円グラフ（ドーナツ）用カラーパレット
const PF_PALETTE = [
  "#4f8ef7", "#f7884f", "#4fd07a", "#f74f8e", "#b14ff7",
  "#f7d24f", "#4fd0d0", "#f76b6b", "#7af74f", "#9e7af7",
  "#f74fc8", "#4fa3f7",
];

function renderPfChart(slices) {
  // slices: [{label, valueJpy, color}]
  const total = slices.reduce((s, x) => s + x.valueJpy, 0);
  if (!total || slices.length === 0) { pfChartEl.hidden = true; return; }
  pfChartEl.hidden = false;
  const R = 70, CX = 80, CY = 80, INNER = 42;
  let acc = 0;
  const segs = slices.map((s) => {
    const frac = s.valueJpy / total;
    const a0 = acc * 2 * Math.PI - Math.PI / 2;
    acc += frac;
    const a1 = acc * 2 * Math.PI - Math.PI / 2;
    const large = frac > 0.5 ? 1 : 0;
    const x0 = CX + R * Math.cos(a0), y0 = CY + R * Math.sin(a0);
    const x1 = CX + R * Math.cos(a1), y1 = CY + R * Math.sin(a1);
    const ix1 = CX + INNER * Math.cos(a1), iy1 = CY + INNER * Math.sin(a1);
    const ix0 = CX + INNER * Math.cos(a0), iy0 = CY + INNER * Math.sin(a0);
    // ほぼ100%の1銘柄だと円が閉じないので円リングで描画
    if (frac > 0.999) {
      return `<circle cx="${CX}" cy="${CY}" r="${(R + INNER) / 2}" fill="none" stroke="${s.color}" stroke-width="${R - INNER}"/>`;
    }
    return `<path d="M${x0} ${y0} A${R} ${R} 0 ${large} 1 ${x1} ${y1} L${ix1} ${iy1} A${INNER} ${INNER} 0 ${large} 0 ${ix0} ${iy0} Z" fill="${s.color}"/>`;
  }).join("");
  const legend = slices.map((s) => {
    const pct = (s.valueJpy / total) * 100;
    return `<div class="pf-leg-item"><span class="pf-leg-dot" style="background:${s.color}"></span><span class="pf-leg-name">${s.label}</span><span class="pf-leg-pct">${pct.toFixed(1)}%</span></div>`;
  }).join("");
  pfChartEl.innerHTML = `
    <div class="pf-chart-title">構成比（評価額・円換算概算）</div>
    <div class="pf-chart-body">
      <svg viewBox="0 0 160 160" class="pf-donut" width="160" height="160">${segs}</svg>
      <div class="pf-legend">${legend}</div>
    </div>`;
}

async function loadPortfolio() {
  pfEmptyEl.style.display = holdings.length ? "none" : "block";
  pfListEl.innerHTML = "";
  pfSummaryEl.innerHTML = "";
  if (!holdings.length) { pfChartEl.hidden = true; return; }
  if (!usdJpyRate) await refreshUsdJpy();

  const [rows, yieldMap] = await Promise.all([
    Promise.all(holdings.map(async (h) => ({ h, data: await fetchAndCache(h.symbol) }))),
    fetchPortfolioYields(holdings.map((h) => h.symbol)),
  ]);

  let totalValueJpy = 0, totalCostJpy = 0, totalDayPlJpy = 0, totalDivJpy = 0;
  let anyUnconvertible = false, anyDay = false;
  const chartSlices = [];

  rows.forEach(({ h, data }, idx) => {
    const card = document.createElement("div");
    card.className = "pf-card";
    if (!data || data.price == null) {
      card.innerHTML = `
        <button class="pf-remove" title="削除">×</button>
        <div class="pf-sym">${h.symbol}</div>
        <div class="pf-err">価格を取得できませんでした</div>`;
      card.querySelector(".pf-remove").addEventListener("click", () => removeHolding(h.symbol));
      pfListEl.appendChild(card);
      return;
    }
    const cur = data.currency || "JPY";
    const value = data.price * h.shares;
    const costTotal = h.cost * h.shares;
    const pl = value - costTotal;
    const plPct = costTotal ? (pl / costTotal) * 100 : 0;
    const up = pl >= 0;

    // 今日の損益（1株あたりの当日変化額 × 株数）
    const dayPl = data.change != null ? data.change * h.shares : null;

    // 年間配当見込み（現在値 × 利回り × 株数）
    const q = yieldMap.get(h.symbol);
    const divYield = q && q.divYield != null ? q.divYield : null;
    const annualDiv = divYield != null ? value * divYield : null;

    const valueJpy = toJpy(value, cur);
    const costJpy = toJpy(costTotal, cur);
    if (valueJpy != null && costJpy != null) {
      totalValueJpy += valueJpy;
      totalCostJpy += costJpy;
      if (dayPl != null) { totalDayPlJpy += toJpy(dayPl, cur); anyDay = true; }
      if (annualDiv != null) totalDivJpy += toJpy(annualDiv, cur);
      chartSlices.push({
        label: data.name || h.symbol,
        valueJpy,
        color: PF_PALETTE[chartSlices.length % PF_PALETTE.length],
      });
    } else {
      anyUnconvertible = true;
    }

    const dayUp = dayPl != null && dayPl >= 0;
    const dayRow = dayPl != null
      ? `<div class="pf-day ${dayUp ? "up" : "down"}">今日 ${dayUp ? "▲" : "▼"} ${fmtPrice(dayPl, cur)}（${dayUp ? "+" : ""}${(data.changePct ?? 0).toFixed(2)}%）</div>`
      : "";
    const divRow = annualDiv != null
      ? `<div class="pf-div">年間配当見込み ${fmtPrice(annualDiv, cur)}（利回り${(divYield * 100).toFixed(2)}%）</div>`
      : "";
    const metricsRow = pfMetricsHtml(q, cur);

    card.innerHTML = `
      <button class="pf-remove" title="削除">×</button>
      <div class="pf-head">
        <span class="pf-name">${data.name || h.symbol}</span>
        <span class="pf-sym">${h.symbol}</span>
      </div>
      <div class="pf-grid">
        <div><span class="pf-k">保有</span><span class="pf-v">${h.shares.toLocaleString("ja-JP")}株</span></div>
        <div><span class="pf-k">取得単価</span><span class="pf-v">${fmtPrice(h.cost, cur)}</span></div>
        <div><span class="pf-k">現在値</span><span class="pf-v">${fmtPrice(data.price, cur)}</span></div>
        <div><span class="pf-k">評価額</span><span class="pf-v">${fmtPrice(value, cur)}</span></div>
      </div>
      <div class="pf-pl ${up ? "up" : "down"}">
        ${up ? "▲" : "▼"} ${fmtPrice(pl, cur)}（${up ? "+" : ""}${plPct.toFixed(2)}%）
      </div>
      ${dayRow}
      ${divRow}
      ${metricsRow}`;
    card.querySelector(".pf-remove").addEventListener("click", () => removeHolding(h.symbol));
    card.addEventListener("click", (e) => {
      if (e.target.closest(".pf-remove")) return;
      openChart(h.symbol);
    });
    pfListEl.appendChild(card);
  });

  // 構成比ドーナツチャート（評価額の大きい順）
  chartSlices.sort((a, b) => b.valueJpy - a.valueJpy);
  chartSlices.forEach((s, i) => { s.color = PF_PALETTE[i % PF_PALETTE.length]; });
  renderPfChart(chartSlices);

  // 合計サマリー（日本円・概算）
  const totalPl = totalValueJpy - totalCostJpy;
  const totalPlPct = totalCostJpy ? (totalPl / totalCostJpy) * 100 : 0;
  const up = totalPl >= 0;
  const dUp = totalDayPlJpy >= 0;
  const dayCostBase = totalValueJpy - totalDayPlJpy;
  const dayPct = dayCostBase ? (totalDayPlJpy / dayCostBase) * 100 : 0;
  const divPct = totalValueJpy ? (totalDivJpy / totalValueJpy) * 100 : 0;
  pfSummaryEl.innerHTML = `
    <div class="pf-sum-item">
      <span class="pf-sum-k">評価額合計（概算）</span>
      <span class="pf-sum-v">¥${Math.round(totalValueJpy).toLocaleString("ja-JP")}</span>
    </div>
    <div class="pf-sum-item">
      <span class="pf-sum-k">取得額合計</span>
      <span class="pf-sum-v">¥${Math.round(totalCostJpy).toLocaleString("ja-JP")}</span>
    </div>
    <div class="pf-sum-item">
      <span class="pf-sum-k">含み損益（概算）</span>
      <span class="pf-sum-v ${up ? "up" : "down"}">${fmtSignedJpy(totalPl)}（${up ? "+" : ""}${totalPlPct.toFixed(2)}%）</span>
    </div>
    ${anyDay ? `<div class="pf-sum-item">
      <span class="pf-sum-k">今日の損益（概算）</span>
      <span class="pf-sum-v ${dUp ? "up" : "down"}">${fmtSignedJpy(totalDayPlJpy)}（${dUp ? "+" : ""}${dayPct.toFixed(2)}%）</span>
    </div>` : ""}
    ${totalDivJpy > 0 ? `<div class="pf-sum-item">
      <span class="pf-sum-k">年間配当見込み（概算）</span>
      <span class="pf-sum-v">¥${Math.round(totalDivJpy).toLocaleString("ja-JP")}（利回り${divPct.toFixed(2)}%）</span>
    </div>` : ""}
    ${anyUnconvertible ? `<div class="pf-sum-note">※ 円換算できない通貨の銘柄は合計に含めていません</div>` : ""}`;
}

if (holdingForm) {
  // ポートフォリオの銘柄欄にも名前検索のオートコンプリートを付ける（選択で欄に反映）
  const hResultsEl = document.getElementById("hSearchResults");
  if (hResultsEl) {
    attachAutocomplete(hSymbolInput, hResultsEl, (sym) => { hSymbolInput.value = sym; });
  }
  holdingForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const raw = hSymbolInput.value;
    const shares = parseFloat(hSharesInput.value);
    const cost = parseFloat(hCostInput.value);
    hSymbolInput.value = "";
    hSharesInput.value = "";
    hCostInput.value = "";
    hSymbolInput.focus();
    smartResolveSymbol(raw).then((sym) => {
      if (sym) addHolding(sym, shares, cost);
      else if (raw.trim()) showToast(`「${raw.trim()}」に一致する銘柄が見つかりませんでした`);
    });
  });
}

/* ===== 決算カレンダー ===== */
const earningsListEl = document.getElementById("earningsList");
let earningsCache = null;

function pfSymbols() {
  return holdings.map((h) => h.symbol);
}

async function loadEarnings(force) {
  if (earningsCache && !force) { renderEarnings(earningsCache); return; }
  const syms = [...new Set([...symbols, ...pfSymbols()])];
  if (!syms.length) {
    earningsListEl.innerHTML = `<div class="earn-empty">ウォッチリストかポートフォリオに銘柄を追加すると、決算予定が表示されます。</div>`;
    return;
  }
  earningsListEl.innerHTML = `<div class="earn-empty">決算予定を取得中…</div>`;
  try {
    const res = await fetch(`/api/earnings?symbols=${encodeURIComponent(syms.join(","))}`);
    const d = await res.json();
    earningsCache = d.items || [];
    renderEarnings(earningsCache);
  } catch {
    earningsListEl.innerHTML = `<div class="earn-empty">決算予定を取得できませんでした。</div>`;
  }
}

function renderEarnings(items) {
  const withDate = items.filter((it) => it.earningsTimestamp);
  if (!withDate.length) {
    earningsListEl.innerHTML = `<div class="earn-empty">登録銘柄の決算予定日が取得できませんでした（米国株中心に対応しています）。</div>`;
    return;
  }
  const nowSec = Date.now() / 1000;
  withDate.sort((a, b) => a.earningsTimestamp - b.earningsTimestamp);
  // 未来を上に、過去（直近の済み）は下にまとめる
  const upcoming = withDate.filter((it) => it.earningsTimestamp >= nowSec - 86400);
  const past = withDate.filter((it) => it.earningsTimestamp < nowSec - 86400);
  earningsListEl.innerHTML = "";

  const makeRow = (it) => {
    const d = new Date(it.earningsTimestamp * 1000);
    const md = `${d.getMonth() + 1}/${d.getDate()}`;
    const wd = "日月火水木金土"[d.getDay()];
    const days = Math.round((it.earningsTimestamp - nowSec) / 86400);
    let when = "";
    if (days > 1) when = `あと${days}日`;
    else if (days === 1) when = "明日";
    else if (days === 0) when = "今日";
    else when = `${-days}日前`;
    const name = (watchData.get(it.symbol)?.name) || (quoteCache.get(it.symbol)?.name) || it.symbol;
    const soon = days >= 0 && days <= 7;
    const row = document.createElement("div");
    row.className = "earn-row" + (soon ? " soon" : "");
    row.innerHTML = `
      <span class="earn-date">
        <span class="earn-md">${md}<small>(${wd})</small></span>
        <span class="earn-when">${when}</span>
      </span>
      <span class="earn-info">
        <span class="earn-nm">${name}</span>
        <span class="earn-sym">${it.symbol}${it.isEstimate ? ' <span class="earn-est">予</span>' : ""}</span>
      </span>`;
    row.addEventListener("click", () => openChart(it.symbol));
    return row;
  };

  if (upcoming.length) {
    const h = document.createElement("div");
    h.className = "earn-head"; h.textContent = "📅 これからの決算";
    earningsListEl.appendChild(h);
    upcoming.forEach((it) => earningsListEl.appendChild(makeRow(it)));
  }
  if (past.length) {
    const h = document.createElement("div");
    h.className = "earn-head past"; h.textContent = "済んだ決算";
    earningsListEl.appendChild(h);
    past.reverse().forEach((it) => earningsListEl.appendChild(makeRow(it)));
  }
}
