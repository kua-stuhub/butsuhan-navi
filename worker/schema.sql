-- 物販ナビ アクセス解析の受け取り用テーブル（Cloudflare D1）
-- 1回の送信を1行として保存する（書き込み数を送信数と同じにして、無料枠に収めるため）。
-- 端末を見分ける番号や IP アドレスは保存しない。
CREATE TABLE IF NOT EXISTS batches (
  at   TEXT NOT NULL,   -- 受け取った日時（UTC、ISO形式）
  data TEXT NOT NULL    -- {"d:<出展者ID>": 回数, ...} の JSON
);
-- QRコードの一覧。Worker がはじめて使うときに自動で作るので、手で作らなくてよい
CREATE TABLE IF NOT EXISTS qr_codes (code TEXT PRIMARY KEY, label TEXT NOT NULL, memo TEXT NOT NULL DEFAULT '', created TEXT NOT NULL);
