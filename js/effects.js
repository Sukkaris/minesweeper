// 開放・終了時の演出。盤面の描画を「いつ・どの順で行うか」だけを扱い、何を描くかは ui.js の renderCell に任せる。
//
//   波紋   : 空白の連鎖開放で開くマスを、起点からの距離順に少しずつ遅らせて開く
//   敗北   : 踏んだ地雷を強調 → 他の地雷を順次開示 → 誤った旗に × を重ねる
//   勝利   : 残りのマスに順に旗が立ち、盤面全体が軽く発光する
//
// 設定「開放・終了時の演出」がオフなら、どれも即座に最終状態を描く。
// 押下中のハイライトと長押しの沈み込みは操作の手応えなので、ここでは扱わない（press.js・常時有効）。
//
// 遅らせた描画はすべてこのファイルのタイマーで管理する。新しいゲームを始めるときは cancelEffects()、
// 演出中に別の操作が来たときは flushEffects()（残りを一気に描いてから次へ進む）を呼ぶ。

import { GameState } from './game.js';
import { isEffectsEnabled } from './settings.js';
import { playReveal, playWin, playLose } from './sound.js';

// ---------- 調整用の定数 ----------
const RIPPLE_STEP_MS = 36;        // 波紋：起点から 1 マス離れるごとの遅れ
const RIPPLE_MAX_MS = 700;        // 波紋：全体がこれより長くなるときは間隔を詰める
const POP_CLEANUP_MS = 220;       // 「ぱっ」と現れるアニメーションのクラスを外すまでの時間（CSS の時間より少し長め）
const LOSS_MINES_START_MS = 260;  // 敗北：踏んだ地雷の強調から他の地雷の開示を始めるまで
const LOSS_MINE_STEP_MAX_MS = 60; // 敗北：地雷 1 個ごとの間隔の上限
const LOSS_MINE_STEP_MIN_MS = 12; // 敗北：同・下限（上級の 99 個でも 1.2 秒程度に収める）
const LOSS_MINES_TOTAL_MS = 1200; // 敗北：地雷の開示全体の目安時間
const LOSS_WRONG_GAP_MS = 150;    // 敗北：地雷を出し終えてから誤った旗に × を付け始めるまで
const LOSS_WRONG_STEP_MS = 80;    // 敗北：誤った旗 1 個ごとの間隔
const WIN_FLAG_STEP_MAX_MS = 50;  // 勝利：旗 1 本ごとの間隔の上限
const WIN_FLAG_STEP_MIN_MS = 15;  // 勝利：同・下限
const WIN_FLAGS_TOTAL_MS = 600;   // 勝利：旗を立て終えるまでの目安時間
const WIN_GLOW_CLEANUP_MS = 1300; // 勝利：発光のクラスを外すまでの時間（CSS の --win-glow-duration より少し長め）

// ---------- 状態 ----------
let deps = null;              // initEffects で受け取る { boardEl, getGame, getCell, renderCell }
const pending = new Set();    // 予約済みの処理 { timer, run }

// ---------- タイマー管理 ----------

/** 処理を遅らせて予約する。cancelEffects / flushEffects で取り消し・即時実行できる */
function schedule(run, delayMs) {
  const entry = { timer: null, run };
  entry.timer = setTimeout(() => {
    pending.delete(entry);
    run();
  }, delayMs);
  pending.add(entry);
}

/** 予約をすべて取り消す（描かない）。新しいゲームを始めるときに呼ぶ */
export function cancelEffects() {
  for (const entry of pending) clearTimeout(entry.timer);
  pending.clear();
  deps.boardEl.classList.remove('win-glow');
}

/** 予約をすべて即座に実行する（残りを一気に描く）。演出中に次の操作が来たときに呼ぶ */
export function flushEffects() {
  const entries = [...pending];
  pending.clear();
  for (const entry of entries) {
    clearTimeout(entry.timer);
    entry.run();
  }
}

// ---------- 描画の小道具 ----------

function renderAll(indices) {
  for (const i of indices) deps.renderCell(i);
}

/** マスを描き、現れるアニメーションのクラスを付ける。少し後にクラスを外す */
function renderWithPop(index, popClass) {
  deps.renderCell(index);
  const cell = deps.getCell(index);
  cell.classList.add(popClass);
  schedule(() => cell.classList.remove(popClass), POP_CLEANUP_MS);
}

/** 2 マスの距離（ユークリッド距離。波紋を丸く広げるため） */
function distance(game, a, b) {
  const pa = game.toCoord(a);
  const pb = game.toCoord(b);
  return Math.hypot(pa.col - pb.col, pa.row - pb.row);
}

/** 個数と目安時間から 1 個ごとの間隔を決める（上限・下限つき） */
function stepFor(count, totalMs, minMs, maxMs) {
  if (count <= 1) return maxMs;
  return Math.min(maxMs, Math.max(minMs, totalMs / (count - 1)));
}

// ---------- 各演出 ----------

/**
 * 通常の開放（波紋）。起点から近い順に、距離 1 につき RIPPLE_STEP_MS ずつ遅らせて開く。
 * 起点のマス自体は即座に開く（指を離した瞬間に反応が無いと不安になるため）
 */
function playRipple(game, changed, origin) {
  playReveal();
  if (changed.length <= 1) {
    renderAll(changed);
    return;
  }

  // 起点からの距離を整数の「輪」に丸めて、同じ輪のマスは同時に開く。
  // いちばん近い輪は即座に開く（チョーディングでは起点の数字マス自体は changed に含まれない）
  const rings = new Map();   // 輪の番号 → マスの添字
  let minRing = Infinity;
  let maxRing = 0;
  for (const i of changed) {
    const ring = Math.round(distance(game, origin, i));
    if (!rings.has(ring)) rings.set(ring, []);
    rings.get(ring).push(i);
    if (ring < minRing) minRing = ring;
    if (ring > maxRing) maxRing = ring;
  }
  const span = Math.max(1, maxRing - minRing);
  const step = Math.min(RIPPLE_STEP_MS, RIPPLE_MAX_MS / span);

  for (const [ring, indices] of rings) {
    if (ring === minRing) {
      renderAll(indices);
      continue;
    }
    schedule(() => {
      for (const i of indices) renderWithPop(i, 'reveal-pop');
      playReveal();   // 連鎖の音は sound.js 側で間引かれる
    }, (ring - minRing) * step);
  }
}

/**
 * 敗北。踏んだ地雷を強調 → 他の地雷を近い順に一つずつ開示 → 誤った旗に × を重ねる。
 * それ以外のマス（見た目が変わらないもの）は即座に描く
 */
function playLoss(game) {
  const exploded = game.explodedIndex;
  const mines = [];
  const wrongFlags = [];
  for (let i = 0; i < game.totalCells; i++) {
    const kind = game.cellView(i).kind;
    if (kind === 'mine') mines.push(i);
    else if (kind === 'wrong-flag') wrongFlags.push(i);
    else deps.renderCell(i);
  }
  playLose();
  if (exploded >= 0) {
    deps.getCell(exploded).classList.add('exploding');
    schedule(() => deps.getCell(exploded).classList.remove('exploding'), LOSS_MINES_START_MS * 4);
  }

  // チョーディングで踏んだ場合など、起点が無ければ盤面の左上から
  const from = exploded >= 0 ? exploded : 0;
  mines.sort((a, b) => distance(game, from, a) - distance(game, from, b));
  const mineStep = stepFor(mines.length, LOSS_MINES_TOTAL_MS, LOSS_MINE_STEP_MIN_MS, LOSS_MINE_STEP_MAX_MS);
  mines.forEach((i, n) => {
    schedule(() => renderWithPop(i, 'mine-pop'), LOSS_MINES_START_MS + n * mineStep);
  });

  const wrongStart = LOSS_MINES_START_MS + Math.max(0, mines.length - 1) * mineStep + LOSS_WRONG_GAP_MS;
  wrongFlags.forEach((i, n) => {
    schedule(() => renderWithPop(i, 'flag-pop'), wrongStart + n * LOSS_WRONG_STEP_MS);
  });
}

/**
 * 勝利。最後に開いたマスは即座に描き、残りの未開放マス（＝地雷）に左上から順に旗が立ち、
 * 立て終わったら盤面全体が軽く発光する
 */
function playWinEffect(game) {
  const newFlags = [];
  for (let i = 0; i < game.totalCells; i++) {
    // まだ旗が描かれていないマスに自動で旗が立つ。すでに旗があるマスは変わらない
    if (game.flagged[i] && !deps.getCell(i).classList.contains('flag')) newFlags.push(i);
    else deps.renderCell(i);
  }
  playWin();

  const flagStep = stepFor(newFlags.length, WIN_FLAGS_TOTAL_MS, WIN_FLAG_STEP_MIN_MS, WIN_FLAG_STEP_MAX_MS);
  newFlags.forEach((i, n) => {
    schedule(() => renderWithPop(i, 'flag-pop'), n * flagStep);
  });

  const glowAt = Math.max(0, newFlags.length - 1) * flagStep;
  schedule(() => {
    deps.boardEl.classList.add('win-glow');
    schedule(() => deps.boardEl.classList.remove('win-glow'), WIN_GLOW_CLEANUP_MS);
  }, glowAt);
}

// ---------- 公開 API ----------

/**
 * 操作の結果を描画する。演出がオンならゲームの状態に応じた演出で、オフなら即座に。
 * @param {number[]} changed 表示を更新すべきマスの添字（game の action が返したもの）
 * @param {number} origin    操作の起点のマス（波紋の中心・敗北時の距離の基準）
 */
export function renderChanges(changed, origin) {
  const game = deps.getGame();
  if (!isEffectsEnabled()) {
    renderAll(changed);
    if (game.state === GameState.LOST) playLose();
    else if (game.state === GameState.WON) playWin();
    else playReveal();
    return;
  }
  if (game.state === GameState.LOST) playLoss(game);
  else if (game.state === GameState.WON) playWinEffect(game);
  else playRipple(game, changed, origin);
}

/**
 * @param {object} options
 * @param {HTMLElement} options.boardEl                  盤面要素（勝利時の発光クラスを付ける）
 * @param {() => Game} options.getGame                   現在のゲーム
 * @param {(index:number) => HTMLElement} options.getCell 添字 → セル要素
 * @param {(index:number) => void} options.renderCell    1 マスを現在の状態で描く
 */
export function initEffects(options) {
  deps = options;
}
