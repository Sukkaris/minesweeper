// 設定画面。フルスクリーンのシートとして開き、
// 難易度（カスタム含む）・テーマ・各種トグル・長押し調整（試し押し付き）・統計への入口を持つ。
// 設定値はすべて localStorage（ms-settings）に保存し、起動時に復元する。
//
// 難易度の「現在値」は ui.js が newGame() のたびに setSetting('difficulty', key) で書く。
// ここでは選択 UI を描き、選ばれたら onDifficultyChange で ui.js に知らせるだけ。

import {
  DIFFICULTIES, DEFAULT_DIFFICULTY, CUSTOM_KEY, CUSTOM_LABEL, CUSTOM_LIMITS,
  DEFAULT_CUSTOM, clampCustomConfig, maxMinesFor,
} from './game.js';
import { createIcon, sinkCell, openSheet, closeSheet, isSheetOpen } from './dom-utils.js';
import { loadSettingsRaw, saveSettingsData, mergeDefaults } from './storage.js';
import { initStatsScreen, openStats } from './stats-screen.js';

// ---------- 調整用の定数 ----------
const LONG_PRESS_DEFAULT_MS = 300;  // 長押しとみなす時間の既定値
const LONG_PRESS_MIN_MS = 200;
const LONG_PRESS_MAX_MS = 600;
const LONG_PRESS_STEP_MS = 50;

/** テーマ一覧。第5段階で増やす。選択肢はこの配列から生成する */
const THEMES = Object.freeze([
  { key: 'classic', label: 'クラシック' },
]);

const DEFAULT_SETTINGS = Object.freeze({
  difficulty: DEFAULT_DIFFICULTY,
  theme: THEMES[0].key,
  noGuess: false,            // 無推測モード（第4段階で機能を実装）
  longPressMs: LONG_PRESS_DEFAULT_MS,
  effects: true,             // 視覚演出（第5段階で機能を実装）
  sound: false,              // サウンド（第5段階で機能を実装）
  custom: DEFAULT_CUSTOM,    // カスタム難易度の入力内容
});

const isBool = (v) => typeof v === 'boolean';
const SETTINGS_VALIDATORS = {
  difficulty: (v) => v === CUSTOM_KEY || Object.prototype.hasOwnProperty.call(DIFFICULTIES, v),
  theme: (v) => THEMES.some((t) => t.key === v),
  noGuess: isBool,
  longPressMs: (v) => Number.isFinite(v) && v >= LONG_PRESS_MIN_MS && v <= LONG_PRESS_MAX_MS,
  effects: isBool,
  sound: isBool,
  custom: (v) => v && typeof v === 'object',   // 中身は clampCustomConfig で必ず範囲内に丸める
};

// ---------- DOM 参照 ----------
const settingsButtonEl = document.getElementById('settings-button');
const settingsEl = document.getElementById('settings');
const settingsCloseEl = document.getElementById('settings-close');
const difficultyGroupEl = document.getElementById('difficulty-group');
const customPanelEl = document.getElementById('custom-panel');
const customColsEl = document.getElementById('custom-cols');
const customRowsEl = document.getElementById('custom-rows');
const customMinesEl = document.getElementById('custom-mines');
const customDensityEl = document.getElementById('custom-density');
const customStartEl = document.getElementById('custom-start');
const themeGroupEl = document.getElementById('theme-group');
const noGuessEl = document.getElementById('toggle-no-guess');
const effectsEl = document.getElementById('toggle-effects');
const soundEl = document.getElementById('toggle-sound');
const longPressRangeEl = document.getElementById('long-press-range');
const longPressValueEl = document.getElementById('long-press-value');
const dummyBoardEl = document.getElementById('dummy-board');
const dummyCellEl = document.getElementById('dummy-cell');
const statsOpenEl = document.getElementById('stats-open');

// ---------- 状態 ----------
let settings = loadSettings();
let callbacks = {};        // { onOpen, onClose, onDifficultyChange }
let dummyPress = null;     // 試し押し中の情報 { pointerId, timer }
let dummyFlagged = false;

// ---------- 永続化 ----------

function loadSettings() {
  const merged = mergeDefaults(DEFAULT_SETTINGS, loadSettingsRaw(), SETTINGS_VALIDATORS);
  merged.custom = clampCustomConfig(merged.custom);
  return merged;
}

function saveSettings() {
  saveSettingsData(settings);
}

/** 設定値を読む */
export function getSetting(key) {
  return settings[key];
}

/** 設定値を書いて保存する */
export function setSetting(key, value) {
  settings[key] = value;
  saveSettings();
}

/** 現在の長押し閾値（ms）。盤面側はこれを毎回参照する */
export function getLongPressMs() {
  return settings.longPressMs;
}

/** カスタム難易度の現在の入力内容（範囲内に丸めた値） */
export function getCustomConfig() {
  return { key: CUSTOM_KEY, label: CUSTOM_LABEL, ...settings.custom };
}

// ---------- シートの開閉 ----------

export function openSettings() {
  renderDifficultyChoice(settings.difficulty);
  openSheet(settingsEl);
  // 「開いている」状態にしてから知らせる（ui.js はこれを見てタイマーを止める）
  if (callbacks.onOpen) callbacks.onOpen();
}

export function closeSettings() {
  clearDummyPress();
  closeSheet(settingsEl);
  if (callbacks.onClose) callbacks.onClose();
}

/** 設定画面（またはその上の統計画面）が開いているか。開いている間はタイマーを止める */
export function isSettingsOpen() {
  return isSheetOpen(settingsEl);
}

// ---------- 選択肢ボタン群（難易度・テーマで共用） ----------

function buildChoiceGroup(container, items, onSelect) {
  container.innerHTML = '';
  for (const item of items) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'choice';
    button.dataset.key = item.key;
    button.textContent = item.label;
    button.addEventListener('click', () => onSelect(item.key));
    container.appendChild(button);
  }
}

function markChoice(container, key) {
  for (const button of container.querySelectorAll('.choice')) {
    button.classList.toggle('selected', button.dataset.key === key);
  }
}

// ---------- 難易度 ----------

/** 難易度ボタンのハイライトと、カスタム入力欄の開閉 */
function renderDifficultyChoice(key) {
  markChoice(difficultyGroupEl, key);
  const isCustom = key === CUSTOM_KEY;
  customPanelEl.hidden = !isCustom;
  if (isCustom) renderCustomInputs();
}

function onDifficultySelected(key) {
  if (key === CUSTOM_KEY) {
    // カスタムはその場で入力欄を展開するだけ。「この設定で始める」を押すまでゲームは変えない
    renderDifficultyChoice(CUSTOM_KEY);
    return;
  }
  // 初級 / 中級 / 上級：即座に新しい盤面を作り、設定画面を閉じる（確認は出さない）
  if (callbacks.onDifficultyChange) callbacks.onDifficultyChange(key);
  closeSettings();
}

// ---------- カスタム難易度 ----------

function renderCustomInputs() {
  const { cols, rows, mines } = settings.custom;
  customColsEl.value = String(cols);
  customRowsEl.value = String(rows);
  customMinesEl.value = String(mines);
  customMinesEl.max = String(maxMinesFor(cols, rows));
  renderDensity(settings.custom);
}

/** 地雷密度（地雷数 ÷ 総マス数）を常時表示する */
function renderDensity({ cols, rows, mines }) {
  const percent = (mines / (cols * rows)) * 100;
  customDensityEl.textContent = percent.toFixed(1) + '%';
}

/** 入力欄の現在値を範囲内に丸めた設定値として読む */
function readCustomInputs() {
  return clampCustomConfig({
    cols: customColsEl.value,
    rows: customRowsEl.value,
    mines: customMinesEl.value,
  });
}

/** 入力確定時：黙って範囲内へ丸め、地雷数の上限を計算し直し、保存する */
function commitCustomInputs() {
  settings.custom = readCustomInputs();
  saveSettings();
  renderCustomInputs();
}

function initCustomPanel() {
  customColsEl.min = String(CUSTOM_LIMITS.minCols);
  customColsEl.max = String(CUSTOM_LIMITS.maxCols);
  customRowsEl.min = String(CUSTOM_LIMITS.minRows);
  customRowsEl.max = String(CUSTOM_LIMITS.maxRows);
  customMinesEl.min = String(CUSTOM_LIMITS.minMines);

  for (const input of [customColsEl, customRowsEl, customMinesEl]) {
    // 入力中は密度の表示だけ追従させ、値の書き換え（丸め）は確定時に行う
    input.addEventListener('input', () => renderDensity(readCustomInputs()));
    input.addEventListener('change', commitCustomInputs);
  }

  customStartEl.addEventListener('click', () => {
    commitCustomInputs();
    if (callbacks.onDifficultyChange) callbacks.onDifficultyChange(CUSTOM_KEY);
    closeSettings();
  });
}

// ---------- テーマ ----------

function applyTheme(key) {
  document.documentElement.dataset.theme = key;
  markChoice(themeGroupEl, key);
}

// ---------- トグル ----------

function bindToggle(input, key) {
  input.checked = settings[key];
  input.addEventListener('change', () => setSetting(key, input.checked));
}

// ---------- 長押し時間 ----------

function applyLongPressMs(value) {
  longPressRangeEl.value = String(value);
  longPressValueEl.textContent = value + ' ms';
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
  }, settings.longPressMs);
  dummyPress = current;
  dummyCellEl.classList.add('pressed');
}

function onDummyPointerEnd(event) {
  if (!dummyPress || event.pointerId !== dummyPress.pointerId) return;
  clearDummyPress();
}

// ---------- 初期化 ----------

/**
 * @param {{onOpen?: () => void, onClose?: () => void, onDifficultyChange?: (key: string) => void}} options
 *   onOpen  : 開く直前（盤面の押下状態を片付け、タイマーを止める用）
 *   onClose : 閉じた直後（タイマーを再開する用）
 *   onDifficultyChange : 難易度が選ばれた。ui.js はこれを受けて新しい盤面を作る
 */
export function initSettings(options = {}) {
  callbacks = options;

  // 難易度：初級 / 中級 / 上級 / カスタム
  const difficultyItems = [...Object.values(DIFFICULTIES), { key: CUSTOM_KEY, label: CUSTOM_LABEL }];
  buildChoiceGroup(difficultyGroupEl, difficultyItems, onDifficultySelected);
  initCustomPanel();

  // テーマ
  buildChoiceGroup(themeGroupEl, THEMES, (key) => {
    setSetting('theme', key);
    applyTheme(key);
  });
  applyTheme(settings.theme);

  // トグル類（この段階では保存のみ。機能は後の段階で実装）
  bindToggle(noGuessEl, 'noGuess');
  bindToggle(effectsEl, 'effects');
  bindToggle(soundEl, 'sound');

  // 長押し時間
  longPressRangeEl.min = String(LONG_PRESS_MIN_MS);
  longPressRangeEl.max = String(LONG_PRESS_MAX_MS);
  longPressRangeEl.step = String(LONG_PRESS_STEP_MS);
  longPressRangeEl.addEventListener('input', () => {
    const value = Number(longPressRangeEl.value);
    applyLongPressMs(value);
    setSetting('longPressMs', value);
  });
  applyLongPressMs(settings.longPressMs);

  dummyCellEl.addEventListener('pointerdown', onDummyPointerDown);
  window.addEventListener('pointerup', onDummyPointerEnd);
  window.addEventListener('pointercancel', onDummyPointerEnd);
  // 押したまま背面に回ったら破棄する（復帰後に遅れて発火して旗が切り替わるのを防ぐ）
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearDummyPress();
  });
  renderDummyCell();

  // 統計画面（設定画面の上に重ねて開く）
  initStatsScreen();
  statsOpenEl.addEventListener('click', openStats);

  // 開閉
  settingsButtonEl.addEventListener('click', openSettings);
  settingsCloseEl.addEventListener('click', closeSettings);

  // 起動直後に一度保存し、第2段階の個別キーからの引き継ぎを確定させる
  saveSettings();
}
