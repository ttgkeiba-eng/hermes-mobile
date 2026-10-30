// Hermes Mobile / グラフ（SVG・依存なし）
//
// ビルド工程を持たないアプリなので、グラフも素の SVG で組む。決めごと:
//   - 線は 2px、終点に 8px の点（面の色の 2px の輪）。面は線の色の 10% の淡い塗り
//   - 目盛り線は面より一段明るい 1px の実線。破線は使わない
//   - 縦軸は 1 本だけ。単位の違う 2 つの量（スコアと順位）は別のグラフに分ける
//   - 値の文字はグラフの色を着けない（文字色のトークンで書く）
//   - タップ（またはキーボードの←→）で、その点の値を吹き出しで出す。値は表でも読める
//
// SVG は viewBox を固定して横幅いっぱいに伸ばす（縦横比は保つ）。スマホの幅
// （343〜430px）なら文字の大きさはほぼ変わらない。

const NS = "http://www.w3.org/2000/svg";

const svgEl = (tag, attrs = {}) => {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
};

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** 目盛りをきりのよい数にする（2・5・10 刻み）。 */
function niceStep(span, count) {
  const raw = span / Math.max(count, 1);
  const pow = 10 ** Math.floor(Math.log10(raw || 1));
  const unit = raw / pow;
  const nice = unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10;
  return nice * pow;
}

function niceRange(min, max, { minSpan = 0, count = 3, floor = -Infinity, ceil = Infinity } = {}) {
  let lo = min;
  let hi = max;
  if (hi - lo < minSpan) {
    const pad = (minSpan - (hi - lo)) / 2;
    lo -= pad;
    hi += pad;
  }
  const step = niceStep(hi - lo, count);
  lo = Math.max(floor, Math.floor(lo / step) * step);
  hi = Math.min(ceil, Math.ceil(hi / step) * step);
  if (hi === lo) hi = lo + step;
  // 目盛りは step の倍数に置く。下限で切った場合（順位の 1 など）はその値も目盛りにする
  const ticks = [lo];
  for (let v = Math.floor(lo / step) * step + step; v <= hi + step / 2; v += step) {
    if (v - lo >= step / 2) ticks.push(Math.round(v * 1000) / 1000);
  }
  return { lo, hi, ticks };
}

/**
 * 吹き出しと、タップ・キーボードでの点の選択をグラフに付ける。
 * pick(index) は吹き出しの中身（行の配列）と、吹き出しを置く x（viewBox 座標）を返す。
 */
function attachTooltip(wrap, svg, { count, xAt, pick, onSelect, width }) {
  const tip = el("div", "chart-tip");
  tip.hidden = true;
  wrap.append(tip);
  wrap.tabIndex = 0;

  let current = -1;

  const show = (index) => {
    if (index < 0 || index >= count) return;
    current = index;
    const { lines, x } = pick(index);
    tip.textContent = "";
    lines.forEach((line, i) => tip.append(el("span", i === 0 ? "chart-tip-head" : "chart-tip-line", line)));
    tip.hidden = false;
    // 吹き出しはグラフの左右からはみ出さないよう端で止める
    const ratio = x / width;
    tip.style.left = `${Math.min(Math.max(ratio * 100, 18), 82)}%`;
    onSelect(index);
  };
  const hide = () => {
    current = -1;
    tip.hidden = true;
    onSelect(-1);
  };

  const indexFromEvent = (event) => {
    const rect = svg.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * width;
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < count; i += 1) {
      const d = Math.abs(xAt(i) - x);
      if (d < bestDist) {
        best = i;
        bestDist = d;
      }
    }
    return best;
  };

  svg.addEventListener("pointerdown", (event) => show(indexFromEvent(event)));
  svg.addEventListener("pointermove", (event) => {
    if (event.pointerType === "mouse" || event.buttons) show(indexFromEvent(event));
  });
  svg.addEventListener("pointerleave", (event) => {
    if (event.pointerType === "mouse") hide();
  });
  wrap.addEventListener("keydown", (event) => {
    if (event.key === "ArrowRight") show(current < 0 ? count - 1 : Math.min(current + 1, count - 1));
    else if (event.key === "ArrowLeft") show(current < 0 ? count - 1 : Math.max(current - 1, 0));
    else if (event.key === "Escape") hide();
    else return;
    event.preventDefault();
  });
  wrap.addEventListener("blur", hide);
}

/**
 * 折れ線。1 系列だけ。
 *
 * @param {object[]} points  { label, value, lines }  lines は吹き出しの 2 行目以降
 * @param {object} opts
 *   invert   … 小さいほど上（順位用）
 *   minSpan  … 縦軸の最小幅。小さな差を崖のように見せないため
 *   floor    … 縦軸の下限（順位なら 1）
 *   format   … 目盛りと終点の数字の書き方
 *   ariaLabel
 */
export function lineChart(points, opts = {}) {
  const values = points.map((p) => p.value).filter(Number.isFinite);
  if (values.length < 2) return null;

  const W = 360;
  const H = opts.height ?? 150;
  const pad = { top: 14, right: 40, bottom: 22, left: 30 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;
  const format = opts.format || ((v) => String(Math.round(v * 10) / 10));

  const { lo, hi, ticks } = niceRange(Math.min(...values), Math.max(...values), {
    minSpan: opts.minSpan ?? 0,
    floor: opts.floor ?? -Infinity,
    count: 3,
  });
  const x = (i) => pad.left + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const y = (v) => {
    const t = (v - lo) / (hi - lo);
    return pad.top + (opts.invert ? t : 1 - t) * plotH;
  };

  const wrap = el("figure", "chart");
  const svg = svgEl("svg", {
    viewBox: `0 0 ${W} ${H}`,
    role: "img",
    "aria-label": opts.ariaLabel || "",
  });

  // 目盛り（横線と左の数字）
  for (const t of ticks) {
    const ty = y(t);
    svg.append(svgEl("line", { x1: pad.left, x2: W - pad.right, y1: ty, y2: ty, class: "grid" }));
    const label = svgEl("text", { x: pad.left - 6, y: ty + 3.5, class: "tick", "text-anchor": "end" });
    label.textContent = format(t);
    svg.append(label);
  }

  // 横軸の日付。端と、間に 2 つだけ
  const labelIdx = new Set([0, points.length - 1, Math.round((points.length - 1) / 3), Math.round(((points.length - 1) * 2) / 3)]);
  for (const i of labelIdx) {
    const t = svgEl("text", {
      x: x(i),
      y: H - 6,
      class: "tick",
      "text-anchor": i === 0 ? "start" : i === points.length - 1 ? "end" : "middle",
    });
    t.textContent = points[i].label;
    svg.append(t);
  }

  // 線と淡い塗り。値の無い点は線を切る
  const segments = [];
  let seg = [];
  points.forEach((p, i) => {
    if (Number.isFinite(p.value)) seg.push([x(i), y(p.value)]);
    else if (seg.length) {
      segments.push(seg);
      seg = [];
    }
  });
  if (seg.length) segments.push(seg);
  const baseY = opts.invert ? pad.top : pad.top + plotH;
  for (const s of segments) {
    // 淡い塗りは「下に溜まる量」として読めるときだけ。上下を逆にした順位には付けない
    if (s.length > 1 && !opts.invert) {
      const area = `M${s[0][0]},${baseY} L${s.map((p) => p.join(",")).join(" L")} L${s[s.length - 1][0]},${baseY} Z`;
      svg.append(svgEl("path", { d: area, class: "area" }));
    }
    svg.append(svgEl("path", { d: `M${s.map((p) => p.join(",")).join(" L")}`, class: "line" }));
  }

  // 終点に点と値（ここだけ直接書く）
  const lastIndex = points.map((p) => Number.isFinite(p.value)).lastIndexOf(true);
  const last = points[lastIndex];
  svg.append(svgEl("circle", { cx: x(lastIndex), cy: y(last.value), r: 4.5, class: "dot" }));
  const endLabel = svgEl("text", { x: x(lastIndex) + 8, y: y(last.value) + 4, class: "end-label" });
  endLabel.textContent = format(last.value);
  svg.append(endLabel);

  // 選んだ点の縦線と点
  const cursor = svgEl("line", { y1: pad.top, y2: pad.top + plotH, class: "cursor" });
  const cursorDot = svgEl("circle", { r: 4.5, class: "dot" });
  cursor.style.display = "none";
  cursorDot.style.display = "none";
  svg.append(cursor, cursorDot);

  wrap.append(svg);
  attachTooltip(wrap, svg, {
    count: points.length,
    width: W,
    xAt: x,
    pick: (i) => ({
      x: x(i),
      lines: [points[i].tipHead || points[i].label, ...(points[i].lines || [])],
    }),
    onSelect: (i) => {
      const on = i >= 0 && Number.isFinite(points[i].value);
      cursor.style.display = on ? "" : "none";
      cursorDot.style.display = on ? "" : "none";
      if (on) {
        cursor.setAttribute("x1", x(i));
        cursor.setAttribute("x2", x(i));
        cursorDot.setAttribute("cx", x(i));
        cursorDot.setAttribute("cy", y(points[i].value));
      }
    },
  });
  return wrap;
}

/**
 * 度数分布（縦棒）。強調する帯（上位）だけ金、ほかは無彩色。
 *
 * @param {number[]} values
 * @param {object} opts  threshold … この値以上の帯を強調 / binSize / note
 */
export function histogram(values, opts = {}) {
  const finite = values.filter(Number.isFinite);
  if (finite.length < 5) return null;

  const binSize = opts.binSize ?? 5;
  const lo = Math.floor(Math.min(...finite) / binSize) * binSize;
  const hi = Math.ceil((Math.max(...finite) + 1e-9) / binSize) * binSize;
  const bins = [];
  for (let start = lo; start < hi; start += binSize) bins.push({ start, end: start + binSize, count: 0 });
  for (const v of finite) {
    const i = Math.min(Math.floor((v - lo) / binSize), bins.length - 1);
    bins[i].count += 1;
  }

  const W = 360;
  const H = 140;
  const pad = { top: 16, right: 6, bottom: 22, left: 6 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;
  const maxCount = Math.max(...bins.map((b) => b.count));
  const band = plotW / bins.length;
  const barW = Math.min(band - 2, 24); // 隣の棒とは 2px 空ける。太さは 24px まで
  const x = (i) => pad.left + band * i + band / 2;

  const wrap = el("figure", "chart");
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": opts.ariaLabel || "" });

  svg.append(svgEl("line", { x1: pad.left, x2: W - pad.right, y1: pad.top + plotH, y2: pad.top + plotH, class: "axis" }));

  const bars = bins.map((b, i) => {
    const h = b.count ? Math.max((b.count / maxCount) * plotH, 2) : 0;
    const hot = opts.threshold !== undefined && b.end > opts.threshold;
    const top = pad.top + plotH - h;
    const r = Math.min(4, h / 2, barW / 2);
    // 上の角だけ丸め、底は直角（基線から立ち上がる棒）
    const x0 = x(i) - barW / 2;
    const d = h
      ? `M${x0},${pad.top + plotH} V${top + r} Q${x0},${top} ${x0 + r},${top} H${x0 + barW - r} Q${x0 + barW},${top} ${x0 + barW},${top + r} V${pad.top + plotH} Z`
      : "";
    const path = svgEl("path", { d, class: hot ? "bar hot" : "bar" });
    svg.append(path);
    return path;
  });

  // 横軸の目盛り（両端と中央）
  for (const i of [0, Math.floor(bins.length / 2), bins.length - 1]) {
    const t = svgEl("text", { x: x(i), y: H - 6, class: "tick", "text-anchor": "middle" });
    t.textContent = `${bins[i].start}`;
    svg.append(t);
  }

  // いちばん高い棒の件数だけ直接書く
  const peak = bins.findIndex((b) => b.count === maxCount);
  const peakLabel = svgEl("text", {
    x: x(peak),
    y: pad.top + plotH - (maxCount / maxCount) * plotH - 4,
    class: "end-label",
    "text-anchor": "middle",
  });
  peakLabel.textContent = `${maxCount}`;
  svg.append(peakLabel);

  wrap.append(svg);
  attachTooltip(wrap, svg, {
    count: bins.length,
    width: W,
    xAt: x,
    pick: (i) => ({
      x: x(i),
      lines: [`${bins[i].start}〜${bins[i].end} 点`, `${bins[i].count} 銘柄`],
    }),
    onSelect: (i) => bars.forEach((bar, j) => bar.classList.toggle("dim", i >= 0 && i !== j)),
  });
  return wrap;
}

/**
 * 横棒の一覧（HTML）。順位つきの銘柄やセクターの件数に使う。1 系列なので 1 色。
 *
 * @param {object[]} rows  { lead, label, sub, value, display, trailing, onClick }
 * @param {object} opts    min … 棒の左端の値（スコアは 0 からでなく見える幅に）
 */
export function barList(rows, opts = {}) {
  const list = el("div", "barlist");
  if (!rows.length) return list;
  const max = Math.max(...rows.map((r) => r.value));
  const min = opts.min ?? 0;
  for (const r of rows) {
    const line = el(r.onClick ? "button" : "div", "barlist-row");
    if (r.onClick) {
      line.type = "button";
      line.addEventListener("click", r.onClick);
    }
    if (r.lead !== undefined) line.append(el("span", "barlist-lead", r.lead));
    const body = el("span", "barlist-body");
    const text = el("span", "barlist-text");
    text.append(el("span", "barlist-label", r.label));
    if (r.sub) text.append(el("span", "barlist-sub", r.sub));
    body.append(text);
    const track = el("span", "barlist-track");
    const bar = el("span", r.highlight ? "barlist-bar hot" : "barlist-bar");
    const share = max > min ? (r.value - min) / (max - min) : 1;
    bar.style.width = `${Math.max(share * 100, 3)}%`;
    track.append(bar);
    body.append(track);
    line.append(body);
    line.append(el("span", "barlist-value", r.display ?? String(r.value)));
    if (r.trailing) line.append(r.trailing);
    list.append(line);
  }
  return list;
}

/**
 * 上昇・下降の分岐棒（HTML）。中央の線から右が上昇、左が下降。
 * 向きは位置と符号（＋／−）でも分かるので、色だけに頼らない。
 */
export function divergingBars(rows) {
  const list = el("div", "diverge");
  if (!rows.length) return list;
  const maxAbs = Math.max(...rows.map((r) => Math.abs(r.value)), 1);
  for (const r of rows) {
    const line = el(r.onClick ? "button" : "div", "diverge-row");
    if (r.onClick) {
      line.type = "button";
      line.addEventListener("click", r.onClick);
    }
    const label = el("span", "diverge-label");
    label.append(el("span", "diverge-name", r.label));
    if (r.sub) label.append(el("span", "diverge-sub", r.sub));
    line.append(label);

    const track = el("span", "diverge-track");
    const left = el("span", "diverge-half left");
    const right = el("span", "diverge-half right");
    const bar = el("span", `diverge-bar ${r.value >= 0 ? "up" : "down"}`);
    bar.style.width = `${Math.max((Math.abs(r.value) / maxAbs) * 100, 4)}%`;
    (r.value >= 0 ? right : left).append(bar);
    track.append(left, el("span", "diverge-axis"), right);
    line.append(track);

    const sign = r.value > 0 ? "+" : r.value < 0 ? "−" : "±";
    const abs = Math.abs(r.value);
    line.append(el("span", "diverge-value", `${sign}${Number.isInteger(abs) ? abs : abs.toFixed(1)}`));
    list.append(line);
  }
  return list;
}

/** 小さな推移の線（ヒーローカード用）。軸も数字も持たない。 */
export function sparkline(values, { width = 96, height = 30 } = {}) {
  const finite = values.filter(Number.isFinite);
  if (finite.length < 2) return null;
  const { lo, hi } = niceRange(Math.min(...finite), Math.max(...finite), { minSpan: 10, count: 2 });
  const x = (i) => 2 + (i / (values.length - 1)) * (width - 8);
  const y = (v) => 3 + (1 - (v - lo) / (hi - lo)) * (height - 6);
  const pts = values.map((v, i) => (Number.isFinite(v) ? [x(i), y(v)] : null)).filter(Boolean);
  const svg = svgEl("svg", { viewBox: `0 0 ${width} ${height}`, class: "spark-line", "aria-hidden": "true" });
  svg.append(svgEl("path", { d: `M${pts.map((p) => p.join(",")).join(" L")}`, class: "line" }));
  const end = pts[pts.length - 1];
  svg.append(svgEl("circle", { cx: end[0], cy: end[1], r: 3, class: "dot" }));
  return svg;
}

/** グラフの数値を表でも読めるようにする（吹き出しだけに頼らない）。 */
export function tableView(caption, headers, rows) {
  const details = el("details", "table-view");
  details.append(el("summary", null, caption));
  const wrap = el("div", "md-table-wrap");
  const table = el("table", "md-table");
  const thead = el("thead");
  const tr = el("tr");
  for (const h of headers) tr.append(el("th", null, h));
  thead.append(tr);
  table.append(thead);
  const tbody = el("tbody");
  for (const row of rows) {
    const line = el("tr");
    for (const cell of row) line.append(el("td", null, cell));
    tbody.append(line);
  }
  table.append(tbody);
  wrap.append(table);
  details.append(wrap);
  return details;
}
