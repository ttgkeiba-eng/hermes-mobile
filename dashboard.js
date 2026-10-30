// Hermes Mobile / ダッシュボード（Phase D）
//
// 読み取り専用の画面:
//
//   ホーム   … 最新 run_date の 1 位（ヒーロー）／上位 10 の棒／スコアの分布／
//              上位のセクター／ウォッチリストの変動
//   全銘柄   … 最新 run_date の全件。検索・セクター・並べ替え
//   銘柄詳細 … スコアと順位の推移（折れ線）と scoring_breakdown の内訳
//   記事・週次 … note 記事と週次 diff レポート（上昇・下降の分岐棒）
//
// グラフは charts.js（素の SVG）。
//
// データはすべて **ログイン中のユーザーの JWT** で PostgREST から読む（RLS 経由）。
// 書き込みは一切しない。VPS 本体と Supabase のスキーマには触れていない。
//
// 内訳の可視化は breakdown の**実際の形に追従する**。キー名を決め打ちせず、
// 「値がオブジェクトのものはグループ」「その中の数値は項目」「subtotal があれば
// グループの小計」という構造だけを仮定する。バッチ側が項目を足しても画面は壊れない。

import { select } from "./session.js";
import { renderMarkdown } from "./markdown.js";
import { barList, divergingBars, histogram, lineChart, sparkline, tableView } from "./charts.js";

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

/** ヒーローカードの小さな推移で遡る回数。 */
const HERO_SPARK_LIMIT = 20;

/**
 * ホームと全銘柄が使う 1 セット。
 * 最新 run_date とその 1 つ前を引き、前回比を突き合わせる。
 *
 * screening_results には**その日に採点した全銘柄**が入っている（上位だけではない）。
 * rank は total_score の降順。
 */
export async function loadOverview() {
  const latestRow = await select("screening_results?select=run_date&order=run_date.desc&limit=1");
  if (!latestRow.length) return { runDate: null, rows: [], watch: [], sectors: new Map() };
  const runDate = latestRow[0].run_date;

  const prevRow = await select(
    `screening_results?select=run_date&run_date=lt.${runDate}&order=run_date.desc&limit=1`,
  );
  const prevDate = prevRow.length ? prevRow[0].run_date : null;

  const [rows, prevRows, watch, sectorRows] = await Promise.all([
    select(
      `screening_results?select=rank,ticker,name,total_score&run_date=eq.${runDate}&order=rank.asc`,
    ),
    prevDate
      ? select(`screening_results?select=rank,ticker,total_score&run_date=eq.${prevDate}`)
      : Promise.resolve([]),
    select("watchlist?select=ticker,name&active=is.true&order=ticker.asc"),
    // セクターは内訳の JSON の中にしか無い。キーだけ抜いて軽く取る。取れなくても画面は出す。
    select(`scoring_breakdown?select=ticker,sector:breakdown->>sector&run_date=eq.${runDate}`).catch(
      () => [],
    ),
  ]);

  const sectors = new Map(sectorRows.filter((r) => r.sector).map((r) => [r.ticker, r.sector]));
  const prevByTicker = new Map(prevRows.map((r) => [r.ticker, r]));
  const ranked = rows.map((r) => {
    const prev = prevByTicker.get(r.ticker);
    return {
      ...r,
      sector: sectors.get(r.ticker) || null,
      score: num(r.total_score),
      delta: prev ? num(r.total_score) - num(prev.total_score) : null,
      rankDelta: prev ? num(prev.rank) - num(r.rank) : null,
      isNew: prevDate !== null && !prev,
    };
  });

  // 1 位の小さな推移（ヒーローカード用）。失敗してもカードは出す。
  let heroHistory = [];
  if (ranked.length) {
    heroHistory = await select(
      `screening_results?select=run_date,total_score&ticker=eq.${encodeURIComponent(ranked[0].ticker)}` +
        `&order=run_date.desc&limit=${HERO_SPARK_LIMIT}`,
    )
      .then((h) => h.slice().reverse())
      .catch(() => []);
  }

  return {
    runDate,
    prevDate,
    rows: ranked,
    sectors,
    heroHistory,
    fetchedAt: new Date(),
    watch: await resolveWatchlist(watch, ranked, prevByTicker, runDate, prevDate),
  };
}

/**
 * ウォッチリストを最新スコアと突き合わせる。
 *
 * 採点の対象から外れた銘柄（ユニバース外・価格の上限超え等）はその日の行が無い。
 * そのときは「圏外」として、勝手に 0 点扱いしない。
 */
async function resolveWatchlist(watch, ranked, prevByTicker, runDate, prevDate) {
  if (!watch.length) return [];

  const rankedByTicker = new Map(ranked.map((r) => [r.ticker, r]));
  const missing = watch.map((w) => w.ticker).filter((t) => !rankedByTicker.has(t));

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

// 銘柄詳細のスコア推移で遡る回数。画面では「1か月（直近 22 回）」と「3か月（66 回）」を
// 切り替える。取得は長い方で 1 回だけ。
const HISTORY_LIMIT = 66;
const HISTORY_SHORT = 22;

/** 銘柄詳細。内訳（最新 run_date）とスコア推移をまとめて取る。 */
export async function loadDetail(ticker, runDate) {
  const [breakdownRows, history] = await Promise.all([
    select(
      `scoring_breakdown?select=run_date,breakdown&ticker=eq.${encodeURIComponent(ticker)}` +
        `&order=run_date.desc&limit=1`,
    ),
    select(
      `screening_results?select=run_date,rank,total_score&ticker=eq.${encodeURIComponent(ticker)}` +
        `&order=run_date.desc&limit=${HISTORY_LIMIT}`,
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

/**
 * note 記事（Phase D-2）。日付を指定しなければ最新 1 件。
 *
 * 記事の正本は Obsidian 側の Markdown で、daily_articles はその写し。
 * ここで読めなくても記事そのものは失われていない、という前提で画面を書く。
 */
export async function loadArticle(runDate) {
  const filter = runDate ? `&run_date=eq.${runDate}` : "";
  const rows = await select(
    `daily_articles?select=run_date,title,body,created_at${filter}` +
      "&order=run_date.desc&limit=1",
  );
  return rows.length ? rows[0] : null;
}

/** 記事一覧（過去分への導線用）。本文は重いので引かない。 */
export function loadArticleIndex(limit = 14) {
  return select(`daily_articles?select=run_date,title&order=run_date.desc&limit=${limit}`);
}

/** 週次 diff レポート。最新 1 件。 */
export async function loadDiffReport() {
  const rows = await select(
    "diff_reports?select=report_date,summary,payload&order=report_date.desc&limit=1",
  );
  return rows.length ? rows[0] : null;
}

// ── 部品 ────────────────────────────────────────────────────────────────────

function deltaChip(delta) {
  const { text, kind } = fmtDelta(delta);
  const chip = el("span", `delta ${kind}`);
  chip.append(el("span", "delta-arrow", kind === "up" ? "▲" : kind === "down" ? "▼" : "—"));
  chip.append(el("span", "delta-value", text));
  return chip;
}

/** カード・行の共通クリック処理。既定は銘柄詳細、hash を渡せばそちらへ。 */
function linkTo(node, ticker, hash) {
  node.tabIndex = 0;
  node.setAttribute("role", "link");
  const target = hash || `#/s/${encodeURIComponent(ticker)}`;
  const go = () => {
    location.hash = target;
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

const goStock = (ticker) => () => {
  location.hash = `#/s/${encodeURIComponent(ticker)}`;
};

function sectorLabel(sector) {
  return sector ? SECTOR_LABELS[sector] || sector : "";
}

function heroCard(row, history) {
  const card = el("article", "hero");
  const top = el("div", "hero-top");
  top.append(el("span", "crown", "1"));
  const label = el("div", "hero-label");
  label.append(el("span", "ticker", row.ticker));
  label.append(el("span", "name", row.name || ""));
  top.append(label);
  card.append(top);

  const scoreRow = el("div", "hero-score");
  const number = el("div", "hero-number-wrap");
  number.append(el("span", "hero-number", fmtScore(row.score)));
  number.append(el("span", "hero-unit", "点"));
  scoreRow.append(number);
  // 直近の推移。数字の横に小さく置き、「いつからこの水準か」だけを見せる
  const spark = sparkline(history.map((h) => num(h.total_score)));
  if (spark) {
    const sparkWrap = el("div", "hero-spark");
    sparkWrap.append(spark);
    sparkWrap.append(el("span", "hero-spark-note", `直近 ${history.length} 回`));
    scoreRow.append(sparkWrap);
  }
  card.append(scoreRow);

  const meta = el("div", "hero-meta");
  meta.append(el("span", "meta-label", "前回比"));
  meta.append(deltaChip(row.delta));
  if (row.isNew) meta.append(el("span", "tag", "新規"));
  if (row.sector) meta.append(el("span", "meta-sector", sectorLabel(row.sector)));
  card.append(meta);

  return linkTo(card, row.ticker);
}

function stockRow(row, { showRank = true } = {}) {
  const line = el("div", "srow");
  if (showRank) line.append(el("span", "srow-rank mono", Number.isFinite(num(row.rank)) ? `${row.rank}` : "—"));
  const label = el("div", "srow-label");
  const top = el("span", "srow-top");
  top.append(el("span", "ticker", row.ticker));
  if (row.sector) top.append(el("span", "srow-sector", sectorLabel(row.sector)));
  label.append(top);
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

function block(title, note) {
  const node = el("section", "block");
  const head = el("div", "block-head");
  head.append(el("h2", null, title));
  if (note) head.append(el("span", "block-note", note));
  node.append(head);
  return node;
}

/** 読み込み中の骨組み。行の数だけ灰色の帯を置き、出来上がりと同じ高さにする。 */
export function skeleton(kind = "home") {
  const root = el("div", "skeleton");
  root.setAttribute("aria-busy", "true");
  root.setAttribute("aria-label", "読み込み中");
  const bar = (cls) => root.append(el("div", `sk ${cls}`));
  if (kind === "home") {
    bar("sk-line short");
    bar("sk-hero");
    for (let i = 0; i < 5; i += 1) bar("sk-row");
  } else if (kind === "detail") {
    bar("sk-line");
    bar("sk-number");
    bar("sk-chart");
    bar("sk-chart");
  } else {
    bar("sk-line short");
    for (let i = 0; i < 8; i += 1) bar("sk-row");
  }
  return root;
}

// ── ホーム ──────────────────────────────────────────────────────────────────

/** ホームの上位の本数。1 位はヒーロー、残りを棒で並べる。 */
const HOME_TOP = 10;
/** セクター構成を数える範囲。上位 10 だと 1 業種 1〜2 件で偏りが読めないため 30。 */
const SECTOR_TOP = 30;

export function renderHome(root, data) {
  root.textContent = "";

  if (!data.runDate) {
    root.append(el("p", "empty", "スクリーニング結果がまだありません。18:00 のバッチの後に、ここに並びます。"));
    return;
  }

  const head = el("div", "section-head");
  head.append(el("span", "run-date", `${fmtDate(data.runDate)} の採点`));
  head.append(el("span", "run-count", `${data.rows.length} 銘柄`));
  root.append(head);

  const [first] = data.rows;
  if (first) root.append(heroCard(first, data.heroHistory || []));

  // ── 上位（2〜10 位）──
  const top = data.rows.slice(1, HOME_TOP);
  if (top.length) {
    const sec = block(`上位 ${HOME_TOP}`, "総合スコア");
    const scores = data.rows.slice(0, HOME_TOP).map((r) => r.score).filter(Number.isFinite);
    // 棒の左端は 0 点でなく、上位の最低点より少し下。上位どうしの差が読める幅にする。
    const floor = Math.floor((Math.min(...scores) - 5) / 5) * 5;
    sec.append(
      barList(
        top.map((r) => ({
          lead: `${r.rank}`,
          label: r.name || r.ticker,
          sub: r.ticker,
          value: r.score,
          display: fmtScore(r.score),
          trailing: deltaChip(r.delta),
          onClick: goStock(r.ticker),
        })),
        { min: floor },
      ),
    );
    const all = el("button", "wide", `全 ${data.rows.length} 銘柄を見る`);
    all.type = "button";
    all.addEventListener("click", () => {
      location.hash = "#/all";
    });
    sec.append(all);
    root.append(sec);
  }

  // ── スコアの分布 ──
  const scores = data.rows.map((r) => r.score);
  const tenth = data.rows[Math.min(HOME_TOP, data.rows.length) - 1]?.score;
  const hist = histogram(scores, {
    threshold: tenth,
    binSize: 5,
    ariaLabel: `${data.rows.length} 銘柄の総合スコアの分布`,
  });
  if (hist) {
    const sec = block("スコアの分布", `${data.rows.length} 銘柄`);
    sec.append(hist);
    sec.append(
      el("p", "note", `金色の帯に上位 ${HOME_TOP}（${fmtScore(tenth)} 点以上）が入っています。棒をタップすると件数が出ます。`),
    );
    root.append(sec);
  }

  // ── 上位のセクター ──
  if (data.sectors && data.sectors.size) {
    const counts = new Map();
    for (const r of data.rows.slice(0, SECTOR_TOP)) {
      const key = sectorLabel(r.sector) || "不明";
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    // 7 業種を超えたら残りを「その他」にまとめる（並びが長くなりすぎないように）
    const shown = ordered.slice(0, 6);
    const rest = ordered.slice(6).reduce((sum, [, n]) => sum + n, 0);
    if (rest) shown.push(["その他", rest]);
    const sec = block(`上位 ${SECTOR_TOP} のセクター`, "銘柄数");
    sec.append(
      barList(
        shown.map(([label, n]) => ({ label, value: n, display: `${n}` })),
        { min: 0 },
      ),
    );
    root.append(sec);
  }

  // ── ウォッチリストの変動 ──
  const watch = block("ウォッチリスト", "前回比");
  if (!data.watch.length) {
    watch.append(
      el("p", "empty", "ウォッチリストは空です。銘柄を登録すると、ここに前回比が並びます。"),
    );
  } else {
    const list = el("div", "rows");
    for (const row of data.watch) list.append(stockRow(row));
    watch.append(list);
  }
  root.append(watch);

  root.append(
    el(
      "p",
      "disclaimer",
      `Hermes は約 ${Math.round(data.rows.length / 10) * 10} 銘柄から割安・値動きの安定した銘柄を毎日絞り込むツールです。` +
        "スコアは並べ替えのための指標で、どれが上がるかを示すものでも、売買の推奨でもありません。",
    ),
  );
}

// ── 全銘柄 ──────────────────────────────────────────────────────────────────

// 絞り込みの状態は画面を行き来しても残す（詳細から戻ったときに条件が消えないように）。
const allState = { query: "", sector: "", sort: "rank" };

const SORTS = {
  rank: { label: "順位", fn: (a, b) => num(a.rank) - num(b.rank) },
  up: { label: "上がった順", fn: (a, b) => (b.delta ?? -Infinity) - (a.delta ?? -Infinity) },
  down: { label: "下がった順", fn: (a, b) => (a.delta ?? Infinity) - (b.delta ?? Infinity) },
};

/** 一度に描く行の上限。350 行を一気に描くと古い端末で引っかかる。 */
const ALL_PAGE = 60;

export function renderAll(root, data) {
  root.textContent = "";
  const head = el("div", "section-head");
  head.append(el("span", "run-date", `${fmtDate(data.runDate)} の採点`));
  const count = el("span", "run-count", "");
  head.append(count);
  root.append(head);

  // 絞り込み（検索・セクター・並べ替え）。1 行にまとめ、すべての行に同じ条件が効く
  const controls = el("div", "filters");
  const search = el("input", "filter-search");
  search.type = "search";
  search.placeholder = "銘柄名・コードで探す";
  search.value = allState.query;
  search.setAttribute("aria-label", "銘柄名・コードで探す");
  search.autocomplete = "off";
  search.enterKeyHint = "search";

  const sectorSelect = el("select", "filter-select");
  sectorSelect.setAttribute("aria-label", "セクター");
  sectorSelect.append(new Option("全セクター", ""));
  const sectorList = [...new Set(data.rows.map((r) => r.sector).filter(Boolean))].sort((a, b) =>
    sectorLabel(a).localeCompare(sectorLabel(b), "ja"),
  );
  for (const s of sectorList) sectorSelect.append(new Option(sectorLabel(s), s));
  sectorSelect.value = allState.sector;
  sectorSelect.hidden = !sectorList.length;

  const sortSelect = el("select", "filter-select");
  sortSelect.setAttribute("aria-label", "並べ替え");
  for (const [key, { label }] of Object.entries(SORTS)) sortSelect.append(new Option(label, key));
  sortSelect.value = allState.sort;

  const selects = el("div", "filter-row");
  selects.append(sectorSelect, sortSelect);
  controls.append(search, selects);
  root.append(controls);

  const list = el("div", "rows");
  const more = el("button", "wide", "");
  more.type = "button";
  const empty = el("p", "empty", "条件に合う銘柄がありません。検索の文字かセクターを変えてください。");
  root.append(list, more, empty);

  let limit = ALL_PAGE;
  const draw = () => {
    const q = allState.query.trim().toLowerCase();
    const filtered = data.rows
      .filter((r) => !allState.sector || r.sector === allState.sector)
      .filter((r) => !q || r.ticker.toLowerCase().includes(q) || (r.name || "").toLowerCase().includes(q))
      .sort(SORTS[allState.sort].fn);
    count.textContent = filtered.length === data.rows.length
      ? `${data.rows.length} 銘柄`
      : `${filtered.length} / ${data.rows.length} 銘柄`;
    list.textContent = "";
    for (const row of filtered.slice(0, limit)) list.append(stockRow(row));
    list.hidden = !filtered.length;
    empty.hidden = filtered.length > 0;
    more.hidden = filtered.length <= limit;
    more.textContent = `続きを表示（残り ${filtered.length - limit}）`;
  };

  search.addEventListener("input", () => {
    allState.query = search.value;
    limit = ALL_PAGE;
    draw();
  });
  sectorSelect.addEventListener("change", () => {
    allState.sector = sectorSelect.value;
    limit = ALL_PAGE;
    draw();
  });
  sortSelect.addEventListener("change", () => {
    allState.sort = sortSelect.value;
    limit = ALL_PAGE;
    draw();
  });
  more.addEventListener("click", () => {
    limit += ALL_PAGE * 2;
    draw();
  });
  draw();
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

  // このグループが何で動いているか。加点・減点・効いていない項目の数を先に出す。
  const plus = entries.filter(([, v]) => num(v) > 0).length;
  const minus = entries.filter(([, v]) => num(v) < 0).length;
  const zero = entries.length - plus - minus;
  const tally = el("p", "bd-tally");
  tally.append(el("span", "tally pos", `加点 ${plus}`));
  tally.append(el("span", "tally neg", `減点 ${minus}`));
  tally.append(el("span", "tally zero", `無風 ${zero}`));
  group.append(tally);

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
 * グループ小計の構成バー。総合スコアが何でできているかを 1 本で見せる。
 *
 * どのグループがあるかは JSON から拾う（base/technical/fundamental を決め打ちしない）。
 * 幅は絶対値の比。減点グループは分けて下に出す — 加点と同じ帯に混ぜると
 * 「合計に占める割合」を誤って読ませてしまうため。
 */
function compositionBar(groups) {
  const scored = groups
    .map(([key, value]) => [key, num(value.subtotal)])
    .filter(([, v]) => Number.isFinite(v) && v !== 0);
  if (scored.length < 2) return null;

  const positives = scored.filter(([, v]) => v > 0);
  const negatives = scored.filter(([, v]) => v < 0);
  const totalAbs = positives.reduce((sum, [, v]) => sum + v, 0);
  if (!totalAbs) return null;

  const wrap = el("div", "comp");
  const track = el("div", "comp-track");
  positives.forEach(([key, value], index) => {
    const seg = el("div", `comp-seg tone-${index % 3}`);
    seg.style.width = `${(value / totalAbs) * 100}%`;
    seg.title = `${GROUP_LABELS[key] || key} ${fmtScore(value)}点`;
    track.append(seg);
  });
  wrap.append(track);

  const legend = el("div", "comp-legend");
  positives.forEach(([key, value], index) => {
    const item = el("span", "comp-item");
    item.append(el("i", `comp-dot tone-${index % 3}`));
    item.append(el("span", null, GROUP_LABELS[key] || key));
    item.append(el("span", "comp-value mono", `${fmtScore(value)}`));
    item.append(el("span", "comp-share", `${Math.round((value / totalAbs) * 100)}%`));
    legend.append(item);
  });
  for (const [key, value] of negatives) {
    const item = el("span", "comp-item");
    item.append(el("i", "comp-dot neg"));
    item.append(el("span", null, GROUP_LABELS[key] || key));
    item.append(el("span", "comp-value mono neg", fmtScore(value)));
    legend.append(item);
  }
  wrap.append(legend);
  return wrap;
}

/** 推移の期間。画面の切り替えだけで、取り直しはしない。 */
const PERIODS = [
  { key: "short", label: "1か月", count: HISTORY_SHORT },
  { key: "long", label: "3か月", count: HISTORY_LIMIT },
];
let detailPeriod = "short";

/**
 * スコアと順位の推移。単位の違う 2 つを 1 枚に重ねず、上下 2 枚に分ける
 * （縦軸を 2 本にすると、目盛りの合わせ方しだいで関係があるように見えてしまう）。
 *
 * スコアの縦軸は最低 10 点幅を確保する。実データは日々の変動が数点しかないため、
 * 実測の幅いっぱいに引き伸ばすと 5 点差が崖のように見えて誤読を招く。
 */
function historyBlock(history) {
  if (history.length < 2) return null;

  const sec = block("推移");
  const tabs = el("div", "segmented");
  tabs.setAttribute("role", "tablist");
  const holder = el("div", "history-charts");
  sec.append(tabs, holder);

  const draw = () => {
    holder.textContent = "";
    const period = PERIODS.find((p) => p.key === detailPeriod) || PERIODS[0];
    const slice = history.slice(-period.count);
    const label = (d) => d.slice(5).replace("-", "/");

    const scorePoints = slice.map((h) => ({
      label: label(h.run_date),
      value: num(h.total_score),
      tipHead: fmtDate(h.run_date),
      lines: [`${fmtScore(h.total_score)} 点`, Number.isFinite(num(h.rank)) ? `${h.rank} 位` : "順位なし"],
    }));
    const rankPoints = slice.map((h) => ({
      label: label(h.run_date),
      value: num(h.rank),
      tipHead: fmtDate(h.run_date),
      lines: [`${h.rank} 位`, `${fmtScore(h.total_score)} 点`],
    }));

    const scoreChart = lineChart(scorePoints, {
      minSpan: 10,
      format: (v) => fmtScore(v),
      ariaLabel: `総合スコアの推移（直近 ${slice.length} 回）`,
    });
    const rankChart = lineChart(rankPoints, {
      invert: true,
      floor: 1,
      minSpan: 10,
      height: 120,
      format: (v) => `${Math.round(v)}`,
      ariaLabel: `順位の推移（直近 ${slice.length} 回、上ほど上位）`,
    });

    if (scoreChart) {
      holder.append(el("h3", "chart-title", "総合スコア"));
      holder.append(scoreChart);
    }
    if (rankChart) {
      holder.append(el("h3", "chart-title", "順位（上ほど上位）"));
      holder.append(rankChart);
    }
    holder.append(
      el("p", "note", `直近 ${slice.length} 回の採点。線をタップするとその日の値が出ます。`),
    );
    holder.append(
      tableView(
        "数値で見る",
        ["日付", "スコア", "順位"],
        slice
          .slice()
          .reverse()
          .map((h) => [fmtDate(h.run_date), fmtScore(h.total_score), Number.isFinite(num(h.rank)) ? `${h.rank}` : "—"]),
      ),
    );

    tabs.textContent = "";
    for (const p of PERIODS) {
      if (p.key === "long" && history.length <= HISTORY_SHORT) continue;
      const b = el("button", p.key === period.key ? "seg on" : "seg", p.label);
      b.type = "button";
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", String(p.key === period.key));
      b.addEventListener("click", () => {
        detailPeriod = p.key;
        draw();
      });
      tabs.append(b);
    }
    tabs.hidden = tabs.childElementCount < 2;
  };
  draw();
  return sec;
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
  if (b && b.sector) chips.append(el("span", "chip", sectorLabel(b.sector)));
  if (overviewRow && Number.isFinite(num(overviewRow.rank))) {
    chips.append(el("span", "chip", `${overviewRow.rank} 位`));
  }
  if (b && b.watch_entry === true) chips.append(el("span", "chip gold", "ウォッチ候補"));
  if (chips.childElementCount) head.append(chips);
  root.append(head);

  // 総合スコア
  const total = el("div", "detail-total");
  const totalValue = num(b ? b.total_score : overviewRow?.score);
  total.append(el("span", "detail-total-number", fmtScore(totalValue)));
  total.append(el("span", "hero-unit", "点"));
  if (overviewRow) total.append(deltaChip(overviewRow.delta));
  root.append(total);

  if (detail.breakdownDate && detail.breakdownDate !== detail.runDate) {
    root.append(el("p", "note", `内訳は ${fmtDate(detail.breakdownDate)} 時点のものです。`));
  }

  // チャットへの導線。スコアの数字より下、内訳より上に置く
  // （「この数字は何？」と思った直後に押せる位置）。
  const ask = el("button", "wide ask", "この銘柄について聞く");
  ask.type = "button";
  ask.addEventListener("click", () => {
    location.hash = `#/chat/${encodeURIComponent(detail.ticker)}`;
  });
  root.append(ask);

  const history = historyBlock(detail.history);
  if (history) root.append(history);

  // 内訳（breakdown の実際の形に追従する）
  if (!b) {
    root.append(el("p", "empty", "この銘柄の内訳データはまだありません。"));
  } else {
    const groups = Object.entries(b).filter(
      ([, value]) => value && typeof value === "object" && !Array.isArray(value),
    );

    // まず「何でできているか」を 1 本のバーで。次にグループごとの深掘り。
    const composition = compositionBar(groups);
    if (composition) {
      const sec = block("スコアの構成");
      sec.append(composition);
      sec.append(el("p", "note", "各グループの小計が総合スコアに占める割合です。"));
      root.append(sec);
    }

    const sec = block("指標グループ別の内訳");
    let drawn = 0;
    for (const [key, value] of groups) {
      const group = breakdownGroup(key, value);
      if (group) {
        sec.append(group);
        drawn += 1;
      }
    }
    if (!drawn) sec.append(el("p", "empty", "内訳の項目がありません。"));
    root.append(sec);
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

// ── note 記事 ───────────────────────────────────────────────────────────────

export function renderArticle(root, article, index) {
  root.textContent = "";

  if (!article) {
    root.append(
      el("p", "empty", "まだ記事が届いていません。18:00 のバッチが記事を書くと、ここに並びます。"),
    );
    return;
  }

  const head = el("header", "article-head");
  head.append(el("span", "run-date", `${fmtDate(article.run_date)} のレポート`));
  head.append(el("h1", "article-title", article.title));
  root.append(head);

  const body = el("article", "md");
  // 画面上部にタイトルを出しているので、本文先頭の同じ H1 は落とす
  body.append(renderMarkdown(article.body, article.title));
  root.append(body);

  // 過去分。記事は日ごとに独立しているので、日付だけのシンプルな並びにする。
  const others = (index || []).filter((row) => row.run_date !== article.run_date);
  if (others.length) {
    const block = el("section", "block");
    block.append(el("h2", null, "過去のレポート"));
    const list = el("div", "rows");
    for (const row of others) {
      const line = el("div", "srow");
      const label = el("div", "srow-label");
      label.append(el("span", "ticker", fmtDate(row.run_date)));
      label.append(el("span", "name", row.title));
      line.append(label);
      line.append(el("span", "nav-arrow", "›"));
      linkTo(line, null, `#/article/${row.run_date}`);
      list.append(line);
    }
    block.append(list);
    root.append(block);
  }
}

// ── 週次 diff レポート ──────────────────────────────────────────────────────

function diffRow(stock) {
  const line = el("div", "srow");
  const label = el("div", "srow-label");
  label.append(el("span", "ticker", stock.code));
  label.append(el("span", "name", stock.name || ""));
  line.append(label);

  const right = el("div", "srow-right");
  const scores = el("span", "diff-scores mono");
  scores.append(el("span", "diff-from", fmtScore(stock.first_total)));
  scores.append(el("span", "diff-to", ` → ${fmtScore(stock.last_total)}`));
  right.append(scores);
  right.append(deltaChip(stock.delta));
  line.append(right);

  return linkTo(line, stock.code);
}

/** 分岐棒に載せる本数（上昇・下降それぞれ）。 */
const MOVERS = 6;

export function renderWeekly(root, report) {
  root.textContent = "";

  if (!report || !report.payload) {
    root.append(
      el("p", "empty", "週次レポートがまだありません。毎週金曜 19:00 の集計後に表示されます。"),
    );
    return;
  }

  const p = report.payload;
  const head = el("div", "section-head");
  head.append(el("span", "run-date", `${fmtDate(report.report_date)} 集計`));
  head.append(el("span", "run-count", `${p.days ?? "—"} 営業日`));
  root.append(head);

  if (p.period_start && p.period_end) {
    root.append(el("p", "note", `対象期間 ${p.period_start} 〜 ${p.period_end}`));
  }

  // 件数の内訳。数字が主役なので大きめに出す。
  const tiles = el("div", "tiles");
  tiles.append(tile("上昇", p.risers, "up"));
  tiles.append(tile("下降", p.fallers, "down"));
  tiles.append(tile("変化なし", p.flat, "flat"));
  root.append(tiles);

  if (report.summary) {
    const summary = el("section", "summary-card");
    summary.append(el("h2", null, "サマリー"));
    summary.append(el("p", null, report.summary));
    root.append(summary);
  }

  const stocks = Array.isArray(p.stocks) ? p.stocks : [];
  const byDelta = stocks.filter((s) => Number.isFinite(num(s.delta)));
  const risers = byDelta.filter((s) => num(s.delta) > 0).sort((a, b) => num(b.delta) - num(a.delta));
  const fallers = byDelta.filter((s) => num(s.delta) < 0).sort((a, b) => num(a.delta) - num(b.delta));
  const others = stocks.filter((s) => !(num(s.delta) > 0) && !(num(s.delta) < 0));

  // 大きく動いた銘柄を 1 枚で。右が上昇、左が下降
  const movers = [...risers.slice(0, MOVERS), ...fallers.slice(0, MOVERS).reverse()];
  if (movers.length) {
    const sec = block("大きく動いた銘柄", "スコアの差");
    sec.append(
      divergingBars(
        movers.map((s) => ({
          label: s.name || s.code,
          sub: s.code,
          value: num(s.delta),
          onClick: goStock(s.code),
        })),
      ),
    );
    sec.append(el("p", "note", "期間の初日と最終日の総合スコアの差です。右が上昇、左が下降。"));
    root.append(sec);
  }

  for (const [title, rows] of [
    ["上昇した銘柄", risers],
    ["下降した銘柄", fallers],
    ["変化のなかった銘柄", others],
  ]) {
    const sec = block(`${title}（${rows.length}）`);
    if (rows.length) {
      const list = el("div", "rows");
      for (const stock of rows) list.append(diffRow(stock));
      sec.append(list);
    } else {
      sec.append(el("p", "empty", "該当なし"));
    }
    root.append(sec);
  }

  root.append(
    el(
      "p",
      "disclaimer",
      "期間中のスコアの動きを並べたものです。値動きの見通しではなく、売買の推奨でもありません。",
    ),
  );
}

function tile(label, value, kind) {
  const box = el("div", `tile ${kind}`);
  box.append(el("span", "tile-value", Number.isFinite(num(value)) ? String(value) : "—"));
  box.append(el("span", "tile-label", label));
  return box;
}
