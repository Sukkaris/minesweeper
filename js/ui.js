// UI 層。DOM 操作・イベント処理・描画を担当する。ゲームのルールは game.js に任せる。

import { Game, GameState, DIFFICULTIES, DEFAULT_DIFFICULTY } from './game.js';

// ---------- 調整用の定数 ----------
const LONG_PRESS_MS = 300;          // 長押しとみなす時間
const LONG_PRESS_MOVE_LIMIT = 10;   // この距離（px）以上動いたら長押しをキャンセル
const TIMER_TICK_MS = 250;          // タイマー表示の更新間隔
const LED_MAX = 999;                // 3 桁表示の上限
const STORAGE_KEY_DIFFICULTY = 'ms-difficulty';

// ---------- DOM 参照 ----------
const boardEl = document.getElementById('board');
const boardWrapEl = document.getElementById('board-wrap');
const mainEl = document.getElementById('main');
const mineCounterEl = document.getElementById('mine-counter');
const timerEl = document.getElementById('timer');
const smileyEl = document.getElementById('smiley');
const difficultyBarEl = document.getElementById('difficulty-bar');

// ---------- 状態 ----------
let game = null;
let difficultyKey = DEFAULT_DIFFICULTY;
let cellEls = [];          // 添字 → セル要素
let timerHandle = null;
let press = null;          // 押下中の情報 { index, x, y, timer, longFired, pointerId }

// ---------- 永続化 ----------

function loadDifficulty() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY_DIFFICULTY);
    if (saved && DIFFICULTIES[saved]) return saved;
  } catch (_) { /* localStorage が使えない環境では無視 */ }
  return DEFAULT_DIFFICULTY;
}

function saveDifficulty(key) {
  try {
    localStorage.setItem(STORAGE_KEY_DIFFICULTY, key);
  } catch (_) { /* 無視 */ }
}

// ---------- 3 桁表示 ----------

/** 3 桁ゼロ埋め。マイナスは "-05" のように先頭に符号を置く。999 で頭打ち */
function formatLed(value) {
  if (value < 0) {
    const abs = Math.min(Math.abs(value), 99);
    return '-' + String(abs).padStart(2, '0');
  }
  return String(Math.min(value, LED_MAX)).padStart(3, '0');
}

function updateMineCounter() {
  mineCounterEl.textContent = formatLed(game.remainingMines);
}

function updateTimer() {
  timerEl.textContent = formatLed(game.elapsedSeconds);
}

function startTimerTick() {
  stopTimerTick();
  timerHandle = setInterval(() => {
    updateTimer();
    if (game.isOver) stopTimerTick();
  }, TIMER_TICK_MS);
}

function stopTimerTick() {
  if (timerHandle !== null) {
    clearInterval(timerHandle);
    timerHandle = null;
  }
}

// ---------- スマイリー ----------

function setFace(face) {
  smileyEl.dataset.face = face;
}

function updateFaceFromState() {
  if (game.state === GameState.WON) setFace('won');
  else if (game.state === GameState.LOST) setFace('lost');
  else setFace('normal');
}

// ---------- 盤面の生成と描画 ----------

/** SVG シンボルを参照する <svg><use> を生成する */
function createIcon(symbolId, className) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon ' + className);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#' + symbolId);
  svg.appendChild(use);
  return svg;
}

function buildBoard() {
  boardEl.innerHTML = '';
  boardEl.style.setProperty('--cols', game.cols);
  boardEl.style.setProperty('--rows', game.rows);
  cellEls = new Array(game.totalCells);

  const fragment = document.createDocumentFragment();
  for (let i = 0; i < game.totalCells; i++) {
    const cell = document.createElement('div');
    cell.className = 'cell hidden';
    cell.dataset.i = i;
    cell.setAttribute('role', 'gridcell');
    cellEls[i] = cell;
    fragment.appendChild(cell);
  }
  boardEl.appendChild(fragment);
  fitBoard();
}

/** 1 マスを game.cellView() の結果に従って描画する */
function renderCell(index) {
  const cell = cellEls[index];
  const view = game.cellView(index);
  cell.className = 'cell ' + view.kind;
  cell.textContent = '';

  switch (view.kind) {
    case 'number':
      cell.classList.add('n' + view.number);
      cell.textContent = String(view.number);
      break;
    case 'flag':
      cell.appendChild(createIcon('icon-flag', 'icon-flag'));
      break;
    case 'wrong-flag':
      cell.appendChild(createIcon('icon-flag', 'icon-flag'));
      cell.appendChild(createIcon('icon-wrong', 'icon-wrong'));
      break;
    case 'mine':
    case 'exploded':
      cell.appendChild(createIcon('icon-mine', 'icon-mine'));
      break;
    default:
      break;
  }
}

function renderCells(indices) {
  for (const i of indices) renderCell(i);
}

/**
 * 盤面のサイズ計算。
 * 1 マスの辺 = (利用可能な横幅 − 余白) ÷ 列数。正方形を保ち、横スクロールは発生させない。
 * 固定値は使わず、実際のコンテナ幅から算出する。
 */
function fitBoard() {
  if (!game) return;
  const wrapStyle = getComputedStyle(boardWrapEl);
  const boardStyle = getComputedStyle(boardEl);
  const padding = parseFloat(wrapStyle.paddingLeft) + parseFloat(wrapStyle.paddingRight);
  const frame = parseFloat(boardStyle.borderLeftWidth) + parseFloat(boardStyle.borderRightWidth)
              + parseFloat(boardStyle.paddingLeft) + parseFloat(boardStyle.paddingRight);
  const available = mainEl.clientWidth - padding - frame;
  // 端末の物理ピクセル単位に切り捨て、マス間に隙間や太さムラが出ないようにする
  const dpr = window.devicePixelRatio || 1;
  const cellSize = Math.max(1, Math.floor((available / game.cols) * dpr) / dpr);
  const value = cellSize + 'px';
  if (boardEl.style.getPropertyValue('--cell-size') !== value) {
    boardEl.style.setProperty('--cell-size', value);
  }
}

// ---------- ゲームの開始 ----------

function newGame(key) {
  stopTimerTick();
  clearPress();          // 押下中の長押しタイマーも含めて確実に破棄する
  difficultyKey = key;
  game = new Game(DIFFICULTIES[key]);

  buildBoard();
  updateMineCounter();
  updateTimer();
  setFace('normal');
  updateDifficultyButtons();
  mainEl.scrollTop = 0;
}

function updateDifficultyButtons() {
  for (const btn of difficultyBarEl.querySelectorAll('.diff-btn')) {
    btn.setAttribute('aria-pressed', btn.dataset.difficulty === difficultyKey ? 'true' : 'false');
  }
}

// ---------- 操作の適用 ----------

function doReveal(index) {
  const { changed } = game.reveal(index);
  if (changed.length === 0) return;

  if (game.startTime !== null && timerHandle === null && !game.isOver) startTimerTick();

  renderCells(changed);
  updateMineCounter();
  updateTimer();
  updateFaceFromState();
  if (game.isOver) stopTimerTick();
}

function doToggleFlag(index) {
  if (!game.toggleFlag(index)) return;
  renderCell(index);
  updateMineCounter();
}

// ---------- 押下（タップ / 長押し）の処理 ----------

function cellIndexFromEvent(event) {
  const cell = event.target.closest('.cell');
  if (!cell || !boardEl.contains(cell)) return -1;
  return Number(cell.dataset.i);
}

function clearPress() {
  if (!press) return;
  clearTimeout(press.timer);
  cellEls[press.index]?.classList.remove('pressed');
  press = null;
  if (game && !game.isOver) setFace('normal');
}

function onPointerDown(event) {
  // 前回の押下が残っていれば（ウィンドウ外で離した等）先に片付ける
  clearPress();

  if (game.isOver) return;
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  const index = cellIndexFromEvent(event);
  if (index < 0 || game.revealed[index]) return;

  const current = {
    index,
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    longFired: false,
    timer: null,
  };
  current.timer = setTimeout(() => {
    // 長押し成立：旗を立てる / 外す。別の押下に切り替わっていたら何もしない
    if (press !== current) return;
    current.longFired = true;
    cellEls[current.index].classList.remove('pressed');
    doToggleFlag(current.index);
    setFace('normal');
  }, LONG_PRESS_MS);
  press = current;

  if (!game.flagged[index]) cellEls[index].classList.add('pressed');
  setFace('pressed');
}

function onPointerMove(event) {
  if (!press || event.pointerId !== press.pointerId) return;
  const dx = event.clientX - press.x;
  const dy = event.clientY - press.y;
  // 指が動きすぎたらキャンセル（スクロール操作を妨げない）
  if (Math.hypot(dx, dy) >= LONG_PRESS_MOVE_LIMIT) clearPress();
}

function onPointerUp(event) {
  if (!press || event.pointerId !== press.pointerId) return;
  const { index, longFired } = press;
  clearPress();
  if (longFired) return;              // 長押し済みならタップとして扱わない
  if (game.flagged[index]) return;    // 旗が立っているマスはタップで開放できない
  doReveal(index);
}

function onPointerCancel(event) {
  if (!press || event.pointerId !== press.pointerId) return;
  clearPress();
}

// ---------- イベント登録 ----------

boardEl.addEventListener('pointerdown', onPointerDown);
window.addEventListener('pointermove', onPointerMove, { passive: true });
window.addEventListener('pointerup', onPointerUp);
window.addEventListener('pointercancel', onPointerCancel);

// 長押し時の iOS のコールアウトメニューやデスクトップの右クリックメニューを抑止
boardEl.addEventListener('contextmenu', (event) => event.preventDefault());

smileyEl.addEventListener('click', () => newGame(difficultyKey));

difficultyBarEl.addEventListener('click', (event) => {
  const btn = event.target.closest('.diff-btn');
  if (!btn) return;
  const key = btn.dataset.difficulty;
  if (!DIFFICULTIES[key]) return;
  saveDifficulty(key);
  newGame(key);
});

// コンテナ幅が変わったらマスの大きさを計算し直す
new ResizeObserver(() => fitBoard()).observe(mainEl);

// ---------- 起動 ----------
newGame(loadDifficulty());
