// 盤面のサイズ計算。コンテナの実測値からマスの大きさを決め、当たり判定用の寸法を返す。
// ゲームの状態には触れず、DOM の計測と CSS 変数の書き込みだけを行う。

/**
 * 1 マスの辺 = (利用可能な横幅 − 余白) ÷ 列数。正方形を保ち、横スクロールは発生させない。
 * 固定値は使わず、実際のコンテナ幅から算出する。
 * @param {{boardEl: HTMLElement, boardWrapEl: HTMLElement, mainEl: HTMLElement, cols: number}} args
 * @returns {{cellSize:number, frameLeft:number, frameTop:number}} 当たり判定用の寸法
 */
export function fitBoardToContainer({ boardEl, boardWrapEl, mainEl, cols }) {
  const wrapStyle = getComputedStyle(boardWrapEl);
  const boardStyle = getComputedStyle(boardEl);
  const padding = parseFloat(wrapStyle.paddingLeft) + parseFloat(wrapStyle.paddingRight);
  const frame = parseFloat(boardStyle.borderLeftWidth) + parseFloat(boardStyle.borderRightWidth)
              + parseFloat(boardStyle.paddingLeft) + parseFloat(boardStyle.paddingRight);
  const available = mainEl.clientWidth - padding - frame;
  // 端末の物理ピクセル単位に切り捨て、マス間に隙間や太さムラが出ないようにする
  const dpr = window.devicePixelRatio || 1;
  const cellSize = Math.max(1, Math.floor((available / cols) * dpr) / dpr);
  const value = cellSize + 'px';
  if (boardEl.style.getPropertyValue('--cell-size') !== value) {
    boardEl.style.setProperty('--cell-size', value);
  }

  updateTouchAction(boardEl, boardWrapEl, mainEl);

  // 当たり判定用に、マスの大きさと外枠の太さを返す
  return {
    cellSize,
    frameLeft: parseFloat(boardStyle.borderLeftWidth) + parseFloat(boardStyle.paddingLeft),
    frameTop: parseFloat(boardStyle.borderTopWidth) + parseFloat(boardStyle.paddingTop),
  };
}

/**
 * 盤面が縦にはみ出さないときはブラウザにスクロールを一切渡さない（touch-action: none）。
 * こうしないと、指を上下に動かして狙いを修正しただけで押下がキャンセルされてしまう。
 * はみ出すとき（上級）だけ縦スクロールを許可する。
 */
function updateTouchAction(boardEl, boardWrapEl, mainEl) {
  const overflows = boardWrapEl.offsetHeight > mainEl.clientHeight;
  boardEl.style.touchAction = overflows ? 'pan-y' : 'none';
}
