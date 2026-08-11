// Hermes Mobile / ダッシュボード（Phase D）
//
// 読み取り専用の画面を 3 つ持つ:
//
//   ホーム   … 最新 run_date の 1 位（ヒーロー）／2・3 位／全銘柄への導線／
//              ウォッチリストの変動
//   全銘柄   … 最新 run_date を rank 昇順で全件
//   銘柄詳細 … scoring_breakdown の内訳とスコア推移
//
// データはすべて **ログイン中のユーザーの JWT** で PostgREST から読む（RLS 経由）。
// 書き込みは一切しない。VPS 本体と Supabase のスキーマには触れていない。
//
// 内訳の可視化は breakdown の**実際の形に追従する**。キー名を決め打ちせず、
// 「値がオブジェクトのものはグループ」「その中の数値は項目」「subtotal があれば
// グループの小計」という構造だけを仮定する。バッチ側が項目を足しても画面は壊れない。

import { select } from "./session.js";

// ── 表示ラベル ──────────────────────────────────────────────────────────────
//
// 未知のキーはそのまま出す（決め打ちしない）。ここにあるのは「今 DB に入っている
// キーを日本語で読めるようにする」ための辞書で、無くても画面は成立する。

const GROUP_LABELS = {
  base_score: "基礎スコア",
  technical_score: "テクニカル",
  fundamental_score: "ファンダメンタル",
};

const ITEM_LABELS = {
  floor: "ベース点",
  per: "PER",
  pbr: "PBR",
  roe: "ROE",
  price: "株価水準",
  sector: "セクター",
  disclosure: "開示",
  macd: "MACD",
  ichimoku: "一目均衡表",
  vwap: "VWAP",
  fibonacci: "フィボナッチ",
  cashflow: "キャッシュフロー",
  dividend: "配当",
};

const SECTOR_LABELS = {
  "Basic Materials": "素材",
  "Communication Services": "通信サービス",
  "Consumer Cyclical": "一般消費財",
  "Consumer Defensive": "生活必需品",
  Energy: "エネルギー",
  "Financial Services": "金融",
  Healthcare: "ヘルスケア",
  Industrials: "資本財",
  "Real Estate": "不動産",
  Technology: "情報技術",
  Utilities: "公益",
};

// ── 小道具 ──────────────────────────────────────────────────────────────────

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const num = (value) => (value === null || value === undefined ? NaN : Number(value));

/** スコアは小数第1位まで持っているが、.0 は落として読みやすくする。 */
function fmtScore(value) {
  const n = num(value);
  if (!Number.isFinite(n)) return "—";
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/** 前回比。0 と「前回データ無し」を区別する。 */
function fmtDelta(delta) {
  if (delta === null || !Number.isFinite(delta)) return { text: "—", kind: "flat" };
  if (delta === 0) return { text: "±0", kind: "flat" };
  const sign = delta > 0 ? "+" : "−";
  const body = Math.abs(delta);
  return {
    text: `${sign}${Number.isInteger(body) ? body : body.toFixed(1)}`,
    kind: delta > 0 ? "up" : "down",
  };
}

function fmtDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${y}/${m}/${d}`;
}

/** PostgREST の in.(...) 用。ticker は数字4桁だが、念のため引用してエスケープする。 */
function inList(values) {
  return values.map((v) => `"${String(v).replace(/"/g, '\\"')}"`).join(",");
}

// ── データ取得 ──────────────────────────────────────────────────────────────

/**
 * ホームと全銘柄が使う 1 セット。
 * 最新 run_date とその 1 つ前を引き、前回比を突き合わせる。
 */
export async function loadOverview() {
  const latestRow = await select("screening_results?select=run_date&order=run_date.desc&limit=1");
  if (!latestRow.length) return { runDate: null, rows: [], watch: [] };
  const runDate = latestRow[0].run_date;

  const prevRow = await select(
    `screening_results?select=run_date&run_date=lt.${runDate}&order=run_date.desc&limit=1`,
  );
  const prevDate = prevRow.length ? prevRow[0].run_date : null;

  const [rows, prevRows, watch] = await Promise.all([
    select(
      `screening_results?select=rank,ticker,name,total_score&run_date=eq.${runDate}&order=rank.asc`,
    ),
    prevDate
      ? select(`screening_results?select=rank,ticker,total_score&run_date=eq.${prevDate}`)
      : Promise.resolve([]),
    select("watchlist?select=ticker,name&active=is.true&order=ticker.asc"),
  ]);

  const prevByTicker = new Map(prevRows.map((r) => [r.ticker, r]));
  const ranked = rows.map((r) => {
    const prev = prevByTicker.get(r.ticker);
    return {
      ...r,
      score: num(r.total_score),
      delta: prev ? num(r.total_score) - num(prev.total_score) : null,
      rankDelta: prev ? num(prev.rank) - num(r.rank) : null,
      isNew: !prev,
    };
  });

  return {
    runDate,
    prevDate,
    rows: ranked,
    watch: await resolveWatchlist(watch, ranked, prevByTicker, runDate, prevDate),
  };
}

/**
 * ウォッチリストを最新スコアと突き合わせる。
 *
 * screening_results は上位 N 銘柄しか持たないので、ウォッチしている銘柄が
 * そこに居るとは限らない。居ない場合は「圏外」として、勝手に 0 点扱いしない。
 */
async function resolveWatchlist(watch, ranked, prevByTicker, runDate, prevDate) {
  if (!watch.length) return [];

  const rankedByTicker = new Map(ranked.map((r) => [r.ticker, r]));
  const missing = watch.map((w) => w.ticker).filter((t) => !rankedByTicker.has(t));

  // 上位 N の外に居る銘柄だけ、直接その行を取りに行く（無ければ本当に圏外）。
  let outside = [];
  if (missing.length) {
    const dates = prevDate ? `${runDate},${prevDate}` : runDate;
    outside = await select(
      `screening_results?select=run_date,rank,ticker,total_score` +
        `&ticker=in.(${encodeURIComponent(inList(missing))})` +
        `&run_date=in.(${dates})`,
    );
  }
  const outsideLatest = new Map(
    outside.filter((r) => r.run_date === runDate).map((r) => [r.ticker, r]),
  );
  const outsidePrev = new Map(
    outside.filter((r) => r.run_date === prevDate).map((r) => [r.ticker, r]),
  );

  return watch.map((w) => {
    const hit = rankedByTicker.get(w.ticker);
    if (hit) return { ticker: w.ticker, name: w.name || hit.name, ...hit, ranked: true };

    const latest = outsideLatest.get(w.ticker);
    const prev = outsidePrev.get(w.ticker) || prevByTicker.get(w.ticker);
    if (!latest) return { ticker: w.ticker, name: w.name, score: NaN, delta: null, ranked: false };
    return {
      ticker: w.ticker,
      name: w.name,
      rank: latest.rank,
      score: num(latest.total_score),
      delta: prev ? num(latest.total_score) - num(prev.total_score) : null,
      ranked: true,
    };
  });
}

/** 銘柄詳細。内訳（最新 run_date）とスコア推移をまとめて取る。 */
export async function loadDetail(ticker, runDate) {
  const [breakdownRows, history] = await Promise.all([
    select(
      `scoring_breakdown?select=run_date,breakdown&ticker=eq.${encodeURIComponent(ticker)}` +
        `&order=run_date.desc&limit=1`,
    ),
    select(
      `screening_results?select=run_date,rank,total_score&ticker=eq.${encodeURIComponent(ticker)}` +
        `&order=run_date.desc&limit=10`,
    ),
  ]);
  return {
    ticker,
    runDate,
    breakdown: breakdownRows.length ? breakdownRows[0].breakdown : null,
    breakdownDate: breakdownRows.length ? breakdownRows[0].run_date : null,
    history: history.slice().reverse(), // 古い→新しい（グラフの並び）
  };
}

// ── 部品 ────────────────────────────────────────────────────────────────────

function deltaChip(delta) {
  const { text, kind } = fmtDelta(delta);
  const chip = el("span", `delta ${kind}`);
  chip.append(el("span", "delta-arrow", kind === "up" ? "▲" : kind === "down" ? "▼" : "—"));
  chip.append(el("span", "delta-value", text));
  return chip;
}

/** カード・行の共通クリック処理。タップで銘柄詳細へ。 */
function linkTo(node, ticker) {
  node.tabIndex = 0;
  node.setAttribute("role", "link");
  const go = () => {
    location.hash = `#/s/${ticker}`;
  };
  node.addEventListener("click", go);
  node.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      go();
    }
  });
  return node;
}

function heroCard(row) {
  const card = el("article", "hero");
  const top = el("div", "hero-top");
  top.append(el("span", "crown", "1"));
  const label = el("div", "hero-label");
  label.append(el("span", "ticker", row.ticker));
  label.append(el("span", "name", row.name || ""));
  top.append(label);
  card.append(top);

  const scoreRow = el("div", "hero-score");
  scoreRow.append(el("span", "hero-number mono", fmtScore(row.score)));
  scoreRow.append(el("span", "hero-unit", "点"));
  card.append(scoreRow);

  const meta = el("div", "hero-meta");
  meta.append(el("span", "meta-label", "前回比"));
  meta.append(deltaChip(row.delta));
  if (row.isNew) meta.append(el("span", "tag", "新規"));
  card.append(meta);

  return linkTo(card, row.ticker);
}

function runnerCard(row) {
  const card = el("article", "runner");
  card.append(el("span", "runner-rank", `${row.rank}`));
  card.append(el("span", "ticker", row.ticker));
  card.append(el("span", "name", row.name || ""));
  const score = el("div", "runner-score");
  score.append(el("span", "runner-number mono", fmtScore(row.score)));
  score.append(deltaChip(row.delta));
  card.append(score);
  return linkTo(card, row.ticker);
}

function stockRow(row, { showRank = true } = {}) {
  const line = el("div", "srow");
  if (showRank) line.append(el("span", "srow-rank mono", Number.isFinite(num(row.rank)) ? `${row.rank}` : "—"));
  const label = el("div", "srow-label");
  label.append(el("span", "ticker", row.ticker));
  label.append(el("span", "name", row.name || ""));
  line.append(label);

  const right = el("div", "srow-right");
  if (Number.isFinite(row.score)) {
    right.append(el("span", "srow-score mono", fmtScore(row.score)));
    right.append(deltaChip(row.delta));
  } else {
    right.append(el("span", "srow-out", "圏外"));
  }
  line.append(right);
  return linkTo(line, row.ticker);
}

// ── ホーム ──────────────────────────────────────────────────────────────────

export function renderHome(root, data) {
  root.textContent = "";

  if (!data.runDate) {
    root.append(el("p", "empty", "スクリーニング結果がまだありません。"));
    return;
  }

  const head = el("div", "section-head");
  head.append(el("span", "run-date", `${fmtDate(data.runDate)} 時点`));
  head.append(el("span", "run-count", `上位 ${data.rows.length} 銘柄`));
  root.append(head);

  const [first, second, third] = data.rows;
  if (first) root.append(heroCard(first));

  if (second || third) {
    const grid = el("div", "grid-2");
    if (second) grid.append(runnerCard(second));
    if (third) grid.append(runnerCard(third));
    root.append(grid);
  }

  const allButton = el("button", "wide", `全 ${data.rows.length} 銘柄を見る`);
  allButton.type = "button";
  allButton.addEventListener("click", () => {
    location.hash = "#/all";
  });
  root.append(allButton);

  // ── ウォッチリストの変動 ──
  const block = el("section", "block");
  block.append(el("h2", null, "ウォッチリストの変動"));
  if (!data.watch.length) {
    block.append(
      el("p", "empty", "ウォッチリストは空です。銘柄を登録すると、ここに前回比が並びます。"),
    );
  } else {
    const list = el("div", "rows");
    for (const row of data.watch) list.append(stockRow(row));
    block.append(list);
  }
  root.append(block);

  root.append(
    el(
      "p",
      "disclaimer",
      "スコアはスクリーニングの並べ替えに使う指標です。売買の判断を示すものではありません。",
    ),
  );
}

// ── 全銘柄 ──────────────────────────────────────────────────────────────────

export function renderAll(root, data) {
  root.textContent = "";
  const head = el("div", "section-head");
  head.append(el("span", "run-date", `${fmtDate(data.runDate)} 時点`));
  head.append(el("span", "run-count", `${data.rows.length} 銘柄`));
  root.append(head);

  const list = el("div", "rows");
  for (const row of data.rows) list.append(stockRow(row));
  root.append(list);
}

// ── 銘柄詳細 ────────────────────────────────────────────────────────────────

/**
 * 内訳グループを 1 つ描く。
 * 棒の長さはグループ内の最大絶対値で正規化する。base_score は floor（ベース点）が
 * 大きいので他が短くなるが、これは実際の寄与どおりで、意図的にそのまま見せている。
 */
const BAR_MIN_SCALE = 5;

function breakdownGroup(key, value) {
  const entries = Object.entries(value).filter(
    ([k, v]) => k !== "subtotal" && Number.isFinite(num(v)),
  );
  if (!entries.length) return null;

  entries.sort((a, b) => Math.abs(num(b[1])) - Math.abs(num(a[1])));
  // 棒はグループ内の最大絶対値で正規化する。ただし分母には下限を置く。
  // グループ内で 1 項目しか動いていない日（例: フィボナッチ -2 だけ）に、その -2 が
  // 満幅で描かれて「大きく減点された」ように見えるのを防ぐ。
  const maxAbs = Math.max(...entries.map(([, v]) => Math.abs(num(v))), BAR_MIN_SCALE);

  const group = el("section", "bd-group");
  const head = el("div", "bd-head");
  head.append(el("h3", null, GROUP_LABELS[key] || key));
  if (Number.isFinite(num(value.subtotal))) {
    head.append(el("span", "bd-subtotal mono", fmtScore(value.subtotal)));
  }
  group.append(head);

  for (const [k, v] of entries) {
    const n = num(v);
    const row = el("div", "bd-row");
    row.append(el("span", "bd-label", ITEM_LABELS[k] || k));

    const track = el("div", "bd-track");
    const bar = el("div", `bd-bar ${n > 0 ? "pos" : n < 0 ? "neg" : "zero"}`);
    bar.style.width = `${Math.max((Math.abs(n) / maxAbs) * 100, n === 0 ? 0 : 6)}%`;
    track.append(bar);
    row.append(track);

    row.append(el("span", `bd-value mono ${n > 0 ? "pos" : n < 0 ? "neg" : ""}`, fmtScore(n)));
    group.append(row);
  }
  return group;
}

/**
 * スコア推移。直近 10 回を縦棒で描く。
 *
 * 目盛りは最小値〜最大値ではなく **最低 10 点幅**を確保して取る。実データは日々の
 * 変動が数点しかない（2 値しか出ない日もある）ため、実測レンジいっぱいに引き伸ばすと
 * 5 点差が崖のように見えて誤読を招く。幅を持たせて、小さい差は小さく見せる。
 */
const SPARK_MIN_SPAN = 10;

function historyChart(history) {
  const values = history.map((h) => num(h.total_score)).filter(Number.isFinite);
  if (values.length < 2) return null;

  const max = Math.max(...values);
  const min = Math.min(...values);
  const observed = max - min;
  const span = Math.max(observed, SPARK_MIN_SPAN);
  const base = min - (span - observed) / 2; // 実測レンジを目盛りの中央に置く

  const chart = el("div", "spark");
  for (const point of history) {
    const n = num(point.total_score);
    const col = el("div", "spark-col");
    const bar = el("div", "spark-bar");
    // 下端でも 12% 残す。高さゼロの棒は「データが無い」ように見えてしまうため。
    bar.style.height = `${12 + ((n - base) / span) * 88}%`;
    if (point === history[history.length - 1]) bar.classList.add("latest");
    col.append(bar);
    col.append(el("span", "spark-label", point.run_date.slice(5).replace("-", "/")));
    col.title = `${fmtDate(point.run_date)}  ${fmtScore(n)}点  ${point.rank}位`;
    chart.append(col);
  }
  return { chart, min, max };
}

export function renderDetail(root, detail, overviewRow) {
  root.textContent = "";
  const b = detail.breakdown;

  const head = el("header", "detail-head");
  const title = el("div", "detail-title");
  title.append(el("span", "ticker big", detail.ticker));
  title.append(el("span", "name big", (b && b.name) || overviewRow?.name || ""));
  head.append(title);

  const chips = el("div", "chips");
  if (b && b.sector) chips.append(el("span", "chip", SECTOR_LABELS[b.sector] || b.sector));
  if (overviewRow && Number.isFinite(num(overviewRow.rank))) {
    chips.append(el("span", "chip", `${overviewRow.rank} 位`));
  }
  if (b && b.watch_entry === true) chips.append(el("span", "chip gold", "ウォッチ候補"));
  if (chips.childElementCount) head.append(chips);
  root.append(head);

  // 総合スコア
  const total = el("div", "detail-total");
  const totalValue = num(b ? b.total_score : overviewRow?.score);
  total.append(el("span", "detail-total-number mono", fmtScore(totalValue)));
  total.append(el("span", "hero-unit", "点"));
  if (overviewRow) total.append(deltaChip(overviewRow.delta));
  root.append(total);

  if (detail.breakdownDate && detail.breakdownDate !== detail.runDate) {
    root.append(el("p", "note", `内訳は ${fmtDate(detail.breakdownDate)} 時点のものです。`));
  }

  // 推移
  const spark = historyChart(detail.history);
  if (spark) {
    const block = el("section", "block");
    block.append(el("h2", null, "スコア推移"));
    block.append(spark.chart);
    // 目盛りを持たない棒グラフなので、実測の上下端は文字で添える。
    block.append(
      el(
        "p",
        "note",
        `直近 ${detail.history.length} 回のスクリーニング / ` +
          `${fmtScore(spark.min)}〜${fmtScore(spark.max)}点`,
      ),
    );
    root.append(block);
  }

  // 内訳（breakdown の実際の形に追従する）
  if (!b) {
    root.append(el("p", "empty", "この銘柄の内訳データはまだありません。"));
  } else {
    const block = el("section", "block");
    block.append(el("h2", null, "スコア内訳"));
    let drawn = 0;
    for (const [key, value] of Object.entries(b)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const group = breakdownGroup(key, value);
      if (group) {
        block.append(group);
        drawn += 1;
      }
    }
    if (!drawn) block.append(el("p", "empty", "内訳の項目がありません。"));
    root.append(block);
  }

  root.append(
    el(
      "p",
      "disclaimer",
      "各項目はバッチが算出した加点・減点の内訳です。将来の値動きを示すものではなく、" +
        "売買の推奨でもありません。投資の判断はご自身の責任で行ってください。",
    ),
  );
}
