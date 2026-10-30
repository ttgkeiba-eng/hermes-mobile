# Hermes Mobile

Hermes の日次スクリーニング結果を見る・**Web Push** で受け取る最小 PWA。
サーバ側（Supabase スキーマ / Edge Function `send-push`）は
[hermes-project](https://github.com/) の `supabase/` 配下にある。

このアプリがやること:

1. Supabase にログインする（単一ユーザー / Email + パスワード）
2. Service Worker を登録して Push を購読する
3. 購読（`endpoint` / `p256dh` / `auth`）を `push_subscriptions` に upsert する
4. スクリーニング結果を読んで表示する（Phase D / **読み取りのみ**）

あとは 18:00 のバッチが `notifications` に行を入れると、Edge Function が
この購読へ暗号化した本文を送り、Service Worker が通知を出す。通知をタップすると
ホーム画面（その日の 1 位）に着地する。

## 構成

```text
hermes-mobile/
├── index.html              画面の器（ログイン / ホーム / 全銘柄 / 詳細 / 記事 / 週次 / 質問 / 設定）と下のタブ
├── app.js                  本体。ルーティング・読み込み中の表示・Push の有効化
├── session.js              セッションと PostgREST 呼び出し（トークン更新は 1 本にまとめる）
├── dashboard.js            ダッシュボードの取得と描画（読み取りのみ）
├── charts.js               グラフ（素の SVG：折れ線・度数分布・横棒・分岐棒・小さな推移）
├── chat.js                 アプリ内チャット（Edge Function chat を呼ぶ）
├── markdown.js             note 記事・チャット用の最小 Markdown レンダラ
├── config.js               接続設定（すべて公開値）
├── sw.js                   Service Worker（push / notificationclick / アプリのファイルの再検証）
├── styles.css              ダークテーマ（ゴールド系）
├── manifest.webmanifest    PWA マニフェスト（standalone）
├── icons/                  アイコン（生成物）
└── tools/
    ├── generate_icons.py   アイコン生成（依存ゼロ）
    └── preview/            画面の確認（Playwright と見本データ。本物の Supabase にはつながない）
```

### 画面（Phase D）

ハッシュだけでルーティングする。GitHub Pages は静的配信なので、パスで分けると
リロード時に 404 になる（`/all` という実ファイルは無い）。ハッシュなら常に
`index.html` が返り、端末の「戻る」もそのまま効く。

| ルート | 画面 | 中身 |
| --- | --- | --- |
| `#/` | ホーム | 1 位のヒーロー（直近 20 回の小さな推移つき）/ 上位 10 の横棒 / 全銘柄のスコアの分布 / 上位 30 のセクター / ウォッチリストの変動 |
| `#/all` | 銘柄 | 最新 `run_date` の全件。名前・コードの検索、セクターの絞り込み、並べ替え（順位・上がった順・下がった順） |
| `#/s/<code>` | 銘柄詳細 | スコアと順位の推移（折れ線 2 枚、1か月 / 3か月、タップで値、表でも読める）と内訳 |
| `#/article` | 記事 | その日の note 記事（`#/article/<YYYY-MM-DD>` で過去分） |
| `#/weekly` | 週次 | `diff_reports` の今週のスコア変動（大きく動いた銘柄の分岐棒つき） |
| `#/chat` | 質問 | Hermes に質問する（`#/chat/<code>` で銘柄を添える） |
| `#/settings` | 設定 | アカウント / 通知の有効化・解除（右上のボタンから） |

下のタブでホーム・銘柄・記事・週次・質問を行き来する。今いるタブをもう一度押すと先頭へ戻る。
右上の更新ボタンで今の画面を取り直す。ホームと銘柄は、30 分以上たってから前面に戻すと自動で取り直す。

`screening_results` には**その日に採点した全銘柄**（約 350）が入っている（上位だけではない）。

読むテーブルは `screening_results` / `scoring_breakdown` / `watchlist` /
`daily_articles` / `diff_reports` の 5 つで、
**すべてログイン中のユーザーの JWT（`authenticated`）経由**。`anon` キーは `apikey`
ヘッダにしか使っておらず、`service_role` はアプリに存在しない。書き込みは
`push_subscriptions` の upsert / delete だけで、Phase B から増えていない。

**前回比**は「最新 `run_date`」と「その 1 つ前の `run_date`」の `total_score` の差。
`screening_results` は上位 N 銘柄しか持たないので、ウォッチ銘柄がそこに居ない場合は
0 点扱いにせず **「圏外」** と表示する。

### 記事表示について（Phase D-2）

記事の**正本は Obsidian 側の Markdown**（`Daily/YYYY-MM/YYYYMMDD_note_article.md`）で、
`daily_articles` はアプリ配信用の写し。18:00 バッチの Step 3.7 が upsert する。

- Markdown は `markdown.js` が **DOM を直接組み立てて**描画する。`innerHTML` は使わない。
- 記事中の画像は vault の相対パス（`charts/*.png`）。PNG は Pages にも Supabase にも
  無いので `img` は出さず、「図があった」ことだけをキャプションで残す。

### チャットについて（Phase C）

質問は Supabase の Edge Function `chat` に投げる。**モデルもツールもサーバ側**にあり、
アプリは自分のアクセストークンで関数を呼ぶだけ。

- `ANTHROPIC_API_KEY` は **Supabase Secrets にしか無い**。`config.js` には置かない
  （置いた瞬間に GitHub Pages で誰でも読める＝課金が公開される）。
- 関数は呼び出し元を GoTrue で検証するので、`config.js` の publishable キーだけでは
  401 になる。ログインしていないと会話できない。
- 過去ログは `chat_messages` から `authenticated` の RLS 経由で読む。
- **モデルの出力を `innerHTML` に流さない。** `markdown.js`（DOM を直接組み立てる
  自前のレンダラ）に通す。出所がモデルである以上、文字列を組み立てて `innerHTML`
  する形にするとそこが注入経路になる。

サーバ側の仕様（ツール一覧・ガード・デプロイ手順）は hermes-project の
`supabase/README.md` の「Phase C」節を見ること。

**内訳の可視化はキー名を決め打ちしない。** 「値がオブジェクトのものはグループ」
「その中の数値が項目」「`subtotal` があれば小計」という構造だけを仮定しているので、
バッチ側が項目を足しても画面は壊れない（日本語ラベルの辞書に無いキーはそのまま出る）。

**ビルド工程は無い。** npm も node_modules も不要で、リポジトリの中身がそのまま
配信物になる。GitHub Pages へは push するだけ。

### なぜ Vite + React ではないのか

当初は Vite + React + `vite-plugin-pwa` を想定していたが、素の HTML/JS に落とした:

- Push の受信には `push` / `notificationclick` を持つ **自前の Service Worker** が要る。
  `vite-plugin-pwa` の既定（Workbox 生成 SW）とは噛み合わず、結局 `injectManifest`
  戦略で自分で SW を書くことになる。プラグインの利点がほぼ消える。
- 画面はボタン 2 つ。React を積む理由が無い。
- ビルドが無ければ「push = デプロイ」になり、CI もアーティファクトも要らない。

画面が育ってきたら Vite に移す。そのときも `sw.js` はほぼそのまま使える。

### ログインが切れる・ログイン画面が残る問題（2026-10 に修正）

- **ログインした後もログイン画面が隠れずに残っていた。** `styles.css` の `.view { display: flex }` が
  ブラウザ既定の `[hidden] { display: none }` に勝ち、全画面が縦に積み重なって見えていた。
  `[hidden] { display: none !important; }` を先頭に置いて直した。
- **通信エラーでログアウトしていた。** トークンの更新に失敗すると理由を問わずセッションを捨てていた。
  スマホは開いた直後に通信が戻っていないことが多い。今は**サーバが拒否したとき（4xx）だけ**ログアウトし、
  通信の失敗では画面に理由と「もう一度読み込む」を出す。
- **更新が同時に何本も走っていた。** 期限切れで開くと 3 本の読み込みがそれぞれ更新し、使い捨ての更新
  トークンを取り合っていた。今は 1 本にまとめる。期限の 5 分前から更新する。
- PostgREST が 401 を返したら、1 回だけ更新してやり直す。2 回続けば再ログイン。
- ログイン画面は前回のメールアドレスを覚える。エラーは日本語で、ボタンのすぐ上に出す。

### 画面の確認（Playwright）

```bash
node tools/preview/preview.mjs /tmp/hermes-preview
```

リポジトリをその場で配信し、Supabase への通信を `tools/preview/mock.mjs` の見本データ（作り物）に
差し替えて、スマホ幅で各画面のスクリーンショットを撮る。ログインまわりの動き（パスワード違い・更新は
1 回だけ・通信が落ちてもログアウトしない・拒否されたら再ログイン・401 のやり直し・ログイン後は
ログイン画面が見えない）も確かめ、すべて PASS なら終了コード 0。

## 前提

サーバ側は用意済み（2026-08-02 時点）:

- `push_subscriptions` テーブル: **作成済み**（RLS 有効 / 0 行）
- Edge Function `send-push`: **デプロイ済み**（ACTIVE）
- VAPID Secrets 3 本: **投入済み**（手元の鍵とダイジェスト一致を確認）
- `notifications` のトリガー: **有効**（INSERT → 約 1.5 秒で自動配信）

### ⚠ 新規登録を必ず無効化すること

このプロジェクトは現在 **誰でもサインアップできる状態**（`disable_signup: false`）。
RLS は「ログイン済み = `authenticated` なら全テーブル read 可」という単一ユーザー前提
なので、放置すると**第三者がアカウントを作るだけでスクリーニング結果・スコア内訳・
ウォッチリストを全部読める**。

Dashboard → **Authentication → Sign In / Providers → Email** で:

- **Allow new users to sign up** を **オフ**
- Confirm email はオンのままでよい

そのうえで自分のユーザーを 1 つ作る:

Dashboard → **Authentication → Users → Add user**
→ メールアドレスとパスワードを入れ、**Auto Confirm User** をオンにして作成。

## ローカルで試す

Service Worker と Push は **HTTPS か localhost** でしか動かない。
`file://` で開いても動かないので、必ずサーバ越しに開く:

```bash
python3 -m http.server 8000
# → http://localhost:8000/
```

Chrome の DevTools → Application タブで、Manifest / Service Workers / Push を確認できる。

## GitHub へ公開する

### 1. リポジトリと push（済み）

<https://github.com/ttgkeiba-eng/hermes-mobile> に push 済み（public / 既定ブランチ `main`）。

リモートは **SSH** で繋いである:

```bash
git remote -v
# origin  git@github.com:ttgkeiba-eng/hermes-mobile.git
```

HTTPS ではなく SSH なのは、この環境に HTTPS 用の資格情報が無く、
`hermes-project` / `trader-knowledge` も同じ SSH 鍵で運用されているため。
以降の更新は `git push` だけでよい。

### 2. Pages を有効化する

リポジトリ → **Settings → Pages**:

| 項目 | 値 |
| --- | --- |
| Source | **Deploy from a branch** |
| Branch | `main` |
| Folder | **`/ (root)`** ← `docs` ではない |

**`/ (root)` を選ぶ理由**: `index.html` / `manifest.webmanifest` / `sw.js` は
すべてリポジトリ直下にある。`docs` を選ぶと何も配信されない。
`docs/` に移すとビルド無しの利点（push = デプロイ）が崩れるので、そのままにしている。

1 分ほどで下記に出る:

```text
https://ttgkeiba-eng.github.io/hermes-mobile/
```

> **末尾のスラッシュを省かないこと。** `…/hermes-mobile` だと相対パスの解決が
> 1 階層ずれて `sw.js` や `manifest.webmanifest` が 404 になる。
> GitHub は自動でリダイレクトするが、手で開くときは付けておくと確実。

`.nojekyll` を置いてあるので Jekyll の処理は走らない（`_` 始まりのファイルが
無視される事故を防ぐ）。

## 動作確認の順番

**通知が届くまでには 3 つの層がある。切り分けられる順に確かめる。**

| # | 確認 | やり方 | これが通れば |
| --- | --- | --- | --- |
| 1 | インストールできる | Chrome のアドレスバー右のインストールアイコン | manifest とアイコンが正しい |
| 2 | 通知の**表示**ができる | ログイン → 「通知を有効化」→ **「テスト表示」** | SW と通知の見た目は正常。以降の失敗はサーバ側 |
| 3 | 購読が**保存**された | Supabase → Table Editor → `push_subscriptions` に 1 行 | 認証と RLS と upsert が正常 |
| 4 | サーバから**届く** | hermes-project 側の疎通確認（`curl` で send-push を叩く） | 経路全体が正常 |

「テスト表示」はサーバを経由せず端末内で `showNotification` を呼ぶだけのボタン。
これが出るのに 4 が届かないなら、原因は Edge Function か VAPID 鍵か購読データにある。

### Chrome での注意

- 通知を一度「ブロック」にすると、アプリからは戻せない。アドレスバー左の錠前
  アイコン → サイトの設定 → 通知 → 許可、で戻す。
- デスクトップ Chrome は OS 側の通知設定にも従う。Windows の集中モード / macOS の
  おやすみモードが有効だと出ない。
- Android Chrome は「ホーム画面に追加」しなくても Push を受けられる。

### iOS の注意

iOS は **16.4 以降 かつ ホーム画面に追加した PWA でのみ** Push が使える。
Safari のタブで開いている状態では `PushManager` が存在せず、画面には「非対応」と出る。

## 設定値について

`config.js` の 3 つはすべて公開値で、GitHub Pages で誰でも読める前提のもの:

| 値 | なぜ公開してよいか |
| --- | --- |
| `SUPABASE_URL` | ただのプロジェクト URL |
| `SUPABASE_ANON_KEY` | publishable キー。これ単体では何も読めない（`anon` は RLS と GRANT の両方で全拒否） |
| `VAPID_PUBLIC_KEY` | 名前のとおり公開鍵。購読時にブラウザへ渡す値 |

**`service_role` キーと VAPID 秘密鍵は絶対に置かないこと。** 前者は RLS をバイパスし、
後者があれば誰でもこのアプリ宛に通知を送れる。どちらも Supabase Secrets にしか無い。

## アイコンを変える

```bash
python3 tools/generate_icons.py
```

`tools/generate_icons.py` の `BG` / `FG` を変えて再実行すれば `icons/` が作り直される。
Pillow も ImageMagick も要らない（zlib で PNG を直接書いている）。
色を変えたら `manifest.webmanifest` の `theme_color` / `background_color` と
`styles.css` の `--bg` / `--gold` も揃えること。

## 配色

ダーク固定のゴールド系。彩度の高い面は 1 位のヒーローだけに使い、他は無彩色に寄せている。

| 用途 | 変数 | 値 |
| --- | --- | --- |
| 背景 | `--bg` | `#0B0D14` |
| カード | `--surface` | `#14161F`（上下でごく僅かな明度差を付けたグラデ） |
| ヒーロー枠 | `--gold-line` | `#C9A24B` |
| ボーダー | `--border` | `#262A34` |
| 文字 | `--text` | `#F2EEE6` |
| 副文字 | `--muted` | `#98917F` |
| アクセント | `--gold` | `#E6C97E` |
| 上昇 | `--up` | `#6FC59A` |
| 下落 | `--down` | `#E08A8A` |

数字はすべて等幅（`--mono` / `tabular-nums`）。1 位のスコアだけ `text-shadow` で
淡く発光させている。
