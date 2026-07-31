// Hermes Mobile / Service Worker
//
// 役割は 3 つ:
//   'push'              … サーバから届いた暗号化本文を復号済み JSON として受け取り通知を出す
//   'notificationclick' … 既存ウィンドウがあれば focus、無ければ開く
//   'fetch'             … 素通し。Chrome のインストール要件を満たすためだけに置いている
//
// 本文の復号はブラウザが購読の秘密鍵で自動的に済ませてくれるので、ここでは
// event.data.json() を読むだけでよい。暗号化側（Edge Function send-push）が
// aes128gcm で送っている前提。
//
// 送られてくる JSON は send-push の buildPayload と対になっている:
//   { id, type, title, body, data }

const VERSION = "hermes-sw-v1";

self.addEventListener("install", () => {
  // 新しい SW を待たせない。通知の出し方を直したらすぐ効いてほしい。
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // 既に開いているタブもこの SW の管理下に置く。
  event.waitUntil(self.clients.claim());
});

// Chrome は「fetch ハンドラを持つ SW」をインストール可能の条件にしている。
// キャッシュはしない（オフライン対応は今回のスコープ外）。素通しさせるだけ。
self.addEventListener("fetch", () => {
  // respondWith を呼ばなければブラウザが通常どおりネットワークへ行く。
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

  // SW から見た自分のスコープ = アプリのトップ。GitHub Pages の /<repo>/ でも正しい。
  const scopeUrl = new URL("./", self.location.href).href;

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({
      type: "window",
      // 既に開いているが SW の管理下に入っていないタブも拾う。
      includeUncontrolled: true,
    });

    for (const client of windows) {
      if (client.url.startsWith(scopeUrl)) {
        await client.focus();
        // アプリ側に「通知から来た」ことを伝える（将来の画面遷移用）。
        client.postMessage({ type: "notification-click", data: event.notification.data });
        return;
      }
    }
    await self.clients.openWindow(scopeUrl);
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
