// Hermes Mobile / アプリ本体
//
// やること:
//   1. Supabase にログインしてアクセストークンを持つ（session.js）
//   2. Service Worker を登録して Push を購読する
//   3. 購読(endpoint/p256dh/auth)を push_subscriptions に upsert する
//   4. ダッシュボードを出す（dashboard.js / グラフは charts.js）
//
// 依存ゼロ。supabase-js も使わず fetch で GoTrue と PostgREST を直接叩く。
// hermes-project 側（supabase_sync.py の urllib、send-push の fetch）と同じ作法で、
// ビルド工程が無いぶん GitHub Pages へは push するだけで配れる。

import { VAPID_PUBLIC_KEY } from "./config.js";
import {
  NetworkError,
  ensureFreshToken,
  getSession,
  loadSession,
  rememberedEmail,
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
  skeleton,
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
const refreshButton = $("refresh-button");
const tabbar = $("tabbar");
const headSub = $("head-sub");

const VIEWS = ["login", "home", "all", "detail", "article", "weekly", "chat", "settings"];

// 取得済みの一覧。全銘柄・詳細から使い回すのでここに持つ（再取得を避ける）。
let overview = null;

const isStandalone = () =>
  window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

// ── 表示 ────────────────────────────────────────────────────────────────────

function say(message, kind = "") {
  statusLine.textContent = message;
  statusLine.className = `status ${kind}`;
}

function setBusy(busy) {
  for (const el of document.querySelectorAll("button")) el.disabled = busy;
}

/** 今どのタブの画面か。詳細は来た元（銘柄）に、設定はどれにも当てない。 */
const TAB_OF = { home: "home", all: "all", detail: "all", article: "article", weekly: "weekly", chat: "chat" };

function showView(name, { keepScroll = false } = {}) {
  for (const view of VIEWS) $(`view-${view}`).hidden = view !== name;
  const signedIn = name !== "login";
  settingsButton.hidden = !signedIn;
  refreshButton.hidden = !signedIn || name === "settings" || name === "chat";
  tabbar.hidden = !signedIn;
  document.body.classList.toggle("has-tabbar", signedIn);
  for (const tab of tabbar.querySelectorAll(".tab")) {
    const on = tab.dataset.tab === TAB_OF[name];
    tab.classList.toggle("on", on);
    if (on) tab.setAttribute("aria-current", "page");
    else tab.removeAttribute("aria-current");
  }
  if (!keepScroll) window.scrollTo(0, 0);
}

/** ヘッダの下の行に「いつの取得か」を出す。古い画面を見ていないかが一目で分かる。 */
function showFetchedAt(date) {
  if (!date) {
    headSub.textContent = "日次スクリーニング";
    return;
  }
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  headSub.textContent = `${hh}:${mm} に取得`;
}

/**
 * 読み込みの失敗を、その画面の中に出す。通信の失敗ならやり直しのボタンを付ける。
 * （下の status 行だけだと、画面が空のまま理由が見えないことがある）
 */
function showError(body, error) {
  body.textContent = "";
  const box = document.createElement("div");
  box.className = "error-box";
  const text = document.createElement("p");
  text.textContent = error instanceof NetworkError
    ? error.message
    : `読み込めませんでした。${error.message}`;
  box.append(text);
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "ghost";
  retry.textContent = "もう一度読み込む";
  retry.addEventListener("click", () => refresh());
  box.append(retry);
  body.append(box);
}

/**
 * 画面を描き直す。前の中身があれば消さずに薄くして待つ（ちらつかせない）。
 * 無ければ骨組みを出す。
 */
async function paint(body, kind, work, key = kind) {
  // 別の銘柄・別の日付の中身は薄くして残さない（違うものを見せてしまうため）
  const sameThing = body.dataset.key === key;
  body.dataset.key = key;
  const hadContent = sameThing && body.childElementCount > 0 && !body.querySelector(".skeleton, .error-box");
  if (hadContent) body.classList.add("is-refreshing");
  else {
    body.textContent = "";
    body.append(skeleton(kind));
  }
  try {
    await work();
  } catch (error) {
    showError(body, error);
  } finally {
    body.classList.remove("is-refreshing");
  }
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

/** 一覧を持っていなければ取りに行く。 */
async function ensureOverview({ force = false } = {}) {
  if (overview && !force) return overview;
  overview = await loadOverview();
  showFetchedAt(overview.fetchedAt);
  return overview;
}

/** 前の route() がまだ読み込み中に次が来たら、前の結果は描かない。 */
let routeSeq = 0;

async function route({ force = false } = {}) {
  const seq = ++routeSeq;
  const stale = () => seq !== routeSeq;

  if (!getSession()) {
    // ログイン画面に戻った理由（期限切れなど）は消さずに残す
    showView("login");
    prepareLogin();
    return;
  }
  say("");

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
    await paint(body, "detail", async () => {
      const data = await ensureOverview({ force });
      const row = data.rows.find((r) => r.ticker === target.ticker)
        || data.watch.find((r) => r.ticker === target.ticker);
      const detail = await loadDetail(target.ticker, data.runDate);
      if (!stale()) renderDetail(body, detail, row);
    }, `detail:${target.ticker}`);
    return;
  }

  if (target.name === "all") {
    showView("all");
    const body = $("all-body");
    await paint(body, "list", async () => {
      const data = await ensureOverview({ force });
      if (!stale()) renderAll(body, data);
    });
    return;
  }

  if (target.name === "article") {
    showView("article");
    const body = $("article-body");
    await paint(body, "list", async () => {
      // 本文と一覧は独立。一覧が取れなくても記事は出す。
      const [article, index] = await Promise.all([
        loadArticle(target.runDate),
        loadArticleIndex().catch(() => []),
      ]);
      if (!stale()) renderArticle(body, article, index);
    }, `article:${target.runDate || "latest"}`);
    return;
  }

  if (target.name === "chat") {
    showView("chat");
    const body = $("chat-body");
    await paint(body, "list", async () => {
      // 過去ログの取得に失敗しても会話は始められる。ここで止めない。
      await loadBacklog().catch((error) => say(`過去ログを読めません: ${error.message}`, "warn"));
      const data = overview ? overview : await ensureOverview().catch(() => null);
      if (!stale()) renderChat(body, target.ticker, data?.runDate ?? null);
    }, `chat:${target.ticker || ""}`);
    return;
  }

  if (target.name === "weekly") {
    showView("weekly");
    const body = $("weekly-body");
    await paint(body, "list", async () => {
      const report = await loadDiffReport();
      if (!stale()) renderWeekly(body, report);
    });
    return;
  }

  // ホーム
  showView("home");
  const home = $("view-home");
  await paint(home, "home", async () => {
    const data = await ensureOverview({ force });
    if (!stale()) renderHome(home, data);
  });
}

/** 右上の更新。今の画面のデータを取り直す（一覧も）。 */
async function refresh() {
  refreshButton.classList.add("spinning");
  try {
    overview = null;
    await route({ force: true });
  } finally {
    refreshButton.classList.remove("spinning");
  }
}

// ── ログイン画面 ────────────────────────────────────────────────────────────

const emailInput = $("email");
const passwordInput = $("password");
const passwordToggle = $("password-toggle");

function prepareLogin() {
  if (!emailInput.value) emailInput.value = rememberedEmail();
  // ホーム画面のアプリと Safari はログインの保存場所が別。片方でログインしても
  // もう片方は未ログインのまま、という戸惑いを先に潰しておく。
  $("login-hint").textContent = isStandalone()
    ? "ホーム画面のアプリは Safari とは別にログインを覚えます。一度ログインすれば、次からは開くだけで入れます。"
    : "通知を受け取るには、Safari の共有メニューから「ホーム画面に追加」して、追加したアプリでログインしてください。";
}

passwordToggle.addEventListener("click", () => {
  const show = passwordInput.type === "password";
  passwordInput.type = show ? "text" : "password";
  passwordToggle.textContent = show ? "隠す" : "表示";
  passwordToggle.setAttribute("aria-pressed", String(show));
  passwordToggle.setAttribute("aria-label", show ? "パスワードを隠す" : "パスワードを表示");
});

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  setBusy(true);
  const loginError = $("login-error");
  loginError.hidden = true;
  say("ログイン中…");
  try {
    await signIn(emailInput.value.trim(), passwordInput.value);
    passwordInput.value = "";
    passwordInput.type = "password";
    passwordToggle.textContent = "表示";
    say("");
    overview = null;
    goHome(true);
    await route();
  } catch (error) {
    // 理由はボタンのすぐ上に出す（画面の下の行だと、キーボードに隠れて見えない）
    say("");
    loginError.textContent = error.message;
    loginError.hidden = false;
    passwordInput.focus();
  } finally {
    setBusy(false);
  }
});

// ── イベント ────────────────────────────────────────────────────────────────

settingsButton.addEventListener("click", () => {
  location.hash = "#/settings";
});

refreshButton.addEventListener("click", () => refresh());

for (const button of document.querySelectorAll("[data-back]")) {
  button.addEventListener("click", () => {
    // 戻り先が自分のアプリ内なら履歴を1つ戻す（詳細 → 全銘柄 が自然につながる）。
    // 通知や外部リンクから直接来た場合は履歴が無いのでホームへ落とす。
    if (history.length > 1) history.back();
    else goHome();
  });
}

// 今いるタブをもう一度押したら、先頭へ戻す（一覧を下まで見た後に便利）
for (const tab of tabbar.querySelectorAll(".tab")) {
  tab.addEventListener("click", (event) => {
    if (tab.classList.contains("on") && location.hash === tab.getAttribute("href")) {
      event.preventDefault();
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
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
  showFetchedAt(null);
  goHome(true);
  await route();
  say("ログアウトしました");
});

window.addEventListener("hashchange", () => {
  route();
});

// セッションが切れたら（更新トークンの失効 / 2 回続けての 401）ログイン画面へ戻す。
// 通信エラーではここに来ない（session.js が NetworkError として投げ、画面に残す）。
setSignedOutHandler((message) => {
  overview = null;
  showFetchedAt(null);
  showView("login");
  prepareLogin();
  say(message || "セッションが切れました。もう一度ログインしてください。", "warn");
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

// PWA を再前面化したとき、30 分以上前の取得なら取り直す。
// 取れなければ表示中のものを残す（ログアウトはしない）。
const STALE_MS = 30 * 60_000;
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState !== "visible" || !getSession()) return;
  const name = parseRoute().name;
  if (name !== "home" && name !== "all") return;
  if (overview && Date.now() - overview.fetchedAt.getTime() < STALE_MS) return;
  overview = null;
  await route({ force: true });
});

// ── 起動 ────────────────────────────────────────────────────────────────────

(async function start() {
  loadSession();

  if (getSession()) {
    try {
      await ensureFreshToken();
    } catch {
      // 起動直後で通信がまだ無い。セッションは残し、画面側で理由とやり直しを出す。
    }
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
    isStandalone() ? "PWA" : "ブラウザ",
  ].join(" / ");
})();
