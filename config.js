// Hermes Mobile / 接続設定
//
// ここに書く 3 つの値は **すべて公開値** で、ブラウザに配られる前提のもの。
// GitHub Pages で誰でも読める場所に置くことになるが、それで問題ない理由:
//
//   SUPABASE_ANON_KEY  … publishable キー。これ単体では何も読めない。RLS で anon は
//                        全テーブル拒否（GRANT ごと剥奪済み）。ログインして
//                        authenticated にならないとデータに触れない。
//   VAPID_PUBLIC_KEY   … 名前のとおり公開鍵。購読時にブラウザへ渡す値。
//                        対になる秘密鍵は Supabase Secrets にしか無い。
//   SUPABASE_URL       … プロジェクトの URL。秘密ではない。
//
// **service_role キーは絶対にここに書かないこと。** RLS をバイパスするので、
// 置いた瞬間に誰でも全データを読み書きできるようになる。

export const SUPABASE_URL = "https://plxknbwrzzpxjmxxeomi.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_mU3BXO8uY67_p8yd2KF_gg_FD64gnb9";
export const VAPID_PUBLIC_KEY = "BMWOcoOP8EKcr4ZERN_rgrl6SxTvVbE48OOU5nfPS3af5q9RdR7kU2MuULvq4U_qjPsJl2j7631uZYyABly57sU";
