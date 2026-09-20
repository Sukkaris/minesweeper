// 無推測判定ソルバー。地雷配置と初手の位置から「論理だけで最後まで解けるか」を判定する。
// DOM には一切触れない（ui.js からも Node のテストスクリプトからも同じように使える）。
//
// 推論は次の 3 種類だけを、新しい確定が出なくなるまで繰り返す:
//   1. 単純推論   : 数字マス 1 つの周囲だけを見る
//   2. 部分集合   : 近くの数字マス 2 つの未確定集合が包含関係にあるとき、差集合の地雷数を確定する
//   3. 大域推論   : 盤面全体の残り地雷数と未確定マス数の一致
// 連結成分ごとの全探索は行わない（実用上はこれで十分な品質が得られる）。

/**
 * 無推測モードの調整用定数。実測に基づいて変える。
 * 2026-09 の計測（Node、3000 試行、初手はランダム）:
 *   初級 9×9/10   : 成功率 82%  1 試行 0.11ms
 *   中級 16×16/40 : 成功率 54%  1 試行 0.11ms
 *   上級 16×30/99 : 成功率  5%  1 試行 0.22ms → 上限 1000 回で失敗確率 ≈ 0%、最悪でも約 0.2 秒
 *   16×16 密度 24% : 0.8%  /  25% : 0.13%  /  28% : 0%
 *   16×30 密度 22% : 1.6%  /  24% : 0.17% /  25% : 0%
 * 大きな盤面では 25% ちょうどでも生成できないため、閾値は「24% 超」にした。
 *
 *   attemptLimits            : 難易度ごとの試行上限。超えたら通常の盤面にフォールバックする
 *   highDensityThreshold     : 地雷密度がこれを超えるカスタム盤面は「高密度」扱い（既定で無推測オフ）
 *   highDensityAttemptLimit  : 高密度で明示的にオンにされた場合の試行上限（待ち時間を 1 秒未満に抑える）
 *   timeSliceMs              : UI を固めないよう、この時間ごとに処理を一旦手放す
 */
export const NO_GUESS = Object.freeze({
  attemptLimits: Object.freeze({ beginner: 200, intermediate: 500, expert: 1000, custom: 2000 }),
  highDensityThreshold: 0.24,
  highDensityAttemptLimit: 100,
  timeSliceMs: 12,
});

/** 開発用: 推論が矛盾した回数（0 のままであるべき。テストスクリプトが確認する） */
export const solverDebug = { broken: 0 };

/** 地雷密度（地雷数 ÷ 総マス数） */
export function densityOf({ cols, rows, mines }) {
  return mines / (cols * rows);
}

/** 高密度（無推測モードの既定をオフにする密度）か */
export function isHighDensity(config) {
  return densityOf(config) > NO_GUESS.highDensityThreshold;
}

/** 難易度キーと盤面設定から試行上限を決める */
export function attemptLimitFor(difficultyKey, config) {
  if (isHighDensity(config)) return NO_GUESS.highDensityAttemptLimit;
  const limits = NO_GUESS.attemptLimits;
  return Object.prototype.hasOwnProperty.call(limits, difficultyKey) ? limits[difficultyKey] : limits.custom;
}

// ---------- 隣接表（盤面サイズごとにキャッシュ） ----------

const NEIGHBOR_OFFSETS = [
  [-1, -1], [0, -1], [1, -1],
  [-1,  0],          [1,  0],
  [-1,  1], [0,  1], [1,  1],
];

const neighborTables = new Map();

/** 添字 → 周囲 8 マス（盤面内のもの）の添字配列。同じサイズなら使い回す */
function neighborTable(cols, rows) {
  const key = cols + 'x' + rows;
  let table = neighborTables.get(key);
  if (table) return table;

  table = new Array(cols * rows);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const list = [];
      for (const [dc, dr] of NEIGHBOR_OFFSETS) {
        const c = col + dc;
        const r = row + dr;
        if (c >= 0 && c < cols && r >= 0 && r < rows) list.push(r * cols + c);
      }
      table[row * cols + col] = list;
    }
  }
  neighborTables.set(key, table);
  return table;
}

// ---------- 判定本体 ----------

// マスの状態
const UNKNOWN = 0;   // 未確定
const OPEN = 1;      // 開放済み（安全と確定）
const MINE = 2;      // 地雷と確定

/**
 * 与えられた地雷配置が、初手 firstIndex から論理だけで最後まで解けるかを判定する。
 * 初手は周囲 8 マスが安全保証されている前提なので、必ず空白マスとなり連鎖開放が起きる。
 * その連鎖まで開いた状態を初期状態として推論を始める。
 *
 * @param {number} cols
 * @param {number} rows
 * @param {Uint8Array} mine   1 = 地雷
 * @param {number} firstIndex 初手のマス
 * @returns {boolean}
 */
export function isSolvable(cols, rows, mine, firstIndex) {
  const total = cols * rows;
  const nb = neighborTable(cols, rows);

  // 周囲の地雷数と総地雷数
  const adjacent = new Uint8Array(total);
  let minesLeft = 0;
  for (let i = 0; i < total; i++) {
    if (mine[i]) { minesLeft++; continue; }
    const ns = nb[i];
    let count = 0;
    for (let k = 0; k < ns.length; k++) count += mine[ns[k]];
    adjacent[i] = count;
  }

  const status = new Uint8Array(total);
  let unknownCount = total;
  let broken = false;   // 推論が矛盾した（= このファイルのバグ）ときに立てる。テストで検出する

  const queue = [];
  /** マスを安全と確定して開く。空白マスなら連鎖開放する */
  const open = (start) => {
    if (status[start] !== UNKNOWN) return;
    if (mine[start]) { broken = true; return; }
    status[start] = OPEN;
    unknownCount--;
    if (adjacent[start] !== 0) return;
    queue.length = 0;
    queue.push(start);
    let head = 0;
    while (head < queue.length) {
      const ns = nb[queue[head++]];
      for (let k = 0; k < ns.length; k++) {
        const n = ns[k];
        if (status[n] !== UNKNOWN) continue;
        status[n] = OPEN;
        unknownCount--;
        if (adjacent[n] === 0) queue.push(n);
      }
    }
  };

  /** マスを地雷と確定する */
  const markMine = (i) => {
    if (status[i] !== UNKNOWN) return;
    if (!mine[i]) { broken = true; return; }
    status[i] = MINE;
    unknownCount--;
    minesLeft--;
  };

  open(firstIndex);

  const unknowns = [];
  let progress = true;
  while (progress && unknownCount > 0 && !broken) {
    progress = false;

    // 1. 単純推論：数字マスごとに「残り地雷数 = 未確定数 → 全部地雷」「残り地雷数 = 0 → 全部安全」
    for (let i = 0; i < total; i++) {
      if (status[i] !== OPEN || adjacent[i] === 0) continue;
      const ns = nb[i];
      let need = adjacent[i];
      unknowns.length = 0;
      for (let k = 0; k < ns.length; k++) {
        const s = status[ns[k]];
        if (s === UNKNOWN) unknowns.push(ns[k]);
        else if (s === MINE) need--;
      }
      if (unknowns.length === 0) continue;
      if (need === 0) {
        for (let k = 0; k < unknowns.length; k++) open(unknowns[k]);
        progress = true;
      } else if (need === unknowns.length) {
        for (let k = 0; k < unknowns.length; k++) markMine(unknowns[k]);
        progress = true;
      }
    }
    if (progress) continue;   // 安い推論で進んだうちは高い推論に進まない

    // 2. 部分集合による推論
    if (applySubsetRule(cols, rows, total, nb, status, adjacent, open, markMine)) {
      progress = true;
      continue;
    }

    // 3. 大域推論：残り地雷が 0 なら未確定は全部安全、残り地雷 = 未確定数なら全部地雷
    if (minesLeft === 0) {
      for (let i = 0; i < total; i++) if (status[i] === UNKNOWN) open(i);
      progress = true;
    } else if (minesLeft === unknownCount) {
      for (let i = 0; i < total; i++) if (status[i] === UNKNOWN) markMine(i);
      progress = true;
    }
  }

  if (broken) solverDebug.broken++;
  return !broken && unknownCount === 0;
}

/**
 * 部分集合ルール。数字マス A, B（互いに 5×5 の範囲内）について、
 * A の未確定集合が B の未確定集合の真部分集合なら、差集合 (B − A) の地雷数は need(B) − need(A) に確定する。
 * それが 0 なら差集合はすべて安全、差集合の要素数と等しければすべて地雷。
 *
 * 途中で open / markMine しても各制約は「その時点で真だった事実」のままなので、
 * 同じパスの中で古い制約を使い続けても推論は誤らない（確定済みのマスへの操作は空振りするだけ）。
 * @returns {boolean} 何か確定したか
 */
function applySubsetRule(cols, rows, total, nb, status, adjacent, open, markMine) {
  // 制約 = 未確定の隣接マスを持つ数字マス。マス添字 → 制約番号の表も作る
  const cCell = [];
  const cUnknowns = [];
  const cNeed = [];
  const constraintAt = new Int32Array(total).fill(-1);
  for (let i = 0; i < total; i++) {
    if (status[i] !== OPEN || adjacent[i] === 0) continue;
    const ns = nb[i];
    let need = adjacent[i];
    const list = [];
    for (let k = 0; k < ns.length; k++) {
      const s = status[ns[k]];
      if (s === UNKNOWN) list.push(ns[k]);
      else if (s === MINE) need--;
    }
    if (list.length === 0) continue;
    constraintAt[i] = cCell.length;
    cCell.push(i);
    cUnknowns.push(list);
    cNeed.push(need);
  }

  const inA = new Uint8Array(total);   // A の未確定集合の印
  const diff = [];
  let progress = false;

  for (let a = 0; a < cCell.length; a++) {
    const setA = cUnknowns[a];
    for (let k = 0; k < setA.length; k++) inA[setA[k]] = 1;

    // 5×5 の範囲にある制約 B を調べる（それより遠いと未確定集合が重ならない）
    const col = cCell[a] % cols;
    const row = (cCell[a] - col) / cols;
    const r0 = Math.max(0, row - 2), r1 = Math.min(rows - 1, row + 2);
    const c0 = Math.max(0, col - 2), c1 = Math.min(cols - 1, col + 2);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const b = constraintAt[r * cols + c];
        if (b < 0 || b === a) continue;
        const setB = cUnknowns[b];
        if (setB.length <= setA.length) continue;   // 真部分集合になり得ない

        // A ⊂ B か：B のうち A に含まれるものの数が |A| と一致すればよい
        diff.length = 0;
        let shared = 0;
        for (let k = 0; k < setB.length; k++) {
          if (inA[setB[k]]) shared++;
          else diff.push(setB[k]);
        }
        if (shared !== setA.length) continue;

        const diffNeed = cNeed[b] - cNeed[a];
        if (diffNeed === 0) {
          for (let k = 0; k < diff.length; k++) open(diff[k]);
          progress = true;
        } else if (diffNeed === diff.length) {
          for (let k = 0; k < diff.length; k++) markMine(diff[k]);
          progress = true;
        }
      }
    }

    for (let k = 0; k < setA.length; k++) inA[setA[k]] = 0;
  }

  return progress;
}

// ---------- 生成ループ（時間分割つき） ----------

/**
 * 無推測で解ける地雷配置を探す。makeLayout() で配置を作っては isSolvable で判定し、
 * 解けるものが出るか試行上限に達するまで繰り返す。
 * UI スレッドを固めないよう、timeSliceMs ごとに setTimeout で処理を手放す。
 * onDone は必ず非同期（この関数から戻った後）に 1 回だけ呼ばれる。
 *
 * @param {object} options
 * @param {number} options.cols
 * @param {number} options.rows
 * @param {number} options.firstIndex
 * @param {() => Uint8Array} options.makeLayout   初手周りを避けたランダム配置を返す
 * @param {number} options.maxAttempts
 * @param {(result: {success:boolean, layout:Uint8Array, attempts:number, elapsedMs:number}) => void} options.onDone
 *   success が false のとき layout は最後に試した配置（初手保証のみ）。フォールバック用にそのまま使える
 * @returns {{cancel: () => void}}
 */
export function findNoGuessLayout({ cols, rows, firstIndex, makeLayout, maxAttempts, onDone }) {
  let cancelled = false;
  let attempts = 0;
  let lastLayout = null;
  const startedAt = performance.now();

  const finish = (success) => {
    onDone({ success, layout: lastLayout, attempts, elapsedMs: performance.now() - startedAt });
  };

  const step = () => {
    if (cancelled) return;
    const sliceStart = performance.now();
    while (attempts < maxAttempts) {
      lastLayout = makeLayout();
      attempts++;
      if (isSolvable(cols, rows, lastLayout, firstIndex)) {
        finish(true);
        return;
      }
      if (performance.now() - sliceStart >= NO_GUESS.timeSliceMs) {
        setTimeout(step, 0);
        return;
      }
    }
    // 上限に達した：最後の配置をフォールバックとして返す（無ければ 1 つ作る）
    if (!lastLayout) lastLayout = makeLayout();
    finish(false);
  };

  setTimeout(step, 0);
  return { cancel() { cancelled = true; } };
}
