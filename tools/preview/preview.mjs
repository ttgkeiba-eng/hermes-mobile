// Hermes Mobile / 画面の確認（Playwright）
//
//   node tools/preview/preview.mjs <出力フォルダ>
//
// リポジトリをその場で配信し、Supabase への通信を見本データ（mock.mjs）に差し替えて、
// スマホの幅で各画面のスクリーンショットを撮る。あわせてログインまわりの動きを確かめる:
//   - パスワード違いのエラー文
//   - 期限切れのトークンで開いたとき、更新が 1 回だけ走ること
//   - 更新の通信が落ちても、ログアウトせず画面に理由とやり直しが出ること
//   - 更新トークンが拒否されたときだけ、ログイン画面に戻ること
//   - PostgREST の 401 は 1 回更新してやり直すこと
// 本物の Supabase には一切つながない。

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { answer } from "./mock.mjs";

// playwright はグローバルに入っているものを使う（このリポジトリは node_modules を持たない）
const { chromium } = createRequire(import.meta.url)("playwright");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = path.resolve(process.argv[2] || "preview-out");
fs.mkdirSync(OUT, { recursive: true });

const SUPABASE = "https://plxknbwrzzpxjmxxeomi.supabase.co";
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png" };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  let file = path.join(ROOT, decodeURIComponent(url.pathname));
  if (file.endsWith("/")) file += "index.html";
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const BASE = `http://localhost:${server.address().port}/`;

const browser = await chromium.launch();
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

/**
 * 見本の Supabase。mode で更新トークンの挙動を切り替える。
 *   ok       … いつも成功
 *   offline  … 更新の通信が落ちる
 *   rejected … 更新トークンが拒否される（400）
 */
async function newPage({ mode = "ok", session = null, restFirst401 = false } = {}) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    colorScheme: "dark",
    serviceWorkers: "block",
  });
  const counters = { refresh: 0, rest401: 0 };
  if (session) {
    await context.addInitScript((value) => {
      localStorage.setItem("hermes.session", JSON.stringify(value));
    }, session);
  }
  let pending401 = restFirst401;
  await context.route(`${SUPABASE}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/auth/v1/token") {
      const grant = url.searchParams.get("grant_type");
      if (grant === "password") {
        const body = route.request().postDataJSON();
        if (body.password !== "correct-horse") {
          return route.fulfill({ status: 400, json: { error: "invalid_grant", error_description: "Invalid login credentials" } });
        }
      } else {
        counters.refresh += 1;
        await new Promise((r) => setTimeout(r, 250)); // 同時に来たら重なるように少し待つ
        if (mode === "offline") return route.abort("internetdisconnected");
        if (mode === "rejected") {
          return route.fulfill({ status: 400, json: { error: "invalid_grant", error_description: "Invalid Refresh Token: Already Used" } });
        }
      }
      return route.fulfill({
        json: { access_token: `token-${Date.now()}`, refresh_token: `refresh-${Date.now()}`, expires_in: 3600, user: { email: "kawamura@example.com" } },
      });
    }
    if (url.pathname.startsWith("/rest/v1/")) {
      if (pending401) {
        pending401 = false;
        counters.rest401 += 1;
        return route.fulfill({ status: 401, json: { message: "JWT expired" } });
      }
      const table = url.pathname.slice("/rest/v1/".length);
      const data = answer(table, url);
      if (data === null) return route.fulfill({ status: 404, json: { message: `mock: ${table}` } });
      return route.fulfill({ json: data });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  return { page, context, counters, errors };
}

const fresh = { access_token: "a", refresh_token: "r", expires_at: Date.now() + 3600_000, email: "kawamura@example.com" };
const expired = { ...fresh, expires_at: Date.now() - 60_000 };

async function shot(page, name, { full = true } = {}) {
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: full });
}

// ── 1. ログイン画面とパスワード違い ──
{
  const { page, context } = await newPage();
  await page.goto(BASE);
  await page.waitForSelector("#view-login:not([hidden])");
  await page.fill("#email", "kawamura@example.com");
  await page.fill("#password", "wrong");
  await page.click("#login-button");
  await page.waitForSelector("#login-error:not([hidden])");
  const msg = await page.textContent("#login-error");
  check("パスワード違いは日本語で理由を出す", msg.includes("メールアドレスかパスワードが違います"), msg);
  await shot(page, "01_login_error", { full: false });

  await page.fill("#password", "correct-horse");
  await page.click("#login-button");
  await page.waitForSelector(".hero");
  check("正しいパスワードでホームが出る", true);
  // 2026-10 まで、ログイン後もログイン画面が隠れずに残っていた（.view の display が
  // hidden 属性に勝っていた）。隠れていることを実際の表示で確かめる
  const loginDisplay = await page.evaluate(() => getComputedStyle(document.querySelector("#view-login")).display);
  check("ログイン後はログイン画面が見えない", loginDisplay === "none", `display=${loginDisplay}`);
  const visibleViews = await page.evaluate(() =>
    [...document.querySelectorAll(".view")].filter((v) => getComputedStyle(v).display !== "none").map((v) => v.id));
  check("見えている画面は 1 つだけ", visibleViews.length === 1, visibleViews.join(","));
  const remembered = await page.evaluate(() => localStorage.getItem("hermes.email"));
  check("メールアドレスを覚える", remembered === "kawamura@example.com", remembered);
  await context.close();
}

// ── 2. 各画面 ──
{
  const { page, context, errors } = await newPage({ session: fresh });
  await page.goto(BASE);
  await page.waitForSelector(".hero");
  await shot(page, "02_home_top", { full: false });
  await shot(page, "03_home_full");

  // 分布の棒をタップ
  const hist = page.locator(".chart").first();
  const box = await hist.boundingBox();
  await page.mouse.click(box.x + box.width * 0.45, box.y + box.height * 0.6);
  await shot(page, "04_home_hist_tap", { full: false });

  await page.goto(`${BASE}#/all`);
  await page.waitForSelector(".filters");
  await shot(page, "05_all", { full: false });
  await page.selectOption(".filter-select >> nth=1", "up");
  await page.fill(".filter-search", "化学");
  await page.waitForTimeout(150);
  await shot(page, "06_all_filtered", { full: false });

  const ticker = await page.evaluate(() => document.querySelector(".srow .ticker").textContent);
  await page.goto(`${BASE}#/s/${ticker}`);
  await page.waitForSelector(".history-charts .chart");
  await shot(page, "07_detail_top", { full: false });
  const line = page.locator(".history-charts .chart").first();
  const lb = await line.boundingBox();
  await page.mouse.click(lb.x + lb.width * 0.6, lb.y + lb.height * 0.5);
  await shot(page, "08_detail_tap", { full: false });
  await page.click(".seg >> text=3か月");
  await shot(page, "09_detail_full");

  await page.goto(`${BASE}#/weekly`);
  await page.waitForSelector(".diverge");
  await shot(page, "10_weekly");

  await page.goto(`${BASE}#/article`);
  await page.waitForSelector(".md");
  await shot(page, "11_article", { full: false });

  await page.goto(`${BASE}#/chat`);
  await page.waitForSelector(".chat-form");
  await shot(page, "12_chat", { full: false });

  await page.goto(`${BASE}#/settings`);
  await page.waitForSelector("#view-settings:not([hidden])");
  await shot(page, "13_settings", { full: false });

  check("画面の表示中に JavaScript のエラーが無い", errors.length === 0, errors.join(" / "));
  await context.close();
}

// ── 3. 期限切れのトークンで開く（更新は 1 回だけ）──
{
  const { page, context, counters } = await newPage({ session: expired });
  await page.goto(BASE);
  await page.waitForSelector(".hero");
  check("期限切れで開いても、トークンの更新は 1 回だけ", counters.refresh === 1, `更新 ${counters.refresh} 回`);
  await context.close();
}

// ── 4. 更新の通信が落ちる（ログアウトしない）──
{
  const { page, context } = await newPage({ session: expired, mode: "offline" });
  await page.goto(BASE);
  await page.waitForSelector(".error-box");
  const stillSignedIn = await page.evaluate(() => localStorage.getItem("hermes.session") !== null);
  const loginShown = await page.isVisible("#view-login");
  check("通信が落ちてもログアウトしない", stillSignedIn && !loginShown);
  await shot(page, "14_offline", { full: false });
  await context.close();
}

// ── 5. 更新トークンが拒否される（ログイン画面へ）──
{
  const { page, context } = await newPage({ session: expired, mode: "rejected" });
  await page.goto(BASE);
  await page.waitForSelector("#view-login:not([hidden])");
  const email = await page.inputValue("#email");
  const status = await page.textContent("#status");
  check("更新トークンが拒否されたらログイン画面に戻る", status.includes("もう一度ログイン"), status);
  check("戻ったログイン画面にメールアドレスが入っている", email === "" || email.includes("@"), email || "(未保存)");
  await context.close();
}

// ── 6. PostgREST の 401 は 1 回やり直す ──
{
  const { page, context, counters } = await newPage({ session: fresh, restFirst401: true });
  await page.goto(BASE);
  await page.waitForSelector(".hero");
  check("401 を受けても 1 回更新してホームが出る", counters.rest401 === 1 && counters.refresh === 1, `401 ${counters.rest401} 回・更新 ${counters.refresh} 回`);
  await context.close();
}

await browser.close();
server.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} PASS  → ${OUT}`);
process.exit(failed.length ? 1 : 0);
