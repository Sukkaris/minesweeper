// 盤面の押下（タップ / 長押し）処理。ui.js から切り出したもの。
//
// 指を触れた時点では確定せず、指の下のマスをハイライトするだけ。
// 指を動かせばハイライトが追従し、離した時点で初めて確定する。
// 盤面の外で離した場合はキャンセル。長押しは「同じマスに触れ続けた時間」で判定する。
//
// ゲームの状態・セル要素・当たり判定は ui.js が持っているので、initPress() で関数として受け取る。

import { sinkCell } from './dom-utils.js';

// ---------- 調整用の定数 ----------
const LONG_SINK_RANGE = 1;   // 長押し成立時に沈める範囲（押したマスから何マス外まで。1 = 3×3）

// ---------- 状態 ----------
let deps = null;    // initPress で受け取る依存（下記参照）
let press = null;   // 押下中の情報 { pointerId, index, highlighted, timer, longFired }

/** 押下ハイライトの対象。数字マスならチョーディング対象（周囲の未開放マス）を沈める */
function highlightTargets(index) {
  const game = deps.getGame();
  if (index < 0) return [];
  if (!game.revealed[index]) return [index];
  if (game.adjacent[index] === 0) return [];
  return game.neighbors(index).filter((n) => !game.revealed[n] && !game.flagged[n]);
}

function setHighlight(indices) {
  for (const i of press.highlighted) deps.getCell(i).classList.remove('pressed');
  for (const i of indices) deps.getCell(i).classList.add('pressed');
  press.highlighted = indices;
}

/**
 * 長押し成立の合図。押したマスを中心に、周囲 LONG_SINK_RANGE マスまでの範囲を一斉に沈めて戻す。
 * 指で隠れる中心のマスだけでは気付きにくいため、周囲まで広げている
 */
function sinkAround(index) {
  const game = deps.getGame();
  const { col, row } = game.toCoord(index);
  for (let dr = -LONG_SINK_RANGE; dr <= LONG_SINK_RANGE; dr++) {
    for (let dc = -LONG_SINK_RANGE; dc <= LONG_SINK_RANGE; dc++) {
      const c = col + dc;
      const r = row + dr;
      if (c < 0 || c >= game.cols || r < 0 || r >= game.rows) continue;
      sinkCell(deps.getCell(game.toIndex(c, r)));
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
  if (index < 0 || deps.getGame().revealed[index]) return;
  const current = press;
  current.timer = setTimeout(() => {
    if (press !== current) return;
    current.timer = null;
    current.longFired = true;
    setHighlight([]);
    deps.onLongPress(index);
    sinkAround(index);
    if (!deps.getGame().isOver) deps.setFace('normal');
  }, deps.getLongPressMs());
}

/** 指の下のマスが変わったときの処理。ハイライトを移し、長押しの計時をやり直す */
function movePressTo(index) {
  if (index === press.index) return;
  press.index = index;
  setHighlight(highlightTargets(index));
  restartLongPressTimer();
}

/** 押下中の状態を破棄する（長押しタイマーも含めて）。押していなければ何もしない */
export function clearPress() {
  if (!press) return;
  stopLongPressTimer();
  setHighlight([]);
  press = null;
  const game = deps.getGame();
  if (game && !game.isOver) deps.setFace('normal');
}

function onPointerDown(event) {
  // 押下中に別の指が触れても無視する（親指で長押し中に他の指がかすっても取り消さない）
  if (press && event.pointerId !== press.pointerId) return;
  // 同じポインタの前回の押下が残っていれば（ウィンドウ外で離した等）先に片付ける
  clearPress();

  if (deps.onPressStart) deps.onPressStart();
  if (deps.isBlocked()) return;
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  const index = deps.cellIndexAtPoint(event.clientX, event.clientY);
  if (index < 0) return;

  press = {
    pointerId: event.pointerId,
    index: -1,           // movePressTo で設定する
    highlighted: [],
    timer: null,
    longFired: false,
  };
  movePressTo(index);
  deps.setFace('pressed');
}

function onPointerMove(event) {
  if (!press || event.pointerId !== press.pointerId) return;
  if (press.longFired) return;   // 長押し確定後は指を動かしても何もしない
  movePressTo(deps.cellIndexAtPoint(event.clientX, event.clientY));
}

function onPointerUp(event) {
  if (!press || event.pointerId !== press.pointerId) return;
  const { longFired } = press;
  const index = deps.cellIndexAtPoint(event.clientX, event.clientY);
  clearPress();
  if (longFired) return;        // 長押し済みならタップとして扱わない
  if (index < 0) return;        // 盤面の外で離した → キャンセル
  deps.onTap(index);
}

function onPointerCancel(event) {
  if (!press || event.pointerId !== press.pointerId) return;
  clearPress();
}

/**
 * 押下処理を盤面に取り付ける。
 * @param {object} options
 * @param {HTMLElement} options.boardEl                 盤面要素（pointerdown を受ける）
 * @param {() => Game} options.getGame                  現在のゲーム（newGame で差し替わるので関数で受ける）
 * @param {(index:number) => HTMLElement} options.getCell 添字 → セル要素
 * @param {(x:number, y:number) => number} options.cellIndexAtPoint 画面座標 → 添字（盤面外は -1）
 * @param {() => void} [options.onPressStart]          指が触れた直後（判定の前）に呼ぶ。演出の残りを描き切る用
 * @param {() => boolean} options.isBlocked             押下を受け付けない状態か（終了後・設定画面・盤面生成中）
 * @param {() => number} options.getLongPressMs         長押し閾値
 * @param {(face:string) => void} options.setFace       スマイリーの表情
 * @param {(index:number) => void} options.onTap        タップ確定
 * @param {(index:number) => void} options.onLongPress  長押し成立
 */
export function initPress(options) {
  deps = options;
  deps.boardEl.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove, { passive: true });
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerCancel);
}
