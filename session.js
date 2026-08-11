// Hermes Mobile / セッションと Supabase への読み書き
//
// app.js から切り出した。Phase D でダッシュボードが増え、認証まわりを
// app.js（push 担当）と dashboard.js（表示担当）の両方から使うようになったため。
// 挙動は Phase B のときと同じで、保存形式（localStorage の hermes.session）も変えていない。
//
// 依存ゼロ。supabase-js は使わず fetch で GoTrue と PostgREST を直接叩く。

import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

const SESSION_KEY = "hermes.session";

let session = null;
/** セッションが切れた／ログアウトしたときに呼ばれる。app.js が画面の出し直しを繋ぐ。 */
let onSignedOut = () => {};

export function setSignedOutHandler(handler) {
  onSignedOut = handler;
}

export function getSession() {
  return session;
}

export function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    session = raw ? JSON.parse(raw) : null;
  } catch {
    session = null;
  }
  return session;
}

function saveSession(value) {
  session = value;
  if (value) localStorage.setItem(SESSION_KEY, JSON.stringify(value));
  else localStorage.removeItem(SESSION_KEY);
}

export function signOut() {
  // 購読は消さない。ログアウトしても同じ端末で再ログインすれば通知は続く。
  saveSession(null);
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

export async function signIn(email, password) {
  storeToken(await authFetch("token?grant_type=password", { email, password }));
}

/**
 * 期限が近ければリフレッシュする。
 * PWA は何日も開きっぱなしになるので、操作のたびに軽く見ておく。
 */
export async function ensureFreshToken() {
  if (!session) return null;
  if (session.expires_at - Date.now() > 60_000) return session.access_token;
  try {
    storeToken(await authFetch("token?grant_type=refresh_token", { refresh_token: session.refresh_token }));
    return session.access_token;
  } catch {
    // リフレッシュトークンごと失効している。作り直しはできないので再ログイン。
    saveSession(null);
    onSignedOut();
    return null;
  }
}

// ── PostgREST ───────────────────────────────────────────────────────────────

/**
 * PostgREST を叩く。認証は**ログイン中のユーザーの JWT**（= authenticated ロール）で、
 * anon キーは apikey ヘッダにしか使わない。anon はどのテーブルにも権限が無いので、
 * トークンが無い／切れている状態では 401 になり、静かに空を返すことはない。
 *
 * service_role キーはアプリに置かない。RLS をバイパスしてしまうため。
 */
export async function rest(path, options = {}) {
  const token = await ensureFreshToken();
  if (!token) throw new Error("ログインが必要です");

  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_ANON_KEY,
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });

  if (response.status === 401) {
    // トークンは持っていたが拒否された（サーバ側で失効・鍵の入れ替え等）。
    saveSession(null);
    onSignedOut();
    throw new Error("セッションが切れました。もう一度ログインしてください。");
  }
  if (!response.ok) {
    throw new Error(`取得に失敗: HTTP ${response.status} ${await response.text()}`);
  }
  if (options.method && options.method !== "GET") return null;
  return await response.json();
}

/** GET 専用の薄い糖衣。テーブル名とクエリ文字列を渡す。 */
export function select(query) {
  return rest(query, { method: "GET" });
}
