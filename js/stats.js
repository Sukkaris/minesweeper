// 統計。難易度ごと（初級・中級・上級）のベストタイム・プレイ回数・勝利数・平均タイムを管理する。
// DOM には触れない。表示は stats-screen.js が担当する。
//
// 仕様上の決めごと:
//   - プレイ回数は「最初のタップで地雷が配置された時点」で加算する
//   - 中断（スマイリー・難易度変更）は敗北扱い。プレイ回数は加算済みなので、勝利数を増やさないだけ
//   - 平均タイムは勝利したゲームのみ。タイムは ms で保持し、999 秒を超えても頭打ちしない
//   - カスタム難易度は一切記録しない

import { DIFFICULTIES } from './game.js';
import { loadStatsRaw, saveStatsData, mergeDefaults } from './storage.js';

const LED_MAX_SECONDS = 999;   // これを超えるタイムは「分:秒」表記に切り替える

/** 1 難易度分の空データ */
function emptyEntry() {
  return { plays: 0, wins: 0, bestMs: null, totalWinMs: 0 };
}

const isCount = (v) => Number.isInteger(v) && v >= 0;
const ENTRY_VALIDATORS = {
  plays: isCount,
  wins: isCount,
  bestMs: (v) => v === null || isCount(v),
  totalWinMs: isCount,
};

/** 保存データから統計を組み立てる。項目ごとに検証し、読めないものは既定値で埋める */
function load() {
  const raw = loadStatsRaw();
  const result = {};
  for (const key of Object.keys(DIFFICULTIES)) {
    const entryRaw = raw && raw[key] && typeof raw[key] === 'object' ? raw[key] : null;
    result[key] = mergeDefaults(emptyEntry(), entryRaw, ENTRY_VALIDATORS);
  }
  return result;
}

let stats = load();

function save() {
  saveStatsData(stats);
}

save();   // 起動時に一度保存し、古い形式からの引き継ぎ結果を現行形式で確定させる

// ---------- 記録 ----------

/** 統計の対象となる難易度か（初級・中級・上級のみ） */
export function isTracked(key) {
  return Object.prototype.hasOwnProperty.call(DIFFICULTIES, key);
}

/** 地雷が配置された（ゲームが実際に始まった）ときに呼ぶ */
export function recordPlayStart(key) {
  if (!isTracked(key)) return;
  stats[key].plays++;
  save();
}

/** 勝利したときに呼ぶ。elapsedMs は正確な経過ミリ秒 */
export function recordWin(key, elapsedMs) {
  if (!isTracked(key)) return;
  const entry = stats[key];
  const ms = Math.max(0, Math.round(elapsedMs));
  entry.wins++;
  entry.totalWinMs += ms;
  if (entry.bestMs === null || ms < entry.bestMs) entry.bestMs = ms;
  save();
}

export function resetStats() {
  for (const key of Object.keys(stats)) stats[key] = emptyEntry();
  save();
}

/** 表示用の読み取り専用コピー */
export function getStats() {
  const copy = {};
  for (const key of Object.keys(stats)) copy[key] = { ...stats[key] };
  return copy;
}

// ---------- 表示用の整形 ----------

/**
 * タイムの表示。999 秒までは「123 秒」、それを超えたら「20:35」の分秒表記。
 * null（記録なし）は「—」
 */
export function formatStatTime(ms) {
  if (ms === null || ms === undefined) return '—';
  const seconds = Math.floor(ms / 1000);
  if (seconds <= LED_MAX_SECONDS) return seconds + ' 秒';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m + ':' + String(s).padStart(2, '0');
}

/** 勝率（小数第 1 位まで）。プレイ回数 0 なら「—」 */
export function formatWinRate(entry) {
  if (entry.plays === 0) return '—';
  return ((entry.wins / entry.plays) * 100).toFixed(1) + '%';
}

/** 平均タイム（勝利したゲームのみ）。勝利 0 なら「—」 */
export function formatAverageTime(entry) {
  if (entry.wins === 0) return '—';
  return formatStatTime(entry.totalWinMs / entry.wins);
}
