// 物販ナビ アクセス解析の受け取り口（Cloudflare Workers）
//
// POST /       … サイトから、まとめた回数を受け取って D1 に1行保存する
// GET  /export … 集計結果を JSON で返す。?token= に EXPORT_TOKEN と同じ値が要る
// GET  /dashboard … 運営用の集計ページ。開いたあと合言葉（EXPORT_TOKEN）を入れると数字が出る
// GET  /qr        … 登録したQRコードの一覧。POST /qr で作る・名前を変える・消す（どちらも ?token= が要る）
// GET  /qrcode.js … 集計ページでQRコードの画像を作るライブラリ
//
// 必要な設定（Cloudflare の画面で行う。README「アクセス解析」参照）
//   D1 のバインディング  DB          … schema.sql のテーブルを作ったデータベース
//   変数                 SITE_ORIGIN … https://kua-stuhub.github.io（ここ以外からの送信は受け取らない）
//   シークレット         EXPORT_TOKEN … 集計を取り出すときの合言葉
//   変数（任意）         SITE_URL    … 公開サイトのURL（QRコードの行き先）。省略時は SITE_ORIGIN/butsuhan-navi/
//   変数（任意）         SITE_DATA   … 公開サイトの data.json のURL。省略時は SITE_URL/data.json
//
// IP アドレスなど、送信元を見分ける情報は保存しない。

const MAX_BYTES = 16384, MAX_KEYS = 200, MAX_COUNT = 500;
// 受け取るキーの形。これ以外は捨てる
//   pv … ページを開いた / nv … その端末ではじめて数えた（端末の数の目安） / d:<id> 詳細 / p:<id> 写真ビューア / pg:<id>:<n> 写真のn枚目
//   f+:<id> f-:<id> お気に入りの追加・解除 / s:<id> 共有 / from:map|list|link 詳細をどこから開いたか
//   t:<タグ> 絞り込み / q 検索 / zero 絞り込みで0件 / scope:fav / sort:shuffle|space / proj:iso|flat
//   dh:<id>:pre|am|mid|pm 詳細を開いた時間帯（開催前／当日の午前・昼・午後）
//   help / imgerr / ld:<秒の目安> 最初の表示までの時間 / h:<0-23> 見られた時間帯（日本時間）
//   qr:<コード> QRコードから開いた / qn:<コード> そのQRコードから来て、その端末ではじめて数えた
const QR_CODE = /^[a-z0-9-]{1,24}$/;
const KEY = /^(pv|nv|q|zero|help|imgerr|(qr|qn):[a-z0-9-]{1,24}|scope:fav|sort:(shuffle|space)|proj:(iso|flat)|from:(map|list|link)|ld:\d{1,2}|h:\d{1,2}|hd:\d{4}-\d{2}-\d{2}:\d{1,2}|(d|p|f\+|f-|s):[A-Za-z0-9_-]{1,40}|pg:[A-Za-z0-9_-]{1,40}:\d|dh:[A-Za-z0-9_-]{1,40}:(pre|am|mid|pm)|t:[^\s]{1,40})$/u;

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
      // 日本時間の日付ごとの送信数・はじめての端末の数（受け取った日で分ける）
      const { results: recv } = await env.DB.prepare(
        "SELECT substr(datetime(at, '+9 hours'), 1, 10) AS day, COUNT(*) AS batches, SUM(COALESCE(json_extract(data, '$.pv'), 0)) AS pv, SUM(COALESCE(json_extract(data, '$.nv'), 0)) AS nv FROM batches GROUP BY day ORDER BY day"
      ).all();
      // 日付ごとの時間帯。hd:日付:時 はページを開いた日。古い h:時 は日付を持たないので受け取った日で代用
      const { results: hours } = await env.DB.prepare(
        "SELECT day, h, SUM(n) AS n FROM (" +
        "SELECT substr(j.key, 4, 10) AS day, CAST(substr(j.key, 15) AS INTEGER) AS h, j.value AS n FROM batches, json_each(batches.data) AS j WHERE j.key LIKE 'hd:%' " +
        "UNION ALL SELECT substr(datetime(at, '+9 hours'), 1, 10), CAST(substr(j.key, 3) AS INTEGER), j.value FROM batches, json_each(batches.data) AS j WHERE j.key LIKE 'h:%'" +
        ") GROUP BY day, h ORDER BY day, h"
      ).all();
      // 日別のページを開いた回数も、開いた日で数え直す（ページを開くたびに時間帯も1つ数えているので合計は同じ）
      const by = {};
      for (const r of recv) by[r.day] = { day: r.day, batches: r.batches, pv: 0, nv: r.nv };
      for (const r of hours) (by[r.day] ||= { day: r.day, batches: 0, pv: 0, nv: 0 }).pv += r.n;
      const daily = Object.values(by).sort((a, b) => (a.day < b.day ? -1 : 1));
      return Response.json({ ...meta[0], daily, hours, counts: Object.fromEntries(results.map((r) => [r.key, r.n])) });
    }

    if (req.method === "GET" && url.pathname === "/dashboard") {
      const site = env.SITE_URL || `${env.SITE_ORIGIN || "https://kua-stuhub.github.io"}/butsuhan-navi/`;
      const data = env.SITE_DATA || `${site}data.json`;
      return new Response(DASHBOARD.replace("__SITE_DATA__", JSON.stringify(data)).replace("__SITE_URL__", JSON.stringify(site)), {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex", "Referrer-Policy": "no-referrer" },
      });
    }

    if (url.pathname === "/qr" && (req.method === "GET" || req.method === "POST")) {
      if (!env.EXPORT_TOKEN || url.searchParams.get("token") !== env.EXPORT_TOKEN) return new Response("forbidden", { status: 403 });
      // QRコードの表は、はじめて使ったときに作る（D1 の画面で SQL を流さなくてよいように）
      await env.DB.prepare("CREATE TABLE IF NOT EXISTS qr_codes (code TEXT PRIMARY KEY, label TEXT NOT NULL, memo TEXT NOT NULL DEFAULT '', created TEXT NOT NULL)").run();
      if (req.method === "POST") {
        let b; try { b = JSON.parse(await req.text()); } catch { return new Response("bad json", { status: 400 }); }
        const code = String(b?.code || ""), label = String(b?.label || "").trim().slice(0, 60), memo = String(b?.memo || "").trim().slice(0, 200);
        if (!QR_CODE.test(code)) return new Response("bad code", { status: 400 });
        if (b.action === "delete") await env.DB.prepare("DELETE FROM qr_codes WHERE code = ?").bind(code).run();
        else if (b.action === "save" && label) await env.DB.prepare(
          "INSERT INTO qr_codes (code, label, memo, created) VALUES (?, ?, ?, ?) ON CONFLICT(code) DO UPDATE SET label = excluded.label, memo = excluded.memo"
        ).bind(code, label, memo, new Date().toISOString()).run();
        else return new Response("bad request", { status: 400 });
      }
      const { results } = await env.DB.prepare("SELECT code, label, memo, created FROM qr_codes ORDER BY created").all();
      return Response.json({ codes: results }, { headers: { "Cache-Control": "no-store" } });
    }

    if (req.method === "GET" && url.pathname === "/qrcode.js") {
      return new Response(QRCODE_LIB, { headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=86400" } });
    }

    return new Response("not found", { status: 404 });
  },
};

// 運営用の集計ページ（/dashboard）。数字は持たず、開いたあと合言葉で /export から読む。
// 出展者名などは公開サイトの data.json から引く。合言葉はこの端末のブラウザにだけ保存する。
// PC（横1100px・縦680px以上）では1画面に収まり、出展者の表だけ中でスクロールする。
const DASHBOARD = String.raw`<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>物販ナビ 集計</title>
<style>
:root{color-scheme:light;--bg:#f2f2ef;--card:#fcfcfb;--fg:#0b0b0b;--muted:#5d5c58;--faint:#8a8984;--line:#e4e3de;
  --bar:#2a78d6;--bar-soft:#dce8f8;--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--warn:#c93b3b;--warn-soft:#f8e0de}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;--bg:#111110;--card:#1a1a19;--fg:#f0efec;--muted:#c3c2b7;--faint:#8d8c85;--line:#302f2c;
  --bar:#3987e5;--bar-soft:#1e3049;--s1:#3987e5;--s2:#d95926;--s3:#199e70;--warn:#e66767;--warn-soft:#3d2222}}
:root[data-theme="dark"]{color-scheme:dark;--bg:#111110;--card:#1a1a19;--fg:#f0efec;--muted:#c3c2b7;--faint:#8d8c85;--line:#302f2c;
  --bar:#3987e5;--bar-soft:#1e3049;--s1:#3987e5;--s2:#d95926;--s3:#199e70;--warn:#e66767;--warn-soft:#3d2222}
*{box-sizing:border-box}
[hidden]{display:none!important}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.5 system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif}
main{max-width:1880px;margin:0 auto;padding:14px max(16px,env(safe-area-inset-right,0px)) 14px max(16px,env(safe-area-inset-left,0px));display:flex;flex-direction:column;gap:10px}
h1{font-size:17px;margin:0}
h2{font-size:12px;font-weight:700;margin:0;color:var(--fg)}
.sub{color:var(--muted);font-size:12px;margin:0}
.panel{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:8px;min-width:0;min-height:0}
.ph{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
.ph small{color:var(--faint);font-size:11px}
button{font:inherit;font-size:12px;padding:6px 12px;border-radius:8px;border:1px solid var(--line);background:var(--fg);color:var(--card);cursor:pointer}
button.alt{background:transparent;color:var(--fg)}
button:focus-visible,input:focus-visible,th:focus-visible{outline:2px solid var(--bar);outline-offset:2px}
.login{max-width:520px}
.login form{display:flex;gap:8px;flex-wrap:wrap}
.login input{flex:1;min-width:180px;font:inherit;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg)}
.err{color:var(--warn);margin:0}
.note{color:var(--faint);font-size:11px;margin:0}
.top{display:flex;justify-content:space-between;align-items:center;gap:8px 16px;flex-wrap:wrap}
.top .t{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}
.top .acts{display:flex;gap:6px}
/* KPI */
.kpis{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:10px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px}
.kpi span{display:block;color:var(--muted);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.kpi b{display:block;font-size:24px;line-height:1.25;font-variant-numeric:tabular-nums;font-weight:700}
.kpi b small{font-size:13px;font-weight:600;color:var(--muted);margin-left:2px}
/* 段 */
.row2{display:grid;grid-template-columns:3fr 5fr 2.6fr 3fr;gap:10px}
.row3{display:grid;grid-template-columns:6fr 3fr 3fr;gap:10px}
/* 縦棒 */
.chart{display:flex;flex-direction:column;flex:1;min-height:120px}
.plot{position:relative;flex:1;display:flex;align-items:flex-end;gap:3px;border-bottom:1px solid var(--line)}
.plot .b{flex:1;min-width:0;height:100%;display:flex;align-items:flex-end;justify-content:center}
.plot .b i{display:block;width:100%;max-width:40px;background:var(--bar);border-radius:4px 4px 0 0}
.plot .b.z i{height:0!important}
.plot.dense{gap:2px}.plot.dense .b i{border-radius:3px 3px 0 0}
.plot .b:hover i{filter:brightness(1.12)}
.plot .b.ev i{background:var(--s2)}
.plot .ymax{position:absolute;left:0;top:-2px;font-size:10px;color:var(--faint);pointer-events:none;background:var(--card);padding-right:4px;line-height:1}
.plot .gl{position:absolute;left:0;right:0;top:0;border-top:1px dashed var(--line);pointer-events:none}
.plot .vl{position:absolute;top:0;bottom:0;border-left:2px dashed var(--fg);opacity:.55;pointer-events:none}
.plot .vlt{position:absolute;top:10px;font-size:10px;color:var(--fg);background:var(--card);padding:0 3px;pointer-events:none;white-space:nowrap}
.plot .vals{position:absolute;inset:0;display:flex;gap:3px;pointer-events:none}
.plot.hasv{margin-top:16px}
.plot .vals span{flex:1;position:relative}
.plot .vals em{position:absolute;left:-20px;right:-20px;text-align:center;font-style:normal;font-size:11px;color:var(--fg);font-variant-numeric:tabular-nums}
.ax{display:flex;gap:3px;height:16px;margin-top:3px}
.ax.dense{gap:2px}
.ax span{flex:1;min-width:0;text-align:center;font-size:10px;color:var(--faint);white-space:nowrap;overflow:visible}
/* 100%積み上げ */
.donut{display:flex;align-items:center;gap:14px;flex:1;min-height:0}
.donut svg{flex:0 0 auto;width:min(132px,100%);height:auto;max-height:100%}
.donut svg path{stroke:var(--card);stroke-width:2}
.donut svg path:hover{filter:brightness(1.1)}
.donut .leg{flex:1;min-width:0}
.donut .c1{font-size:20px;font-weight:700;fill:var(--fg);font-variant-numeric:tabular-nums}
.donut .c2{font-size:10px;fill:var(--muted)}
.donut text{pointer-events:none}
.pager{display:flex;align-items:center;gap:4px}
.pager button{padding:1px 8px;font-size:12px;line-height:1.4}
.pager button:disabled{opacity:.35;cursor:default}
.pager span{font-size:11px;color:var(--muted);min-width:6.5em;text-align:center;font-variant-numeric:tabular-nums}
select{font:inherit;font-size:12px;padding:2px 6px;border-radius:6px;border:1px solid var(--line);background:var(--card);color:var(--fg)}
.leg{display:grid;grid-template-columns:auto 1fr auto auto;gap:4px 8px;align-items:center;font-size:12px}
.leg span{white-space:nowrap}
.leg .sw{width:10px;height:10px;border-radius:3px}
.leg .n{font-variant-numeric:tabular-nums;text-align:right}
.leg .p{font-variant-numeric:tabular-nums;text-align:right;color:var(--muted);min-width:3.2em}
/* 横棒リスト（ラベルの後ろに棒） */
.list{display:flex;flex-direction:column;gap:3px;overflow:auto;min-height:0;flex:1}
.li{position:relative;display:flex;justify-content:space-between;gap:8px;padding:2px 8px;border-radius:5px;font-size:12px}
.li i{position:absolute;left:0;top:0;bottom:0;background:var(--bar-soft);border-radius:5px;z-index:0}
.li span,.li b{position:relative;z-index:1}
.li span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.li b{font-weight:600;font-variant-numeric:tabular-nums}
.li.warn i{background:var(--warn-soft)}.li.warn b{color:var(--warn)}
.li.sep{margin-top:6px}
.empty{color:var(--faint);font-size:12px}
/* 表 */
.tablewrap{overflow:auto;flex:1;min-height:0;margin:0 -6px}
table{border-collapse:collapse;width:100%;font-size:12px}
th,td{padding:5px 8px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
th{font-size:11px;color:var(--muted);font-weight:600;cursor:pointer;user-select:none;position:sticky;top:0;background:var(--card);z-index:1}
th[aria-sort]::after{content:" ▾"}th[aria-sort=ascending]::after{content:" ▴"}
td.l,th.l{text-align:left}
td.name{max-width:18em;overflow:hidden;text-overflow:ellipsis}
.cb{display:inline-block;width:72px;height:8px;background:var(--bar-soft);border-radius:4px;margin-left:8px;vertical-align:middle;overflow:hidden}
.cb i{display:block;height:100%;background:var(--bar);border-radius:4px}
tbody tr:hover td{background:var(--bg)}
/* ツールチップ */
#tip{position:fixed;z-index:9;pointer-events:none;background:var(--fg);color:var(--card);font-size:12px;padding:4px 8px;border-radius:6px;white-space:nowrap;font-variant-numeric:tabular-nums;transform:translate(-50%,calc(-100% - 8px))}
/* PC は1画面に収める */
@media (min-width:1100px) and (min-height:680px){
  main{height:100%}
  #out{display:flex;flex-direction:column;gap:10px;flex:1;min-height:0}
  .row2{flex:0 0 31%;min-height:0}
  .row3{flex:1;min-height:0}
  .row3 .panel{overflow:hidden}
}
/* 切り替え */
.tabs{display:flex;gap:4px}
.tabs button{background:transparent;color:var(--fg)}
.tabs button[aria-pressed=true]{background:var(--fg);color:var(--card)}
/* QRコード */
.qgrid{display:grid;grid-template-columns:2fr 1fr;gap:10px}
.qgrid table tbody tr{cursor:pointer}
.qgrid tr.sel td{background:var(--bar-soft)}
.qgrid td.dim{color:var(--faint)}
.qform{display:grid;grid-template-columns:auto 1fr;gap:6px 8px;align-items:center;font-size:12px}
.qform input{font:inherit;padding:6px 8px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);min-width:0}
.qform .full{grid-column:1/-1;display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.qprev{display:flex;flex-direction:column;gap:8px;align-items:flex-start}
.qprev .img{width:200px;max-width:100%;aspect-ratio:1;background:#fff;border:1px solid var(--line);border-radius:8px;padding:6px}
.qprev .img svg{display:block;width:100%;height:100%}
.qprev .url{font-family:ui-monospace,Menlo,monospace;font-size:12px;word-break:break-all;margin:0}
.qprev .btns{display:flex;gap:6px;flex-wrap:wrap}
@media (min-width:1100px) and (min-height:680px){
  #qrv{flex:1;min-height:0}
  .qgrid{height:100%}
  .qgrid .panel{overflow:auto}
}
@media (max-width:1099px){
  .qgrid{grid-template-columns:1fr}
  #out{display:flex;flex-direction:column;gap:10px}
  .kpis{grid-template-columns:repeat(3,minmax(0,1fr))}
  .row2,.row3{grid-template-columns:1fr 1fr}
  .row2 .hours,.row3 .exh{grid-column:1/-1}
  .chart{min-height:150px}
  .tablewrap{max-height:70vh}
}
@media (max-width:640px){
  .kpis{grid-template-columns:repeat(2,minmax(0,1fr))}
  .row2,.row3{grid-template-columns:1fr}
  .cb{display:none}
  .ax.dense span:nth-child(odd){visibility:hidden}
}
</style></head>
<body><main>
<div class="top">
  <div class="t"><h1>物販ナビ 集計</h1><p class="sub" id="span">運営の中だけで見るページです。出展者ごとの順位は外に出さないでください（規約 第4条）</p></div>
  <div class="acts" id="acts" hidden><div class="tabs"><button class="alt" data-view="out" aria-pressed="true">全体</button><button class="alt" data-view="qrv" aria-pressed="false">QRコード</button></div><button class="alt" id="reload">更新</button><button class="alt" id="logout">合言葉を消す</button></div>
</div>

<section class="panel login" id="login">
  <h2>合言葉</h2>
  <form id="f"><input id="tok" type="password" autocomplete="current-password" placeholder="EXPORT_TOKEN" aria-label="合言葉"><button>表示</button></form>
  <p class="note">この端末のブラウザにだけ保存されます。共有のパソコンでは、使い終わったら「合言葉を消す」を押してください。</p>
  <p class="err" id="err" hidden></p>
</section>

<div id="out" hidden>
  <div class="kpis" id="kpis"></div>
  <div class="row2">
    <section class="panel"><div class="ph"><h2>日別</h2><div class="pager"><button class="alt" id="wprev" aria-label="前の週">‹</button><span id="wlabel"></span><button class="alt" id="wnext" aria-label="次の週">›</button></div></div><div class="chart" id="daily"></div><p class="note">ページを開いた回数・橙は開催日</p></section>
    <section class="panel hours"><div class="ph"><h2>時間帯 <small>日本時間・ページを開いた回数</small></h2><select id="hday" aria-label="日付"></select></div><div class="chart" id="hours"></div></section>
    <section class="panel"><div class="ph"><h2>表示までの時間</h2><small>秒・30は30秒以上</small></div><div class="chart" id="ld"></div></section>
    <section class="panel"><div class="ph"><h2>詳細をどこから開いたか</h2></div><div class="donut"><svg id="pie" viewBox="0 0 120 120" role="img" aria-label="詳細をどこから開いたかの割合"></svg><div class="leg" id="leg"></div></div></section>
  </div>
  <div class="row3">
    <section class="panel exh"><div class="ph"><h2>出展者ごと</h2><span><small>見出しで並び替え・お気に入りは追加−解除</small> <button class="alt" id="csv">CSVで保存</button></span></div>
      <div class="tablewrap"><table id="tbl"></table></div></section>
    <section class="panel"><div class="ph"><h2>機能の利用</h2><small>回数</small></div><div class="list" id="feat"></div></section>
    <section class="panel"><div class="ph"><h2>タグでの絞り込み</h2><small id="zero"></small></div><div class="list" id="tags"></div></section>
  </div>
</div>
<div id="qrv" hidden>
  <div class="qgrid">
    <section class="panel"><div class="ph"><h2>QRコードごと</h2><small>同意した人だけの数・行を押すとQRコードが出ます</small></div>
      <div class="tablewrap"><table id="qtbl"></table></div>
      <p class="note">「開いた回数」はQRコードを読んでサイトを開いた回数、「はじめての端末」はそのうち、その端末で初めて数えたもの。消したQRコードや未登録のコードで来た分は「未登録」として残ります。</p></section>
    <section class="panel">
      <h2>新しく作る</h2>
      <form class="qform" id="qf">
        <label for="qlabel">名前</label><input id="qlabel" maxlength="60" placeholder="例：チラシ（学内配布）" required>
        <label for="qcode">コード</label><input id="qcode" maxlength="24" pattern="[a-z0-9-]{1,24}" placeholder="空欄なら自動（英小文字・数字・-）">
        <label for="qmemo">メモ</label><input id="qmemo" maxlength="200" placeholder="配った場所・枚数など（任意）">
        <div class="full"><button>作る</button><span class="err" id="qerr" hidden></span></div>
      </form>
      <p class="note">コードはQRコードの中身（URL）に入るので、印刷したあとは変えられません。名前とメモはあとから変えられます。</p>
      <h2 id="qsel-h" hidden>選んだQRコード</h2>
      <div class="qprev" id="qsel" hidden>
        <div class="img" id="qimg"></div>
        <div><b id="qname"></b><p class="note" id="qnote"></p></div>
        <p class="url" id="qurl"></p>
        <div class="btns"><button id="qsvg">SVGで保存</button><button class="alt" id="qpng">PNGで保存</button><button class="alt" id="qcopy">URLをコピー</button><button class="alt" id="qedit">名前・メモを変える</button><button class="alt" id="qdel">消す</button></div>
        <p class="note">印刷にはSVG（拡大してもぼやけない）がおすすめです。読み取れるよう、印刷では2cm角以上にしてください。</p>
      </div>
    </section>
  </div>
</div>
</main>
<div id="tip" hidden></div>
<script src="qrcode.js"></script>
<script>
var SITE_DATA = __SITE_DATA__, SITE_URL = __SITE_URL__;
var $ = function (s) { return document.querySelector(s); };
var store = { get: function () { try { return localStorage.getItem("bn_dash_token") || ""; } catch (e) { return ""; } },
  set: function (v) { try { v ? localStorage.setItem("bn_dash_token", v) : localStorage.removeItem("bn_dash_token"); } catch (e) {} } };
var fmt = function (n) { return Number(n || 0).toLocaleString("ja-JP"); };
var pct = function (a, b) { return b ? Math.round(a / b * 100) + "%" : "—"; };
var el = function (tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
var C = {}, EX = [], sortKey = "d", sortAsc = false;
var n = function (k) { return C[k] || 0; };
function sum(re) { return Object.keys(C).filter(function (k) { return re.test(k); }).reduce(function (a, k) { return a + C[k]; }, 0); }

// ツールチップ：data-tip を持つ要素に乗ったら出す
var tip = $("#tip");
document.addEventListener("pointermove", function (ev) {
  var t = ev.target.closest && ev.target.closest("[data-tip]");
  if (!t) { tip.hidden = true; return; }
  tip.textContent = t.getAttribute("data-tip"); tip.hidden = false;
  var r = t.getBoundingClientRect();
  tip.style.left = Math.min(window.innerWidth - 60, Math.max(60, r.left + r.width / 2)) + "px";
  tip.style.top = Math.max(30, r.top) + "px";
});
document.addEventListener("pointerleave", function () { tip.hidden = true; });

// 縦棒。items: [{v, label, tip, cls}]。opt: {dense, values, marker:{at, text}}
function columns(box, items, opt) {
  opt = opt || {}; box.textContent = "";
  var max = Math.max.apply(null, items.map(function (x) { return x.v; }).concat([0]));
  var plot = el("div", "plot" + (opt.dense ? " dense" : "") + (opt.values ? " hasv" : "")), ax = el("div", "ax" + (opt.dense ? " dense" : ""));
  items.forEach(function (x) {
    var b = el("div", "b" + (x.v ? "" : " z") + (x.cls ? " " + x.cls : "")); b.setAttribute("data-tip", x.tip + "：" + fmt(x.v));
    var i = el("i"); i.style.height = (max ? x.v / max * 100 : 0) + "%"; b.append(i); plot.append(b);
    ax.append(el("span", "", x.label));
  });
  if (max && !opt.values) { plot.append(el("div", "gl")); plot.append(el("span", "ymax", fmt(max))); }
  if (opt.values) {
    var vals = el("div", "vals");
    items.forEach(function (x) { var s = el("span"); var t = el("em", "", fmt(x.v)); t.style.bottom = "calc(" + (max ? x.v / max * 100 : 0) + "% + 2px)"; s.append(t); vals.append(s); });
    plot.append(vals);
  }
  if (opt.marker && max) {
    var left = (opt.marker.at + 0.5) / items.length * 100;
    var vl = el("div", "vl"); vl.style.left = left + "%"; plot.append(vl);
    var vt = el("span", "vlt", opt.marker.text); vt.style.left = "calc(" + left + "% + 4px)"; plot.append(vt);
  }
  box.append(plot, ax);
  if (!max) { var e = el("p", "empty", "まだありません"); box.prepend(e); }
}
// ラベルの後ろに棒を敷いた横棒リスト。items: [[label, value, cls]]
function list(box, items, total) {
  box.textContent = "";
  var max = Math.max.apply(null, items.map(function (x) { return x[1]; }).concat([0]));
  items.forEach(function (x) {
    var li = el("div", "li" + (x[2] ? " " + x[2] : "")); li.setAttribute("data-tip", x[0] + "：" + fmt(x[1]) + (total ? "（" + pct(x[1], total) + "）" : ""));
    var i = el("i"); i.style.width = (max ? x[1] / max * 100 : 0) + "%";
    li.append(i, el("span", "", x[0]), el("b", "", fmt(x[1]))); box.append(li);
  });
  if (!items.length) box.append(el("p", "empty", "まだありません"));
}
function median(hist) { // hist: [[value, count]] を value 順に
  var tot = hist.reduce(function (a, h) { return a + h[1]; }, 0), acc = 0;
  for (var i = 0; i < hist.length; i++) { acc += hist[i][1]; if (acc * 2 >= tot) return { i: i, v: hist[i][0] }; }
  return null;
}

// 日別：1週間（月〜日）ずつ。データのない日は0で埋める
var DAILY = [], week = null;
var dayStr = function (t) { return new Date(t).toISOString().slice(0, 10); };
function renderDaily(daily) {
  DAILY = daily;
  var by = {}; daily.forEach(function (d) { by[d.day] = d; });
  var start = window.EVENT_START || "", last = daily.length ? daily[daily.length - 1].day : dayStr(Date.now() + 9 * 3600e3);
  if (start && start > last) last = start;
  var lt = Date.parse(last + "T00:00:00Z"), dow = (new Date(lt).getUTCDay() + 6) % 7; // 月曜=0
  if (week === null) { // はじめは今日の週を出す（開催日の週は › で見られる）
    var tt = Date.parse(dayStr(Date.now() + 9 * 3600e3) + "T00:00:00Z"), tdow = (new Date(tt).getUTCDay() + 6) % 7;
    week = Math.max(0, Math.round(((lt - dow * 864e5) - (tt - tdow * 864e5)) / (7 * 864e5)));
  }
  var mon = lt - (dow + 7 * week) * 864e5, items = [];
  for (var i = 0; i < 7; i++) {
    var day = dayStr(mon + i * 864e5), d = by[day] || { pv: 0, nv: 0 }, md = day.slice(5).replace("-", "/");
    var end = window.EVENT_END || (start ? dayStr(Date.parse(start + "T00:00:00Z") + 864e5) : ""); // 終わりの日がなければ2日間とみなす
    var ev = start && day >= start && day <= end;
    items.push({ v: d.pv, label: md, tip: md + "・はじめての端末 " + fmt(d.nv || 0) + "・ページを開いた回数", cls: ev ? "ev" : "" });
  }
  columns($("#daily"), items, { values: true });
  $("#wlabel").textContent = items[0].label + "〜" + items[6].label;
  var first = daily.length ? Date.parse(daily[0].day + "T00:00:00Z") : mon;
  $("#wprev").disabled = first >= mon; $("#wnext").disabled = week === 0;
}
// 時間帯：全期間か、選んだ日だけ
var HOURS = [];
function renderHours(hours) {
  HOURS = hours;
  var sel = $("#hday"), cur = sel.value || "all";
  var days = Array.from(new Set(hours.map(function (r) { return r.day; }))).sort();
  sel.textContent = "";
  var o = el("option", "", "全期間"); o.value = "all"; sel.append(o);
  days.slice().reverse().forEach(function (d) { var op = el("option", "", d.slice(5).replace("-", "/")); op.value = d; sel.append(op); });
  sel.value = days.indexOf(cur) >= 0 ? cur : "all";
  drawHours();
}
function drawHours() {
  var day = $("#hday").value, v = [];
  for (var h = 0; h < 24; h++) v[h] = 0;
  HOURS.forEach(function (r) { if ((day === "all" || r.day === day) && r.h >= 0 && r.h < 24) v[r.h] += r.n; });
  if (!HOURS.length) for (var k = 0; k < 24; k++) v[k] = n("h:" + k);
  columns($("#hours"), v.map(function (x, h) { return { v: x, label: String(h), tip: h + "時台" }; }), { dense: true });
}
// ドーナツ。items: [{v, color, tip}]
function donut(svg, items, center, unit) {
  svg.textContent = "";
  var NS = "http://www.w3.org/2000/svg", tot = items.reduce(function (a, i) { return a + i.v; }, 0), R = 56, r = 34, a0 = -Math.PI / 2;
  var mk = function (tag, attrs) { var e = document.createElementNS(NS, tag); for (var k in attrs) e.setAttribute(k, attrs[k]); return e; };
  if (!tot) svg.append(mk("circle", { cx: 60, cy: 60, r: (R + r) / 2, fill: "none", stroke: "var(--line)", "stroke-width": R - r }));
  items.forEach(function (it) {
    if (!it.v) return;
    var a1 = a0 + it.v / tot * Math.PI * 2, big = a1 - a0 > Math.PI ? 1 : 0;
    if (it.v === tot) a1 -= 0.0001;
    var p = function (rad, a) { return (60 + rad * Math.cos(a)).toFixed(2) + " " + (60 + rad * Math.sin(a)).toFixed(2); };
    var path = mk("path", { d: "M" + p(R, a0) + " A" + R + " " + R + " 0 " + big + " 1 " + p(R, a1) + " L" + p(r, a1) + " A" + r + " " + r + " 0 " + big + " 0 " + p(r, a0) + "Z", fill: it.color, "data-tip": it.tip });
    svg.append(path); a0 = a1;
  });
  var t1 = mk("text", { x: 60, y: 62, "text-anchor": "middle", class: "c1" }); t1.textContent = center;
  var t2 = mk("text", { x: 60, y: 76, "text-anchor": "middle", class: "c2" }); t2.textContent = unit;
  svg.append(t1, t2);
}

function rowsFor() {
  return EX.map(function (e) {
    var id = e.id;
    return { e: e, d: n("d:" + id), p: n("p:" + id), fav: n("f+:" + id) - n("f-:" + id), s: n("s:" + id),
      pages: [1, 2, 3, 4, 5].map(function (i) { return n("pg:" + id + ":" + i); }),
      when: ["pre", "am", "mid", "pm"].map(function (w) { return n("dh:" + id + ":" + w); }) };
  });
}
var COLS = [["space", "スペース", 1], ["name", "サークル名", 1], ["d", "詳細"], ["p", "写真"], ["fav", "お気に入り"], ["s", "共有"]];
function renderTable() {
  var data = rowsFor(), maxD = Math.max.apply(null, data.map(function (r) { return r.d; }).concat([1]));
  var key = function (r) { return sortKey === "space" ? r.e.space : sortKey === "name" ? r.e.name : r[sortKey]; };
  data.sort(function (a, b) {
    var x = key(a), y = key(b);
    var c = typeof x === "string" ? x.localeCompare(y, "ja", { numeric: true }) : x - y;
    return sortAsc ? c : -c;
  });
  var t = $("#tbl"); t.textContent = "";
  var hr = el("tr");
  COLS.forEach(function (c) {
    var th = el("th", c[2] ? "l" : "", c[1]); th.scope = "col"; th.tabIndex = 0;
    if (c[0] === sortKey) th.setAttribute("aria-sort", sortAsc ? "ascending" : "descending");
    var go = function () { if (sortKey === c[0]) sortAsc = !sortAsc; else { sortKey = c[0]; sortAsc = !!c[2]; } renderTable(); };
    th.onclick = go; th.onkeydown = function (ev) { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); go(); } };
    hr.append(th);
  });
  var thead = el("thead"); thead.append(hr); t.append(thead);
  var tb = el("tbody");
  data.forEach(function (r) {
    var tr = el("tr");
    tr.append(el("td", "l", r.e.space));
    var nm = el("td", "l name", r.e.name); nm.title = r.e.name; tr.append(nm);
    var d = el("td", "", fmt(r.d)); var cb = el("span", "cb"); var ci = el("i"); ci.style.width = (r.d / maxD * 100) + "%"; cb.append(ci); d.append(cb); tr.append(d);
    tr.append(el("td", "", fmt(r.p)), el("td", "", fmt(r.fav)), el("td", "", fmt(r.s)));
    tb.append(tr);
  });
  if (!data.length) { var tr0 = el("tr"); var td0 = el("td", "l", "出展者の一覧を読めませんでした"); td0.colSpan = 6; tr0.append(td0); tb.append(tr0); }
  t.append(tb);
}
function downloadCsv() {
  var data = rowsFor().sort(function (a, b) { return a.e.space.localeCompare(b.e.space, "ja", { numeric: true }); });
  var ds = data.map(function (r) { return r.d; }).sort(function (a, b) { return a - b; });
  var mid = ds.length ? ds[Math.floor(ds.length / 2)] : 0;
  var q = function (v) { v = String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  var out = [["スペース", "サークル名", "詳細", "写真", "写真1枚目", "2枚目", "3枚目", "4枚目", "5枚目", "お気に入り", "共有", "開催前", "当日午前", "当日昼", "当日午後", "中央値との比"]];
  data.forEach(function (r) { out.push([r.e.space, r.e.name, r.d, r.p].concat(r.pages, [r.fav, r.s], r.when, [mid ? (r.d / mid).toFixed(2) : ""])); });
  var blob = new Blob(["\uFEFF" + out.map(function (r) { return r.map(q).join(","); }).join("\n") + "\n"], { type: "text/csv" });
  var a = el("a"); a.href = URL.createObjectURL(blob); a.download = "butsuhan-report.csv"; a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
}

function render(x) {
  C = x.counts || {};
  var jst = function (s) { return s ? new Date(new Date(s).getTime() + 9 * 3600e3).toISOString().slice(5, 16).replace("T", " ") : "—"; };
  $("#span").textContent = jst(x.first) + " 〜 " + jst(x.last) + "（日本時間）・送信 " + fmt(x.batches) + " 回・順位は外に出さないでください";

  var lds = []; for (var s = 0; s <= 30; s++) lds.push([s, n("ld:" + s)]);
  var med = median(lds);
  var kp = [["訪問した端末の数", fmt(n("nv"))], ["ページを開いた回数", fmt(n("pv"))], ["詳細を開いた回数", fmt(sum(/^d:/))], ["写真を開いた回数", fmt(sum(/^p:/))],
    ["お気に入り（追加−解除）", fmt(sum(/^f\+:/) - sum(/^f-:/))], ["共有", fmt(sum(/^s:/))], ["表示までの時間（中央値）", med ? med.v : "—", "秒"]];
  var kb = $("#kpis"); kb.textContent = "";
  kp.forEach(function (k) { var d = el("div", "kpi"); var b = el("b", "", k[1]); if (k[2] && med) b.append(el("small", "", k[2])); d.append(el("span", "", k[0]), b); kb.append(d); });

  renderDaily(x.daily || []);
  renderHours(x.hours || []);
  columns($("#ld"), lds.map(function (l) { return { v: l[1], label: l[0] % 5 ? "" : String(l[0]), tip: l[0] === 30 ? "30秒以上" : l[0] + "秒" }; }),
    { dense: true, marker: med ? { at: med.i, text: "中央値 " + med.v + "秒" } : null });

  var fr = [["地図", n("from:map"), "--s1"], ["一覧", n("from:list"), "--s2"], ["共有リンク", n("from:link"), "--s3"]];
  var ft = fr.reduce(function (a, f) { return a + f[1]; }, 0);
  var lg = $("#leg"); lg.textContent = "";
  donut($("#pie"), fr.map(function (f) { return { v: f[1], color: "var(" + f[2] + ")", tip: f[0] + "：" + fmt(f[1]) + "（" + pct(f[1], ft) + "）" }; }), fmt(ft), "回");
  fr.forEach(function (f) {
    var sw = el("span", "sw"); sw.style.background = "var(" + f[2] + ")";
    lg.append(sw, el("span", "", f[0]), el("span", "n", fmt(f[1])), el("span", "p", pct(f[1], ft)));
  });

  var feats = [["タグで絞り込み", sum(/^t:/)], ["検索", n("q")], ["お気に入りだけ表示", n("scope:fav")], ["番号順に並べ替え", n("sort:space")],
    ["シャッフルに戻す", n("sort:shuffle")], ["平面図に切替", n("proj:flat")], ["立体図に切替", n("proj:iso")], ["？を開いた", n("help")]]
    .sort(function (a, b) { return b[1] - a[1]; });
  feats.push(["画像の読み込み失敗", n("imgerr"), "warn sep"]);
  list($("#feat"), feats);

  var tg = Object.keys(C).filter(function (k) { return k.indexOf("t:") === 0; }).map(function (k) { return [k.slice(2), C[k]]; })
    .sort(function (a, b) { return b[1] - a[1]; });
  var tt = tg.reduce(function (a, t) { return a + t[1]; }, 0);
  if (tg.length > 12) { var rest = tg.slice(11).reduce(function (a, t) { return a + t[1]; }, 0); tg = tg.slice(0, 11).concat([["その他 " + (tg.length - 11) + " 件", rest]]); }
  list($("#tags"), tg, tt);
  $("#zero").textContent = "0件になった回数 " + fmt(n("zero"));
  renderTable();
}

// ---------- QRコード ----------
var QR = [], qsel = null;
var qrUrl = function (code) { return SITE_URL + "?qr=" + code; };
function qrMatrix(code) { var q = qrcode(0, "M"); q.addData(qrUrl(code)); q.make(); return q; }
// 白地に黒のマス。周りに4マスの余白（読み取りに必要）
function qrSvg(code) {
  var q = qrMatrix(code), n = q.getModuleCount(), m = 4, d = "";
  for (var y = 0; y < n; y++) for (var x = 0; x < n; x++) if (q.isDark(y, x)) d += "M" + (x + m) + " " + (y + m) + "h1v1h-1z";
  var w = n + m * 2;
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + " " + w + '" shape-rendering="crispEdges"><rect width="' + w + '" height="' + w + '" fill="#fff"/><path d="' + d + '" fill="#000"/></svg>';
}
function qrPng(code, size) {
  var q = qrMatrix(code), n = q.getModuleCount(), m = 4, w = n + m * 2, s = Math.max(1, Math.floor(size / w));
  var cv = document.createElement("canvas"); cv.width = cv.height = w * s;
  var g = cv.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, cv.width, cv.height); g.fillStyle = "#000";
  for (var y = 0; y < n; y++) for (var x = 0; x < n; x++) if (q.isDark(y, x)) g.fillRect((x + m) * s, (y + m) * s, s, s);
  return cv;
}
function save(blob, name) {
  var a = el("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
}
// ファイル名はコードだけにする（日本語の名前だとブラウザによって「download」になる）
var fileName = function (r) { return "qr_" + r.code; };
// 登録したQRコードと、数字にだけ出てくる（未登録の）コードをまとめる
function qrRows() {
  var by = {};
  QR.forEach(function (q) { by[q.code] = { code: q.code, label: q.label, memo: q.memo, created: q.created, reg: true }; });
  Object.keys(C).forEach(function (k) { var m = /^(qr|qn):(.+)$/.exec(k); if (m && !by[m[2]]) by[m[2]] = { code: m[2], label: "未登録", memo: "", created: "", reg: false }; });
  return Object.keys(by).map(function (c) { var r = by[c]; r.o = n("qr:" + c); r.nv = n("qn:" + c); return r; });
}
function renderQr() {
  var rows = qrRows().sort(function (a, b) { return b.o - a.o || (a.created < b.created ? -1 : 1); });
  var max = Math.max.apply(null, rows.map(function (r) { return r.o; }).concat([1]));
  var t = $("#qtbl"); t.textContent = "";
  var hr = el("tr"); [["名前", 1], ["コード", 1], ["開いた回数"], ["はじめての端末"], ["作った日"]].forEach(function (c) { var th = el("th", c[1] ? "l" : "", c[0]); th.style.cursor = "default"; hr.append(th); });
  var th0 = el("thead"); th0.append(hr); t.append(th0);
  var tb = el("tbody");
  rows.forEach(function (r) {
    var tr = el("tr", r.code === qsel ? "sel" : ""); tr.tabIndex = 0;
    var nm = el("td", "l name" + (r.reg ? "" : " dim"), r.label); nm.title = r.memo || r.label; tr.append(nm);
    tr.append(el("td", "l", r.code));
    var o = el("td", "", fmt(r.o)); var cb = el("span", "cb"); var ci = el("i"); ci.style.width = (r.o / max * 100) + "%"; cb.append(ci); o.append(cb); tr.append(o);
    tr.append(el("td", "", fmt(r.nv)), el("td", "", r.created ? new Date(Date.parse(r.created) + 9 * 3600e3).toISOString().slice(5, 10).replace("-", "/") : "—"));
    var go = function () { qsel = r.code; renderQr(); if (matchMedia("(max-width:1099px)").matches) $("#qsel-h").scrollIntoView({ behavior: "smooth" }); };
    tr.onclick = go; tr.onkeydown = function (ev) { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); go(); } };
    tb.append(tr);
  });
  if (!rows.length) { var tr0 = el("tr"); var td0 = el("td", "l", "まだありません。右の「新しく作る」から作れます"); td0.colSpan = 5; tr0.append(td0); tb.append(tr0); }
  t.append(tb);
  var r = rows.filter(function (x) { return x.code === qsel; })[0];
  $("#qsel").hidden = $("#qsel-h").hidden = !r;
  if (!r) return;
  $("#qimg").innerHTML = qrSvg(r.code);
  $("#qname").textContent = r.label;
  $("#qnote").textContent = (r.memo ? r.memo + "・" : "") + "開いた回数 " + fmt(r.o) + "・はじめての端末 " + fmt(r.nv);
  $("#qurl").textContent = qrUrl(r.code);
  $("#qedit").textContent = r.reg ? "名前・メモを変える" : "名前を付ける";
  $("#qdel").hidden = !r.reg;
}
async function qrApi(body) {
  var r = await fetch("qr?token=" + encodeURIComponent(store.get()), body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : { cache: "no-store" });
  if (!r.ok) throw new Error("QRコードの一覧を" + (body ? "保存" : "読め") + "ませんでした（" + r.status + "）");
  QR = (await r.json()).codes || [];
}
function qrError(e) { var q = $("#qerr"); q.textContent = e.message; q.hidden = false; }
var selRow = function () { return qrRows().filter(function (x) { return x.code === qsel; })[0]; };
$("#qf").onsubmit = async function (ev) {
  ev.preventDefault(); $("#qerr").hidden = true;
  var label = $("#qlabel").value.trim(), code = $("#qcode").value.trim().toLowerCase();
  if (!code) { var a = "abcdefghijkmnpqrstuvwxyz23456789"; do { code = ""; for (var i = 0; i < 5; i++) code += a[Math.floor(Math.random() * a.length)]; } while (qrRows().some(function (x) { return x.code === code; })); }
  if (!/^[a-z0-9-]{1,24}$/.test(code)) return qrError(new Error("コードは英小文字・数字・- の24文字までです"));
  if (QR.some(function (x) { return x.code === code; })) return qrError(new Error("そのコードはもう使われています"));
  try { await qrApi({ action: "save", code: code, label: label, memo: $("#qmemo").value }); } catch (e) { return qrError(e); }
  $("#qlabel").value = $("#qcode").value = $("#qmemo").value = ""; qsel = code; renderQr();
};
$("#qsvg").onclick = function () { var r = selRow(); if (r) save(new Blob([qrSvg(r.code)], { type: "image/svg+xml" }), fileName(r) + ".svg"); };
$("#qpng").onclick = function () { var r = selRow(); if (r) qrPng(r.code, 1200).toBlob(function (b) { save(b, fileName(r) + ".png"); }); };
$("#qcopy").onclick = function () {
  var r = selRow(), b = $("#qcopy"); if (!r) return;
  var done = function () { b.textContent = "コピーしました"; setTimeout(function () { b.textContent = "URLをコピー"; }, 1600); };
  try { navigator.clipboard.writeText(qrUrl(r.code)).then(done, function () {}); } catch (e) {}
};
$("#qedit").onclick = async function () {
  var r = selRow(); if (!r) return;
  var label = prompt("名前", r.reg ? r.label : ""); if (label == null || !label.trim()) return;
  var memo = prompt("メモ（任意）", r.memo || ""); if (memo == null) memo = r.memo || "";
  try { await qrApi({ action: "save", code: r.code, label: label, memo: memo }); renderQr(); } catch (e) { alert(e.message); }
};
$("#qdel").onclick = async function () {
  var r = selRow(); if (!r || !confirm("「" + r.label + "」を一覧から消しますか？\n数えた回数は「未登録」として残ります。印刷済みのQRコードも読めば数えられます。")) return;
  try { await qrApi({ action: "delete", code: r.code }); renderQr(); } catch (e) { alert(e.message); }
};
document.querySelectorAll("[data-view]").forEach(function (b) {
  b.onclick = function () {
    document.querySelectorAll("[data-view]").forEach(function (x) { var on = x === b; x.setAttribute("aria-pressed", on); $("#" + x.getAttribute("data-view")).hidden = !on; });
  };
});
var view = function () { var b = document.querySelector('[data-view][aria-pressed="true"]'); return b ? b.getAttribute("data-view") : "out"; };

async function load() {
  var tok = store.get(); if (!tok) return;
  var err = $("#err"); err.hidden = true;
  try {
    var r = await fetch("export?token=" + encodeURIComponent(tok), { cache: "no-store" });
    if (r.status === 403) { store.set(""); throw new Error("合言葉が違います。もう一度入れてください"); }
    if (!r.ok) throw new Error("集計を読めませんでした（" + r.status + "）。少し待って「表示」を押し直してください");
    var x = await r.json();
    try { var d = await (await fetch(SITE_DATA, { cache: "no-store" })).json(); EX = d.exhibitors || []; window.EVENT_START = (d.event && d.event.start) || ""; window.EVENT_END = (d.event && d.event.end) || ""; }
    catch (e) { EX = []; }
    try { await qrApi(); } catch (e) { QR = []; }
    $("#login").hidden = true; $("#acts").hidden = false; $("#out").hidden = view() !== "out"; $("#qrv").hidden = view() !== "qrv";
    render(x); renderQr();
  } catch (e) { err.textContent = e.message; err.hidden = false; $("#login").hidden = false; $("#out").hidden = $("#qrv").hidden = true; $("#acts").hidden = true; }
}
$("#f").onsubmit = function (ev) { ev.preventDefault(); store.set($("#tok").value.trim()); $("#tok").value = ""; load(); };
$("#reload").onclick = load;
$("#logout").onclick = function () { store.set(""); $("#out").hidden = $("#qrv").hidden = true; $("#acts").hidden = true; $("#login").hidden = false; };
$("#csv").onclick = downloadCsv;
$("#wprev").onclick = function () { week++; renderDaily(DAILY); };
$("#wnext").onclick = function () { if (week) { week--; renderDaily(DAILY); } };
$("#hday").onchange = drawHours;
load();
</script></body></html>`;

// QRコードを作るライブラリ（QR Code Generator for JavaScript 1.4.4、Copyright (c) 2009 Kazuhiko Arase、MIT License、https://github.com/kazuhikoarase/qrcode-generator）を縮めたもの。
// 「QR Code」は株式会社デンソーウェーブの登録商標です。
const QRCODE_LIB = String.raw`var qrcode=function(){var t=function(t,r){var e=t,n=g[r],o=null,i=0,a=null,u=[],f={},c=function(t,r){o=function(t){for(var r=new Array(t),e=0;e<t;e+=1){r[e]=new Array(t);for(var n=0;n<t;n+=1)r[e][n]=null}return r}(i=4*e+17),l(0,0),l(i-7,0),l(0,i-7),s(),h(),d(t,r),e>=7&&v(t),null==a&&(a=p(e,n,u)),w(a,r)},l=function(t,r){for(var e=-1;e<=7;e+=1)if(!(t+e<=-1||i<=t+e))for(var n=-1;n<=7;n+=1)r+n<=-1||i<=r+n||(o[t+e][r+n]=0<=e&&e<=6&&(0==n||6==n)||0<=n&&n<=6&&(0==e||6==e)||2<=e&&e<=4&&2<=n&&n<=4)},h=function(){for(var t=8;t<i-8;t+=1)null==o[t][6]&&(o[t][6]=t%2==0);for(var r=8;r<i-8;r+=1)null==o[6][r]&&(o[6][r]=r%2==0)},s=function(){for(var t=B.getPatternPosition(e),r=0;r<t.length;r+=1)for(var n=0;n<t.length;n+=1){var i=t[r],a=t[n];if(null==o[i][a])for(var u=-2;u<=2;u+=1)for(var f=-2;f<=2;f+=1)o[i+u][a+f]=-2==u||2==u||-2==f||2==f||0==u&&0==f}},v=function(t){for(var r=B.getBCHTypeNumber(e),n=0;n<18;n+=1){var a=!t&&1==(r>>n&1);o[Math.floor(n/3)][n%3+i-8-3]=a}for(n=0;n<18;n+=1){a=!t&&1==(r>>n&1);o[n%3+i-8-3][Math.floor(n/3)]=a}},d=function(t,r){for(var e=n<<3|r,a=B.getBCHTypeInfo(e),u=0;u<15;u+=1){var f=!t&&1==(a>>u&1);u<6?o[u][8]=f:u<8?o[u+1][8]=f:o[i-15+u][8]=f}for(u=0;u<15;u+=1){f=!t&&1==(a>>u&1);u<8?o[8][i-u-1]=f:u<9?o[8][15-u-1+1]=f:o[8][15-u-1]=f}o[i-8][8]=!t},w=function(t,r){for(var e=-1,n=i-1,a=7,u=0,f=B.getMaskFunction(r),c=i-1;c>0;c-=2)for(6==c&&(c-=1);;){for(var g=0;g<2;g+=1)if(null==o[n][c-g]){var l=!1;u<t.length&&(l=1==(t[u]>>>a&1)),f(n,c-g)&&(l=!l),o[n][c-g]=l,-1==(a-=1)&&(u+=1,a=7)}if((n+=e)<0||i<=n){n-=e,e=-e;break}}},p=function(t,r,e){for(var n=A.getRSBlocks(t,r),o=b(),i=0;i<e.length;i+=1){var a=e[i];o.put(a.getMode(),4),o.put(a.getLength(),B.getLengthInBits(a.getMode(),t)),a.write(o)}var u=0;for(i=0;i<n.length;i+=1)u+=n[i].dataCount;if(o.getLengthInBits()>8*u)throw"code length overflow. ("+o.getLengthInBits()+">"+8*u+")";for(o.getLengthInBits()+4<=8*u&&o.put(0,4);o.getLengthInBits()%8!=0;)o.putBit(!1);for(;!(o.getLengthInBits()>=8*u||(o.put(236,8),o.getLengthInBits()>=8*u));)o.put(17,8);return function(t,r){for(var e=0,n=0,o=0,i=new Array(r.length),a=new Array(r.length),u=0;u<r.length;u+=1){var f=r[u].dataCount,c=r[u].totalCount-f;n=Math.max(n,f),o=Math.max(o,c),i[u]=new Array(f);for(var g=0;g<i[u].length;g+=1)i[u][g]=255&t.getBuffer()[g+e];e+=f;var l=B.getErrorCorrectPolynomial(c),h=k(i[u],l.getLength()-1).mod(l);for(a[u]=new Array(l.getLength()-1),g=0;g<a[u].length;g+=1){var s=g+h.getLength()-a[u].length;a[u][g]=s>=0?h.getAt(s):0}}var v=0;for(g=0;g<r.length;g+=1)v+=r[g].totalCount;var d=new Array(v),w=0;for(g=0;g<n;g+=1)for(u=0;u<r.length;u+=1)g<i[u].length&&(d[w]=i[u][g],w+=1);for(g=0;g<o;g+=1)for(u=0;u<r.length;u+=1)g<a[u].length&&(d[w]=a[u][g],w+=1);return d}(o,n)};f.addData=function(t,r){var e=null;switch(r=r||"Byte"){case"Numeric":e=M(t);break;case"Alphanumeric":e=x(t);break;case"Byte":e=m(t);break;case"Kanji":e=L(t);break;default:throw"mode:"+r}u.push(e),a=null},f.isDark=function(t,r){if(t<0||i<=t||r<0||i<=r)throw t+","+r;return o[t][r]},f.getModuleCount=function(){return i},f.make=function(){if(e<1){for(var t=1;t<40;t++){for(var r=A.getRSBlocks(t,n),o=b(),i=0;i<u.length;i++){var a=u[i];o.put(a.getMode(),4),o.put(a.getLength(),B.getLengthInBits(a.getMode(),t)),a.write(o)}var g=0;for(i=0;i<r.length;i++)g+=r[i].dataCount;if(o.getLengthInBits()<=8*g)break}e=t}c(!1,function(){for(var t=0,r=0,e=0;e<8;e+=1){c(!0,e);var n=B.getLostPoint(f);(0==e||t>n)&&(t=n,r=e)}return r}())},f.createTableTag=function(t,r){t=t||2;var e="";e+='<table style="',e+=" border-width: 0px; border-style: none;",e+=" border-collapse: collapse;",e+=" padding: 0px; margin: "+(r=void 0===r?4*t:r)+"px;",e+='">',e+="<tbody>";for(var n=0;n<f.getModuleCount();n+=1){e+="<tr>";for(var o=0;o<f.getModuleCount();o+=1)e+='<td style="',e+=" border-width: 0px; border-style: none;",e+=" border-collapse: collapse;",e+=" padding: 0px; margin: 0px;",e+=" width: "+t+"px;",e+=" height: "+t+"px;",e+=" background-color: ",e+=f.isDark(n,o)?"#000000":"#ffffff",e+=";",e+='"/>';e+="</tr>"}return e+="</tbody>",e+="</table>"},f.createSvgTag=function(t,r,e,n){var o={};"object"==typeof arguments[0]&&(t=(o=arguments[0]).cellSize,r=o.margin,e=o.alt,n=o.title),t=t||2,r=void 0===r?4*t:r,(e="string"==typeof e?{text:e}:e||{}).text=e.text||null,e.id=e.text?e.id||"qrcode-description":null,(n="string"==typeof n?{text:n}:n||{}).text=n.text||null,n.id=n.text?n.id||"qrcode-title":null;var i,a,u,c,g=f.getModuleCount()*t+2*r,l="";for(c="l"+t+",0 0,"+t+" -"+t+",0 0,-"+t+"z ",l+='<svg version="1.1" xmlns="http://www.w3.org/2000/svg"',l+=o.scalable?"":' width="'+g+'px" height="'+g+'px"',l+=' viewBox="0 0 '+g+" "+g+'" ',l+=' preserveAspectRatio="xMinYMin meet"',l+=n.text||e.text?' role="img" aria-labelledby="'+y([n.id,e.id].join(" ").trim())+'"':"",l+=">",l+=n.text?'<title id="'+y(n.id)+'">'+y(n.text)+"</title>":"",l+=e.text?'<description id="'+y(e.id)+'">'+y(e.text)+"</description>":"",l+='<rect width="100%" height="100%" fill="white" cx="0" cy="0"/>',l+='<path d="',a=0;a<f.getModuleCount();a+=1)for(u=a*t+r,i=0;i<f.getModuleCount();i+=1)f.isDark(a,i)&&(l+="M"+(i*t+r)+","+u+c);return l+='" stroke="transparent" fill="black"/>',l+="</svg>"},f.createDataURL=function(t,r){t=t||2,r=void 0===r?4*t:r;var e=f.getModuleCount()*t+2*r,n=r,o=e-r;return I(e,e,(function(r,e){if(n<=r&&r<o&&n<=e&&e<o){var i=Math.floor((r-n)/t),a=Math.floor((e-n)/t);return f.isDark(a,i)?0:1}return 1}))},f.createImgTag=function(t,r,e){t=t||2,r=void 0===r?4*t:r;var n=f.getModuleCount()*t+2*r,o="";return o+="<img",o+=' src="',o+=f.createDataURL(t,r),o+='"',o+=' width="',o+=n,o+='"',o+=' height="',o+=n,o+='"',e&&(o+=' alt="',o+=y(e),o+='"'),o+="/>"};var y=function(t){for(var r="",e=0;e<t.length;e+=1){var n=t.charAt(e);switch(n){case"<":r+="&lt;";break;case">":r+="&gt;";break;case"&":r+="&amp;";break;case'"':r+="&quot;";break;default:r+=n}}return r};return f.createASCII=function(t,r){if((t=t||1)<2)return function(t){t=void 0===t?2:t;var r,e,n,o,i,a=1*f.getModuleCount()+2*t,u=t,c=a-t,g={"██":"█","█ ":"▀"," █":"▄","  ":" "},l={"██":"▀","█ ":"▀"," █":" ","  ":" "},h="";for(r=0;r<a;r+=2){for(n=Math.floor((r-u)/1),o=Math.floor((r+1-u)/1),e=0;e<a;e+=1)i="█",u<=e&&e<c&&u<=r&&r<c&&f.isDark(n,Math.floor((e-u)/1))&&(i=" "),u<=e&&e<c&&u<=r+1&&r+1<c&&f.isDark(o,Math.floor((e-u)/1))?i+=" ":i+="█",h+=t<1&&r+1>=c?l[i]:g[i];h+="\n"}return a%2&&t>0?h.substring(0,h.length-a-1)+Array(a+1).join("▀"):h.substring(0,h.length-1)}(r);t-=1,r=void 0===r?2*t:r;var e,n,o,i,a=f.getModuleCount()*t+2*r,u=r,c=a-r,g=Array(t+1).join("██"),l=Array(t+1).join("  "),h="",s="";for(e=0;e<a;e+=1){for(o=Math.floor((e-u)/t),s="",n=0;n<a;n+=1)i=1,u<=n&&n<c&&u<=e&&e<c&&f.isDark(o,Math.floor((n-u)/t))&&(i=0),s+=i?g:l;for(o=0;o<t;o+=1)h+=s+"\n"}return h.substring(0,h.length-1)},f.renderTo2dContext=function(t,r){r=r||2;for(var e=f.getModuleCount(),n=0;n<e;n++)for(var o=0;o<e;o++)t.fillStyle=f.isDark(n,o)?"black":"white",t.fillRect(n*r,o*r,r,r)},f};t.stringToBytes=(t.stringToBytesFuncs={default:function(t){for(var r=[],e=0;e<t.length;e+=1){var n=t.charCodeAt(e);r.push(255&n)}return r}}).default,t.createStringToBytes=function(t,r){var e=function(){for(var e=S(t),n=function(){var t=e.read();if(-1==t)throw"eof";return t},o=0,i={};;){var a=e.read();if(-1==a)break;var u=n(),f=n()<<8|n();i[String.fromCharCode(a<<8|u)]=f,o+=1}if(o!=r)throw o+" != "+r;return i}(),n="?".charCodeAt(0);return function(t){for(var r=[],o=0;o<t.length;o+=1){var i=t.charCodeAt(o);if(i<128)r.push(i);else{var a=e[t.charAt(o)];"number"==typeof a?(255&a)==a?r.push(a):(r.push(a>>>8),r.push(255&a)):r.push(n)}}return r}};var r,e,n,o,i,a=1,u=2,f=4,c=8,g={L:1,M:0,Q:3,H:2},l=0,h=1,s=2,v=3,d=4,w=5,p=6,y=7,B=(r=[[],[6,18],[6,22],[6,26],[6,30],[6,34],[6,22,38],[6,24,42],[6,26,46],[6,28,50],[6,30,54],[6,32,58],[6,34,62],[6,26,46,66],[6,26,48,70],[6,26,50,74],[6,30,54,78],[6,30,56,82],[6,30,58,86],[6,34,62,90],[6,28,50,72,94],[6,26,50,74,98],[6,30,54,78,102],[6,28,54,80,106],[6,32,58,84,110],[6,30,58,86,114],[6,34,62,90,118],[6,26,50,74,98,122],[6,30,54,78,102,126],[6,26,52,78,104,130],[6,30,56,82,108,134],[6,34,60,86,112,138],[6,30,58,86,114,142],[6,34,62,90,118,146],[6,30,54,78,102,126,150],[6,24,50,76,102,128,154],[6,28,54,80,106,132,158],[6,32,58,84,110,136,162],[6,26,54,82,110,138,166],[6,30,58,86,114,142,170]],e=1335,n=7973,i=function(t){for(var r=0;0!=t;)r+=1,t>>>=1;return r},(o={}).getBCHTypeInfo=function(t){for(var r=t<<10;i(r)-i(e)>=0;)r^=e<<i(r)-i(e);return 21522^(t<<10|r)},o.getBCHTypeNumber=function(t){for(var r=t<<12;i(r)-i(n)>=0;)r^=n<<i(r)-i(n);return t<<12|r},o.getPatternPosition=function(t){return r[t-1]},o.getMaskFunction=function(t){switch(t){case l:return function(t,r){return(t+r)%2==0};case h:return function(t,r){return t%2==0};case s:return function(t,r){return r%3==0};case v:return function(t,r){return(t+r)%3==0};case d:return function(t,r){return(Math.floor(t/2)+Math.floor(r/3))%2==0};case w:return function(t,r){return t*r%2+t*r%3==0};case p:return function(t,r){return(t*r%2+t*r%3)%2==0};case y:return function(t,r){return(t*r%3+(t+r)%2)%2==0};default:throw"bad maskPattern:"+t}},o.getErrorCorrectPolynomial=function(t){for(var r=k([1],0),e=0;e<t;e+=1)r=r.multiply(k([1,C.gexp(e)],0));return r},o.getLengthInBits=function(t,r){if(1<=r&&r<10)switch(t){case a:return 10;case u:return 9;case f:case c:return 8;default:throw"mode:"+t}else if(r<27)switch(t){case a:return 12;case u:return 11;case f:return 16;case c:return 10;default:throw"mode:"+t}else{if(!(r<41))throw"type:"+r;switch(t){case a:return 14;case u:return 13;case f:return 16;case c:return 12;default:throw"mode:"+t}}},o.getLostPoint=function(t){for(var r=t.getModuleCount(),e=0,n=0;n<r;n+=1)for(var o=0;o<r;o+=1){for(var i=0,a=t.isDark(n,o),u=-1;u<=1;u+=1)if(!(n+u<0||r<=n+u))for(var f=-1;f<=1;f+=1)o+f<0||r<=o+f||0==u&&0==f||a==t.isDark(n+u,o+f)&&(i+=1);i>5&&(e+=3+i-5)}for(n=0;n<r-1;n+=1)for(o=0;o<r-1;o+=1){var c=0;t.isDark(n,o)&&(c+=1),t.isDark(n+1,o)&&(c+=1),t.isDark(n,o+1)&&(c+=1),t.isDark(n+1,o+1)&&(c+=1),0!=c&&4!=c||(e+=3)}for(n=0;n<r;n+=1)for(o=0;o<r-6;o+=1)t.isDark(n,o)&&!t.isDark(n,o+1)&&t.isDark(n,o+2)&&t.isDark(n,o+3)&&t.isDark(n,o+4)&&!t.isDark(n,o+5)&&t.isDark(n,o+6)&&(e+=40);for(o=0;o<r;o+=1)for(n=0;n<r-6;n+=1)t.isDark(n,o)&&!t.isDark(n+1,o)&&t.isDark(n+2,o)&&t.isDark(n+3,o)&&t.isDark(n+4,o)&&!t.isDark(n+5,o)&&t.isDark(n+6,o)&&(e+=40);var g=0;for(o=0;o<r;o+=1)for(n=0;n<r;n+=1)t.isDark(n,o)&&(g+=1);return e+=Math.abs(100*g/r/r-50)/5*10},o),C=function(){for(var t=new Array(256),r=new Array(256),e=0;e<8;e+=1)t[e]=1<<e;for(e=8;e<256;e+=1)t[e]=t[e-4]^t[e-5]^t[e-6]^t[e-8];for(e=0;e<255;e+=1)r[t[e]]=e;var n={glog:function(t){if(t<1)throw"glog("+t+")";return r[t]},gexp:function(r){for(;r<0;)r+=255;for(;r>=256;)r-=255;return t[r]}};return n}();function k(t,r){if(void 0===t.length)throw t.length+"/"+r;var e=function(){for(var e=0;e<t.length&&0==t[e];)e+=1;for(var n=new Array(t.length-e+r),o=0;o<t.length-e;o+=1)n[o]=t[o+e];return n}(),n={getAt:function(t){return e[t]},getLength:function(){return e.length},multiply:function(t){for(var r=new Array(n.getLength()+t.getLength()-1),e=0;e<n.getLength();e+=1)for(var o=0;o<t.getLength();o+=1)r[e+o]^=C.gexp(C.glog(n.getAt(e))+C.glog(t.getAt(o)));return k(r,0)},mod:function(t){if(n.getLength()-t.getLength()<0)return n;for(var r=C.glog(n.getAt(0))-C.glog(t.getAt(0)),e=new Array(n.getLength()),o=0;o<n.getLength();o+=1)e[o]=n.getAt(o);for(o=0;o<t.getLength();o+=1)e[o]^=C.gexp(C.glog(t.getAt(o))+r);return k(e,0).mod(t)}};return n}var A=function(){var t=[[1,26,19],[1,26,16],[1,26,13],[1,26,9],[1,44,34],[1,44,28],[1,44,22],[1,44,16],[1,70,55],[1,70,44],[2,35,17],[2,35,13],[1,100,80],[2,50,32],[2,50,24],[4,25,9],[1,134,108],[2,67,43],[2,33,15,2,34,16],[2,33,11,2,34,12],[2,86,68],[4,43,27],[4,43,19],[4,43,15],[2,98,78],[4,49,31],[2,32,14,4,33,15],[4,39,13,1,40,14],[2,121,97],[2,60,38,2,61,39],[4,40,18,2,41,19],[4,40,14,2,41,15],[2,146,116],[3,58,36,2,59,37],[4,36,16,4,37,17],[4,36,12,4,37,13],[2,86,68,2,87,69],[4,69,43,1,70,44],[6,43,19,2,44,20],[6,43,15,2,44,16],[4,101,81],[1,80,50,4,81,51],[4,50,22,4,51,23],[3,36,12,8,37,13],[2,116,92,2,117,93],[6,58,36,2,59,37],[4,46,20,6,47,21],[7,42,14,4,43,15],[4,133,107],[8,59,37,1,60,38],[8,44,20,4,45,21],[12,33,11,4,34,12],[3,145,115,1,146,116],[4,64,40,5,65,41],[11,36,16,5,37,17],[11,36,12,5,37,13],[5,109,87,1,110,88],[5,65,41,5,66,42],[5,54,24,7,55,25],[11,36,12,7,37,13],[5,122,98,1,123,99],[7,73,45,3,74,46],[15,43,19,2,44,20],[3,45,15,13,46,16],[1,135,107,5,136,108],[10,74,46,1,75,47],[1,50,22,15,51,23],[2,42,14,17,43,15],[5,150,120,1,151,121],[9,69,43,4,70,44],[17,50,22,1,51,23],[2,42,14,19,43,15],[3,141,113,4,142,114],[3,70,44,11,71,45],[17,47,21,4,48,22],[9,39,13,16,40,14],[3,135,107,5,136,108],[3,67,41,13,68,42],[15,54,24,5,55,25],[15,43,15,10,44,16],[4,144,116,4,145,117],[17,68,42],[17,50,22,6,51,23],[19,46,16,6,47,17],[2,139,111,7,140,112],[17,74,46],[7,54,24,16,55,25],[34,37,13],[4,151,121,5,152,122],[4,75,47,14,76,48],[11,54,24,14,55,25],[16,45,15,14,46,16],[6,147,117,4,148,118],[6,73,45,14,74,46],[11,54,24,16,55,25],[30,46,16,2,47,17],[8,132,106,4,133,107],[8,75,47,13,76,48],[7,54,24,22,55,25],[22,45,15,13,46,16],[10,142,114,2,143,115],[19,74,46,4,75,47],[28,50,22,6,51,23],[33,46,16,4,47,17],[8,152,122,4,153,123],[22,73,45,3,74,46],[8,53,23,26,54,24],[12,45,15,28,46,16],[3,147,117,10,148,118],[3,73,45,23,74,46],[4,54,24,31,55,25],[11,45,15,31,46,16],[7,146,116,7,147,117],[21,73,45,7,74,46],[1,53,23,37,54,24],[19,45,15,26,46,16],[5,145,115,10,146,116],[19,75,47,10,76,48],[15,54,24,25,55,25],[23,45,15,25,46,16],[13,145,115,3,146,116],[2,74,46,29,75,47],[42,54,24,1,55,25],[23,45,15,28,46,16],[17,145,115],[10,74,46,23,75,47],[10,54,24,35,55,25],[19,45,15,35,46,16],[17,145,115,1,146,116],[14,74,46,21,75,47],[29,54,24,19,55,25],[11,45,15,46,46,16],[13,145,115,6,146,116],[14,74,46,23,75,47],[44,54,24,7,55,25],[59,46,16,1,47,17],[12,151,121,7,152,122],[12,75,47,26,76,48],[39,54,24,14,55,25],[22,45,15,41,46,16],[6,151,121,14,152,122],[6,75,47,34,76,48],[46,54,24,10,55,25],[2,45,15,64,46,16],[17,152,122,4,153,123],[29,74,46,14,75,47],[49,54,24,10,55,25],[24,45,15,46,46,16],[4,152,122,18,153,123],[13,74,46,32,75,47],[48,54,24,14,55,25],[42,45,15,32,46,16],[20,147,117,4,148,118],[40,75,47,7,76,48],[43,54,24,22,55,25],[10,45,15,67,46,16],[19,148,118,6,149,119],[18,75,47,31,76,48],[34,54,24,34,55,25],[20,45,15,61,46,16]],r=function(t,r){var e={};return e.totalCount=t,e.dataCount=r,e},e={};return e.getRSBlocks=function(e,n){var o=function(r,e){switch(e){case g.L:return t[4*(r-1)+0];case g.M:return t[4*(r-1)+1];case g.Q:return t[4*(r-1)+2];case g.H:return t[4*(r-1)+3];default:return}}(e,n);if(void 0===o)throw"bad rs block @ typeNumber:"+e+"/errorCorrectionLevel:"+n;for(var i=o.length/3,a=[],u=0;u<i;u+=1)for(var f=o[3*u+0],c=o[3*u+1],l=o[3*u+2],h=0;h<f;h+=1)a.push(r(c,l));return a},e}(),b=function(){var t=[],r=0,e={getBuffer:function(){return t},getAt:function(r){var e=Math.floor(r/8);return 1==(t[e]>>>7-r%8&1)},put:function(t,r){for(var n=0;n<r;n+=1)e.putBit(1==(t>>>r-n-1&1))},getLengthInBits:function(){return r},putBit:function(e){var n=Math.floor(r/8);t.length<=n&&t.push(0),e&&(t[n]|=128>>>r%8),r+=1}};return e},M=function(t){var r=a,e=t,n={getMode:function(){return r},getLength:function(t){return e.length},write:function(t){for(var r=e,n=0;n+2<r.length;)t.put(o(r.substring(n,n+3)),10),n+=3;n<r.length&&(r.length-n==1?t.put(o(r.substring(n,n+1)),4):r.length-n==2&&t.put(o(r.substring(n,n+2)),7))}},o=function(t){for(var r=0,e=0;e<t.length;e+=1)r=10*r+i(t.charAt(e));return r},i=function(t){if("0"<=t&&t<="9")return t.charCodeAt(0)-"0".charCodeAt(0);throw"illegal char :"+t};return n},x=function(t){var r=u,e=t,n={getMode:function(){return r},getLength:function(t){return e.length},write:function(t){for(var r=e,n=0;n+1<r.length;)t.put(45*o(r.charAt(n))+o(r.charAt(n+1)),11),n+=2;n<r.length&&t.put(o(r.charAt(n)),6)}},o=function(t){if("0"<=t&&t<="9")return t.charCodeAt(0)-"0".charCodeAt(0);if("A"<=t&&t<="Z")return t.charCodeAt(0)-"A".charCodeAt(0)+10;switch(t){case" ":return 36;case"$":return 37;case"%":return 38;case"*":return 39;case"+":return 40;case"-":return 41;case".":return 42;case"/":return 43;case":":return 44;default:throw"illegal char :"+t}};return n},m=function(r){var e=f,n=t.stringToBytes(r),o={getMode:function(){return e},getLength:function(t){return n.length},write:function(t){for(var r=0;r<n.length;r+=1)t.put(n[r],8)}};return o},L=function(r){var e=c,n=t.stringToBytesFuncs.SJIS;if(!n)throw"sjis not supported.";!function(){var t=n("友");if(2!=t.length||38726!=(t[0]<<8|t[1]))throw"sjis not supported."}();var o=n(r),i={getMode:function(){return e},getLength:function(t){return~~(o.length/2)},write:function(t){for(var r=o,e=0;e+1<r.length;){var n=(255&r[e])<<8|255&r[e+1];if(33088<=n&&n<=40956)n-=33088;else{if(!(57408<=n&&n<=60351))throw"illegal char at "+(e+1)+"/"+n;n-=49472}n=192*(n>>>8&255)+(255&n),t.put(n,13),e+=2}if(e<r.length)throw"illegal char at "+(e+1)}};return i},D=function(){var t=[],r={writeByte:function(r){t.push(255&r)},writeShort:function(t){r.writeByte(t),r.writeByte(t>>>8)},writeBytes:function(t,e,n){e=e||0,n=n||t.length;for(var o=0;o<n;o+=1)r.writeByte(t[o+e])},writeString:function(t){for(var e=0;e<t.length;e+=1)r.writeByte(t.charCodeAt(e))},toByteArray:function(){return t},toString:function(){var r="";r+="[";for(var e=0;e<t.length;e+=1)e>0&&(r+=","),r+=t[e];return r+="]"}};return r},S=function(t){var r=t,e=0,n=0,o=0,i={read:function(){for(;o<8;){if(e>=r.length){if(0==o)return-1;throw"unexpected end of file./"+o}var t=r.charAt(e);if(e+=1,"="==t)return o=0,-1;t.match(/^\s$/)||(n=n<<6|a(t.charCodeAt(0)),o+=6)}var i=n>>>o-8&255;return o-=8,i}},a=function(t){if(65<=t&&t<=90)return t-65;if(97<=t&&t<=122)return t-97+26;if(48<=t&&t<=57)return t-48+52;if(43==t)return 62;if(47==t)return 63;throw"c:"+t};return i},I=function(t,r,e){for(var n=function(t,r){var e=t,n=r,o=new Array(t*r),i={setPixel:function(t,r,n){o[r*e+t]=n},write:function(t){t.writeString("GIF87a"),t.writeShort(e),t.writeShort(n),t.writeByte(128),t.writeByte(0),t.writeByte(0),t.writeByte(0),t.writeByte(0),t.writeByte(0),t.writeByte(255),t.writeByte(255),t.writeByte(255),t.writeString(","),t.writeShort(0),t.writeShort(0),t.writeShort(e),t.writeShort(n),t.writeByte(0);var r=a(2);t.writeByte(2);for(var o=0;r.length-o>255;)t.writeByte(255),t.writeBytes(r,o,255),o+=255;t.writeByte(r.length-o),t.writeBytes(r,o,r.length-o),t.writeByte(0),t.writeString(";")}},a=function(t){for(var r=1<<t,e=1+(1<<t),n=t+1,i=u(),a=0;a<r;a+=1)i.add(String.fromCharCode(a));i.add(String.fromCharCode(r)),i.add(String.fromCharCode(e));var f,c,g,l=D(),h=(f=l,c=0,g=0,{write:function(t,r){if(t>>>r!=0)throw"length over";for(;c+r>=8;)f.writeByte(255&(t<<c|g)),r-=8-c,t>>>=8-c,g=0,c=0;g|=t<<c,c+=r},flush:function(){c>0&&f.writeByte(g)}});h.write(r,n);var s=0,v=String.fromCharCode(o[s]);for(s+=1;s<o.length;){var d=String.fromCharCode(o[s]);s+=1,i.contains(v+d)?v+=d:(h.write(i.indexOf(v),n),i.size()<4095&&(i.size()==1<<n&&(n+=1),i.add(v+d)),v=d)}return h.write(i.indexOf(v),n),h.write(e,n),h.flush(),l.toByteArray()},u=function(){var t={},r=0,e={add:function(n){if(e.contains(n))throw"dup key:"+n;t[n]=r,r+=1},size:function(){return r},indexOf:function(r){return t[r]},contains:function(r){return void 0!==t[r]}};return e};return i}(t,r),o=0;o<r;o+=1)for(var i=0;i<t;i+=1)n.setPixel(i,o,e(i,o));var a=D();n.write(a);for(var u=function(){var t=0,r=0,e=0,n="",o={},i=function(t){n+=String.fromCharCode(a(63&t))},a=function(t){if(t<0);else{if(t<26)return 65+t;if(t<52)return t-26+97;if(t<62)return t-52+48;if(62==t)return 43;if(63==t)return 47}throw"n:"+t};return o.writeByte=function(n){for(t=t<<8|255&n,r+=8,e+=1;r>=6;)i(t>>>r-6),r-=6},o.flush=function(){if(r>0&&(i(t<<6-r),t=0,r=0),e%3!=0)for(var o=3-e%3,a=0;a<o;a+=1)n+="="},o.toString=function(){return n},o}(),f=a.toByteArray(),c=0;c<f.length;c+=1)u.writeByte(f[c]);return u.flush(),"data:image/gif;base64,"+u};return t}();qrcode.stringToBytesFuncs["UTF-8"]=function(t){return function(t){for(var r=[],e=0;e<t.length;e++){var n=t.charCodeAt(e);n<128?r.push(n):n<2048?r.push(192|n>>6,128|63&n):n<55296||n>=57344?r.push(224|n>>12,128|n>>6&63,128|63&n):(e++,n=65536+((1023&n)<<10|1023&t.charCodeAt(e)),r.push(240|n>>18,128|n>>12&63,128|n>>6&63,128|63&n))}return r}(t)},function(t){"function"==typeof define&&define.amd?define([],t):"object"==typeof exports&&(module.exports=t())}((function(){return qrcode}));`;
