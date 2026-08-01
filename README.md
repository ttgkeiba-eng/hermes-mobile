# Hermes Mobile

Hermes の日次スクリーニング結果を **Web Push** で受け取る最小 PWA。
サーバ側（Supabase スキーマ / Edge Function `send-push`）は
[hermes-project](https://github.com/) の `supabase/` 配下にある。

このアプリがやることは 3 つだけ:

1. Supabase にログインする（単一ユーザー / Email + パスワード）
2. Service Worker を登録して Push を購読する
3. 購読（`endpoint` / `p256dh` / `auth`）を `push_subscriptions` に upsert する

あとは 18:00 のバッチが `notifications` に行を入れると、Edge Function が
この購読へ暗号化した本文を送り、Service Worker が通知を出す。

## 構成

```text
hermes-mobile/
├── index.html              画面（ログイン / 通知の有効化）
├── app.js                  本体。fetch で GoTrue と PostgREST を直接叩く
├── config.js               接続設定（すべて公開値）
├── sw.js                   Service Worker（push / notificationclick）
├── styles.css              ダークテーマ
├── manifest.webmanifest    PWA マニフェスト（standalone）
├── icons/                  アイコン（生成物）
└── tools/generate_icons.py アイコン生成（依存ゼロ）
```

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

## 前提

サーバ側は用意済み（2026-08-02 時点）:

- `push_subscriptions` テーブル: **作成済み**（RLS 有効 / 0 行）
- Edge Function `send-push`: **デプロイ済み**（ACTIVE）
- VAPID Secrets 3 本: **投入済み**（手元の鍵とダイジェスト一致を確認）
- `notifications` のトリガー: **未作成**（購読ができてから最後に張る）

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
`styles.css` の `--bg` / `--accent` も揃えること。
