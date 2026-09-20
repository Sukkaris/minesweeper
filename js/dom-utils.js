// DOM まわりの小道具。ui.js・settings.js・stats-screen.js から使う。

const LONG_SINK_MS = 280;   // 長押し成立アニメーションのクラスを付けておく時間（CSS の --long-sink-duration より少し長め）
const DOUBLE_TAP_MS = 350;  // この間隔以内の 2 回目のタップをダブルタップとみなし、拡大を抑止する

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

// ---------- 下からせり上がるシート（設定画面・統計画面） ----------

/** シートを開く。動きは CSS（.sheet / .sheet.open）に任せる */
export function openSheet(el) {
  el.classList.add('open');
  el.setAttribute('aria-hidden', 'false');
}

export function closeSheet(el) {
  el.classList.remove('open');
  el.setAttribute('aria-hidden', 'true');
}

export function isSheetOpen(el) {
  return el.classList.contains('open');
}

// ---------- 拡大操作の抑止 ----------

/**
 * ダブルタップ拡大・ピンチ拡大・長押しメニューを画面全体で抑止する。
 * iOS は viewport の user-scalable=no を無視することがあるため、イベント側でも止める。
 * 短い間隔で 2 回目のタップが終わった瞬間に標準動作を止めれば、拡大は起きない。
 * ただしボタン・入力欄・シート内は click イベントで動くので、そこでは止めない
 * （止めると click が発火しなくなる）。これらは CSS の touch-action: manipulation で抑止済み。
 */
export function installZoomGuards() {
  // 長押し時の iOS のコールアウトメニューやデスクトップの右クリックメニューを抑止
  document.addEventListener('contextmenu', (event) => event.preventDefault());

  let lastTouchEndTime = 0;
  document.addEventListener('touchend', (event) => {
    const now = Date.now();
    const isDoubleTap = now - lastTouchEndTime < DOUBLE_TAP_MS;
    lastTouchEndTime = now;
    if (!isDoubleTap || !event.cancelable) return;
    if (event.target.closest('button, input, .sheet')) return;
    event.preventDefault();
  }, { passive: false });

  // ピンチ拡大の開始も止める（iOS Safari 独自のイベント）
  document.addEventListener('gesturestart', (event) => event.preventDefault());
}
