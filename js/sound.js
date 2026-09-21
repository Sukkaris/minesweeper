// 効果音。Web Audio API で短い電子音をその場で合成する（音声ファイルは同梱しない）。
//
// iOS では、ユーザーの操作（タッチ）の中で AudioContext を作る／再開しないと音が出ない。
// そのためサウンドがオンなら最初のタップで初期化し、以後もタップのたびに止まっていれば再開する
// （アプリを裏に回すと止められることがあるため）。
// 鳴らすかどうかは settings.js のサウンド設定に従う。既定はオフで、オフの間は AudioContext に触れない。

import { isSoundEnabled } from './settings.js';

// ---------- 調整用の定数 ----------
const MASTER_GAIN = 0.35;          // 全体の音量（0〜1）
const REVEAL_MIN_INTERVAL_MS = 45; // 開放音の最小間隔。連鎖開放で大量に鳴らないよう間引く
const REVEAL_FREQ = 1400;          // 開放：ごく短い高めのクリック
const REVEAL_MS = 35;
const FLAG_ON_FREQ = 740;          // 旗を立てる：やや高い短音
const FLAG_OFF_FREQ = 520;         // 旗を外す：やや低い短音
const FLAG_MS = 70;
const WIN_NOTES = [523, 659, 784]; // 勝利：上昇する 3 音（C5 E5 G5）
const WIN_NOTE_MS = 140;
const WIN_NOTE_GAP_MS = 110;
const LOSE_FREQ_FROM = 220;        // 敗北：下降する低音
const LOSE_FREQ_TO = 70;
const LOSE_MS = 450;

// ---------- 状態 ----------
let context = null;       // AudioContext。最初のユーザー操作で作る
let master = null;        // 全体の音量ノード
let lastRevealAt = 0;     // 開放音を最後に鳴らした時刻（間引き用）

/**
 * ユーザー操作の中で呼ぶ。AudioContext を用意し、止まっていれば再開する。
 * サウンドがオフのときは何もしない：iOS では AudioContext を動かした時点で音声セッションが有効になり、
 * 裏で再生中の音楽が止まることがあるため、使わない人の端末では触らない
 */
function unlock() {
  if (!isSoundEnabled()) {
    // オンからオフに切り替えた後は、次の操作で止めておく（音楽アプリへの影響を残さない）
    if (context && context.state === 'running') context.suspend().catch(() => {});
    return;
  }
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return;
  if (!context) {
    // 効果音なので、他アプリの音楽と共存する種別にする（iOS 17 以降。無い環境では無視）
    if (navigator.audioSession && 'type' in navigator.audioSession) {
      try { navigator.audioSession.type = 'ambient'; } catch (_) { /* 無視 */ }
    }
    context = new AudioContextClass();
    master = context.createGain();
    master.gain.value = MASTER_GAIN;
    master.connect(context.destination);
  }
  // iOS では着信や背面化で 'interrupted'（非標準）になることもあるので、running 以外はすべて再開を試みる
  if (context.state !== 'running') {
    context.resume().catch(() => { /* 操作の外で呼ばれた等。次の操作でまた試す */ });
  }
}

/** 鳴らせる状態か（設定オン・初期化済み・再開済み） */
function ready() {
  return isSoundEnabled() && context !== null && context.state === 'running';
}

/**
 * 1 音を鳴らす。音量は短い立ち上がりの後、指数的に減衰させてプチ音を防ぐ。
 * @param {object} spec
 * @param {number} spec.freq        周波数（Hz）
 * @param {number} [spec.freqTo]    終了時の周波数（指定すると滑らかに変化させる）
 * @param {number} spec.ms          長さ
 * @param {number} [spec.delayMs]   鳴らし始めるまでの遅れ
 * @param {OscillatorType} [spec.type] 波形
 * @param {number} [spec.volume]    音量（0〜1）
 */
function tone({ freq, freqTo, ms, delayMs = 0, type = 'square', volume = 1 }) {
  const start = context.currentTime + delayMs / 1000;
  const end = start + ms / 1000;

  const osc = context.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  if (freqTo) osc.frequency.exponentialRampToValueAtTime(freqTo, end);

  const gain = context.createGain();
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(volume, start + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, end);

  osc.connect(gain);
  gain.connect(master);
  osc.start(start);
  osc.stop(end + 0.02);
}

// ---------- 公開 API ----------

/**
 * ユーザー操作で初期化するための登録。ui.js が起動時に一度呼ぶ。
 * iOS はタッチ由来の pointerdown を「ユーザー操作」と認めないことがあるため、
 * 指を離したとき（pointerup）と click でも試みる。resume は非同期なので、
 * 最初のタップの音は出ないことがあるが、2 回目以降は鳴る
 */
export function initSound() {
  for (const type of ['pointerdown', 'pointerup', 'click']) {
    document.addEventListener(type, unlock, { passive: true });
  }
}

/** マス開放：ごく短い高めのクリック音。短い間隔で連続して呼ばれたら間引く */
export function playReveal() {
  if (!ready()) return;
  const now = performance.now();
  if (now - lastRevealAt < REVEAL_MIN_INTERVAL_MS) return;
  lastRevealAt = now;
  tone({ freq: REVEAL_FREQ, ms: REVEAL_MS, type: 'square', volume: 0.5 });
}

/** 旗の設置（on = true）／除去（on = false）：音程の違う短音 */
export function playFlag(on) {
  if (!ready()) return;
  tone({ freq: on ? FLAG_ON_FREQ : FLAG_OFF_FREQ, ms: FLAG_MS, type: 'triangle', volume: 0.9 });
}

/** 勝利：上昇する 3 音 */
export function playWin() {
  if (!ready()) return;
  WIN_NOTES.forEach((freq, i) => {
    tone({ freq, ms: WIN_NOTE_MS, delayMs: i * WIN_NOTE_GAP_MS, type: 'triangle', volume: 0.9 });
  });
}

/** 敗北：下降する低音 */
export function playLose() {
  if (!ready()) return;
  tone({ freq: LOSE_FREQ_FROM, freqTo: LOSE_FREQ_TO, ms: LOSE_MS, type: 'sawtooth', volume: 0.7 });
}
