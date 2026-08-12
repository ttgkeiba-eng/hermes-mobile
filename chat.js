// Hermes Mobile / アプリ内チャット（Phase C）
//
// Edge Function `chat` を叩いて会話する画面。モデルもツールもサーバ側にあり、
// ここがやるのは「送る・並べる・待っている間そう見せる」だけ。
//
//   #/chat          … ふつうに開く
//   #/chat/<code>   … 銘柄詳細の「この銘柄について聞く」から。ticker を添えて送る
//
// 秘密情報はここに無い。ANTHROPIC_API_KEY は Supabase Secrets にしか置かず、
// アプリは自分のアクセストークンで Edge Function を呼ぶだけ。
//
// **モデルの出力を innerHTML に流さない。** markdown.js（DOM を直接組み立てる
// 自前のレンダラ）に通す。文字列を組み立てて innerHTML する形にすると、出所が
// モデルである以上そこが注入経路になる。

import { callFunction, select } from "./session.js";
import { renderMarkdown } from "./markdown.js";

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** サーバへ引き継ぐ履歴の件数。Edge Function 側も 10 件で切っている。 */
const HISTORY_LIMIT = 10;

/** 画面に読み込む過去ログの件数。 */
const BACKLOG_LIMIT = 20;

// 画面を離れても会話が消えないよう、モジュール側に持つ。
// リロードで消えるが、過去ログは chat_messages から読み直せる。
let messages = [];
let loadedBacklog = false;
let pending = false;

/** 過去ログを chat_messages から読む（authenticated の RLS 経由）。 */
export async function loadBacklog() {
  if (loadedBacklog) return;
  const rows = await select(
    `chat_messages?select=role,content,created_at&order=created_at.desc&limit=${BACKLOG_LIMIT}`,
  );
  // 新しい順で取って古い順に並べ直す（表示は上から下へ時系列）。
  messages = rows.slice().reverse().map((r) => ({ role: r.role, content: r.content }));
  loadedBacklog = true;
}

function bubble(role, content) {
  const row = el("div", `bubble-row ${role}`);
  const bubbleEl = el("div", `bubble ${role}`);
  if (role === "assistant") {
    // 自前レンダラで DOM を組む。innerHTML は使わない。
    bubbleEl.append(renderMarkdown(content));
  } else {
    // ユーザーの発言は書いたまま。改行だけ保つ。
    bubbleEl.classList.add("plain");
    bubbleEl.textContent = content;
  }
  row.append(bubbleEl);
  return row;
}

/**
 * 会話画面を組み立てる。
 *
 * @param {HTMLElement} root  描画先
 * @param {string|null} ticker  銘柄詳細から来た場合の銘柄コード
 * @param {string|null} runDate  同じく対象日
 */
export function renderChat(root, ticker, runDate) {
  root.textContent = "";

  const head = el("div", "section-head");
  head.append(el("span", "run-date", ticker ? `${ticker} について聞く` : "Hermes に聞く"));
  root.append(head);

  const log = el("div", "chat-log");
  root.append(log);

  if (!messages.length) {
    log.append(
      el(
        "p",
        "empty",
        ticker
          ? `${ticker} のスコアの内訳や推移について聞けます。`
          : "スコアの理由や今週の動きについて聞けます。数字はその場でデータベースから引きます。",
      ),
    );
  }
  for (const m of messages) log.append(bubble(m.role, m.content));

  // 送信中の表示。行を1つ足して、返ってきたら中身を差し替える。
  const thinking = el("div", "bubble-row assistant");
  const thinkingBubble = el("div", "bubble assistant thinking", "考え中…");
  thinking.append(thinkingBubble);
  thinking.hidden = true;
  log.append(thinking);

  const form = el("form", "chat-form");
  const input = el("input", "chat-input");
  input.type = "text";
  input.placeholder = ticker ? `${ticker} について質問する` : "質問を入力";
  input.autocomplete = "off";
  input.setAttribute("aria-label", "質問");
  const send = el("button", "chat-send", "送信");
  send.type = "submit";
  form.append(input, send);
  root.append(form);

  root.append(
    el(
      "p",
      "disclaimer",
      "回答はスクリーニング結果をもとにした説明で、売買の推奨ではありません。",
    ),
  );

  const scrollToEnd = () => {
    // 入力欄が隠れないよう、最後の行まで送る。
    window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
  };

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const question = input.value.trim();
    if (!question || pending) return;

    pending = true;
    input.value = "";
    input.disabled = true;
    send.disabled = true;

    messages.push({ role: "user", content: question });
    log.insertBefore(bubble("user", question), thinking);
    // 空状態の案内は最初の発言で消す。
    const empty = log.querySelector(".empty");
    if (empty) empty.remove();

    thinking.hidden = false;
    thinkingBubble.textContent = "考え中…";
    scrollToEnd();

    try {
      const result = await callFunction("chat", {
        message: question,
        ticker: ticker || null,
        run_date: runDate || null,
        history: messages.slice(-HISTORY_LIMIT - 1, -1),
      });
      const answer = result.answer || "回答が空でした。";
      messages.push({ role: "assistant", content: answer });
      thinking.hidden = true;
      log.insertBefore(bubble("assistant", answer), thinking);
      if (result.truncated) {
        log.insertBefore(
          el("p", "note", "情報を集めきる前に打ち切りました。質問を分けると通りやすくなります。"),
          thinking,
        );
      }
    } catch (error) {
      // 失敗も会話に残さず、その場に理由を出す（履歴が汚れると次の質問に効いてしまう）。
      messages.pop();
      thinking.hidden = true;
      log.insertBefore(el("p", "chat-error", error.message), thinking);
    } finally {
      pending = false;
      input.disabled = false;
      send.disabled = false;
      scrollToEnd();
    }
  });

  // 銘柄から来たときは入力欄にフォーカスしない（iOS でキーボードが開いて
  // 画面の大半が隠れるため）。ユーザーがタップしたときだけ開く。
}
