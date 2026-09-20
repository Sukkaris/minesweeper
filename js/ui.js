// UI 層。DOM 操作・イベント処理・描画を担当する。ゲームのルールは game.js に任せる。
// 盤面の押下（タップ / 長押し）の判定は press.js に分けてある。

import { Game, GameState, DIFFICULTIES, CUSTOM_KEY } from './game.js';
import { createIcon, installZoomGuards } from './dom-utils.js';
import { fitBoardToContainer } from './board-layout.js';
import {
  initSettings, getLongPressMs, getSetting, setSetting, getCustomConfig, isSettingsOpen, isNoGuessEnabled,
} from './settings.js';
import { loadGameData, saveGameData, clearGameData } from './storage.js';
import { recordPlayStart, recordWin } from './stats.js';
import { initPress, clearPress } from './press.js';
import { findNoGuessLayout, attemptLimitFor } from './solver.js';
import { showLoading, hideLoading, showToast, hideToast } from './notice.js';

// ---------- 調整用の定数 ----------
// 長押し時間の閾値（既定 300ms・範囲 200〜600ms）は settings.js で管理する
const TIMER_TICK_MS = 250;          // タイマー表示の更新間隔
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
let noGuessJob = null;     // 無推測の盤面生成中なら { cancel } が入る。生成中は盤面の操作を受け付けない

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

// ---------- ゲームの開始 ----------

/**
 * 新しいゲームを始める（スマイリー・難易度変更・起動時）。
 * 進行中のゲームは確認なしに破棄する。中断は「敗北」扱いだが、
 * プレイ回数は開始時に加算済みなので、ここでは保存データを消すだけで統計には触れない
 */
function newGame(key) {
  clearPress();          // 押下中の長押しタイマーも含めて確実に破棄する
  cancelNoGuess();       // 無推測の盤面を生成中なら打ち切る
  hideToast();           // 前のゲームの通知（生成失敗など）を持ち越さない
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

/**
 * 今のゲームの盤面設定（密度の判定用）。
 * カスタムは設定画面で数値を変えただけで保存されるので、configFor() ではなく game の実際の値を使う
 */
function currentConfig() {
  return { label: configFor(difficultyKey).label, cols: game.cols, rows: game.rows, mines: game.totalMines };
}

function doReveal(index) {
  // 初手で無推測モードが有効なら、解ける配置を探してから開く（非同期）
  if (game.state === GameState.READY && isNoGuessEnabled(currentConfig())) {
    startNoGuess(index);
    return;
  }
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

// ---------- 無推測モードの盤面生成 ----------

/**
 * 初手 index から論理だけで解ける地雷配置を探し、見つかったらそれで初手を開く。
 * 生成中は盤面の操作を受け付けず、時間がかかるときだけローディング表示を出す。
 * 上限まで見つからなければ通常の盤面で始め、一行の通知を出す（ダイアログは出さない）
 */
function startNoGuess(index) {
  cancelNoGuess();
  const startedGame = game;
  const config = currentConfig();
  const maxAttempts = attemptLimitFor(difficultyKey, config);

  boardEl.classList.add('generating');
  showLoading('盤面を生成中…');

  noGuessJob = findNoGuessLayout({
    cols: game.cols,
    rows: game.rows,
    firstIndex: index,
    makeLayout: () => startedGame.createMineLayout(index),
    maxAttempts,
    onDone: ({ success, layout, attempts, elapsedMs }) => {
      // 生成中に新しいゲームが始まっていれば、cancel 済みなのでここには来ないが念のため
      if (game !== startedGame) return;
      finishNoGuess();
      // 開発用ログ：実測した生成時間
      console.log(
        `[no-guess] ${config.label} ${config.cols}×${config.rows}/${config.mines}: `
        + `${success ? '成功' : '失敗（通常の盤面で開始）'} 試行 ${attempts}/${maxAttempts} 回, ${elapsedMs.toFixed(0)}ms`
      );
      if (!success) showToast('無推測の盤面を生成できませんでした');
      runAction(() => game.reveal(index, layout));
    },
  });
}

/** 生成中の表示と入力ブロックを解除する */
function finishNoGuess() {
  noGuessJob = null;
  boardEl.classList.remove('generating');
  hideLoading();
}

/** 生成中なら打ち切る（新しいゲームを始めるとき） */
function cancelNoGuess() {
  if (!noGuessJob) return;
  noGuessJob.cancel();
  finishNoGuess();
}

// ---------- イベント登録 ----------

initPress({
  boardEl,
  getGame: () => game,
  getCell: (i) => cellEls[i],
  cellIndexAtPoint,
  // 終了後・設定画面がせり上がっている最中・無推測の盤面生成中は押下を受け付けない
  isBlocked: () => game.isOver || isSettingsOpen() || noGuessJob !== null,
  getLongPressMs,
  setFace,
  onTap: tapAction,
  onLongPress: longPressAction,
});

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
