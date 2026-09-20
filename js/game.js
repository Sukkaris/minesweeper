// ゲームロジック。盤面データ・地雷配置・開放処理・勝敗判定を担当する。
// このファイルは DOM を一切参照しない（UI から独立してテストできる状態を保つ）。

/** 難易度定義。「列 × 行 / 地雷数」。上級はクラシックの 30×16 を意図的に転置している。 */
export const DIFFICULTIES = Object.freeze({
  beginner:     { key: 'beginner',     label: '初級', cols: 9,  rows: 9,  mines: 10 },
  intermediate: { key: 'intermediate', label: '中級', cols: 16, rows: 16, mines: 40 },
  expert:       { key: 'expert',       label: '上級', cols: 16, rows: 30, mines: 99 },
});

export const DEFAULT_DIFFICULTY = 'beginner';

/** カスタム難易度のキー。統計には記録しない */
export const CUSTOM_KEY = 'custom';
export const CUSTOM_LABEL = 'カスタム';

/**
 * カスタム難易度の入力範囲。
 * 列数の上限 16 は「横スクロールを実装しない」方針に由来する。これを超える値を許可してはならない。
 */
export const CUSTOM_LIMITS = Object.freeze({
  minCols: 3, maxCols: 16,
  minRows: 3, maxRows: 30,
  minMines: 1,
  maxMineRatio: 0.35,   // 地雷数の上限 = 総マス数 × この値（切り捨て）
});

export const DEFAULT_CUSTOM = Object.freeze({ cols: 9, rows: 9, mines: 10 });

function clampInt(value, min, max, fallback) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 列数・行数から地雷数の上限を求める */
export function maxMinesFor(cols, rows) {
  return Math.max(CUSTOM_LIMITS.minMines, Math.floor(cols * rows * CUSTOM_LIMITS.maxMineRatio));
}

/** カスタム難易度の入力を黙って範囲内へ丸める（エラーは出さない） */
export function clampCustomConfig(input) {
  const src = input && typeof input === 'object' ? input : {};
  const cols = clampInt(src.cols, CUSTOM_LIMITS.minCols, CUSTOM_LIMITS.maxCols, DEFAULT_CUSTOM.cols);
  const rows = clampInt(src.rows, CUSTOM_LIMITS.minRows, CUSTOM_LIMITS.maxRows, DEFAULT_CUSTOM.rows);
  const mines = clampInt(src.mines, CUSTOM_LIMITS.minMines, maxMinesFor(cols, rows), DEFAULT_CUSTOM.mines);
  return { cols, rows, mines };
}

/** ゲームの進行状態 */
export const GameState = Object.freeze({
  READY:   'ready',    // 盤面は用意されているが、まだ地雷は置かれていない
  PLAYING: 'playing',  // 初手が打たれ、地雷が配置された
  WON:     'won',
  LOST:    'lost',
});

/** 隣接 8 方向のオフセット */
const NEIGHBOR_OFFSETS = [
  [-1, -1], [0, -1], [1, -1],
  [-1,  0],          [1,  0],
  [-1,  1], [0,  1], [1,  1],
];

export class Game {
  /**
   * @param {{cols:number, rows:number, mines:number}} config
   */
  constructor(config) {
    this.cols = config.cols;
    this.rows = config.rows;
    this.totalMines = config.mines;
    this.totalCells = this.cols * this.rows;

    // マスごとの状態（添字 = row * cols + col）
    this.mine = new Uint8Array(this.totalCells);      // 1 = 地雷
    this.adjacent = new Uint8Array(this.totalCells);  // 周囲の地雷数
    this.revealed = new Uint8Array(this.totalCells);  // 1 = 開放済み
    this.flagged = new Uint8Array(this.totalCells);   // 1 = 旗あり

    this.state = GameState.READY;
    this.revealedCount = 0;
    this.flagCount = 0;
    this.explodedIndex = -1;   // 敗北時に踏んだ地雷の添字

    // タイマー。表示側で 999 に頭打ちするが、内部では正確な値を保持する。
    // 「計測済みの累積 ms」＋「今の計測区間の開始時刻」の 2 つで持ち、
    // 背面に回った時間や設定画面を開いていた時間を経過時間に含めないようにする
    this.elapsedBase = 0;
    this.runningSince = null;
  }

  // ---------- 座標ユーティリティ ----------

  toIndex(col, row) {
    return row * this.cols + col;
  }

  toCoord(index) {
    return { col: index % this.cols, row: Math.floor(index / this.cols) };
  }

  /** 周囲 8 マス（盤面内のもの）の添字を返す */
  neighbors(index) {
    const { col, row } = this.toCoord(index);
    const result = [];
    for (const [dc, dr] of NEIGHBOR_OFFSETS) {
      const c = col + dc;
      const r = row + dr;
      if (c >= 0 && c < this.cols && r >= 0 && r < this.rows) {
        result.push(this.toIndex(c, r));
      }
    }
    return result;
  }

  // ---------- 状態の参照 ----------

  get isOver() {
    return this.state === GameState.WON || this.state === GameState.LOST;
  }

  /** 残り地雷数 = 総地雷数 − 旗の数。マイナスも許容する */
  get remainingMines() {
    return this.totalMines - this.flagCount;
  }

  /** 経過ミリ秒。未開始なら 0。一時停止中・終了後は止まった値のまま */
  get elapsedMs() {
    const running = this.runningSince !== null ? Date.now() - this.runningSince : 0;
    return this.elapsedBase + running;
  }

  /** 経過秒数（切り捨て）。頭打ちしない正確な値 */
  get elapsedSeconds() {
    return Math.floor(this.elapsedMs / 1000);
  }

  /** タイマーが進んでいるか */
  get isRunning() {
    return this.runningSince !== null;
  }

  // ---------- タイマーの一時停止 / 再開 ----------

  /** 計測を止める。二重に呼んでも安全 */
  pause() {
    if (this.runningSince === null) return;
    this.elapsedBase += Date.now() - this.runningSince;
    this.runningSince = null;
  }

  /** 計測を再開する。プレイ中でなければ何もしない */
  resume() {
    if (this.state !== GameState.PLAYING || this.runningSince !== null) return;
    this.runningSince = Date.now();
  }

  // ---------- 地雷配置 ----------

  /**
   * 最初のタップを受けてから地雷を配置する。
   * 最初にタップしたマスとその周囲 8 マスには地雷を置かない。
   * 地雷が多すぎて満たせない場合は、安全マスを段階的に減らす。
   */
  placeMines(firstIndex) {
    let safe = new Set([firstIndex, ...this.neighbors(firstIndex)]);

    // 安全マスを除いた候補が足りなければ、最初のマスだけを安全にする
    if (this.totalCells - safe.size < this.totalMines) {
      safe = new Set([firstIndex]);
    }
    // それでも足りなければ地雷数の方を丸める（通常の難易度では起こらない）
    if (this.totalCells - safe.size < this.totalMines) {
      this.totalMines = this.totalCells - safe.size;
    }

    const candidates = [];
    for (let i = 0; i < this.totalCells; i++) {
      if (!safe.has(i)) candidates.push(i);
    }

    // Fisher–Yates の部分シャッフルで先頭 totalMines 個を選ぶ
    for (let i = 0; i < this.totalMines; i++) {
      const j = i + Math.floor(Math.random() * (candidates.length - i));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
      this.mine[candidates[i]] = 1;
    }

    this.computeAdjacent();
  }

  /** 各マスの周囲の地雷数を数え直す（配置時と復元時に使う） */
  computeAdjacent() {
    for (let i = 0; i < this.totalCells; i++) {
      if (this.mine[i]) continue;
      let count = 0;
      for (const n of this.neighbors(i)) count += this.mine[n];
      this.adjacent[i] = count;
    }
  }

  // ---------- 操作 ----------

  /**
   * マスを開放する。
   * @returns {{changed:number[]}} 表示を更新すべきマスの添字
   */
  reveal(index) {
    if (this.isOver) return { changed: [] };
    if (this.revealed[index] || this.flagged[index]) return { changed: [] };

    if (this.state === GameState.READY) {
      this.placeMines(index);
      this.state = GameState.PLAYING;
      this.resume();
    }

    // 地雷を踏んだ → 敗北
    if (this.mine[index]) {
      this.explodedIndex = index;
      this.revealed[index] = 1;
      this.finish(GameState.LOST);
      return { changed: this.allIndices() };
    }

    // キューを使った反復的な flood fill（上級で深い再帰を避けるため）
    const changed = [];
    const queue = [index];
    this.revealed[index] = 1;
    let head = 0;
    while (head < queue.length) {
      const i = queue[head++];
      changed.push(i);
      this.revealedCount++;
      if (this.adjacent[i] !== 0) continue;   // 数字マスはそこで止まる
      for (const n of this.neighbors(i)) {
        if (this.revealed[n] || this.flagged[n] || this.mine[n]) continue;
        this.revealed[n] = 1;
        queue.push(n);
      }
    }

    // 地雷以外のすべてのマスが開放されたら勝利（旗の数は条件に含めない）
    if (this.revealedCount === this.totalCells - this.totalMines) {
      this.finish(GameState.WON);
      return { changed: this.allIndices() };
    }

    return { changed };
  }

  /** 周囲 8 マスに立っている旗の数 */
  countAdjacentFlags(index) {
    let count = 0;
    for (const n of this.neighbors(index)) count += this.flagged[n];
    return count;
  }

  /**
   * チョーディング。開放済みの数字マスに対して、周囲の旗の数が数字と一致するとき、
   * 周囲の未開放マス（旗のないもの）を一斉に開放する。
   * 旗の位置が誤っていれば地雷を踏んで敗北する（仕様通り。警告は出さない）。
   * @returns {{changed:number[]}} 表示を更新すべきマスの添字
   */
  chord(index) {
    if (this.isOver) return { changed: [] };
    if (!this.revealed[index] || this.adjacent[index] === 0) return { changed: [] };
    if (this.countAdjacentFlags(index) !== this.adjacent[index]) return { changed: [] };

    const changed = [];
    for (const n of this.neighbors(index)) {
      if (this.revealed[n] || this.flagged[n]) continue;
      const result = this.reveal(n);
      changed.push(...result.changed);
      // 地雷を踏んだ / 勝利した時点で全マスが返ってくるので、それ以上は不要
      if (this.isOver) return { changed: this.allIndices() };
    }
    return { changed };
  }

  /**
   * 旗を立てる / 外す。旗の数に上限はない。
   * @returns {boolean} 状態が変わったか
   */
  toggleFlag(index) {
    if (this.isOver) return false;
    if (this.revealed[index]) return false;

    if (this.flagged[index]) {
      this.flagged[index] = 0;
      this.flagCount--;
    } else {
      this.flagged[index] = 1;
      this.flagCount++;
    }
    return true;
  }

  // ---------- 終了処理 ----------

  finish(state) {
    this.pause();          // 終了時点でタイマーを止める（以後 elapsedMs は固定）
    this.state = state;

    if (state === GameState.WON) {
      // 未開放のマス（＝すべて地雷）に自動で旗を立てる
      for (let i = 0; i < this.totalCells; i++) {
        if (!this.revealed[i] && !this.flagged[i]) {
          this.flagged[i] = 1;
          this.flagCount++;
        }
      }
    }
  }

  allIndices() {
    const list = new Array(this.totalCells);
    for (let i = 0; i < this.totalCells; i++) list[i] = i;
    return list;
  }

  // ---------- 表示用の情報 ----------

  /**
   * 1 マスの表示状態をまとめて返す。UI はこれだけを見て描画する。
   * kind: 'hidden' | 'flag' | 'number' | 'blank' | 'mine' | 'exploded' | 'wrong-flag'
   */
  cellView(index) {
    const lost = this.state === GameState.LOST;

    if (this.revealed[index]) {
      if (this.mine[index]) return { kind: 'exploded', number: 0 };
      return { kind: this.adjacent[index] > 0 ? 'number' : 'blank', number: this.adjacent[index] };
    }

    if (this.flagged[index]) {
      // 敗北時、地雷でないマスの旗には × を重ねる
      if (lost && !this.mine[index]) return { kind: 'wrong-flag', number: 0 };
      return { kind: 'flag', number: 0 };
    }

    // 敗北時は他のすべての地雷を開示する
    if (lost && this.mine[index]) return { kind: 'mine', number: 0 };

    return { kind: 'hidden', number: 0 };
  }

  // ---------- 保存 / 復元 ----------

  /**
   * 保存用のプレーンなオブジェクトに変換する。
   * マスごとの配列は "0101..." の文字列にして小さくまとめる。
   * 経過時間は「止めた状態」の値を入れる（復元後に改めて resume する）
   */
  serialize() {
    return {
      cols: this.cols,
      rows: this.rows,
      mines: this.totalMines,
      state: this.state,
      mine: bitsToString(this.mine),
      revealed: bitsToString(this.revealed),
      flagged: bitsToString(this.flagged),
      explodedIndex: this.explodedIndex,
      elapsedMs: this.elapsedMs,
    };
  }

  /**
   * serialize() の結果からゲームを復元する。形が崩れていれば null を返す。
   * 復元直後のタイマーは止まっているので、UI 側で resume() すること
   */
  static deserialize(data) {
    if (!data || typeof data !== 'object') return null;
    const { cols, rows, mines, state } = data;
    // 列数の上限は横スクロールを実装しない方針に由来する（保存データが壊れていても超えさせない）
    if (!Number.isInteger(cols) || cols < 1 || cols > CUSTOM_LIMITS.maxCols) return null;
    if (!Number.isInteger(rows) || rows < 1 || rows > CUSTOM_LIMITS.maxRows) return null;
    if (!Number.isInteger(mines) || mines < 0) return null;
    if (!Object.values(GameState).includes(state)) return null;

    const total = cols * rows;
    const mine = stringToBits(data.mine, total);
    const revealed = stringToBits(data.revealed, total);
    const flagged = stringToBits(data.flagged, total);
    if (!mine || !revealed || !flagged) return null;
    // 地雷数は勝利判定に使うので、実際に置かれている数と一致していなければ信用しない
    let placed = 0;
    for (let i = 0; i < total; i++) placed += mine[i];
    if (placed !== mines) return null;

    const game = new Game({ cols, rows, mines });
    game.mine = mine;
    game.revealed = revealed;
    game.flagged = flagged;
    game.state = state;
    game.computeAdjacent();
    for (let i = 0; i < total; i++) {
      game.revealedCount += revealed[i];
      game.flagCount += flagged[i];
    }
    game.explodedIndex = Number.isInteger(data.explodedIndex) ? data.explodedIndex : -1;
    game.elapsedBase = Number.isFinite(data.elapsedMs) && data.elapsedMs >= 0 ? data.elapsedMs : 0;
    return game;
  }
}

/** Uint8Array(0/1) → "0101..." */
function bitsToString(bits) {
  let s = '';
  for (let i = 0; i < bits.length; i++) s += bits[i] ? '1' : '0';
  return s;
}

/** "0101..." → Uint8Array。長さが合わない・0/1 以外を含む場合は null */
function stringToBits(str, length) {
  if (typeof str !== 'string' || str.length !== length) return null;
  const bits = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    const ch = str[i];
    if (ch !== '0' && ch !== '1') return null;
    bits[i] = ch === '1' ? 1 : 0;
  }
  return bits;
}
