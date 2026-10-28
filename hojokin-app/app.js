/* 補助金ウォッチ フロントエンド */
"use strict";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

async function api(path, opts) {
  const res = await fetch(path, opts);
  return res.json();
}
function esc(s) {
  return (s || "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function todayStr() {
  const d = new Date();
  const z = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}
function daysLeft(deadline) {
  if (!deadline) return null;
  const d = new Date(deadline + "T00:00:00");
  const now = new Date(todayStr() + "T00:00:00");
  return Math.round((d - now) / 86400000);
}

// ---------- タブ切り替え ----------
function showTab(name) {
  $$(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === "tab-" + name));
  if (name === "list") loadList();
  if (name === "new") loadNew();
  if (name === "sources") loadSources();
}
$$(".tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

// ---------- 一覧 ----------
let allSubsidies = [];
async function loadList() {
  allSubsidies = await api("/api/subsidies");
  renderList();
}
function renderList() {
  const cat = $("#filterCat").value;
  let items = allSubsidies.slice();
  if (cat) items = items.filter((s) => s.category === cat);
  // 締切が近い順（締切なしは後ろ）
  items.sort((a, b) => {
    const da = a.deadline || "9999-99-99";
    const db = b.deadline || "9999-99-99";
    return da < db ? -1 : da > db ? 1 : 0;
  });
  const area = $("#listArea");
  if (!items.length) {
    area.innerHTML = `<p class="empty">まだ登録がありません。「＋ 補助金を登録」から追加するか、
      「新着」タブで見つけたものを登録してください。</p>`;
    return;
  }
  area.innerHTML = items.map((s) => {
    const dl = daysLeft(s.deadline);
    let badge = "";
    if (dl === null) badge = `<span class="pill gray">締切未定</span>`;
    else if (dl < 0) badge = `<span class="pill gray">締切終了</span>`;
    else if (dl <= 7) badge = `<span class="pill red">あと${dl}日</span>`;
    else if (dl <= 14) badge = `<span class="pill amber">あと${dl}日</span>`;
    else badge = `<span class="pill green">あと${dl}日</span>`;
    return `<div class="card">
      <div class="card-head">
        <span class="cat">${esc(s.category)}</span>
        ${badge}
      </div>
      <h3>${esc(s.name)}</h3>
      <dl class="meta">
        <div><dt>対象</dt><dd>${esc(s.target) || "—"}</dd></div>
        <div><dt>上限額</dt><dd>${esc(s.maxAmount) || "—"}</dd></div>
        <div><dt>締切</dt><dd>${esc(s.deadline) || "未定"}</dd></div>
        <div><dt>確認日</dt><dd>${esc(s.checkedOn) || "—"}</dd></div>
      </dl>
      ${s.summary ? `<p class="summary">${esc(s.summary).replace(/\n/g, "<br>")}</p>` : ""}
      <div class="card-actions">
        <a href="${esc(s.url)}" target="_blank" rel="noopener">公式ページ ↗</a>
        <button class="link" data-edit="${s.id}">編集</button>
        <button class="link danger" data-del="${s.id}">削除</button>
      </div>
    </div>`;
  }).join("");
  area.querySelectorAll("[data-edit]").forEach((b) =>
    b.addEventListener("click", () => openForm(allSubsidies.find((x) => x.id === b.dataset.edit))));
  area.querySelectorAll("[data-del]").forEach((b) =>
    b.addEventListener("click", () => delSubsidy(b.dataset.del)));
}
$("#filterCat").addEventListener("change", renderList);

async function delSubsidy(id) {
  const s = allSubsidies.find((x) => x.id === id);
  if (!confirm(`「${s ? s.name : ""}」を削除しますか？`)) return;
  await api("/api/subsidies/delete", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
  loadList();
}

// ---------- 登録・編集フォーム ----------
function openForm(entry) {
  entry = entry || {};
  $("#modalTitle").textContent = entry.id ? "補助金を編集" : "補助金を登録";
  $("#f-id").value = entry.id || "";
  $("#f-name").value = entry.name || "";
  $("#f-url").value = entry.url || "";
  $("#f-category").value = entry.category || "その他";
  $("#f-target").value = entry.target || "";
  $("#f-maxAmount").value = entry.maxAmount || "";
  $("#f-deadline").value = entry.deadline || "";
  $("#f-summary").value = entry.summary || "";
  $("#f-checkedOn").value = entry.checkedOn || todayStr();
  $("#f-note").value = entry.note || "";
  $("#formMsg").textContent = "";
  $("#modal").hidden = false;
}
$("#addBtn").addEventListener("click", () => openForm());
$("#cancelBtn").addEventListener("click", () => ($("#modal").hidden = true));

$("#saveBtn").addEventListener("click", async () => {
  const body = {
    id: $("#f-id").value,
    name: $("#f-name").value,
    url: $("#f-url").value,
    category: $("#f-category").value,
    target: $("#f-target").value,
    maxAmount: $("#f-maxAmount").value,
    deadline: $("#f-deadline").value,
    summary: $("#f-summary").value,
    checkedOn: $("#f-checkedOn").value,
    note: $("#f-note").value,
  };
  const r = await api("/api/subsidies", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (r.error) { $("#formMsg").textContent = "⚠️ " + r.error; return; }
  $("#modal").hidden = true;
  loadList();
});

// リンクから要約の下書き
$("#draftBtn").addEventListener("click", async () => {
  const url = $("#f-url").value.trim();
  if (!url) { $("#formMsg").textContent = "⚠️ 先に公式リンクを入れてください"; return; }
  $("#formMsg").textContent = "下書きを作っています…";
  const r = await api("/api/draft?url=" + encodeURIComponent(url));
  if (r.error) { $("#formMsg").textContent = "⚠️ " + r.error; return; }
  if (!$("#f-name").value && r.title) $("#f-name").value = r.title;
  $("#f-summary").value = r.draft || "";
  $("#formMsg").textContent = "下書きを入れました。中身は必ず公式ページで確認して直してください。";
});

// ---------- 新着（自動検知） ----------
async function loadNew() {
  const items = await api("/api/new-items");
  const badge = $("#newBadge");
  if (items.length) { badge.hidden = false; badge.textContent = items.length; }
  else badge.hidden = true;
  const area = $("#newArea");
  if (!items.length) {
    area.innerHTML = `<p class="empty">未確認の新着はありません。
      情報源を増やして「今すぐチェック」を押すと見つかることがあります。</p>`;
    return;
  }
  area.innerHTML = items.map((it) => `<div class="card">
    <div class="card-head"><span class="cat">${esc(it.sourceName)}</span>
      <span class="pill gray">${esc(it.foundOn)} 検知</span></div>
    <h3>${esc(it.title)}</h3>
    <div class="card-actions">
      <a href="${esc(it.url)}" target="_blank" rel="noopener">公式ページを確認 ↗</a>
      <button class="link" data-reg='${esc(JSON.stringify(it))}'>これを登録</button>
      <button class="link danger" data-dismiss="${it.id}">消す</button>
    </div>
  </div>`).join("");
  area.querySelectorAll("[data-reg]").forEach((b) =>
    b.addEventListener("click", () => {
      const it = JSON.parse(b.dataset.reg);
      openForm({ name: it.title, url: it.url, category: "その他" });
    }));
  area.querySelectorAll("[data-dismiss]").forEach((b) =>
    b.addEventListener("click", async () => {
      await api("/api/new-items/dismiss", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: b.dataset.dismiss }),
      });
      loadNew();
    }));
}

// ---------- 情報源 ----------
let sources = [];
async function loadSources() {
  sources = await api("/api/sources");
  renderSources();
}
function renderSources() {
  const area = $("#sourcesArea");
  if (!sources.length) {
    area.innerHTML = `<p class="empty">情報源がありません。下から追加してください。</p>`;
    return;
  }
  area.innerHTML = sources.map((s, i) => `<div class="src-row">
    <div><b>${esc(s.name)}</b><br><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.url)}</a></div>
    <button class="link danger" data-srcdel="${i}">削除</button>
  </div>`).join("");
  area.querySelectorAll("[data-srcdel]").forEach((b) =>
    b.addEventListener("click", () => { sources.splice(+b.dataset.srcdel, 1); renderSources(); }));
}
$("#addSrcBtn").addEventListener("click", () => {
  const name = $("#srcName").value.trim();
  const url = $("#srcUrl").value.trim();
  if (!url) { $("#srcMsg").textContent = "⚠️ URLを入れてください"; return; }
  sources.push({ name: name || url, url });
  $("#srcName").value = ""; $("#srcUrl").value = "";
  renderSources();
});
$("#saveSrcBtn").addEventListener("click", async () => {
  const r = await api("/api/sources", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sources }),
  });
  $("#srcMsg").textContent = r.ok ? `保存しました（${r.count}件）` : "⚠️ 保存に失敗しました";
});
$("#checkNowBtn").addEventListener("click", async () => {
  $("#srcMsg").textContent = "チェック中…（情報源が多いと数十秒かかります）";
  const r = await api("/api/check");
  if (r.error) { $("#srcMsg").textContent = "⚠️ " + r.error; return; }
  $("#srcMsg").textContent = `新着 ${r.sources.added} 件を検知しました。「新着」タブで確認できます。`;
  loadNew();
});

// ---------- 週次レポート ----------
$("#genReportBtn").addEventListener("click", async () => {
  const r = await api("/api/report");
  $("#reportText").value = r.text || "";
});
$("#copyReportBtn").addEventListener("click", async () => {
  const t = $("#reportText").value;
  if (!t) return;
  try { await navigator.clipboard.writeText(t); alert("コピーしました"); }
  catch { $("#reportText").select(); document.execCommand("copy"); }
});

// ---------- 通知（Web Push） ----------
function urlB64ToUint8(base64) {
  const pad = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}
let swReg = null;
async function initSW() {
  if (!("serviceWorker" in navigator)) return;
  try { swReg = await navigator.serviceWorker.register("sw.js"); } catch (e) {}
}
$("#notifBtn").addEventListener("click", async () => {
  const msg = $("#notifMsg");
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    msg.textContent = "⚠️ この端末/ブラウザは通知に対応していません（iPhoneはホーム画面に追加してから）";
    return;
  }
  const perm = await Notification.requestPermission();
  if (perm !== "granted") { msg.textContent = "通知が許可されませんでした"; return; }
  const pk = await api("/api/push/publicKey");
  if (!pk.available || !pk.key) {
    msg.textContent = "ℹ️ サーバー側の通知が未設定です（ローカルでは未設定でも一覧・新着は使えます）";
    return;
  }
  swReg = swReg || (await navigator.serviceWorker.ready);
  const sub = await swReg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlB64ToUint8(pk.key),
  });
  await api("/api/push/subscribe", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subscription: sub }),
  });
  msg.textContent = "✅ 通知をオンにしました。締切・新着をお知らせします。";
});
$("#notifTestBtn").addEventListener("click", async () => {
  const msg = $("#notifMsg");
  swReg = swReg || (await navigator.serviceWorker.ready);
  const sub = await swReg.pushManager.getSubscription();
  if (!sub) { msg.textContent = "先に「通知をオンにする」を押してください"; return; }
  const r = await api("/api/push/test", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subscription: sub }),
  });
  msg.textContent = r.ok ? "テスト通知を送りました" : "送信できませんでした";
});

// ---------- 起動 ----------
(async function () {
  await initSW();
  // 新着バッジだけ先に反映
  try {
    const n = await api("/api/new-items");
    if (n.length) { $("#newBadge").hidden = false; $("#newBadge").textContent = n.length; }
  } catch (e) {}
  // URLに ?tab=new があればそのタブを開く（通知からの遷移用）
  const params = new URLSearchParams(location.search);
  showTab(params.get("tab") === "new" ? "new" : "list");
})();
