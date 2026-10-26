// Hermes Mobile / 見本データ（画面の確認用）
//
// 本物の Supabase の代わりに Playwright が返す応答を作る。数字はすべて作り物で、
// 実在の銘柄・実際のスコアとは関係ない。形だけ本物（screening_results /
// scoring_breakdown / daily_articles / diff_reports）に合わせている。

const SECTORS = [
  "Industrials", "Consumer Cyclical", "Technology", "Basic Materials", "Real Estate",
  "Financial Services", "Consumer Defensive", "Healthcare", "Communication Services",
  "Utilities", "Energy",
];

// 乱数は種を固定（毎回同じ見本になるように）
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const rand = rng(20261027);
const gauss = () => {
  const u = rand() || 1e-9;
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

const KANA = ["サンプル", "見本", "架空", "テスト", "モデル", "例示"];
const KIND = ["工業", "化学", "商事", "電機", "建設", "不動産", "食品", "精機", "製作所", "ホールディングス"];

// 取引日（土日を除く）を新しい順に 70 日
function sessions(endIso, n) {
  const out = [];
  const d = new Date(`${endIso}T00:00:00Z`);
  while (out.length < n) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return out;
}
export const DATES = sessions("2026-10-26", 70); // [0] が最新

const STOCKS = Array.from({ length: 347 }, (_, i) => {
  const code = String(1300 + Math.floor(rand() * 8600)).padStart(4, "0");
  return {
    ticker: `${code}`,
    name: `${KANA[i % KANA.length]}${KIND[Math.floor(rand() * KIND.length)]}${i}`,
    sector: SECTORS[Math.floor(rand() ** 1.6 * SECTORS.length)],
    level: 44 + gauss() * 9,
    drift: gauss() * 0.08,
  };
});
// コードの重複を避ける
const seen = new Set();
for (const s of STOCKS) {
  while (seen.has(s.ticker)) s.ticker = String(Number(s.ticker) + 1);
  seen.add(s.ticker);
}

// 日付ごとのスコアと順位
export const SCREENING = new Map(); // date -> rows（rank 順）
DATES.slice().reverse().forEach((date, dayIndex) => {
  const rows = STOCKS.map((s) => {
    const v = s.level + s.drift * dayIndex + gauss() * 1.8;
    return { run_date: date, ticker: s.ticker, name: s.name, total_score: Math.round(v * 2) / 2 };
  });
  rows.sort((a, b) => b.total_score - a.total_score);
  rows.forEach((r, i) => {
    r.rank = i + 1;
  });
  SCREENING.set(date, rows);
});

function breakdownFor(stock, total) {
  const tech = Math.round((total * 0.32 + gauss() * 2) * 2) / 2;
  const fund = Math.round((total * 0.18 + gauss() * 1.5) * 2) / 2;
  const base = Math.round((total - tech - fund) * 2) / 2;
  return {
    name: stock.name,
    sector: stock.sector,
    total_score: total,
    watch_entry: rand() < 0.2,
    base_score: { floor: 10, per: 4, pbr: 6, roe: 3, price: 2, sector: 1, disclosure: -2, subtotal: base },
    technical_score: { macd: 4, ichimoku: 6, vwap: 2, fibonacci: -2, subtotal: tech },
    fundamental_score: { cashflow: 5, dividend: 3, subtotal: fund },
  };
}

export const WATCH = STOCKS.slice(40, 44).map((s) => ({ ticker: s.ticker, name: s.name }));
WATCH.push({ ticker: "9999", name: "圏外の見本" });

const ARTICLE = `# 2026/10/26 AIスクリーニング — 見本の記事

> Hermes は約350銘柄から割安・値動きの安定した銘柄群を毎日**絞り込む**ツールです。順位は「どれが上がるか」を当てるものではなく、検討する母集団を狭めるためのものです。

## 📊 今日のトップ3

| 順位 | 銘柄 | スコア |
|------|------|------|
| 1 | 見本工業（0000） | 72 |
| 2 | 見本化学（0001） | 69 |
| 3 | 見本商事（0002） | 68 |

これは画面の確認用の見本です。本物の記事は 18:00 のバッチが書きます。

## 📈 先週のトップ10 答え合わせ

| 順位 | 銘柄 | 騰落率 | 判定 |
|------|------|--------|------|
| 1 | 見本電機（0003） | +3.5% | ✅+1%以上 |
| 2 | 見本建設（0004） | -2.0% | ❌-2%以下 |

**勝率:** 1 / 2（50%）

> **勝率をどう受け取るか**
> ・この勝率は「Hermes が絞り込んだ銘柄群が、この期間どうだったか」の記録です。
`;

export const ARTICLES = DATES.slice(0, 8).map((d) => ({
  run_date: d,
  title: `${d.replaceAll("-", "/")} AIスクリーニング — 見本`,
  body: ARTICLE,
  created_at: `${d}T09:10:00Z`,
}));

function diffReport() {
  const first = SCREENING.get(DATES[4]);
  const last = SCREENING.get(DATES[0]);
  const lastBy = new Map(last.map((r) => [r.ticker, r]));
  const stocks = first.slice(0, 40).map((r) => {
    const l = lastBy.get(r.ticker);
    return {
      code: r.ticker,
      name: r.name,
      first_total: r.total_score,
      last_total: l.total_score,
      delta: Math.round((l.total_score - r.total_score) * 2) / 2,
    };
  });
  return {
    report_date: "2026-10-23",
    summary: "見本の週次サマリーです。上位 40 銘柄のうち、上昇と下降がほぼ半々でした。",
    payload: {
      days: 5,
      period_start: DATES[4],
      period_end: DATES[0],
      risers: stocks.filter((s) => s.delta > 0).length,
      fallers: stocks.filter((s) => s.delta < 0).length,
      flat: stocks.filter((s) => s.delta === 0).length,
      stocks,
    },
  };
}

const CHAT = [
  { role: "user", content: "今日の1位はなぜ高いの？", created_at: "2026-10-26T10:00:00Z" },
  {
    role: "assistant",
    content: "見本の回答です。**テクニカル**の小計が高く、MACD と一目均衡表が加点になっています。\n\n- 割安度（PBR）も加点\n- フィボナッチが -2",
    created_at: "2026-10-26T10:00:05Z",
  },
];

// ── PostgREST のクエリを最低限だけ読む ─────────────────────────────────────

function param(url, key) {
  return url.searchParams.get(key);
}
function eq(url, key) {
  const v = param(url, key);
  return v && v.startsWith("eq.") ? v.slice(3) : null;
}
function inValues(url, key) {
  const v = param(url, key);
  if (!v || !v.startsWith("in.(")) return null;
  return v
    .slice(4, -1)
    .split(",")
    .map((s) => s.replace(/^"|"$/g, ""));
}

/** テーブル名と URL から JSON を返す。知らない問い合わせは null。 */
export function answer(table, url) {
  if (table === "screening_results") {
    const select = param(url, "select");
    const limit = Number(param(url, "limit") || 0);
    const lt = param(url, "run_date")?.startsWith("lt.") ? param(url, "run_date").slice(3) : null;
    if (select === "run_date") {
      const dates = lt ? DATES.filter((d) => d < lt) : DATES;
      return dates.slice(0, limit || 1).map((d) => ({ run_date: d }));
    }
    const ticker = eq(url, "ticker");
    if (ticker) {
      const rows = DATES.map((d) => SCREENING.get(d).find((r) => r.ticker === ticker)).filter(Boolean);
      return rows.slice(0, limit || rows.length);
    }
    const tickers = inValues(url, "ticker");
    if (tickers) {
      const dates = inValues(url, "run_date") || [DATES[0]];
      return dates.flatMap((d) => (SCREENING.get(d) || []).filter((r) => tickers.includes(r.ticker)));
    }
    const date = eq(url, "run_date");
    if (date) return SCREENING.get(date) || [];
  }
  if (table === "scoring_breakdown") {
    const date = eq(url, "run_date");
    const ticker = eq(url, "ticker");
    if (ticker) {
      const stock = STOCKS.find((s) => s.ticker === ticker);
      const row = SCREENING.get(DATES[0]).find((r) => r.ticker === ticker);
      if (!stock || !row) return [];
      return [{ run_date: DATES[0], breakdown: breakdownFor(stock, row.total_score) }];
    }
    if (date) return STOCKS.map((s) => ({ ticker: s.ticker, sector: s.sector }));
  }
  if (table === "watchlist") return WATCH;
  if (table === "daily_articles") {
    const date = eq(url, "run_date");
    const rows = date ? ARTICLES.filter((a) => a.run_date === date) : ARTICLES;
    return rows.slice(0, Number(param(url, "limit") || rows.length));
  }
  if (table === "diff_reports") return [diffReport()];
  if (table === "chat_messages") return CHAT.slice().reverse();
  return null;
}
