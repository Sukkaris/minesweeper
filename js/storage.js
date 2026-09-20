// 永続化層。localStorage への保存・読み込みと、保存データのスキーマバージョン管理を担当する。
// DOM には触れない。キーはすべて "ms-" の接頭辞を付ける。
//
// 方針:
//   - ゲーム状態: バージョン不一致なら破棄して新規ゲームとして起動する（移行処理は書かない）
//   - 統計・設定: 失われると惜しいので破棄しない。読める項目だけ引き継ぎ、不明な項目は既定値で埋める
//     （その判定は各モジュールが mergeDefaults() で行う）

/** 保存データのスキーマバージョン。形式を変えたらここを上げる */
export const SCHEMA_VERSION = Object.freeze({
  game: 1,
  stats: 1,
  settings: 1,
});

const KEY_GAME = 'ms-game';
const KEY_STATS = 'ms-stats';
const KEY_SETTINGS = 'ms-settings';

// 第2段階で使っていた個別キー。初回だけ読み取って ms-settings に引き継ぎ、その後は削除する
const LEGACY_KEY_DIFFICULTY = 'ms-difficulty';
const LEGACY_KEY_LONG_PRESS = 'ms-long-press-ms';

// ---------- 低レベルの読み書き（localStorage が使えない環境では黙って無視する） ----------

function readJson(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value : null;
  } catch (_) {
    return null;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (_) { /* 容量超過や無効化時は無視 */ }
}

function removeKey(key) {
  try {
    localStorage.removeItem(key);
  } catch (_) { /* 無視 */ }
}

// ---------- ゲーム状態 ----------

/** 未完了ゲームの保存データ。バージョン不一致・破損なら削除して null を返す */
export function loadGameData() {
  const data = readJson(KEY_GAME);
  if (!data || data.schemaVersion !== SCHEMA_VERSION.game) {
    removeKey(KEY_GAME);
    return null;
  }
  return data;
}

export function saveGameData(data) {
  writeJson(KEY_GAME, { schemaVersion: SCHEMA_VERSION.game, ...data });
}

export function clearGameData() {
  removeKey(KEY_GAME);
}

// ---------- 統計 ----------

/** 統計の保存データをそのまま返す（バージョンに関わらず。読める項目の選別は呼び出し側） */
export function loadStatsRaw() {
  return readJson(KEY_STATS);
}

export function saveStatsData(data) {
  writeJson(KEY_STATS, { schemaVersion: SCHEMA_VERSION.stats, ...data });
}

// ---------- 設定 ----------

/** 設定の保存データをそのまま返す。無ければ第2段階の個別キーから組み立てる */
export function loadSettingsRaw() {
  const data = readJson(KEY_SETTINGS);
  if (data) return data;
  return loadLegacySettings();
}

export function saveSettingsData(data) {
  writeJson(KEY_SETTINGS, { schemaVersion: SCHEMA_VERSION.settings, ...data });
  removeKey(LEGACY_KEY_DIFFICULTY);
  removeKey(LEGACY_KEY_LONG_PRESS);
}

function loadLegacySettings() {
  const legacy = {};
  try {
    const difficulty = localStorage.getItem(LEGACY_KEY_DIFFICULTY);
    if (difficulty) legacy.difficulty = difficulty;
    const longPress = Number(localStorage.getItem(LEGACY_KEY_LONG_PRESS));
    if (Number.isFinite(longPress) && longPress > 0) legacy.longPressMs = longPress;
  } catch (_) { /* 無視 */ }
  return Object.keys(legacy).length > 0 ? legacy : null;
}

// ---------- 共通ユーティリティ ----------

/**
 * 既定値の各項目について、保存データの値が検証を通ればそれを、通らなければ既定値を採用する。
 * 保存データ側にしかない項目（古い形式の名残など）は捨てる。
 * @param {object} defaults   既定値。ここにある項目だけが結果に含まれる
 * @param {object|null} raw   保存データ
 * @param {object} validators 項目名 → (値) => boolean
 */
export function mergeDefaults(defaults, raw, validators) {
  const result = {};
  for (const key of Object.keys(defaults)) {
    const value = raw ? raw[key] : undefined;
    const ok = value !== undefined && validators[key] ? validators[key](value) : false;
    result[key] = ok ? value : defaults[key];
  }
  return result;
}
