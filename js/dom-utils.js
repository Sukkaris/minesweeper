// DOM まわりの小道具。ui.js と settings.js の両方から使う。

const LONG_FLASH_MS = 280;   // 長押し成立フラッシュのクラスを付けておく時間（CSS の --long-flash-duration より少し長め）

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

/** 長押し成立の合図（マスの周縁を一瞬光らせる）。常時有効で、設定ではオフにしない */
export function flashCell(cell) {
  cell.classList.remove('long-flash');
  void cell.offsetWidth;   // クラスを付け直してもアニメーションが再生されるようにする
  cell.classList.add('long-flash');
  setTimeout(() => cell.classList.remove('long-flash'), LONG_FLASH_MS);
}
