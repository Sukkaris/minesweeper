// ゲームロジック。盤面データ・地雷配置・開放処理・勝敗判定を担当する。
// このファイルは DOM を一切参照しない（UI から独立してテストできる状態を保つ）。

/** 難易度定義。「列 × 行 / 地雷数」。上級はクラシックの 30×16 を意図的に転置している。 */
export const DIFFICULTIES = Object.freeze({
  beginner:     { key: 'beginner',     label: '初級', cols: 9,  rows: 9,  mines: 10 },
  intermediate: { key: 'intermediate', label: '中級', cols: 16, rows: 16, mines: 40 },
  expert:       { key: 'expert',       label: '上級', cols: 16, rows: 30, mines: 99 },
});

export const DEFAULT_DIFFICULTY = 'beginner';

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

    // タイマー。表示側で 999 に頭打ちするが、内部では正確な時刻を保持する
    this.startTime = null;
    this.endTime = null;
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

  /** 経過ミリ秒。未開始なら 0。終了後は終了時点で固定 */
  get elapsedMs() {
    if (this.startTime === null) return 0;
    const end = this.endTime ?? Date.now();
    return end - this.startTime;
  }

  /** 経過秒数（切り捨て）。頭打ちしない正確な値 */
  get elapsedSeconds() {
    return Math.floor(this.elapsedMs / 1000);
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

    // 周囲の地雷数を数える
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
      this.startTime = Date.now();
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
    this.state = state;
    this.endTime = Date.now();

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
}
