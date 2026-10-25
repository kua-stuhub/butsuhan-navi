// 物販ナビ アクセス解析の受け取り口（Cloudflare Workers）
//
// POST /       … サイトから、まとめた回数を受け取って D1 に1行保存する
// GET  /export … 集計結果を JSON で返す。?token= に EXPORT_TOKEN と同じ値が要る
// GET  /dashboard … 運営用の集計ページ。開いたあと合言葉（EXPORT_TOKEN）を入れると数字が出る
//
// 必要な設定（Cloudflare の画面で行う。README「アクセス解析」参照）
//   D1 のバインディング  DB          … schema.sql のテーブルを作ったデータベース
//   変数                 SITE_ORIGIN … https://kua-stuhub.github.io（ここ以外からの送信は受け取らない）
//   シークレット         EXPORT_TOKEN … 集計を取り出すときの合言葉
//   変数（任意）         SITE_DATA   … 公開サイトの data.json のURL。省略時は SITE_ORIGIN/butsuhan-navi/data.json
//
// IP アドレスなど、送信元を見分ける情報は保存しない。

const MAX_BYTES = 16384, MAX_KEYS = 200, MAX_COUNT = 500;
// 受け取るキーの形。これ以外は捨てる
//   pv … ページを開いた / nv … その端末ではじめて数えた（端末の数の目安） / d:<id> 詳細 / p:<id> 写真ビューア / pg:<id>:<n> 写真のn枚目
//   f+:<id> f-:<id> お気に入りの追加・解除 / s:<id> 共有 / from:map|list|link 詳細をどこから開いたか
//   t:<タグ> 絞り込み / q 検索 / zero 絞り込みで0件 / scope:fav / sort:shuffle|space / proj:iso|flat
//   dh:<id>:pre|am|mid|pm 詳細を開いた時間帯（開催前／当日の午前・昼・午後）
//   help / imgerr / ld:<秒の目安> 最初の表示までの時間 / h:<0-23> 見られた時間帯（日本時間）
const KEY = /^(pv|nv|q|zero|help|imgerr|scope:fav|sort:(shuffle|space)|proj:(iso|flat)|from:(map|list|link)|ld:\d{1,2}|h:\d{1,2}|(d|p|f\+|f-|s):[A-Za-z0-9_-]{1,40}|pg:[A-Za-z0-9_-]{1,40}:\d|dh:[A-Za-z0-9_-]{1,40}:(pre|am|mid|pm)|t:[^\s]{1,40})$/u;

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
      // 日本時間の日付ごとの送信数・ページを開いた回数・はじめての端末の数
      const { results: daily } = await env.DB.prepare(
        "SELECT substr(datetime(at, '+9 hours'), 1, 10) AS day, COUNT(*) AS batches, SUM(COALESCE(json_extract(data, '$.pv'), 0)) AS pv, SUM(COALESCE(json_extract(data, '$.nv'), 0)) AS nv FROM batches GROUP BY day ORDER BY day"
      ).all();
      // 日付ごとの時間帯（送信を受け取った日で分ける。日付をまたいだ送信は翌日に入ることがある）
      const { results: hours } = await env.DB.prepare(
        "SELECT substr(datetime(at, '+9 hours'), 1, 10) AS day, CAST(substr(j.key, 3) AS INTEGER) AS h, SUM(j.value) AS n FROM batches, json_each(batches.data) AS j WHERE j.key LIKE 'h:%' GROUP BY day, h"
      ).all();
      return Response.json({ ...meta[0], daily, hours, counts: Object.fromEntries(results.map((r) => [r.key, r.n])) });
    }

    if (req.method === "GET" && url.pathname === "/dashboard") {
      const data = env.SITE_DATA || `${env.SITE_ORIGIN || "https://kua-stuhub.github.io"}/butsuhan-navi/data.json`;
      return new Response(DASHBOARD.replace("__SITE_DATA__", JSON.stringify(data)), {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex", "Referrer-Policy": "no-referrer" },
      });
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
@media (max-width:1099px){
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
  <div class="acts" id="acts" hidden><button class="alt" id="reload">更新</button><button class="alt" id="logout">合言葉を消す</button></div>
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
</main>
<div id="tip" hidden></div>
<script>
var SITE_DATA = __SITE_DATA__;
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
var DAILY = [], week = 0;
var dayStr = function (t) { return new Date(t).toISOString().slice(0, 10); };
function renderDaily(daily) {
  DAILY = daily;
  var by = {}; daily.forEach(function (d) { by[d.day] = d; });
  var start = window.EVENT_START || "", last = daily.length ? daily[daily.length - 1].day : dayStr(Date.now() + 9 * 3600e3);
  if (start && start > last) last = start;
  var lt = Date.parse(last + "T00:00:00Z"), dow = (new Date(lt).getUTCDay() + 6) % 7; // 月曜=0
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
    $("#login").hidden = true; $("#out").hidden = false; $("#acts").hidden = false;
    render(x);
  } catch (e) { err.textContent = e.message; err.hidden = false; $("#login").hidden = false; $("#out").hidden = true; $("#acts").hidden = true; }
}
$("#f").onsubmit = function (ev) { ev.preventDefault(); store.set($("#tok").value.trim()); $("#tok").value = ""; load(); };
$("#reload").onclick = load;
$("#logout").onclick = function () { store.set(""); $("#out").hidden = true; $("#acts").hidden = true; $("#login").hidden = false; };
$("#csv").onclick = downloadCsv;
$("#wprev").onclick = function () { week++; renderDaily(DAILY); };
$("#wnext").onclick = function () { if (week) { week--; renderDaily(DAILY); } };
$("#hday").onchange = drawHours;
load();
</script></body></html>`;
