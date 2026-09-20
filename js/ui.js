// UI 層。DOM 操作・イベント処理・描画を担当する。ゲームのルールは game.js に任せる。

import { Game, GameState, DIFFICULTIES, CUSTOM_KEY } from './game.js';
import { createIcon, sinkCell, installZoomGuards } from './dom-utils.js';
import { fitBoardToContainer } from './board-layout.js';
import {
  initSettings, getLongPressMs, getSetting, setSetting, getCustomConfig, isSettingsOpen,
} from './settings.js';
import { loadGameData, saveGameData, clearGameData } from './storage.js';
import { recordPlayStart, recordWin } from './stats.js';

// ---------- 調整用の定数 ----------
// 長押し時間の閾値（既定 300ms・範囲 200〜600ms）は settings.js で管理する
const TIMER_TICK_MS = 250;          // タイマー表示の更新間隔
const LONG_SINK_RANGE = 1;          // 長押し成立時に沈める範囲（押したマスから何マス外まで。1 = 3×3）
const LED_MAX = 999;                // 3 桁表示の上限

/** 操作モード。開放モードが既定 */
const Mode = Object.freeze({ REVEAL: 'reveal', FLAG: 'flag' });

/** URL の ?level= に受け付ける値 → 難易度キー（advanced は上級の別名） */
const LEVEL_PARAM_ALIASES = Object.freeze({
  beginner: 'beginner',
  intermediate: 'intermediate',
  advanced: 'expert',
  expert: 'expert',
});

// ---------- DOM 参照 ----------
const boardEl = document.getElementById('board');
const boardWrapEl = document.getElementById('board-wrap');
const mainEl = document.getElementById('main');
const mineCounterEl = document.getElementById('mine-counter');
const timerEl = document.getElementById('timer');
const smileyEl = document.getElementById('smiley');
const footerEl = document.getElementById('footer');
const modeToggleEl = document.getElementById('mode-toggle');
const modeLabelEl = document.getElementById('mode-label');
const modeHintEl = document.getElementById('mode-hint');

// ---------- 状態 ----------
let game = null;
let difficultyKey = null;  // 現在のゲームの難易度キー（'beginner' 等、または CUSTOM_KEY）
let mode = Mode.REVEAL;
let cellEls = [];          // 添字 → セル要素
let boardMetrics = null;   // 当たり判定用 { cellSize, frameLeft, frameTop }（fitBoard が更新）
let timerHandle = null;
let press = null;          // 押下中の情報（下記 startPress を参照）

// ---------- 難易度 ----------

/** キーから盤面設定を引く。カスタムは設定画面の入力内容を使う */
function configFor(key) {
  return key === CUSTOM_KEY ? getCustomConfig() : DIFFICULTIES[key];
}

/**
 * URL の ?level= を読む。あれば「明示的に新しいゲームを頼まれた」とみなし、
 * 保存済みの途中ゲームがあっても新規に始める。無ければ null
 */
function difficultyFromUrl() {
  const param = new URLSearchParams(location.search).get('level');
  if (!param) return null;
  const alias = param.toLowerCase();
  return Object.prototype.hasOwnProperty.call(LEVEL_PARAM_ALIASES, alias) ? LEVEL_PARAM_ALIASES[alias] : null;
}

// ---------- ゲーム状態の保存 / 復元 ----------

/** プレイ中なら保存、そうでなければ（未開始・終了）保存データを消す */
function persistGame() {
  if (game.state === GameState.PLAYING) {
    saveGameData({ difficulty: difficultyKey, ...game.serialize() });
  } else {
    clearGameData();
  }
}

/** 保存されていた途中のゲームを無言で復元する。無ければ false */
function restoreGame() {
  const data = loadGameData();
  if (!data) return false;
  const restored = Game.deserialize(data);
  if (!restored || restored.state !== GameState.PLAYING) {
    clearGameData();
    return false;
  }
  game = restored;
  // 難易度キーが今のコードに無いものなら、統計に影響しないようカスタム扱いにする
  const known = Object.prototype.hasOwnProperty.call(DIFFICULTIES, data.difficulty);
  difficultyKey = known ? data.difficulty : CUSTOM_KEY;
  setSetting('difficulty', difficultyKey);   // 設定画面の表示と食い違わないよう揃えておく
  setupBoard();
  return true;
}

// ---------- タイマーの進行制御 ----------

/**
 * 「プレイ中」かつ「前面にある」かつ「設定画面が閉じている」ときだけタイマーを進める。
 * 背面にいた時間や設定画面を開いていた時間はベストタイムに含めない
 */
function updateRunning() {
  const shouldRun = game.state === GameState.PLAYING && !document.hidden && !isSettingsOpen();
  if (shouldRun) {
    game.resume();
    startTimerTick();
  } else {
    game.pause();
    stopTimerTick();
  }
  updateTimer();
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
  if (timerHandle !== null) return;
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

/** 盤面のサイズをコンテナ幅に合わせ、当たり判定用の寸法を覚えておく（計算は board-layout.js） */
function fitBoard() {
  if (!game) return;
  boardMetrics = fitBoardToContainer({ boardEl, boardWrapEl, mainEl, cols: game.cols });
}

// ---------- ゲームの開始 ----------

/**
 * 新しいゲームを始める（スマイリー・難易度変更・起動時）。
 * 進行中のゲームは確認なしに破棄する。中断は「敗北」扱いだが、
 * プレイ回数は開始時に加算済みなので、ここでは保存データを消すだけで統計には触れない
 */
function newGame(key) {
  clearPress();          // 押下中の長押しタイマーも含めて確実に破棄する
  difficultyKey = key;
  game = new Game(configFor(key));
  setSetting('difficulty', key);
  clearGameData();
  setupBoard();
}

/** 盤面と表示を現在の game に合わせて作り直す（新規・復元の両方で使う） */
function setupBoard() {
  stopTimerTick();
  buildBoard();
  renderCells(game.allIndices());
  updateMineCounter();
  updateFaceFromState();
  mainEl.scrollTop = 0;
  updateRunning();
}

// ---------- モード切替 ----------

function setMode(next) {
  mode = next;
  footerEl.dataset.mode = mode;
  if (mode === Mode.FLAG) {
    modeLabelEl.textContent = 'フラグモード';
    modeHintEl.textContent = 'タップ = 旗 ／ 長押し = 開放';
  } else {
    modeLabelEl.textContent = '開放モード';
    modeHintEl.textContent = 'タップ = 開放 ／ 長押し = 旗';
  }
}

function toggleMode() {
  setMode(mode === Mode.REVEAL ? Mode.FLAG : Mode.REVEAL);
}

// ---------- 操作の適用 ----------

/**
 * 盤面を変える操作を 1 つ実行し、描画・統計・保存をまとめて行う。
 * @param {() => {changed:number[]}} action
 */
function runAction(action) {
  const before = game.state;
  const { changed } = action();
  if (changed.length === 0) return;

  // 最初のタップで地雷が置かれた時点をプレイ回数に数える（カスタムは stats 側で無視される）
  if (before === GameState.READY && game.state !== GameState.READY) recordPlayStart(difficultyKey);
  if (game.state === GameState.WON) recordWin(difficultyKey, game.elapsedMs);

  renderCells(changed);
  updateMineCounter();
  updateFaceFromState();
  updateRunning();
  persistGame();
}

function doReveal(index) {
  runAction(() => game.reveal(index));
}

function doChord(index) {
  runAction(() => game.chord(index));
}

function doToggleFlag(index) {
  if (!game.toggleFlag(index)) return;
  renderCell(index);
  updateMineCounter();
  persistGame();
}

/** タップ（指を離したとき）の動作。開放済みの数字マスはモードに関係なくチョーディング */
function tapAction(index) {
  if (game.revealed[index]) {
    doChord(index);
  } else if (mode === Mode.FLAG) {
    doToggleFlag(index);
  } else if (!game.flagged[index]) {
    doReveal(index);
  }
}

/** 長押し成立時の動作。開放済みのマスには何もしない */
function longPressAction(index) {
  if (game.revealed[index]) return;
  if (mode === Mode.FLAG) {
    if (!game.flagged[index]) doReveal(index);
  } else {
    doToggleFlag(index);
  }
}

// ---------- 押下（タップ / 長押し）の処理 ----------
//
// 指を触れた時点では確定せず、指の下のマスをハイライトするだけ。
// 指を動かせばハイライトが追従し、離した時点で初めて確定する。
// 盤面の外で離した場合はキャンセル。長押しは「同じマスに触れ続けた時間」で判定する。

/**
 * 画面座標からセルの添字を求める。盤面の外なら -1。
 * elementFromPoint は使わない。押下中のマスは縮小表示されるため、縁の部分で
 * 「どのマスにも当たらない」判定になり、タップが取りこぼされてしまうから。
 * 代わりに盤面の位置とマスの大きさから計算で求める。
 */
function cellIndexAtPoint(x, y) {
  if (!boardMetrics) return -1;
  const rect = boardEl.getBoundingClientRect();
  const col = Math.floor((x - rect.left - boardMetrics.frameLeft) / boardMetrics.cellSize);
  const row = Math.floor((y - rect.top - boardMetrics.frameTop) / boardMetrics.cellSize);
  if (col < 0 || col >= game.cols || row < 0 || row >= game.rows) return -1;
  // 盤面がスクロールで見切れている部分（ヘッダーやフッターの裏）は盤面外として扱う
  const mainRect = mainEl.getBoundingClientRect();
  if (y < mainRect.top || y >= mainRect.bottom) return -1;
  return game.toIndex(col, row);
}

/** 押下ハイライトの対象。数字マスならチョーディング対象（周囲の未開放マス）を沈める */
function highlightTargets(index) {
  if (index < 0) return [];
  if (!game.revealed[index]) return [index];
  if (game.adjacent[index] === 0) return [];
  return game.neighbors(index).filter((n) => !game.revealed[n] && !game.flagged[n]);
}

function setHighlight(indices) {
  for (const i of press.highlighted) cellEls[i].classList.remove('pressed');
  for (const i of indices) cellEls[i].classList.add('pressed');
  press.highlighted = indices;
}

/**
 * 長押し成立の合図。押したマスを中心に、周囲 LONG_SINK_RANGE マスまでの範囲を一斉に沈めて戻す。
 * 指で隠れる中心のマスだけでは気付きにくいため、周囲まで広げている
 */
function sinkAround(index) {
  const { col, row } = game.toCoord(index);
  for (let dr = -LONG_SINK_RANGE; dr <= LONG_SINK_RANGE; dr++) {
    for (let dc = -LONG_SINK_RANGE; dc <= LONG_SINK_RANGE; dc++) {
      const c = col + dc;
      const r = row + dr;
      if (c < 0 || c >= game.cols || r < 0 || r >= game.rows) continue;
      sinkCell(cellEls[game.toIndex(c, r)]);
    }
  }
}

function stopLongPressTimer() {
  if (press && press.timer !== null) {
    clearTimeout(press.timer);
    press.timer = null;
  }
}

/** 現在のマスに対する長押しタイマーを（再）開始する。開放済みのマスでは開始しない */
function restartLongPressTimer() {
  stopLongPressTimer();
  const index = press.index;
  if (index < 0 || game.revealed[index]) return;
  const current = press;
  current.timer = setTimeout(() => {
    if (press !== current) return;
    current.timer = null;
    current.longFired = true;
    setHighlight([]);
    longPressAction(index);
    sinkAround(index);
    if (!game.isOver) setFace('normal');
  }, getLongPressMs());
}

/** 指の下のマスが変わったときの処理。ハイライトを移し、長押しの計時をやり直す */
function movePressTo(index) {
  if (index === press.index) return;
  press.index = index;
  setHighlight(highlightTargets(index));
  restartLongPressTimer();
}

function clearPress() {
  if (!press) return;
  stopLongPressTimer();
  setHighlight([]);
  press = null;
  if (game && !game.isOver) setFace('normal');
}

function onPointerDown(event) {
  // 押下中に別の指が触れても無視する（親指で長押し中に他の指がかすっても取り消さない）
  if (press && event.pointerId !== press.pointerId) return;
  // 同じポインタの前回の押下が残っていれば（ウィンドウ外で離した等）先に片付ける
  clearPress();

  if (game.isOver) return;
  if (isSettingsOpen()) return;   // 設定画面がせり上がっている最中に、まだ隠れていない盤面を押されても無視する
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  const index = cellIndexAtPoint(event.clientX, event.clientY);
  if (index < 0) return;

  press = {
    pointerId: event.pointerId,
    index: -1,           // movePressTo で設定する
    highlighted: [],
    timer: null,
    longFired: false,
  };
  movePressTo(index);
  setFace('pressed');
}

function onPointerMove(event) {
  if (!press || event.pointerId !== press.pointerId) return;
  if (press.longFired) return;   // 長押し確定後は指を動かしても何もしない
  movePressTo(cellIndexAtPoint(event.clientX, event.clientY));
}

function onPointerUp(event) {
  if (!press || event.pointerId !== press.pointerId) return;
  const { longFired } = press;
  const index = cellIndexAtPoint(event.clientX, event.clientY);
  clearPress();
  if (longFired) return;        // 長押し済みならタップとして扱わない
  if (index < 0) return;        // 盤面の外で離した → キャンセル
  tapAction(index);
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

// アプリが裏に回ったら：押下を破棄し（復帰後に長押しタイマーが遅れて発火して勝手に旗が立つのを防ぐ）、
// タイマーを止め、その時点の状態を保存する（iOS は背面のアプリを予告なく終了させるため）。
// 前面に戻ったらタイマーを再開する
document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearPress();
  updateRunning();
  if (document.hidden) persistGame();
});
window.addEventListener('pagehide', () => {
  updateRunning();
  persistGame();
});

installZoomGuards();

smileyEl.addEventListener('click', () => newGame(difficultyKey));
modeToggleEl.addEventListener('click', toggleMode);

// コンテナ幅が変わったらマスの大きさを計算し直す
new ResizeObserver(() => fitBoard()).observe(mainEl);

// ---------- 起動 ----------
initSettings({
  onOpen: () => { clearPress(); updateRunning(); },   // 開いている間はタイマーを止める
  onClose: updateRunning,
  onDifficultyChange: newGame,
});
setMode(Mode.REVEAL);

// 起動時の盤面：?level= の明示指定 → 保存済みの途中ゲームを無言で復元 → 保存済みの難易度で新規
const urlDifficulty = difficultyFromUrl();
if (urlDifficulty) {
  newGame(urlDifficulty);
} else if (!restoreGame()) {
  newGame(getSetting('difficulty'));
}
