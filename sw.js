// Hermes Mobile / Service Worker
//
// 役割は 3 つ:
//   'push'              … サーバから届いた暗号化本文を復号済み JSON として受け取り通知を出す
//   'notificationclick' … 既存ウィンドウがあれば focus、無ければ開く
//   'fetch'             … アプリ自身のファイルは毎回サーバに「変わったか」を確かめて取る
//
// 本文の復号はブラウザが購読の秘密鍵で自動的に済ませてくれるので、ここでは
// event.data.json() を読むだけでよい。暗号化側（Edge Function send-push）が
// aes128gcm で送っている前提。
//
// 送られてくる JSON は send-push の buildPayload と対になっている:
//   { id, type, title, body, data }

const VERSION = "hermes-sw-v3";

// 通知の種類ごとの着地先（アプリ内ハッシュルート）。
// 未知の種類はホームに落とす。存在しない画面へ飛ばして空白を見せない。
const LANDING = {
  batch_done: "#/",
  diff_report: "#/",
  tdnet_hit: "#/",
};

self.addEventListener("install", () => {
  // 新しい SW を待たせない。通知の出し方を直したらすぐ効いてほしい。
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // 既に開いているタブもこの SW の管理下に置く。
  event.waitUntil(self.clients.claim());
});

// Chrome は「fetch ハンドラを持つ SW」をインストール可能の条件にしている。
//
// アプリ自身のファイル（同じオリジンの GET）は cache: "no-cache" で取る。ブラウザの
// キャッシュは使うが、毎回サーバに「変わったか」を確かめる（変わっていなければ 304 で軽い）。
// GitHub Pages は 10 分キャッシュさせるので、これが無いと公開直後に新しい app.js と
// 古い dashboard.js が混ざって画面が出ないことがある。
// Supabase など別オリジンへの通信には触らない（素通し）。オフライン対応はしない。
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  if (new URL(request.url).origin !== self.location.origin) return;
  // 画面そのもの（navigate）は Request を作り直せないので URL で取り直す。
  // スコープの中ではリダイレクトは起きない（/hermes-mobile → / の補正はスコープの外）。
  event.respondWith(
    request.mode === "navigate"
      ? fetch(request.url, { cache: "no-cache", credentials: "same-origin" })
      : fetch(request, { cache: "no-cache" }),
  );
});

self.addEventListener("push", (event) => {
  // 本文が壊れていても「何も出ない」のが一番困る。必ず何か出す。
  let payload = {};
  if (event.data) {
    try {
      payload = event.data.json();
    } catch {
      payload = { title: "Hermes", body: event.data.text() };
    }
  }

  const title = payload.title || "Hermes";
  const options = {
    body: payload.body || "",
    icon: "./icons/icon-192.png",
    badge: "./icons/badge-72.png",
    // 種類ごとに tag を分ける。同じ種類の通知は積み上がらず最新に置き換わる。
    tag: payload.type ? `hermes-${payload.type}` : "hermes",
    renotify: true,
    timestamp: Date.now(),
    data: {
      id: payload.id ?? null,
      type: payload.type ?? null,
      ...(payload.data || {}),
    },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const data = event.notification.data || {};
  // SW から見た自分のスコープ = アプリのトップ。GitHub Pages の /<repo>/ でも正しい。
  const scopeUrl = new URL("./", self.location.href).href;
  // batch_done は「その日の結果が出た」合図なので、ホーム（1位のヒーロー）に着地させる。
  // data.ticker が入っている通知（将来の tdnet_hit 想定）はその銘柄の詳細へ。
  const landing = data.ticker
    ? `#/s/${encodeURIComponent(data.ticker)}`
    : (LANDING[data.type] || "#/");
  const targetUrl = scopeUrl + landing;

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({
      type: "window",
      // 既に開いているが SW の管理下に入っていないタブも拾う。
      includeUncontrolled: true,
    });

    for (const client of windows) {
      if (client.url.startsWith(scopeUrl)) {
        // 先に postMessage する。focus() より前に届けておくと、画面が前に出た時点で
        // もう目的の画面になっている（切り替わりが見えない）。
        client.postMessage({ type: "notification-click", data });
        // navigate は同一オリジンなら使える。使えない環境（iOS）でも postMessage 側で
        // ルーティングされるので、失敗は握りつぶしてよい。
        try {
          await client.navigate?.(targetUrl);
        } catch {
          /* 失敗しても postMessage 側で着地する */
        }
        await client.focus();
        return;
      }
    }
    await self.clients.openWindow(targetUrl);
  })());
});

// 購読がブラウザ都合で作り直されたときに飛んでくる。
// ここで再購読しても、新しい endpoint をサーバへ送るには認証トークンが要る（SW は
// localStorage を読めない）。よってサーバ側に古い行が残るが、次の配信で 410 が
// 返って send-push が消す。ユーザーがアプリを開けば新しい購読が upsert される。
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    self.registration.showNotification("Hermes", {
      body: "通知の登録が更新されました。アプリを開いて有効化し直してください。",
      icon: "./icons/icon-192.png",
      badge: "./icons/badge-72.png",
      tag: "hermes-resubscribe",
    }),
  );
});

console.log(`[${VERSION}] service worker loaded`);
