// Hermes Mobile / アプリ本体
//
// やることは 3 つだけ:
//   1. Supabase にログインしてアクセストークンを持つ
//   2. Service Worker を登録して Push を購読する
//   3. 購読(endpoint/p256dh/auth)を push_subscriptions に upsert する
//
// 依存ゼロ。supabase-js も使わず fetch で GoTrue と PostgREST を直接叩く。
// hermes-project 側（supabase_sync.py の urllib、send-push の fetch）と同じ作法で、
// ビルド工程が無いぶん GitHub Pages へは push するだけで配れる。

import { SUPABASE_URL, SUPABASE_ANON_KEY, VAPID_PUBLIC_KEY } from "./config.js";

const SESSION_KEY = "hermes.session";

// ── DOM ─────────────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);
const loginCard = $("login-card");
const mainCard = $("main-card");
const statusLine = $("status");
const hintLine = $("hint");
const pushState = $("push-state");
const enableButton = $("enable-button");
const testButton = $("test-button");
const disableButton = $("disable-button");

let session = null;

// ── 表示 ────────────────────────────────────────────────────────────────────

function say(message, kind = "") {
  statusLine.textContent = message;
  statusLine.className = `status ${kind}`;
}

function setBusy(busy) {
  for (const el of document.querySelectorAll("button")) el.disabled = busy;
}

// ── セッション ──────────────────────────────────────────────────────────────

function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveSession(value) {
  session = value;
  if (value) localStorage.setItem(SESSION_KEY, JSON.stringify(value));
  else localStorage.removeItem(SESSION_KEY);
}

async function authFetch(path, body) {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/${path}`, {
    method: "POST",
    headers: { apikey: SUPABASE_ANON_KEY, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error_description || payload.msg || payload.error || `HTTP ${response.status}`);
  }
  return payload;
}

function storeToken(payload) {
  saveSession({
    access_token: payload.access_token,
    refresh_token: payload.refresh_token,
    // expires_in は「発行からの秒数」。実時刻に直して保存する。
    expires_at: Date.now() + (payload.expires_in ?? 3600) * 1000,
    email: payload.user?.email ?? "",
  });
}

async function signIn(email, password) {
  storeToken(await authFetch("token?grant_type=password", { email, password }));
}

/**
 * 期限が近ければリフレッシュする。
 * PWA は何日も開きっぱなしになるので、操作のたびに軽く見ておく。
 */
async function ensureFreshToken() {
  if (!session) return null;
  if (session.expires_at - Date.now() > 60_000) return session.access_token;
  try {
    storeToken(await authFetch("token?grant_type=refresh_token", { refresh_token: session.refresh_token }));
    return session.access_token;
  } catch {
    // リフレッシュトークンごと失効している。作り直しはできないので再ログイン。
    saveSession(null);
    render();
    say("セッションが切れました。もう一度ログインしてください。", "warn");
    return null;
  }
}

// ── PostgREST ───────────────────────────────────────────────────────────────

/**
 * 購読を push_subscriptions に upsert する。
 * endpoint が UNIQUE なので、同じ端末で再購読しても行は増えない。
 */
async function upsertSubscription(subscription) {
  const token = await ensureFreshToken();
  if (!token) throw new Error("ログインが必要です");

  const json = subscription.toJSON();
  if (!json.keys?.p256dh || !json.keys?.auth) {
    throw new Error("購読に暗号鍵が含まれていません（このブラウザでは配信できません）");
  }

  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/push_subscriptions?on_conflict=endpoint`,
    {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        // merge-duplicates = endpoint が既にあれば UPDATE。updated_at は DB のトリガが進める。
        prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify({
        endpoint: json.endpoint,
        p256dh: json.keys.p256dh,
        auth: json.keys.auth,
        platform: "web",
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`購読の保存に失敗: HTTP ${response.status} ${await response.text()}`);
  }
}

async function deleteSubscription(endpoint) {
  const token = await ensureFreshToken();
  if (!token) return;
  await fetch(
    `${SUPABASE_URL}/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(endpoint)}`,
    {
      method: "DELETE",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        authorization: `Bearer ${token}`,
        prefer: "return=minimal",
      },
    },
  );
}

// ── Push ────────────────────────────────────────────────────────────────────

/**
 * base64url の VAPID 公開鍵を Uint8Array に変換する。
 * applicationServerKey に文字列を受け付けるブラウザもあるが、
 * Uint8Array ならどこでも通るのでこちらに揃える。
 */
function vapidKeyToBytes(base64url) {
  const padded = (base64url + "=".repeat((4 - (base64url.length % 4)) % 4))
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function pushSupported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

async function getRegistration() {
  // スコープは sw.js の位置（= ./）。GitHub Pages の /<repo>/ 配下でも正しく効く。
  return await navigator.serviceWorker.register("./sw.js", { scope: "./" });
}

async function enablePush() {
  if (!pushSupported()) {
    throw new Error("このブラウザは Web Push に対応していません");
  }
  if (!window.isSecureContext) {
    throw new Error("HTTPS でないと Push は使えません（localhost は例外）");
  }

  // requestPermission はユーザー操作からしか呼べない。ボタン経由なので OK。
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error(
      permission === "denied"
        ? "通知がブロックされています。ブラウザのサイト設定から許可してください。"
        : "通知が許可されませんでした",
    );
  }

  const registration = await getRegistration();
  // 有効化直後は SW がまだ activating のことがある。ここで待たないと subscribe が失敗しうる。
  await navigator.serviceWorker.ready;

  const existing = await registration.pushManager.getSubscription();
  // 既に購読済みなら作り直さない。作り直すと endpoint が変わり、サーバ側に
  // 死んだ行が残る（次の配信で 410 が返るまで消えない）。
  const subscription = existing ?? await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: vapidKeyToBytes(VAPID_PUBLIC_KEY),
  });

  await upsertSubscription(subscription);
  return subscription;
}

async function disablePush() {
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;
  // 先に DB から消す。ブラウザ側だけ解除して DB に残ると、配信のたびに
  // 410 が返るまで無駄打ちが続く。
  await deleteSubscription(subscription.endpoint);
  await subscription.unsubscribe();
}

// ── 画面の出し分け ──────────────────────────────────────────────────────────

async function refreshPushState() {
  if (!pushSupported()) {
    pushState.textContent = "非対応";
    enableButton.hidden = true;
    hintLine.textContent = "iOS はホーム画面に追加した PWA でのみ Push が使えます（iOS 16.4+）。";
    return;
  }

  const permission = Notification.permission;
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();

  if (subscription && permission === "granted") {
    pushState.textContent = "有効";
    pushState.className = "value ok";
    enableButton.hidden = true;
    testButton.hidden = false;
    disableButton.hidden = false;
    hintLine.textContent = "18:00 のバッチ完了時に通知が届きます。";
  } else if (permission === "denied") {
    pushState.textContent = "ブロック中";
    pushState.className = "value bad";
    enableButton.hidden = true;
    hintLine.textContent = "ブラウザのサイト設定で通知を「許可」に戻すと有効化できます。";
  } else {
    pushState.textContent = "未設定";
    pushState.className = "value";
    enableButton.hidden = false;
    testButton.hidden = true;
    disableButton.hidden = true;
    hintLine.textContent = "";
  }
}

async function render() {
  const signedIn = Boolean(session);
  loginCard.hidden = signedIn;
  mainCard.hidden = !signedIn;
  if (signedIn) {
    $("user-email").textContent = session.email || "(不明)";
    await refreshPushState();
  }
}

// ── イベント ────────────────────────────────────────────────────────────────

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  setBusy(true);
  say("ログイン中…");
  try {
    await signIn($("email").value.trim(), $("password").value);
    $("password").value = "";
    say("ログインしました", "ok");
    await render();
  } catch (error) {
    say(`ログインに失敗: ${error.message}`, "bad");
  } finally {
    setBusy(false);
  }
});

enableButton.addEventListener("click", async () => {
  setBusy(true);
  say("通知を設定中…");
  try {
    await enablePush();
    say("通知を有効にしました", "ok");
  } catch (error) {
    say(error.message, "bad");
  } finally {
    setBusy(false);
    await refreshPushState();
  }
});

testButton.addEventListener("click", async () => {
  // サーバを経由しないローカル表示。SW と通知の見た目だけを切り分けて確認できる。
  // これが出れば「表示側は正常」で、届かない原因はサーバ側だと分かる。
  try {
    const registration = await navigator.serviceWorker.ready;
    await registration.showNotification("Hermes（テスト）", {
      body: "これは端末内で出しているテスト表示です。サーバは経由していません。",
      icon: "./icons/icon-192.png",
      badge: "./icons/badge-72.png",
      tag: "hermes-test",
    });
    say("テスト表示を出しました", "ok");
  } catch (error) {
    say(`テスト表示に失敗: ${error.message}`, "bad");
  }
});

disableButton.addEventListener("click", async () => {
  setBusy(true);
  try {
    await disablePush();
    say("通知を解除しました", "ok");
  } catch (error) {
    say(`解除に失敗: ${error.message}`, "bad");
  } finally {
    setBusy(false);
    await refreshPushState();
  }
});

$("logout-button").addEventListener("click", async () => {
  // 購読は消さない。ログアウトしても同じ端末で再ログインすれば通知は続く。
  saveSession(null);
  say("ログアウトしました");
  await render();
});

// SW からの通知タップ通知を受ける（今は何もしないが、将来の画面遷移用の口）。
navigator.serviceWorker?.addEventListener("message", (event) => {
  if (event.data?.type === "notification-click") {
    say(`通知から起動: ${event.data.data?.type ?? ""}`);
  }
});

// ── 起動 ────────────────────────────────────────────────────────────────────

(async function start() {
  session = loadSession();
  await render();

  if (session) await ensureFreshToken();

  // 既にログイン済み・許可済みなら SW を登録しておく（購読状態の表示に要る）。
  if (pushSupported() && Notification.permission === "granted") {
    try {
      await getRegistration();
      await refreshPushState();
    } catch {
      /* 登録に失敗しても画面は出す */
    }
  }

  $("diag").textContent = [
    pushSupported() ? "push:対応" : "push:非対応",
    window.isSecureContext ? "https:ok" : "https:なし",
    window.matchMedia("(display-mode: standalone)").matches ? "PWA" : "ブラウザ",
  ].join(" / ");
})();
