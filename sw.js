// Service Worker。インストール時に静的ファイルをすべてキャッシュし、
// 以後はキャッシュ優先で応答する（オフラインで完全に動作させるため）。
//
// ★ コードを変更したら、必ず下の CACHE_VERSION の数字を 1 つ増やすこと ★
// これを忘れると、ホーム画面のアプリは古いキャッシュで起動し続け、変更が反映されない。

const CACHE_VERSION = 6;
const CACHE_NAME = 'ms-cache-v' + CACHE_VERSION;

// キャッシュ対象。tools/ 配下は開発用なので含めない。
// すべて相対パスで書く（サブディレクトリ配信のため）。
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './css/settings.css',
  './css/themes.css',
  './js/game.js',
  './js/storage.js',
  './js/stats.js',
  './js/stats-screen.js',
  './js/board-layout.js',
  './js/dom-utils.js',
  './js/settings.js',
  './js/ui.js',
  './js/pwa.js',
  './icons/icon.svg',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// インストール：全ファイルをキャッシュに入れる。
// ブラウザの HTTP キャッシュを迂回して、必ずサーバーから最新版を取る
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' })))
    )
  );
});

// 有効化：古いバージョンのキャッシュを削除し、開いているページの制御を引き継ぐ
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith('ms-cache-') && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

// 取得：キャッシュ優先。無ければネットワーク。
// ?level=... のようなクエリ付きの起動でも index.html を返せるよう、検索文字列は無視して照合する
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((cached) => {
      if (cached) return cached;
      return fetch(request).catch(() => {
        // オフラインでキャッシュにも無い場合、ページ遷移なら index.html で代替する
        if (request.mode === 'navigate') return caches.match('./index.html');
        return Response.error();
      });
    })
  );
});

// ページからの合図
//   SKIP_WAITING: 更新バナーが押された。待機中の自分自身を即座に有効化する
//   GET_VERSION : 設定画面の版番号表示用。今動いている自分の CACHE_VERSION を返す
self.addEventListener('message', (event) => {
  if (!event.data) return;
  if (event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  } else if (event.data.type === 'GET_VERSION' && event.source) {
    event.source.postMessage({ type: 'VERSION', version: CACHE_VERSION });
  }
});
