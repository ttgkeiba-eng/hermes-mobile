// Hermes Mobile / セッションと Supabase への読み書き
//
// app.js から切り出した。Phase D でダッシュボードが増え、認証まわりを
// app.js（push 担当）と dashboard.js（表示担当）の両方から使うようになったため。
// 保存形式（localStorage の hermes.session）は Phase B から変えていない。
//
// 依存ゼロ。supabase-js は使わず fetch で GoTrue と PostgREST を直接叩く。
//
// ── ログインが切れる問題への対処（2026-10）──
// 以前は次の 2 つで、ログインしているのにログイン画面へ戻されることがあった。
//   1. トークンの更新に失敗すると、理由を問わずログアウトしていた。スマホは画面を開いた
//      直後に通信がまだ戻っていないことが多く、そのとき fetch が投げる「通信エラー」でも
//      セッションを捨てていた。→ 更新が**サーバに拒否されたとき**だけログアウトする。
//   2. 期限切れの状態でホームを開くと、3 本の読み込みがそれぞれ同時に更新しに行っていた。
//      GoTrue は更新トークンを使い捨てにする（rotation）ので、2 本目以降が古いトークンを
//      使うことになり、条件によってはセッションごと失効する。→ 更新は常に 1 本にまとめる。
// あわせて、PostgREST が 401 を返したときは一度だけ更新してやり直す（端末の時計のずれ等で
// 「まだ有効」と判断したトークンが実は切れていた場合に、いきなりログアウトしない）。

import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

const SESSION_KEY = "hermes.session";
const EMAIL_KEY = "hermes.email";

/** 期限のこれだけ前に更新する。iPhone の時計が多少ずれていても間に合う幅。 */
const REFRESH_MARGIN_MS = 5 * 60_000;

let session = null;
/** 実行中の更新。同時に呼ばれても 1 本だけ走らせ、全員が同じ結果を待つ。 */
let refreshing = null;
/** セッションが切れた／ログアウトしたときに呼ばれる。app.js が画面の出し直しを繋ぐ。 */
let onSignedOut = () => {};

export function setSignedOutHandler(handler) {
  onSignedOut = handler;
}

export function getSession() {
  return session;
}

// localStorage は端末の設定やプライベートブラウズで投げることがある。投げても画面は出す。
function storageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function storageSet(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* 保存できなくても、このタブの間はメモリ上のセッションで動く */
  }
}

export function loadSession() {
  try {
    const raw = storageGet(SESSION_KEY);
    session = raw ? JSON.parse(raw) : null;
  } catch {
    session = null;
  }
  return session;
}

function saveSession(value) {
  session = value;
  storageSet(SESSION_KEY, value ? JSON.stringify(value) : null);
}

/** 前回ログインしたメールアドレス。ログイン画面に入れておく。 */
export function rememberedEmail() {
  return storageGet(EMAIL_KEY) || "";
}

export function signOut() {
  // 購読は消さない。ログアウトしても同じ端末で再ログインすれば通知は続く。
  saveSession(null);
}

/** 通信そのものが届かなかった（圏外・復帰直後・サーバが落ちている）。ログアウトはしない。 */
export class NetworkError extends Error {
  constructor(message = "通信できません。電波の状態を確かめて、もう一度読み込んでください。") {
    super(message);
    this.name = "NetworkError";
  }
}

/** サーバが認証を拒否した。セッションはもう使えない。 */
class AuthRejected extends Error {}

// GoTrue の英語のエラーを、何をすればよいかが分かる日本語に直す。
const AUTH_MESSAGES = [
  [/invalid login credentials/i, "メールアドレスかパスワードが違います。"],
  [/email not confirmed/i, "メールアドレスの確認が済んでいません。Supabase の Users で Confirm してください。"],
  [/too many requests|rate limit/i, "試行回数が多すぎます。少し待ってからもう一度ログインしてください。"],
  [/user not found/i, "このメールアドレスのユーザーがいません。"],
  [/missing email|missing password/i, "メールアドレスとパスワードを入れてください。"],
];

function authMessage(payload, status) {
  const raw = payload.error_description || payload.msg || payload.message || payload.error || "";
  for (const [pattern, text] of AUTH_MESSAGES) if (pattern.test(raw)) return text;
  if (status >= 500) return "認証サーバが応答しません。少し待ってからもう一度試してください。";
  return raw ? `ログインできませんでした（${raw}）` : `ログインできませんでした（HTTP ${status}）`;
}

async function authFetch(path, body) {
  let response;
  try {
    response = await fetch(`${SUPABASE_URL}/auth/v1/${path}`, {
      method: "POST",
      headers: { apikey: SUPABASE_ANON_KEY, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new NetworkError();
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    // 4xx はトークン／資格情報が拒否された。5xx はサーバ側の都合なのでセッションは捨てない。
    if (response.status >= 400 && response.status < 500) {
      throw new AuthRejected(authMessage(payload, response.status));
    }
    throw new NetworkError(authMessage(payload, response.status));
  }
  return payload;
}

function storeToken(payload) {
  saveSession({
    access_token: payload.access_token,
    refresh_token: payload.refresh_token,
    // expires_in は「発行からの秒数」。実時刻に直して保存する。
    expires_at: Date.now() + (payload.expires_in ?? 3600) * 1000,
    email: payload.user?.email ?? session?.email ?? "",
  });
}

export async function signIn(email, password) {
  if (!email || !password) throw new Error("メールアドレスとパスワードを入れてください。");
  try {
    storeToken(await authFetch("token?grant_type=password", { email, password }));
  } catch (error) {
    // ログイン画面では「拒否」も「通信」も文字で見せるだけ。種類は呼び出し側に要らない。
    throw new Error(error.message);
  }
  storageSet(EMAIL_KEY, email);
}

function expireSession(message) {
  saveSession(null);
  onSignedOut(message);
}

/** 更新を 1 本だけ走らせる。走っていればそれを待つ。 */
function refreshOnce() {
  if (!refreshing) {
    const token = session?.refresh_token;
    refreshing = (async () => {
      try {
        storeToken(await authFetch("token?grant_type=refresh_token", { refresh_token: token }));
        return session.access_token;
      } catch (error) {
        if (error instanceof AuthRejected) {
          // 更新トークンが失効している。作り直しはできないので再ログイン。
          expireSession("ログインの有効期限が切れました。もう一度ログインしてください。");
          return null;
        }
        throw error; // 通信エラーはセッションを残したまま呼び出し側へ
      } finally {
        refreshing = null;
      }
    })();
  }
  return refreshing;
}

/**
 * 期限が近ければ更新して、使えるアクセストークンを返す。
 * PWA は何日も開きっぱなしになるので、操作のたびに軽く見ておく。
 * 通信できなければ NetworkError を投げる（ログアウトはしない）。
 */
export async function ensureFreshToken({ force = false } = {}) {
  if (!session) return null;
  if (!force && session.expires_at - Date.now() > REFRESH_MARGIN_MS) return session.access_token;
  return await refreshOnce();
}

// ── PostgREST ───────────────────────────────────────────────────────────────

async function fetchWithToken(url, options, token) {
  try {
    return await fetch(url, {
      ...options,
      headers: {
        apikey: SUPABASE_ANON_KEY,
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(options.headers || {}),
      },
    });
  } catch {
    throw new NetworkError();
  }
}

/**
 * PostgREST を叩く。認証は**ログイン中のユーザーの JWT**（= authenticated ロール）で、
 * anon キーは apikey ヘッダにしか使わない。anon はどのテーブルにも権限が無いので、
 * トークンが無い／切れている状態では 401 になり、静かに空を返すことはない。
 *
 * service_role キーはアプリに置かない。RLS をバイパスしてしまうため。
 */
export async function rest(path, options = {}) {
  let token = await ensureFreshToken();
  if (!token) throw new Error("ログインが必要です");

  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  let response = await fetchWithToken(url, options, token);

  if (response.status === 401) {
    // 手元では有効なはずのトークンが拒否された。一度だけ更新してやり直す。
    token = await ensureFreshToken({ force: true });
    if (!token) throw new Error("ログインが必要です");
    response = await fetchWithToken(url, options, token);
    if (response.status === 401) {
      expireSession("セッションが切れました。もう一度ログインしてください。");
      throw new Error("セッションが切れました。もう一度ログインしてください。");
    }
  }
  if (!response.ok) {
    throw new Error(`取得に失敗しました（HTTP ${response.status}）: ${(await response.text()).slice(0, 200)}`);
  }
  if (options.method && options.method !== "GET") return null;
  return await response.json();
}

/** GET 専用の薄い糖衣。テーブル名とクエリ文字列を渡す。 */
export function select(query) {
  return rest(query, { method: "GET" });
}

// ── Edge Functions ──────────────────────────────────────────────────────────

/**
 * Edge Function を **ログイン中のユーザーの JWT** で叩く（Phase C の chat）。
 *
 * anon キーを apikey ヘッダに乗せない。chat 側は GET /auth/v1/user で実ユーザーを
 * 確認しており、公開キーだけでは 401 を返す。ここで anon キーを足すと、その意図が
 * 分かりにくくなるだけで通りやすくもならない。
 */
export async function callFunction(name, body) {
  const call = async (token) => {
    try {
      return await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      throw new NetworkError();
    }
  };

  let token = await ensureFreshToken();
  if (!token) throw new Error("ログインが必要です");
  let response = await call(token);

  if (response.status === 401) {
    token = await ensureFreshToken({ force: true });
    if (!token) throw new Error("ログインが必要です");
    response = await call(token);
    if (response.status === 401) {
      expireSession("セッションが切れました。もう一度ログインしてください。");
      throw new Error("セッションが切れました。もう一度ログインしてください。");
    }
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  return payload;
}
