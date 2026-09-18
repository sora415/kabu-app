// 写真でカロリー推定 — 画面の動きを担当するファイル
"use strict";

const fileInput = document.getElementById("fileInput");
const previewBox = document.getElementById("preview");
const previewImg = document.getElementById("previewImg");
const analyzeBtn = document.getElementById("analyzeBtn");
const statusBox = document.getElementById("status");
const resultBox = document.getElementById("result");
const totalKcal = document.getElementById("totalKcal");
const confidence = document.getElementById("confidence");
const itemList = document.getElementById("itemList");
const note = document.getElementById("note");

let imageDataUrl = null; // 選んだ写真（data:image/... の文字列）

// 写真が選ばれたとき
fileInput.addEventListener("change", () => {
  const file = fileInput.files && fileInput.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    imageDataUrl = reader.result; // "data:image/jpeg;base64,..."
    previewImg.src = imageDataUrl;
    previewBox.hidden = false;
    analyzeBtn.disabled = false;
    resultBox.hidden = true;
    statusBox.hidden = true;
  };
  reader.readAsDataURL(file);
});

// 「解析する」ボタン
analyzeBtn.addEventListener("click", async () => {
  if (!imageDataUrl) return;

  analyzeBtn.disabled = true;
  resultBox.hidden = true;
  showStatus("loading", "AIが写真を解析しています… 少しお待ちください");

  try {
    const res = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: imageDataUrl }),
    });
    const data = await res.json();

    if (!res.ok || data.error) {
      showStatus("error", data.error || "解析に失敗しました。");
      return;
    }
    renderResult(data);
    statusBox.hidden = true;
  } catch (e) {
    showStatus("error", "通信エラーが発生しました。サーバーが起動しているか確認してください。");
  } finally {
    analyzeBtn.disabled = false;
  }
});

// 状態メッセージを表示
function showStatus(kind, message) {
  statusBox.hidden = false;
  statusBox.className = "status status--" + kind;
  statusBox.textContent = message;
}

// 結果を画面に描く
function renderResult(data) {
  totalKcal.textContent = Number(data.total_calories || 0).toLocaleString("ja-JP");

  const labels = { high: "確度: 高", medium: "確度: 中", low: "確度: 低" };
  confidence.textContent = labels[data.confidence] || "確度: —";
  confidence.className = "badge badge--" + (data.confidence || "low");

  itemList.innerHTML = "";
  const items = Array.isArray(data.items) ? data.items : [];
  if (items.length === 0) {
    const li = document.createElement("li");
    li.className = "item item--empty";
    li.textContent = "食べ物を認識できませんでした。";
    itemList.appendChild(li);
  } else {
    for (const item of items) {
      const li = document.createElement("li");
      li.className = "item";
      li.innerHTML =
        '<span class="item__name">' + escapeHtml(item.name || "不明") + "</span>" +
        '<span class="item__qty">' + escapeHtml(item.quantity || "") + "</span>" +
        '<span class="item__kcal">' + Number(item.calories || 0).toLocaleString("ja-JP") + " kcal</span>";
      itemList.appendChild(li);
    }
  }

  note.textContent = data.note || "";
  resultBox.hidden = false;
}

// 文字列をHTMLに安全に入れるためのエスケープ
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
