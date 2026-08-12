// Hermes Mobile / アプリ本体
//
// やること:
//   1. Supabase にログインしてアクセストークンを持つ（session.js）
//   2. Service Worker を登録して Push を購読する
//   3. 購読(endpoint/p256dh/auth)を push_subscriptions に upsert する
//   4. ダッシュボードを出す（dashboard.js / Phase D で追加）
//
// 依存ゼロ。supabase-js も使わず fetch で GoTrue と PostgREST を直接叩く。
// hermes-project 側（supabase_sync.py の urllib、send-push の fetch）と同じ作法で、
// ビルド工程が無いぶん GitHub Pages へは push するだけで配れる。

import { VAPID_PUBLIC_KEY } from "./config.js";
import {
  ensureFreshToken,
  getSession,
  loadSession,
  rest,
  setSignedOutHandler,
  signIn,
  signOut,
} from "./session.js";
import {
  loadArticle,
  loadArticleIndex,
  loadDetail,
  loadDiffReport,
  loadOverview,
  renderAll,
  renderArticle,
  renderDetail,
  renderHome,
  renderWeekly,
} from "./dashboard.js";
import { loadBacklog, renderChat } from "./chat.js";

// ── DOM ─────────────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);
const statusLine = $("status");
const hintLine = $("hint");
const pushState = $("push-state");
const enableButton = $("enable-button");
const testButton = $("test-button");
const disableButton = $("disable-button");
const settingsButton = $("settings-button");

const VIEWS = ["login", "home", "all", "detail", "article", "weekly", "chat", "settings"];

// 取得済みの一覧。全銘柄・詳細から使い回すのでここに持つ（再取得を避ける）。
let overview = null;

// ── 表示 ────────────────────────────────────────────────────────────────────

function say(message, kind = "") {
  statusLine.textContent = message;
  statusLine.className = `status ${kind}`;
}

function setBusy(busy) {
  for (const el of document.querySelectorAll("button")) el.disabled = busy;
}

function showView(name) {
  for (const view of VIEWS) $(`view-${view}`).hidden = view !== name;
  settingsButton.hidden = name === "login";
  window.scrollTo(0, 0);
}

// ── Push ────────────────────────────────────────────────────────────────────

/**
 * 購読を push_subscriptions に upsert する。
 * endpoint が UNIQUE なので、同じ端末で再購読しても行は増えない。
 */
async function upsertSubscription(subscription) {
  const json = subscription.toJSON();
  if (!json.keys?.p256dh || !json.keys?.auth) {
    throw new Error("購読に暗号鍵が含まれていません（このブラウザでは配信できません）");
  }

  await rest("push_subscriptions?on_conflict=endpoint", {
    method: "POST",
    // merge-duplicates = endpoint が既にあれば UPDATE。updated_at は DB のトリガが進める。
    headers: { prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      endpoint: json.endpoint,
      p256dh: json.keys.p256dh,
      auth: json.keys.auth,
      platform: "web",
    }),
  });
}

async function deleteSubscription(endpoint) {
  await rest(`push_subscriptions?endpoint=eq.${encodeURIComponent(endpoint)}`, {
    method: "DELETE",
    headers: { prefer: "return=minimal" },
  });
}

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

// ── ルーティング ────────────────────────────────────────────────────────────
//
// ハッシュだけで切り替える。GitHub Pages は静的配信なので、パスで分けると
// リロード時に 404 になる（/all という実ファイルは無い）。ハッシュなら常に
// index.html が返り、戻る／進むも端末の標準操作がそのまま効く。
//
//   #/              ホーム
//   #/all           全銘柄
//   #/s/<code>      銘柄詳細
//   #/article       最新の note 記事
//   #/article/<日付> 指定日の note 記事（YYYY-MM-DD）
//   #/weekly        週次 diff レポート
//   #/chat          アプリ内チャット
//   #/chat/<code>   銘柄を添えたチャット（銘柄詳細から）
//   #/settings      設定

function parseRoute() {
  const hash = location.hash.replace(/^#/, "");
  const parts = hash.split("/").filter(Boolean);
  if (!parts.length) return { name: "home" };
  if (parts[0] === "all") return { name: "all" };
  if (parts[0] === "weekly") return { name: "weekly" };
  if (parts[0] === "chat") return { name: "chat", ticker: parts[1] ? decodeURIComponent(parts[1]) : null };
  if (parts[0] === "settings") return { name: "settings" };
  if (parts[0] === "article") return { name: "article", runDate: parts[1] || null };
  if (parts[0] === "s" && parts[1]) return { name: "detail", ticker: decodeURIComponent(parts[1]) };
  return { name: "home" };
}

function goHome(replace = false) {
  if (replace) history.replaceState(null, "", "#/");
  else location.hash = "#/";
}

/** 一覧を持っていなければ取りに行く。失敗しても画面は残す（文字で理由を出す）。 */
async function ensureOverview({ force = false } = {}) {
  if (overview && !force) return overview;
  overview = await loadOverview();
  return overview;
}

async function route() {
  if (!getSession()) {
    showView("login");
    return;
  }

  const target = parseRoute();

  if (target.name === "settings") {
    showView("settings");
    $("user-email").textContent = getSession().email || "(不明)";
    await refreshPushState();
    return;
  }

  if (target.name === "detail") {
    showView("detail");
    const body = $("detail-body");
    body.textContent = "読み込み中…";
    try {
      const data = await ensureOverview();
      const row = data.rows.find((r) => r.ticker === target.ticker)
        || data.watch.find((r) => r.ticker === target.ticker);
      const detail = await loadDetail(target.ticker, data.runDate);
      renderDetail(body, detail, row);
    } catch (error) {
      body.textContent = "";
      say(error.message, "bad");
    }
    return;
  }

  if (target.name === "all") {
    showView("all");
    const body = $("all-body");
    body.textContent = "読み込み中…";
    try {
      renderAll(body, await ensureOverview());
    } catch (error) {
      body.textContent = "";
      say(error.message, "bad");
    }
    return;
  }

  if (target.name === "article") {
    showView("article");
    const body = $("article-body");
    body.textContent = "読み込み中…";
    try {
      // 本文と一覧は独立。一覧が取れなくても記事は出す。
      const [article, index] = await Promise.all([
        loadArticle(target.runDate),
        loadArticleIndex().catch(() => []),
      ]);
      renderArticle(body, article, index);
    } catch (error) {
      body.textContent = "";
      say(error.message, "bad");
    }
    return;
  }

  if (target.name === "chat") {
    showView("chat");
    const body = $("chat-body");
    body.textContent = "読み込み中…";
    try {
      // 過去ログの取得に失敗しても会話は始められる。ここで止めない。
      await loadBacklog().catch((error) => say(`過去ログを読めません: ${error.message}`, "warn"));
      const data = overview ? overview : await ensureOverview().catch(() => null);
      renderChat(body, target.ticker, data?.runDate ?? null);
    } catch (error) {
      body.textContent = "";
      say(error.message, "bad");
    }
    return;
  }

  if (target.name === "weekly") {
    showView("weekly");
    const body = $("weekly-body");
    body.textContent = "読み込み中…";
    try {
      renderWeekly(body, await loadDiffReport());
    } catch (error) {
      body.textContent = "";
      say(error.message, "bad");
    }
    return;
  }

  // ホーム
  showView("home");
  const home = $("view-home");
  if (!overview) home.textContent = "読み込み中…";
  try {
    renderHome(home, await ensureOverview());
  } catch (error) {
    home.textContent = "";
    say(error.message, "bad");
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
    say("");
    overview = null;
    goHome(true);
    await route();
  } catch (error) {
    say(`ログインに失敗: ${error.message}`, "bad");
  } finally {
    setBusy(false);
  }
});

settingsButton.addEventListener("click", () => {
  location.hash = "#/settings";
});

for (const button of document.querySelectorAll("[data-back]")) {
  button.addEventListener("click", () => {
    // 戻り先が自分のアプリ内なら履歴を1つ戻す（詳細 → 全銘柄 が自然につながる）。
    // 通知や外部リンクから直接来た場合は履歴が無いのでホームへ落とす。
    if (history.length > 1) history.back();
    else goHome();
  });
}

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
  signOut();
  overview = null;
  say("ログアウトしました");
  goHome(true);
  await route();
});

window.addEventListener("hashchange", () => {
  route();
});

// セッションが切れたら（リフレッシュ失敗 / 401）ログイン画面へ戻す。
setSignedOutHandler(() => {
  overview = null;
  showView("login");
  say("セッションが切れました。もう一度ログインしてください。", "warn");
});

// 通知タップで開かれた／前面化されたときの着地。batch_done はホームに落とす。
navigator.serviceWorker?.addEventListener("message", async (event) => {
  if (event.data?.type !== "notification-click") return;
  const data = event.data.data || {};
  // 通知は「その日のバッチが終わった」合図なので、必ず最新を取り直してから出す。
  overview = null;
  if (data.ticker) location.hash = `#/s/${encodeURIComponent(data.ticker)}`;
  else if (location.hash && location.hash !== "#/") goHome();
  else await route();
});

// PWA を再前面化したときに古い日付のまま残らないようにする。
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState !== "visible" || !getSession()) return;
  if (parseRoute().name !== "home") return;
  try {
    await ensureOverview({ force: true });
    await route();
  } catch {
    /* 取れなければ表示中のものを残す */
  }
});

// ── 起動 ────────────────────────────────────────────────────────────────────

(async function start() {
  loadSession();

  if (getSession()) {
    await ensureFreshToken();
    // 通知から開かれた直後を除き、起動時はホームに揃える。
    if (!location.hash) history.replaceState(null, "", "#/");
  }

  await route();

  // 既にログイン済み・許可済みなら SW を登録しておく（購読状態の表示に要る）。
  if (pushSupported() && Notification.permission === "granted") {
    try {
      await getRegistration();
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
