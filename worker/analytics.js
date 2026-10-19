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
      // 日本時間の日付ごとの送信数とページを開いた回数
      const { results: daily } = await env.DB.prepare(
        "SELECT substr(datetime(at, '+9 hours'), 1, 10) AS day, COUNT(*) AS batches, SUM(COALESCE(json_extract(data, '$.pv'), 0)) AS pv FROM batches GROUP BY day ORDER BY day"
      ).all();
      return Response.json({ ...meta[0], daily, counts: Object.fromEntries(results.map((r) => [r.key, r.n])) });
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
const DASHBOARD = String.raw`<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>物販ナビ 集計</title>
<style>
:root{color-scheme:light;--bg:#f4f3f0;--card:#fcfcfb;--fg:#0b0b0b;--muted:#52514e;--line:#e3e2dd;--bar:#2a78d6;--bar-soft:#d5e4f7}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#111110;--card:#1a1a19;--fg:#f0efec;--muted:#c3c2b7;--line:#33322f;--bar:#3987e5;--bar-soft:#1f3350}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif}
main{max-width:980px;margin:0 auto;padding:20px 16px 48px}
h1{font-size:20px;margin:0 0 4px}
h2{font-size:15px;margin:0 0 10px}
.sub{color:var(--muted);font-size:12px;margin:0 0 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:14px}
.login{display:flex;gap:8px;flex-wrap:wrap}
.login input{flex:1;min-width:180px;font:inherit;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg)}
button{font:inherit;padding:8px 14px;border-radius:8px;border:1px solid var(--line);background:var(--fg);color:var(--card);cursor:pointer}
button.alt{background:transparent;color:var(--fg)}
.err{color:#c93b3b;margin:8px 0 0}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:14px}
.tile{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px}
.tile b{display:block;font-size:24px;font-variant-numeric:tabular-nums;line-height:1.2}
.tile span{color:var(--muted);font-size:12px}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px}
.grid2 .card{margin-bottom:0}
.cols{display:flex;align-items:flex-end;gap:2px;height:150px;padding-top:18px}
.col{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%;min-width:0;position:relative}
.col i{display:block;width:100%;max-width:28px;background:var(--bar);border-radius:4px 4px 0 0}
.col.zero i{height:1px!important;background:var(--line)}
.col:hover i{filter:brightness(1.15)}
.col em{font-style:normal;font-size:10px;color:var(--muted);margin-top:4px;white-space:nowrap}
.col .v{position:absolute;top:-2px;font-size:10px;color:var(--muted);visibility:hidden}
.col:hover .v{visibility:visible;color:var(--fg)}
.rows{display:grid;grid-template-columns:auto 1fr auto;gap:6px 10px;align-items:center}
.rows .k{color:var(--muted);font-size:12px;white-space:nowrap;max-width:12em;overflow:hidden;text-overflow:ellipsis}
.rows .t{height:12px;background:transparent;border-radius:0 4px 4px 0}
.rows .t i{display:block;height:100%;background:var(--bar);border-radius:0 4px 4px 0;min-width:1px}
.rows .n{font-variant-numeric:tabular-nums;text-align:right;font-size:12px}
.tablewrap{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{padding:6px 8px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
th{font-size:12px;color:var(--muted);font-weight:600;cursor:pointer;user-select:none;position:sticky;top:0;background:var(--card)}
@media (max-width:600px){td .cellbar{display:none}}
th[aria-sort]::after{content:" ▾"}th[aria-sort=ascending]::after{content:" ▴"}
td.l,th.l{text-align:left}
td.name{max-width:16em;overflow:hidden;text-overflow:ellipsis}
.cellbar{display:inline-block;width:60px;height:8px;background:var(--bar-soft);border-radius:4px;margin-left:6px;vertical-align:middle;overflow:hidden}
.cellbar i{display:block;height:100%;background:var(--bar)}
.head{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px}
.head h2{margin:0}
.note{color:var(--muted);font-size:12px;margin:8px 0 0}
[hidden]{display:none!important}
</style></head>
<body><main>
<h1>物販ナビ 集計</h1>
<p class="sub">運営の中だけで見るページです。出展者ごとの順位は外に出さないでください（規約 第4条）。</p>

<section class="card" id="login">
  <h2>合言葉</h2>
  <form class="login" id="f"><input id="tok" type="password" autocomplete="current-password" placeholder="EXPORT_TOKEN" aria-label="合言葉"><button>表示</button></form>
  <p class="note">この端末のブラウザにだけ保存されます。共有のパソコンでは使い終わったら「合言葉を消す」を押してください。</p>
  <p class="err" id="err" hidden></p>
</section>

<div id="out" hidden>
  <div class="head"><p class="sub" id="span" style="margin:0"></p><span><button class="alt" id="reload">更新</button> <button class="alt" id="logout">合言葉を消す</button></span></div>
  <div class="tiles" id="tiles"></div>
  <section class="card"><h2>日別：ページを開いた回数</h2><div class="cols" id="daily"></div></section>
  <div class="grid2">
    <section class="card"><h2>時間帯（日本時間）：ページを開いた回数</h2><div class="cols" id="hours"></div></section>
    <section class="card"><h2>最初の表示までの時間</h2><div class="cols" id="ld"></div><p class="note">秒。30 は30秒以上。混雑時に右へ寄っていたら重くなっています。</p></section>
  </div>
  <div class="grid2" style="margin-top:14px">
    <section class="card"><h2>詳細をどこから開いたか</h2><div class="rows" id="from"></div></section>
    <section class="card"><h2>機能の利用</h2><div class="rows" id="feat"></div></section>
  </div>
  <section class="card" style="margin-top:14px"><h2>タグでの絞り込み</h2><div class="rows" id="tags"></div><p class="note" id="zero"></p></section>
  <section class="card">
    <div class="head"><h2>出展者ごと</h2><button class="alt" id="csv">CSVで保存</button></div>
    <div class="tablewrap"><table id="tbl"></table></div>
    <p class="note">見出しを押すと並び替え。お気に入りは追加から解除を引いた数。CSV は出展者に渡す用で、全体の中央値との比を付けます（順位は付けません）。</p>
  </section>
</div>
</main>
<script>
var SITE_DATA = __SITE_DATA__;
var $ = function (s) { return document.querySelector(s); };
var store = { get: function () { try { return localStorage.getItem("bn_dash_token") || ""; } catch (e) { return ""; } },
  set: function (v) { try { v ? localStorage.setItem("bn_dash_token", v) : localStorage.removeItem("bn_dash_token"); } catch (e) {} } };
var fmt = function (n) { return Number(n || 0).toLocaleString("ja-JP"); };
var el = function (tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
var C = {}, EX = [], sortKey = "d", sortAsc = false;
var n = function (k) { return C[k] || 0; };

function cols(box, items) {
  box.textContent = "";
  var max = Math.max(1, Math.max.apply(null, items.map(function (x) { return x[1]; })));
  items.forEach(function (x) {
    var c = el("div", x[1] ? "col" : "col zero"); c.title = x[0] + "：" + fmt(x[1]);
    var v = el("span", "v", fmt(x[1])); var bar = el("i"); bar.style.height = (x[1] / max * 100) + "%";
    c.append(v, bar, el("em", "", x[2] == null ? x[0] : x[2])); box.append(c);
  });
}
function rows(box, items) {
  box.textContent = "";
  var max = Math.max(1, Math.max.apply(null, items.map(function (x) { return x[1]; })));
  items.forEach(function (x) {
    var k = el("div", "k", x[0]); k.title = x[0];
    var t = el("div", "t"); var i = el("i"); i.style.width = (x[1] / max * 100) + "%"; t.append(i);
    box.append(k, t, el("div", "n", fmt(x[1])));
  });
  if (!items.length) box.append(el("div", "k", "まだありません"));
}
function sum(re) { return Object.keys(C).filter(function (k) { return re.test(k); }).reduce(function (a, k) { return a + C[k]; }, 0); }

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
  var data = rowsFor(), maxD = Math.max(1, Math.max.apply(null, data.map(function (r) { return r.d; }).concat([0])));
  var key = function (r) { return sortKey === "space" ? r.e.space : sortKey === "name" ? r.e.name : r[sortKey]; };
  data.sort(function (a, b) {
    var x = key(a), y = key(b);
    var c = typeof x === "string" ? x.localeCompare(y, "ja", { numeric: true }) : x - y;
    return sortAsc ? c : -c;
  });
  var t = $("#tbl"); t.textContent = "";
  var hr = el("tr");
  COLS.forEach(function (c) {
    var th = el("th", c[2] ? "l" : "", c[1]); th.scope = "col";
    if (c[0] === sortKey) th.setAttribute("aria-sort", sortAsc ? "ascending" : "descending");
    th.onclick = function () { if (sortKey === c[0]) sortAsc = !sortAsc; else { sortKey = c[0]; sortAsc = !!c[2]; } renderTable(); };
    hr.append(th);
  });
  var thead = el("thead"); thead.append(hr); t.append(thead);
  var tb = el("tbody");
  data.forEach(function (r) {
    var tr = el("tr");
    tr.append(el("td", "l", r.e.space));
    var nm = el("td", "l name", r.e.name); nm.title = r.e.name; tr.append(nm);
    var d = el("td", "", fmt(r.d)); var cb = el("span", "cellbar"); var ci = el("i"); ci.style.width = (r.d / maxD * 100) + "%"; cb.append(ci); d.append(cb); tr.append(d);
    tr.append(el("td", "", fmt(r.p)), el("td", "", fmt(r.fav)), el("td", "", fmt(r.s)));
    tb.append(tr);
  });
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
  $("#span").textContent = "期間 " + jst(x.first) + " 〜 " + jst(x.last) + "（日本時間）・送信 " + fmt(x.batches) + " 回";
  var tiles = [["ページを開いた回数", n("pv")], ["詳細を開いた回数", sum(/^d:/)], ["写真を開いた回数", sum(/^p:/)],
    ["お気に入り（追加−解除）", sum(/^f\+:/) - sum(/^f-:/)], ["共有", sum(/^s:/)]];
  var tb = $("#tiles"); tb.textContent = "";
  tiles.forEach(function (t) { var d = el("div", "tile"); d.append(el("b", "", fmt(t[1])), el("span", "", t[0])); tb.append(d); });
  cols($("#daily"), (x.daily || []).map(function (d) { return [d.day, d.pv, d.day.slice(5).replace("-", "/")]; }));
  var hs = []; for (var h = 0; h < 24; h++) hs.push([h + "時", n("h:" + h), h % 3 ? "" : String(h)]);
  cols($("#hours"), hs);
  var ls = []; for (var s = 0; s <= 30; s++) ls.push([s + "秒", n("ld:" + s), s % 5 ? "" : String(s)]);
  cols($("#ld"), ls);
  rows($("#from"), [["地図", n("from:map")], ["一覧", n("from:list")], ["共有リンク", n("from:link")]]);
  rows($("#feat"), [["タグで絞り込み", sum(/^t:/)], ["検索", n("q")], ["お気に入りだけ表示", n("scope:fav")],
    ["番号順に並べ替え", n("sort:space")], ["シャッフルに戻す", n("sort:shuffle")], ["平面図に切替", n("proj:flat")],
    ["立体図に切替", n("proj:iso")], ["？を開いた", n("help")], ["画像の読み込み失敗", n("imgerr")]]);
  var tg = Object.keys(C).filter(function (k) { return k.indexOf("t:") === 0; }).map(function (k) { return [k.slice(2), C[k]]; })
    .sort(function (a, b) { return b[1] - a[1]; });
  rows($("#tags"), tg);
  $("#zero").textContent = "絞り込みで0件になった回数：" + fmt(n("zero"));
  renderTable();
}

async function load() {
  var tok = store.get(); if (!tok) return;
  var err = $("#err"); err.hidden = true;
  try {
    var r = await fetch("export?token=" + encodeURIComponent(tok), { cache: "no-store" });
    if (r.status === 403) { store.set(""); throw new Error("合言葉が違います"); }
    if (!r.ok) throw new Error("集計を読めませんでした（" + r.status + "）");
    var x = await r.json();
    try { var d = await (await fetch(SITE_DATA, { cache: "no-store" })).json(); EX = d.exhibitors || []; }
    catch (e) { EX = []; err.textContent = "出展者の一覧（data.json）を読めなかったので、出展者ごとの表は空です"; err.hidden = false; }
    render(x);
    $("#login").hidden = true; $("#out").hidden = false;
  } catch (e) { err.textContent = e.message; err.hidden = false; $("#login").hidden = false; $("#out").hidden = true; }
}
$("#f").onsubmit = function (ev) { ev.preventDefault(); store.set($("#tok").value.trim()); $("#tok").value = ""; load(); };
$("#reload").onclick = load;
$("#logout").onclick = function () { store.set(""); $("#out").hidden = true; $("#login").hidden = false; };
$("#csv").onclick = downloadCsv;
load();
</script></body></html>`;
