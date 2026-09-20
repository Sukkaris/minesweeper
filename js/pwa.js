// PWA 周り。Service Worker の登録と、更新検知バナーの制御を担当する。
//
// sw.js はキャッシュ優先で応答するため、新しいコードを配信しても
// ホーム画面のアプリは古いまま起動し続ける。そこで、
//   1. 新しい Service Worker が「待機中」になったらバナーを出す
//   2. バナーを押したときだけ新しい Service Worker を有効化して再読み込みする
//   3. 自動では絶対に再読み込みしない（遊んでいる最中に盤面が飛ぶため）
// という流れにしている。バナーを無視すれば次回起動時にまた表示される。

const appEl = document.getElementById('app');
const bannerEl = document.getElementById('update-banner');
const versionEl = document.getElementById('sw-version');   // 設定画面の最下部に表示する版番号

let waitingWorker = null;    // 適用待ちの新しい Service Worker
let reloadRequested = false; // バナーを押したかどうか

// ---------- 動作中の Service Worker の版番号表示 ----------
// 「今ホーム画面で動いているのが最新か」を目視で確かめるためのもの。
// ページ側は sw.js を直接読めないので、制御中の Service Worker に問い合わせて答えてもらう

function requestVersion() {
  const controller = navigator.serviceWorker.controller;
  if (!controller) {
    versionEl.textContent = '未登録';
    return;
  }
  controller.postMessage({ type: 'GET_VERSION' });
}

function showVersion(version) {
  versionEl.textContent = 'v' + version;
}

function showBanner(worker) {
  waitingWorker = worker;
  bannerEl.hidden = false;
  appEl.classList.add('has-update');
}

function hideBanner() {
  waitingWorker = null;
  bannerEl.hidden = true;
  appEl.classList.remove('has-update');
}

/** 登録情報を見て、待機中 / インストール中の Service Worker があればバナーにつなぐ */
function watchRegistration(registration) {
  if (registration.waiting && navigator.serviceWorker.controller) {
    showBanner(registration.waiting);
  }

  registration.addEventListener('updatefound', () => {
    const installing = registration.installing;
    if (!installing) return;
    installing.addEventListener('statechange', () => {
      // controller が無い場合は初回インストールなので、バナーは不要
      if (installing.state === 'installed' && navigator.serviceWorker.controller) {
        showBanner(installing);
      }
    });
  });
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    versionEl.textContent = '非対応';
    return;
  }

  // Service Worker からの返事（版番号）を受け取る
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'VERSION') showVersion(event.data.version);
  });

  window.addEventListener('load', async () => {
    try {
      // サブディレクトリ配信のため、必ず相対パスで登録する
      const registration = await navigator.serviceWorker.register('./sw.js');
      watchRegistration(registration);
      requestVersion();
      // 登録時には自動で更新確認が走る。アプリ切替から戻ってきたとき（再読み込みされない）にも確認する
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        registration.update().catch(() => { /* オフライン時は失敗して当然なので無視 */ });
      });
    } catch (err) {
      console.warn('Service Worker の登録に失敗しました', err);
    }
  });

  // 新しい Service Worker がページの制御を引き継いだら再読み込みする。
  // ただしバナーを押した場合に限る（自動更新による勝手な再読み込みを防ぐ）
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!reloadRequested) {
      requestVersion();   // 初回インストール時など、制御が始まった時点で版番号を取りに行く
      return;
    }
    reloadRequested = false;
    location.reload();
  });
}

bannerEl.addEventListener('click', () => {
  if (!waitingWorker) {
    hideBanner();
    return;
  }
  reloadRequested = true;
  // sw.js 側で skipWaiting() を呼び、controllerchange を発火させる
  waitingWorker.postMessage({ type: 'SKIP_WAITING' });
});

registerServiceWorker();
