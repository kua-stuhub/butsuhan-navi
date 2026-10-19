// アクセス解析の集計を、出展者ごとの表（CSV）にする
//
// 使い方:
//   1. ブラウザで <Workers のURL>/export?token=<EXPORT_TOKEN> を開いて、中身を export.json として保存
//   2. 公開サイトの data.json（https://kua-stuhub.github.io/butsuhan-navi/data.json）を保存
//   3. node tools/analytics-report.mjs export.json data.json > report.csv
//
// 列：スペース, サークル名, 詳細を開いた回数, 写真を開いた回数, 写真1〜5枚目, お気に入り（追加−解除）,
//     共有, 開催前／当日午前／昼／午後に詳細を開いた回数, 詳細を開いた回数の全体の中央値との比（順位は出さない）
import fs from "node:fs";

const [exportPath, dataPath] = process.argv.slice(2);
if (!exportPath || !dataPath) { console.error("使い方: node tools/analytics-report.mjs export.json data.json > report.csv"); process.exit(1); }
const { counts = {} } = JSON.parse(fs.readFileSync(exportPath, "utf8"));
const { exhibitors } = JSON.parse(fs.readFileSync(dataPath, "utf8"));
const n = (k) => counts[k] || 0;

const rows = exhibitors.map((e) => ({
  e,
  d: n(`d:${e.id}`), p: n(`p:${e.id}`), pages: [1, 2, 3, 4, 5].map((i) => n(`pg:${e.id}:${i}`)),
  fav: n(`f+:${e.id}`) - n(`f-:${e.id}`), share: n(`s:${e.id}`),
  when: ["pre", "am", "mid", "pm"].map((w) => n(`dh:${e.id}:${w}`)),
}));
const sorted = rows.map((r) => r.d).sort((a, b) => a - b), mid = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
const csv = (v) => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
const out = [["スペース", "サークル名", "詳細", "写真", "写真1枚目", "2枚目", "3枚目", "4枚目", "5枚目", "お気に入り", "共有", "開催前", "当日午前", "当日昼", "当日午後", "中央値との比"]];
for (const r of rows.sort((a, b) => a.e.space.localeCompare(b.e.space, "ja", { numeric: true })))
  out.push([r.e.space, r.e.name, r.d, r.p, ...r.pages, r.fav, r.share, ...r.when, mid ? (r.d / mid).toFixed(2) : ""]);
process.stdout.write("\uFEFF" + out.map((r) => r.map(csv).join(",")).join("\n") + "\n");

// 全体の数字は標準エラーに出す（CSV には入れない）
const sum = (re) => Object.entries(counts).filter(([k]) => re.test(k)).reduce((a, [, v]) => a + v, 0);
console.error(`ページを開いた回数 ${n("pv")} / 詳細の出どころ 地図 ${n("from:map")}・一覧 ${n("from:list")}・共有リンク ${n("from:link")}`);
console.error(`絞り込み ${sum(/^t:/)}（0件 ${n("zero")}）/ 検索 ${n("q")} / お気に入りだけ表示 ${n("scope:fav")} / 番号順 ${n("sort:space")} / 平面 ${n("proj:flat")} / ？ ${n("help")} / 画像エラー ${n("imgerr")}`);
