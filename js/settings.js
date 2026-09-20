// 簡易設定（第2段階の暫定版。第3段階で正式な設定画面に移す）。
// 長押し時間の調整と、その場で感触を確かめる試し押し用ダミーマスを担当する。

import { createIcon, sinkCell } from './dom-utils.js';

// ---------- 調整用の定数 ----------
const LONG_PRESS_DEFAULT_MS = 300;  // 長押しとみなす時間の既定値
const LONG_PRESS_MIN_MS = 200;
const LONG_PRESS_MAX_MS = 600;
const LONG_PRESS_STEP_MS = 50;
const STORAGE_KEY_LONG_PRESS = 'ms-long-press-ms';

// ---------- DOM 参照 ----------
const settingsButtonEl = document.getElementById('settings-button');
const settingsEl = document.getElementById('settings');
const settingsCloseEl = document.getElementById('settings-close');
const longPressRangeEl = document.getElementById('long-press-range');
const longPressValueEl = document.getElementById('long-press-value');
const dummyBoardEl = document.getElementById('dummy-board');
const dummyCellEl = document.getElementById('dummy-cell');

// ---------- 状態 ----------
let longPressMs = LONG_PRESS_DEFAULT_MS;
let onOpen = null;        // パネルを開く直前に呼ぶコールバック（盤面の押下状態を片付ける用）
let dummyPress = null;    // 試し押し中の情報 { pointerId, timer }
let dummyFlagged = false;

// ---------- 永続化 ----------

function loadLongPressMs() {
  try {
    const saved = Number(localStorage.getItem(STORAGE_KEY_LONG_PRESS));
    if (Number.isFinite(saved) && saved >= LONG_PRESS_MIN_MS && saved <= LONG_PRESS_MAX_MS) return saved;
  } catch (_) { /* localStorage が使えない環境では無視 */ }
  return LONG_PRESS_DEFAULT_MS;
}

function saveLongPressMs(value) {
  try {
    localStorage.setItem(STORAGE_KEY_LONG_PRESS, String(value));
  } catch (_) { /* 無視 */ }
}

// ---------- 長押し時間 ----------

/** 現在の長押し閾値（ms）。盤面側はこれを毎回参照する */
export function getLongPressMs() {
  return longPressMs;
}

function applyLongPressMs(value) {
  longPressMs = value;
  longPressRangeEl.value = String(value);
  longPressValueEl.textContent = value + ' ms';
}

// ---------- パネルの開閉 ----------

export function openSettings() {
  if (onOpen) onOpen();
  settingsEl.hidden = false;
}

export function closeSettings() {
  clearDummyPress();
  settingsEl.hidden = true;
}

// ---------- 試し押し用のダミーマス ----------
// 長押しで旗が立ち、もう一度長押しすると外れるだけのもの。盤面と同じ沈み込み・成立時の動きを出す

function renderDummyCell() {
  dummyCellEl.className = 'cell ' + (dummyFlagged ? 'flag' : 'hidden');
  dummyCellEl.textContent = '';
  if (dummyFlagged) dummyCellEl.appendChild(createIcon('icon-flag', 'icon-flag'));
}

function clearDummyPress() {
  if (!dummyPress) return;
  clearTimeout(dummyPress.timer);
  dummyPress = null;
  dummyCellEl.classList.remove('pressed');
}

function onDummyPointerDown(event) {
  clearDummyPress();
  const current = { pointerId: event.pointerId, timer: null };
  current.timer = setTimeout(() => {
    if (dummyPress !== current) return;
    current.timer = null;
    dummyFlagged = !dummyFlagged;
    renderDummyCell();
    dummyCellEl.classList.add('pressed');   // 指を離すまでは沈めたままにする（盤面と同じ挙動）
    // 盤面と同じく、周囲のマスまで（3×3 全体を）沈めて戻す
    for (const cell of dummyBoardEl.querySelectorAll('.cell')) sinkCell(cell);
  }, longPressMs);
  dummyPress = current;
  dummyCellEl.classList.add('pressed');
}

function onDummyPointerEnd(event) {
  if (!dummyPress || event.pointerId !== dummyPress.pointerId) return;
  clearDummyPress();
}

// ---------- 初期化 ----------

/**
 * @param {{onOpen?: () => void}} options
 */
export function initSettings(options = {}) {
  onOpen = options.onOpen ?? null;

  longPressRangeEl.min = String(LONG_PRESS_MIN_MS);
  longPressRangeEl.max = String(LONG_PRESS_MAX_MS);
  longPressRangeEl.step = String(LONG_PRESS_STEP_MS);
  longPressRangeEl.addEventListener('input', () => {
    const value = Number(longPressRangeEl.value);
    applyLongPressMs(value);
    saveLongPressMs(value);
  });

  settingsButtonEl.addEventListener('click', openSettings);
  settingsCloseEl.addEventListener('click', closeSettings);
  settingsEl.addEventListener('click', (event) => {
    if (event.target === settingsEl) closeSettings();   // 枠外タップで閉じる
  });

  dummyCellEl.addEventListener('pointerdown', onDummyPointerDown);
  window.addEventListener('pointerup', onDummyPointerEnd);
  window.addEventListener('pointercancel', onDummyPointerEnd);

  applyLongPressMs(loadLongPressMs());
  renderDummyCell();
}
