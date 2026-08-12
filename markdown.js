// Hermes Mobile / 最小 Markdown レンダラ（Phase D-2）
//
// note 記事（daily_articles.body）を表示するためだけのもの。汎用ではなく、
// note_article_generator が実際に書く記法だけを扱う:
//
//   見出し（# 〜 ######） / 段落 / 引用（>） / 箇条書き（- ・ 1.） / 表 / 水平線 /
//   強調（** **・* *） / インラインコード（` `） / リンク / 画像
//
// **DOM ノードを直接作る。innerHTML は使わない。** 本文は自前のバッチが書いた
// ものだが、文字列を組み立てて innerHTML に流す形にすると、将来 body の出所が
// 増えたときに黙って注入経路になる。ノードを作れば構造上そうならない。
//
// ライブラリを積まないのはこのリポジトリの方針（ビルド工程なし / push = デプロイ）
// をそのまま守るため。marked や markdown-it を CDN から読むと相対パス配信と
// オフライン時の挙動が崩れる。

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

// ── インライン ──────────────────────────────────────────────────────────────
//
// 画像・リンク・コード・強調を 1 本の正規表現で拾って順に置き換える。
// 入れ子（リンクの中の強調など）は記事に出てこないので扱わない。
const INLINE = /(!?)\[([^\]]*)\]\(([^)\s]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*/g;

/**
 * 画像は「参照はあるが表示できない」ことを文字で示す。
 *
 * 記事の ![...](charts/xxx.png) は Obsidian vault の相対パス。PNG は vault に
 * しか無く、GitHub Pages にも Supabase にも置いていないので、img を出すと必ず
 * 壊れた画像アイコンになる。黙って消すと「図があったこと」まで消えるため、
 * キャプションとして残す。
 */
function imagePlaceholder(alt) {
  const box = el("span", "md-image");
  box.append(el("span", "md-image-mark", "図"));
  box.append(el("span", "md-image-alt", alt || "画像"));
  return box;
}

function inline(text, target) {
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    if (match.index > last) target.append(text.slice(last, match.index));
    const [raw, bang, label, href, code, strong, em] = match;

    if (href !== undefined) {
      if (bang) {
        target.append(imagePlaceholder(label));
      } else if (/^https?:\/\//i.test(href)) {
        const a = el("a", null, label || href);
        a.href = href;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        target.append(a);
      } else {
        // vault 内リンク。アプリからは開けないので文字だけ残す。
        target.append(label || href);
      }
    } else if (code !== undefined) target.append(el("code", null, code));
    else if (strong !== undefined) target.append(el("strong", null, strong));
    else if (em !== undefined) target.append(el("em", null, em));
    else target.append(raw);

    last = match.index + raw.length;
  }
  if (last < text.length) target.append(text.slice(last));
  return target;
}

// ── ブロック ────────────────────────────────────────────────────────────────

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+(.*)$/;
const RULE = /^\s*([-*_])\1{2,}\s*$/;
const TABLE_DIVIDER = /^\s*\|?[\s:|-]+\|[\s:|-]*$/;

const cells = (line) =>
  line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());

/**
 * Markdown を DOM に変換する。
 *
 * @param {string} source  記事本文
 * @param {string} [skipTitle]  この文字列と一致する H1 は落とす（画面の見出しと二重になるため）
 * @returns {DocumentFragment}
 */
export function renderMarkdown(source, skipTitle) {
  const fragment = document.createDocumentFragment();
  const lines = String(source || "").replace(/\r\n?/g, "\n").split("\n");
  let i = 0;

  const paragraph = (buffer) => {
    if (!buffer.length) return;
    fragment.append(inline(buffer.join(" "), el("p", "md-p")));
    buffer.length = 0;
  };
  const buffer = [];

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      paragraph(buffer);
      i += 1;
      continue;
    }

    // 表: ヘッダ行 + 区切り行 が揃って初めて表とみなす
    if (line.includes("|") && TABLE_DIVIDER.test(lines[i + 1] || "")) {
      paragraph(buffer);
      const wrap = el("div", "md-table-wrap");
      const table = el("table", "md-table");
      const thead = el("thead");
      const headRow = el("tr");
      for (const cell of cells(line)) headRow.append(inline(cell, el("th")));
      thead.append(headRow);
      table.append(thead);

      const tbody = el("tbody");
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        const row = el("tr");
        for (const cell of cells(lines[i])) row.append(inline(cell, el("td")));
        tbody.append(row);
        i += 1;
      }
      table.append(tbody);
      wrap.append(table);
      fragment.append(wrap);
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      paragraph(buffer);
      const level = heading[1].length;
      const text = heading[2].trim();
      // 画面上部に出している記事タイトルと同じ H1 は落とす
      if (!(level === 1 && skipTitle && text === skipTitle)) {
        // 記事タイトルが画面の h1 なので、本文は h2 から始める。段を飛ばすと
        // 見出しだけを辿る読み上げで階層が崩れるため、2〜6 に丸める。
        const tag = `h${Math.min(Math.max(level, 2), 6)}`;
        fragment.append(inline(text, el(tag, `md-h${level}`)));
      }
      i += 1;
      continue;
    }

    if (RULE.test(line)) {
      paragraph(buffer);
      fragment.append(el("hr", "md-hr"));
      i += 1;
      continue;
    }

    if (line.trimStart().startsWith(">")) {
      paragraph(buffer);
      const quote = el("blockquote", "md-quote");
      const collected = [];
      while (i < lines.length && lines[i].trimStart().startsWith(">")) {
        collected.push(lines[i].trimStart().replace(/^>\s?/, ""));
        i += 1;
      }
      // 引用の中は段落だけ（空行で切る）。記事の引用は注記が数行あるだけ。
      let part = [];
      for (const row of [...collected, ""]) {
        if (row.trim()) part.push(row);
        else if (part.length) {
          quote.append(inline(part.join(" "), el("p", "md-p")));
          part = [];
        }
      }
      fragment.append(quote);
      continue;
    }

    const isOrdered = ORDERED.test(line);
    if (isOrdered || BULLET.test(line)) {
      paragraph(buffer);
      const list = el(isOrdered ? "ol" : "ul", "md-list");
      const pattern = isOrdered ? ORDERED : BULLET;
      while (i < lines.length && pattern.test(lines[i])) {
        list.append(inline(pattern.exec(lines[i])[1], el("li")));
        i += 1;
      }
      fragment.append(list);
      continue;
    }

    buffer.push(line.trim());
    i += 1;
  }
  paragraph(buffer);
  return fragment;
}
