// 盤面の上に重ねる通知。ダイアログで操作を止めることはしない。
//   ローディング表示 : 消すまで出続ける（無推測の盤面生成中）。一瞬で終わる場合は出さない
//   トースト         : 一行の知らせを数秒だけ出す（無推測の盤面を生成できなかった、など）

// ---------- 調整用の定数 ----------
const LOADING_DELAY_MS = 150;   // 生成がこれより早く終わればローディング表示は出さない（ちらつき防止）
const TOAST_MS = 3000;          // トーストを表示しておく時間

// ---------- DOM 参照 ----------
const loadingEl = document.getElementById('board-loading');
const toastEl = document.getElementById('toast');

let loadingTimer = null;
let toastTimer = null;

/** ローディング表示を（少し遅れて）出す */
export function showLoading(text) {
  hideLoading();
  loadingEl.textContent = text;
  loadingTimer = setTimeout(() => {
    loadingTimer = null;
    loadingEl.hidden = false;
  }, LOADING_DELAY_MS);
}

/** ローディング表示を消す。まだ出ていなければ出さないようにする */
export function hideLoading() {
  if (loadingTimer !== null) {
    clearTimeout(loadingTimer);
    loadingTimer = null;
  }
  loadingEl.hidden = true;
}

/** 一行の通知を数秒間表示する。連続して呼ばれたら最後のものに置き換える */
export function showToast(text) {
  hideToast();
  toastEl.textContent = text;
  toastEl.classList.add('show');
  toastTimer = setTimeout(() => {
    toastTimer = null;
    toastEl.classList.remove('show');
  }, TOAST_MS);
}

/** 表示中の通知をすぐ消す（新しいゲームに持ち越さないため） */
export function hideToast() {
  if (toastTimer !== null) {
    clearTimeout(toastTimer);
    toastTimer = null;
  }
  toastEl.classList.remove('show');
}
