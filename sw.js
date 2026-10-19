// オフライン用キャッシュ。アプリのファイルを更新したら VERSION を上げる。
const VERSION = 'v3';
const CACHE = 'term-cards-' + VERSION;
const ASSETS = [
  './', 'index.html', 'style.css', 'app.js', 'sync.js', 'firebase-config.js', 'manifest.webmanifest',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
];
// 同期用の Firebase SDK（バージョン固定のURLなので中身は変わらない）
const SDK_PREFIX = 'https://www.gstatic.com/firebasejs/';
const SDK = ['firebase-app.js', 'firebase-auth.js', 'firebase-firestore.js'].map(f => SDK_PREFIX + '12.3.0/' + f);

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(ASSETS).then(() => c.addAll(SDK).catch(() => {}))) // SDKが取れなくてもアプリ本体は入れる
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('term-cards-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = e.request.url;

  // Firebase SDK はキャッシュ優先
  if (url.startsWith(SDK_PREFIX)) {
    e.respondWith(
      caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
        return res;
      })),
    );
    return;
  }
  if (new URL(url).origin !== location.origin) return; // ログインや同期の通信には触れない

  // アプリ本体はネット優先・失敗したらキャッシュ（更新はすぐ反映、オフラインでも動く）
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        if (res.ok) caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html'))),
  );
});
