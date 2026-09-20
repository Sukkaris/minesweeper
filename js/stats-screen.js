// 統計画面。設定画面の上に重ねて開くシート。難易度ごとの成績を表にして見せる。
// 数値の計算・整形は stats.js に任せ、ここは DOM の組み立てだけを行う。

import { DIFFICULTIES } from './game.js';
import { openSheet, closeSheet } from './dom-utils.js';
import { getStats, resetStats, formatStatTime, formatWinRate, formatAverageTime } from './stats.js';

const RESET_CONFIRM_MESSAGE = '統計をすべて消去します。よろしいですか？';

/** 表の行。ラベルと、1 難易度分のデータから表示文字列を作る関数 */
const ROWS = [
  { label: 'ベストタイム', value: (e) => formatStatTime(e.bestMs) },
  { label: 'プレイ回数',   value: (e) => String(e.plays) },
  { label: '勝利数',       value: (e) => String(e.wins) },
  { label: '勝率',         value: (e) => formatWinRate(e) },
  { label: '平均タイム',   value: (e) => formatAverageTime(e) },
];

// ---------- DOM 参照 ----------
const statsEl = document.getElementById('stats');
const statsBackEl = document.getElementById('stats-back');
const statsTableEl = document.getElementById('stats-table');
const statsResetEl = document.getElementById('stats-reset');

// ---------- 描画 ----------

function cell(tag, text, className) {
  const el = document.createElement(tag);
  el.textContent = text;
  if (className) el.className = className;
  return el;
}

function renderTable() {
  const stats = getStats();
  const keys = Object.keys(DIFFICULTIES);
  statsTableEl.innerHTML = '';

  // 見出し行：空欄 ＋ 難易度名
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  headRow.appendChild(cell('th', '', 'stats-corner'));
  for (const key of keys) headRow.appendChild(cell('th', DIFFICULTIES[key].label));
  thead.appendChild(headRow);
  statsTableEl.appendChild(thead);

  // データ行
  const tbody = document.createElement('tbody');
  for (const row of ROWS) {
    const tr = document.createElement('tr');
    tr.appendChild(cell('th', row.label, 'stats-label'));
    for (const key of keys) tr.appendChild(cell('td', row.value(stats[key])));
    tbody.appendChild(tr);
  }
  statsTableEl.appendChild(tbody);
}

// ---------- 開閉 ----------

export function openStats() {
  renderTable();
  openSheet(statsEl);
}

export function closeStats() {
  closeSheet(statsEl);
}

// ---------- 初期化 ----------

export function initStatsScreen() {
  statsBackEl.addEventListener('click', closeStats);

  // リセットは破壊的操作なので、例外的に確認ダイアログを挟む
  statsResetEl.addEventListener('click', () => {
    if (!window.confirm(RESET_CONFIRM_MESSAGE)) return;
    resetStats();
    renderTable();
  });
}
