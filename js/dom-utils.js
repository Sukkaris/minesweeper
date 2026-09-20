// DOM まわりの小道具。ui.js と settings.js の両方から使う。

const LONG_SINK_MS = 280;   // 長押し成立アニメーションのクラスを付けておく時間（CSS の --long-sink-duration より少し長め）

/** SVG シンボルを参照する <svg><use> を生成する */
export function createIcon(symbolId, className) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon ' + className);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#' + symbolId);
  svg.appendChild(use);
  return svg;
}

/** 長押し成立の合図（マスを一瞬沈めて戻す）。常時有効で、設定ではオフにしない */
export function sinkCell(cell) {
  cell.classList.remove('long-sink');
  void cell.offsetWidth;   // クラスを付け直してもアニメーションが再生されるようにする
  cell.classList.add('long-sink');
  setTimeout(() => cell.classList.remove('long-sink'), LONG_SINK_MS);
}
