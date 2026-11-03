// 出展者に渡すレポートを、1出展者1枚の画像（1920×1080、スライド1枚分）で作る
//
// 使い方:
//   1. <Workers のURL>/export?token=<EXPORT_TOKEN>&until=<締めの日 例 2026-11-02> を開いて export.json として保存
//      （until を付けると、その日の終わり（日本時間）までに届いた分だけになる。右上の集計期間もその日まで）
//   2. 公開サイトの data.json（https://kua-stuhub.github.io/butsuhan-navi/data.json）を保存
//   3. node tools/exhibitor-report.mjs export.json data.json reports/
//      → reports/<スペース>_<サークル名>.png ができる。1出展者だけなら最後に出展者の id を足す
//
// 載せるもの：お品書き（詳細）を開かれた回数（サイト訪問100回あたり何回か）・写真を開かれた回数・
// お気に入り（追加−解除）・共有された回数（この2つは1枚の小さいカードにまとめ、サイト全体の件数を添える）、見られた時間帯、写真が何枚目まで見られたか、サイト全体の合計1行。他の出展者との比較や順位は出さない。
// 文字は opentype.js で図形にして描くので、どの環境でも同じ見た目になる（フォントは assets/fonts/）。
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const [exportPath, dataPath, outDir = "reports", only] = process.argv.slice(2);
if (!exportPath || !dataPath) { console.error("使い方: node tools/exhibitor-report.mjs export.json data.json [出力フォルダ] [出展者id]"); process.exit(1); }

const sharp = (await import("sharp")).default;
const opentype = (await import("opentype.js")).default;
const font = async (n) => { const b = await fs.readFile(path.join(root, "assets", "fonts", n + ".ttf")); return opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
const [JP_B, JP_M, NUM] = await Promise.all([font("ZenKakuGothicNew-Bold"), font("ZenKakuGothicNew-Medium"), font("Barlow-SemiBold")]);
// サークル名に Zen Kaku Gothic にない文字（✋ ₃ ᘌ など）があるときに使う予備のフォント。見つかったものだけ使う
const FALLBACK = [];
for (const p of ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf", "/usr/share/fonts/truetype/freefont/FreeSans.ttf", "/usr/share/fonts/truetype/freefont/FreeSerif.ttf"]) {
  try { const b = await fs.readFile(p); FALLBACK.push(opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))); } catch {}
}
const cfg = JSON.parse(await fs.readFile(path.join(root, "config.json"), "utf8"));
const layout = JSON.parse(await fs.readFile(path.join(root, "data", "layout.json"), "utf8").catch(() => "{}"));

const exp = JSON.parse(await fs.readFile(exportPath, "utf8"));
const { counts = {} } = exp;
const { exhibitors = [] } = JSON.parse(await fs.readFile(dataPath, "utf8"));
const n = (k) => counts[k] || 0;
// 集計期間（日本時間）。export の最初と最後の受け取り日時から作る。?until= で締めたときはその日を終わりにする
const jst = (iso) => new Date(Date.parse(iso) + 9 * 3600e3);
const md = (d) => `${d.getUTCMonth() + 1}.${String(d.getUTCDate()).padStart(2, "0")}`;
const period = exp.first ? `集計 ${md(jst(exp.first))}–${exp.until ? md(new Date(exp.until + "T00:00:00Z")) : md(jst(exp.last || exp.first))}` : String(cfg.event?.dates || "");
// サイト全体の数字（順位や中央値は出さない。自分の数字の大きさの目安として1行だけ）
const sumOf = (re) => Object.entries(counts).reduce((a, [k, v]) => (re.test(k) ? a + v : a), 0);
const totalDetail = sumOf(/^d:/), totalFav = Math.max(0, sumOf(/^f\+:/) - sumOf(/^f-:/)), totalShare = sumOf(/^s:/);

/* ---------- 描画の道具 ---------- */
const W = 1920, H = 1080, M = 96;
const C = { bg: "#F4F5F6", card: "#FFFFFF", fg: "#1F1E1C", muted: "#6B6E73", faint: "#9A9DA2", line: "#DADDE0", accent: "#C8553D", accentSoft: "#F3DCD5", bar: "#C8553D", barSoft: "#E9D3CC" };
// 文字ごとに、その文字を持っているフォントで描く（ふだんは指定のフォントだけで1回で済む）
function runs(f, str) {
  const out = [];
  for (const ch of String(str)) {
    const use = /\s/.test(ch) || f.charToGlyphIndex(ch) ? f : FALLBACK.find((g) => g.charToGlyphIndex(ch)) || f;
    if (out.length && out[out.length - 1][0] === use) out[out.length - 1][1] += ch; else out.push([use, ch]);
  }
  return out;
}
const adv = (f, s, size) => runs(f, s).reduce((a, [g, t]) => a + g.getAdvanceWidth(t, size, { kerning: true }), 0);
const text = (f, s, x, y, size, fill) => {
  let d = "", cx = x;
  for (const [g, t] of runs(f, s)) { d += g.getPath(t, cx, y, size, { kerning: true }).toPathData(1); cx += g.getAdvanceWidth(t, size, { kerning: true }); }
  return `<path fill="${fill}" d="${d}"/>`;
};
const right = (f, s, x, y, size, fill) => text(f, s, x - adv(f, s, size), y, size, fill);
const center = (f, s, x, y, size, fill) => text(f, s, x - adv(f, s, size) / 2, y, size, fill);
const fmt = (v) => Number(v).toLocaleString("ja-JP");
// 空白があれば空白で、なければ日本語は1文字ずつ・英数字は単語ごとに折り返す
function wrapChars(f, s, size, maxW) {
  const toks = s.match(/[A-Za-z0-9'&\-.]+|./gu) || [], lines = []; let cur = "";
  for (const t of toks) { if (cur && adv(f, cur + t, size) > maxW) { lines.push(cur); cur = t; } else cur += t; }
  if (cur) lines.push(cur);
  return lines;
}
function wrap(f, s, size, maxW) {
  const lines = []; let cur = "";
  for (const w of s.split(/\s+/).filter(Boolean)) {
    const next = cur ? cur + " " + w : w;
    if (adv(f, next, size) <= maxW) { cur = next; continue; }
    if (cur) lines.push(cur);
    if (adv(f, w, size) <= maxW) cur = w;
    else { const parts = wrapChars(f, w, size, maxW); cur = parts.pop(); lines.push(...parts); }
  }
  if (cur) lines.push(cur);
  return lines;
}
function fitName(s, maxW) {
  for (const [size, max] of [[88, 1], [72, 1], [60, 2], [50, 2]]) { const l = wrap(JP_B, s, size, maxW); if (l.length <= max) return { size, lines: l }; }
  const l = wrap(JP_B, s, 50, maxW).slice(0, 2); let last = l[1] || "";
  while (last && adv(JP_B, last + "…", 50) > maxW) last = last.slice(0, -1);
  if (l.length > 1) l[1] = last + "…";
  return { size: 50, lines: l };
}
const card = (x, y, w, h) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="20" fill="${C.card}" stroke="${C.line}" stroke-width="2"/>`;

/* ---------- 1枚分 ---------- */

function slide(e) {
  const ev = cfg.event, d = n(`d:${e.id}`), p = n(`p:${e.id}`), fav = n(`f+:${e.id}`) - n(`f-:${e.id}`), sh = n(`s:${e.id}`);
  const when = [["開催前", "pre"], ["当日 〜12時", "am"], ["当日 12〜14時", "mid"], ["当日 14時〜・終了後", "pm"]].map(([l, k]) => [l, n(`dh:${e.id}:${k}`)]);
  const imgs = Math.max(1, Math.min(5, (e.images || []).length || 5));
  const pages = Array.from({ length: imgs }, (_, i) => [`${i + 1}枚目`, n(`pg:${e.id}:${i + 1}`)]);
  const room = (layout.rooms || []).find((r) => { const b = (layout.booths || []).find((b) => String(b[0]) === e.space); if (!b) return false; const cx = (b[1] + b[2]) / 2, cy = (b[3] + b[4]) / 2; return cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h; });

  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="${C.bg}"/>`;
  s += `<rect width="${W}" height="10" fill="${C.accent}"/>`;
  // ヘッダー
  const year = String(ev.year);
  s += text(JP_M, ev.name, M, 104, 30, C.fg);
  let hx = M + adv(JP_M, ev.name, 30) + 10;
  s += `<rect x="${hx.toFixed(1)}" y="76" width="${(adv(NUM, year, 28) + 16).toFixed(1)}" height="36" rx="6" fill="${C.fg}"/>` + text(NUM, year, hx + 8, 104, 28, C.bg);
  hx += adv(NUM, year, 28) + 28;
  s += text(JP_M, "物販ナビ 閲覧レポート", hx, 104, 30, C.fg);
  s += right(JP_M, period, W - M, 104, 28, C.muted);

  // スペースとサークル名
  const no = e.space || "—";
  s += text(NUM, "SPACE", M + 2, 186, 22, C.muted) + text(NUM, no, M, 262, 76, C.accent);
  const nx = 520;
  if (room) {
    const rx = M + adv(NUM, no, 76) + 24, avail = nx - 64 - rx;
    let label = room.name, size = 30;
    while (size > 18 && adv(JP_M, label, size) > avail) size -= 2;
    if (adv(JP_M, label, size) > avail && room.short) label = room.short;
    while (label.length > 1 && adv(JP_M, label, size) > avail) label = label.slice(0, -2) + "…";
    s += text(JP_M, label, rx, 256, size, C.fg);
  }
  const nm = fitName(e.name, W - M - nx);
  const nTop = nm.lines.length > 1 ? 196 : 238;
  nm.lines.forEach((ln, i) => (s += text(JP_B, ln, nx, nTop + i * nm.size * 1.25, nm.size, C.fg)));
  s += `<rect x="${nx - 40}" y="168" width="2" height="104" fill="${C.line}"/>`;

  // 数字：大きいカード2枚（開かれた回数・写真）と、お気に入り・共有をまとめた小さいカード1枚
  // お気に入りと共有は使った人が少なく 0 の組が多いので、大きな 0 を並べず、サイト全体の件数を添える
  const ky = 330, kh = 250, gap = 28, kw = (W - M * 2 - gap * 2) / 3;
  const pv = n("pv"), per100 = pv ? (d / pv * 100 < 10 ? (d / pv * 100).toFixed(1) : Math.round(d / pv * 100)) : 0;
  const kpis = [
    ["お品書きを開かれた回数", d, pv && d ? `サイト訪問100回あたり 約${per100}回` : ""],
    ["写真を開かれた回数", p, p && d ? `開いた人のうち ${Math.round(Math.min(1, p / d) * 100)}% が写真まで` : ""],
  ];
  kpis.forEach(([label, v, sub], i) => {
    const x = M + i * (kw + gap);
    s += card(x, ky, kw, kh) + text(JP_M, label, x + 36, ky + 62, 28, C.muted);
    s += text(NUM, fmt(v), x + 34, ky + 168, 104, i === 0 ? C.accent : C.fg);
    if (sub) s += text(JP_M, sub, x + 36, ky + 218, 22, C.muted);
  });
  const fx = M + 2 * (kw + gap), half = (kw - 72) / 2;
  s += card(fx, ky, kw, kh);
  [["お気に入り登録", Math.max(0, fav)], ["共有された回数", sh]].forEach(([label, v], i) => {
    const x = fx + 36 + i * half;
    s += text(JP_M, label, x, ky + 62, 24, C.muted) + text(NUM, fmt(v), x - 2, ky + 150, 72, C.fg);
  });
  s += text(JP_M, `サイト全体でも お気に入り ${fmt(totalFav)}件・共有 ${fmt(totalShare)}件の機能です`, fx + 36, ky + 218, 20, C.muted);

  // 下段：時間帯（横棒）と写真の何枚目まで（縦棒）
  const by = 612, bh = 330, lw = 900, rw = W - M * 2 - lw - gap;
  s += card(M, by, lw, bh) + text(JP_B, "いつ見られたか", M + 36, by + 58, 30, C.fg) + text(JP_M, "お品書きを開かれた回数", M + 36 + adv(JP_B, "いつ見られたか", 30) + 20, by + 58, 22, C.muted);
  const wmax = Math.max(1, ...when.map((w) => w[1])), lx = M + 36, bx = M + 310, bw = lw - 310 - 130;
  when.forEach(([l, v], i) => {
    const y = by + 108 + i * 54;
    s += text(JP_M, l, lx, y + 26, 24, C.fg);
    s += `<rect x="${bx}" y="${y}" width="${bw}" height="34" rx="8" fill="${C.bg}"/>`;
    if (v) s += `<rect x="${bx}" y="${y}" width="${Math.max(8, bw * v / wmax).toFixed(1)}" height="34" rx="8" fill="${C.bar}"/>`;
    s += right(NUM, fmt(v), M + lw - 36, y + 28, 30, C.fg);
  });

  const rx = M + lw + gap;
  s += card(rx, by, rw, bh) + text(JP_B, "写真は何枚目まで見られたか", rx + 36, by + 58, 30, C.fg);
  const pmax = Math.max(1, ...pages.map((q) => q[1])), px = rx + 48, pw = rw - 96, ph = 150, pb = by + bh - 64;
  const colW = pw / pages.length, barW = Math.min(110, colW * 0.6);
  if (!p) s += center(JP_M, "まだ写真は開かれていません", rx + rw / 2, by + bh / 2 + 24, 28, C.faint);
  else s += `<rect x="${px}" y="${pb}" width="${pw}" height="2" fill="${C.line}"/>`;
  if (p) pages.forEach(([l, v], i) => {
    const cx = px + colW * (i + 0.5), h = ph * v / pmax;
    if (v) s += `<rect x="${(cx - barW / 2).toFixed(1)}" y="${(pb - h).toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="8" fill="${i ? C.barSoft : C.bar}"/>`;
    s += center(NUM, fmt(v), cx, pb - h - 14, 28, C.fg) + center(JP_M, l, cx, pb + 38, 22, C.muted);
  });

  // 注記
  const org = cfg.org?.name || "";
  const pvAll = n("pv");
  const whole = `サイト全体（同じ期間）：サイト訪問 ${fmt(pvAll)}回・お品書きが開かれた回数 ${fmt(totalDetail)}回・掲載 ${fmt(exhibitors.length)}組`;
  s += text(JP_M, whole, M, 996, 22, C.fg);
  s += text(JP_M, "集計に協力いただいた来場者の閲覧のみを数えています。個人を特定する情報は含まず、他の出展者との順位はお伝えしていません。", M, 1030, 20, C.muted);
  if (org) s += right(JP_M, `運営：${org}`, W - M, 1030, 20, C.muted);
  return s + "</svg>";
}

/* ---------- 書き出す ---------- */
await fs.mkdir(outDir, { recursive: true });
const safe = (s) => String(s).replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 60);
const list = only ? exhibitors.filter((e) => e.id === only) : exhibitors;
if (!list.length) { console.error(only ? `出展者 ${only} が data.json にありません` : "data.json に出展者がいません"); process.exit(1); }
for (const e of list) {
  const file = path.join(outDir, `${safe(e.space || "none")}_${safe(e.name)}.png`);
  await sharp(Buffer.from(slide(e))).png().toFile(file);
}
console.error(`${list.length} 枚を ${outDir} に書き出しました`);
