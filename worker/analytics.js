// 物販ナビ アクセス解析の受け取り口（Cloudflare Workers）
//
// POST /       … サイトから、まとめた回数を受け取って D1 に1行保存する
// GET  /export … 集計結果を JSON で返す。?token= に EXPORT_TOKEN と同じ値が要る
//
// 必要な設定（Cloudflare の画面で行う。README「アクセス解析」参照）
//   D1 のバインディング  DB          … schema.sql のテーブルを作ったデータベース
//   変数                 SITE_ORIGIN … https://kua-stuhub.github.io（ここ以外からの送信は受け取らない）
//   シークレット         EXPORT_TOKEN … 集計を取り出すときの合言葉
//
// IP アドレスなど、送信元を見分ける情報は保存しない。

const MAX_BYTES = 16384, MAX_KEYS = 200, MAX_COUNT = 500;
// 受け取るキーの形。これ以外は捨てる
//   pv … ページを開いた / d:<id> 詳細 / p:<id> 写真ビューア / pg:<id>:<n> 写真のn枚目
//   f+:<id> f-:<id> お気に入りの追加・解除 / s:<id> 共有 / from:map|list|link 詳細をどこから開いたか
//   t:<タグ> 絞り込み / q 検索 / zero 絞り込みで0件 / scope:fav / sort:shuffle|space / proj:iso|flat
//   dh:<id>:pre|am|mid|pm 詳細を開いた時間帯（開催前／当日の午前・昼・午後）
//   help / imgerr / ld:<秒の目安> 最初の表示までの時間 / h:<0-23> 見られた時間帯（日本時間）
const KEY = /^(pv|q|zero|help|imgerr|scope:fav|sort:(shuffle|space)|proj:(iso|flat)|from:(map|list|link)|ld:\d{1,2}|h:\d{1,2}|(d|p|f\+|f-|s):[A-Za-z0-9_-]{1,40}|pg:[A-Za-z0-9_-]{1,40}:\d|dh:[A-Za-z0-9_-]{1,40}:(pre|am|mid|pm)|t:[^\s]{1,40})$/u;

const cors = (env) => ({
  "Access-Control-Allow-Origin": env.SITE_ORIGIN || "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
});

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(env) });

    if (req.method === "POST" && url.pathname === "/") {
      const origin = req.headers.get("Origin");
      if (env.SITE_ORIGIN && origin && origin !== env.SITE_ORIGIN) return new Response("forbidden", { status: 403 });
      const body = await req.text();
      if (!body || body.length > MAX_BYTES) return new Response("too large", { status: 413, headers: cors(env) });
      let input; try { input = JSON.parse(body); } catch { return new Response("bad json", { status: 400, headers: cors(env) }); }
      const clean = {}; let n = 0;
      for (const [k, v] of Object.entries(input || {})) {
        if (n >= MAX_KEYS || !KEY.test(k)) continue;
        const c = Math.floor(Number(v));
        if (c > 0) { clean[k] = Math.min(c, MAX_COUNT); n++; }
      }
      if (n) await env.DB.prepare("INSERT INTO batches (at, data) VALUES (?, ?)").bind(new Date().toISOString(), JSON.stringify(clean)).run();
      return new Response(null, { status: 204, headers: cors(env) });
    }

    if (req.method === "GET" && url.pathname === "/export") {
      if (!env.EXPORT_TOKEN || url.searchParams.get("token") !== env.EXPORT_TOKEN) return new Response("forbidden", { status: 403 });
      const { results } = await env.DB.prepare(
        "SELECT j.key AS key, SUM(j.value) AS n FROM batches, json_each(batches.data) AS j GROUP BY j.key ORDER BY j.key"
      ).all();
      const { results: meta } = await env.DB.prepare("SELECT COUNT(*) AS batches, MIN(at) AS first, MAX(at) AS last FROM batches").all();
      return Response.json({ ...meta[0], counts: Object.fromEntries(results.map((r) => [r.key, r.n])) });
    }

    return new Response("not found", { status: 404 });
  },
};
