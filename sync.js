// 端末間の同期（Firebase Authentication + Cloud Firestore）
// 保存の本体はこれまでどおり端末内の IndexedDB。ここでは「未送信の変更を送る」「他の端末の変更を取り込む」だけを行う。
// クラウド上の保存場所: users/{ログインしたユーザーのID}/terms/{用語ID}
import { firebaseConfig } from './firebase-config.js';

const SDK = 'https://www.gstatic.com/firebasejs/12.3.0/';
const BATCH_SIZE = 400; // Firestore の一括書き込み上限（500）より少なめ
const $ = sel => document.querySelector(sel);
const lsGet = k => { try { return localStorage.getItem('tc:' + k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem('tc:' + k, v); } catch { /* 無視 */ } };
const hhmm = d => d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });

const state = { user: null, pending: 0, lastSync: null, error: '', ready: false };

function render() {
  const signedIn = !!state.user;
  $('#syncSignedOut').hidden = !state.ready || signedIn;
  $('#syncSignedIn').hidden = !signedIn;
  if (signedIn) $('#syncUser').textContent = state.user.email || state.user.displayName || '';
  let text, badge = '';
  if (!firebaseConfig) text = '未設定です（firebase-config.js に Firebase の設定を書くと使えます）。';
  else if (!state.ready) text = state.error || '準備中…';
  else if (!signedIn) { text = 'ログインしていません。データはこの端末にだけ保存されています。'; }
  else if (state.error) { text = state.error; badge = '同期エラー'; }
  else if (state.pending) { text = `未送信の変更 ${state.pending} 件（ネットにつながると自動で送ります）`; badge = `未同期 ${state.pending}`; }
  else { text = state.lastSync ? `同期済み（${hhmm(state.lastSync)}）` : '同期中…'; badge = state.lastSync ? '同期済み' : ''; }
  $('#syncStatus').textContent = text;
  $('#syncBadge').textContent = badge;
}

const AUTH_ERRORS = {
  'auth/popup-blocked': 'ポップアップがブロックされました。ブラウザでポップアップを許可してください。',
  'auth/popup-closed-by-user': 'ログイン画面が閉じられました。',
  'auth/cancelled-popup-request': 'ログイン画面が閉じられました。',
  'auth/unauthorized-domain': 'このURLはFirebaseで許可されていません（Authentication の承認済みドメインに追加が必要）。',
  'auth/network-request-failed': 'ネットにつながっていないためログインできません。',
};

async function main() {
  render();
  if (!firebaseConfig) return;

  let mods;
  try {
    mods = await Promise.all(['firebase-app.js', 'firebase-auth.js', 'firebase-firestore.js'].map(f => import(SDK + f)));
  } catch {
    state.error = '同期機能を読み込めませんでした（初回だけはネット接続が必要です）。';
    render();
    return;
  }
  const [{ initializeApp }, A, F] = mods;
  const app = initializeApp(firebaseConfig);
  const auth = A.getAuth(app);
  let fs;
  try {
    // 端末内にもキャッシュし、オフライン中の送信待ちをアプリを閉じても保持する
    fs = F.initializeFirestore(app, { localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }) });
  } catch {
    fs = F.getFirestore(app);
  }
  await window.TermApp.ready;
  state.ready = true;
  render();

  let unsubscribe = null, pushing = false, pushAgain = false, timer = null;

  async function push() {
    if (!state.user) return;
    if (pushing) { pushAgain = true; return; }
    pushing = true;
    try {
      do {
        pushAgain = false;
        const dirty = await window.TermApp.getDirty();
        state.pending = dirty.length; render();
        for (let i = 0; i < dirty.length; i += BATCH_SIZE) {
          const chunk = dirty.slice(i, i + BATCH_SIZE);
          const batch = F.writeBatch(fs);
          chunk.forEach(({ dirty: _, ...rec }) => {
            // Firestore は undefined を保存できないので JSON を通して取り除く
            batch.set(F.doc(fs, 'users', state.user.uid, 'terms', rec.id), JSON.parse(JSON.stringify(rec)));
          });
          await batch.commit(); // オフライン中はつながるまで待つ
          await window.TermApp.markClean(chunk.map(t => ({ id: t.id, editedAt: t.editedAt, lastReviewed: t.lastReviewed })));
          state.pending = Math.max(0, state.pending - chunk.length); render();
        }
      } while (pushAgain);
      state.pending = 0; state.error = ''; state.lastSync = new Date();
    } catch (err) {
      state.error = err.code === 'permission-denied'
        ? '同期が拒否されました（Firestore のセキュリティルールでこのアカウントが許可されていません）。'
        : `同期に失敗しました（${err.code || err.message}）。`;
    } finally {
      pushing = false;
      render();
    }
  }
  const schedulePush = (ms = 1500) => { clearTimeout(timer); timer = setTimeout(push, ms); };

  A.onAuthStateChanged(auth, async user => {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    state.user = user; state.error = ''; state.lastSync = null; state.pending = 0;
    render();
    if (!user) return;
    // このアカウントで初めて同期する端末なら、手元の全データを送る
    if (lsGet('syncedUid') !== user.uid) {
      await window.TermApp.markAllDirty();
      lsSet('syncedUid', user.uid);
    }
    const col = F.collection(fs, 'users', user.uid, 'terms');
    unsubscribe = F.onSnapshot(col, async snap => {
      // 自分が送った直後の変更（hasPendingWrites）は取り込み不要
      const changes = snap.docChanges()
        .filter(c => c.type !== 'removed' && !c.doc.metadata.hasPendingWrites)
        .map(c => c.doc.data());
      await window.TermApp.applyRemote(changes);
      if (!snap.metadata.fromCache) { state.lastSync = new Date(); if (!state.pending) state.error = ''; }
      render();
      schedulePush(300); // 取り込みの結果、こちらの方が新しい項目があれば送り返す
    }, err => {
      state.error = err.code === 'permission-denied'
        ? '同期が拒否されました（Firestore のセキュリティルールでこのアカウントが許可されていません）。'
        : `同期に失敗しました（${err.code || err.message}）。`;
      render();
    });
    schedulePush(0);
  });

  window.addEventListener('tc:local-change', () => { if (state.user) { state.pending++; render(); schedulePush(); } });
  window.addEventListener('online', () => schedulePush(0));

  $('#googleLogin').addEventListener('click', async () => {
    try {
      await A.signInWithPopup(auth, new A.GoogleAuthProvider());
    } catch (err) {
      state.error = '';
      alert(AUTH_ERRORS[err.code] || `ログインできませんでした（${err.code || err.message}）`);
    }
  });
  $('#syncNow').addEventListener('click', () => schedulePush(0));
  $('#logout').addEventListener('click', async () => {
    if (!confirm('ログアウトします。この端末のデータは残りますが、以後は同期されません。')) return;
    await A.signOut(auth);
  });
}

main().catch(err => { console.error(err); state.error = '同期機能の初期化に失敗しました。'; render(); });
