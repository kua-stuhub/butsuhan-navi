// 出展者に渡すレポートを、1出展者1枚の画像（1920×1080、スライド1枚分）で作る
//
// 使い方:
//   1. <Workers のURL>/export?token=<EXPORT_TOKEN> を開いて export.json として保存
//   2. 公開サイトの data.json（https://kua-stuhub.github.io/butsuhan-navi/data.json）を保存
//   3. node tools/exhibitor-report.mjs export.json data.json reports/
//      → reports/<スペース>_<サークル名>.png ができる。1出展者だけなら最後に出展者の id を足す
//
// 載せるもの：お品書き（詳細）を開かれた回数・写真を開かれた回数・お気に入り（追加−解除）・共有された回数、
// 全出展者の中央値との比（順位は出さない）、見られた時間帯、写真が何枚目まで見られたか。
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
const cfg = JSON.parse(await fs.readFile(path.join(root, "config.json"), "utf8"));
const layout = JSON.parse(await fs.readFile(path.join(root, "data", "layout.json"), "utf8").catch(() => "{}"));

const { counts = {} } = JSON.parse(await fs.readFile(exportPath, "utf8"));
const { exhibitors = [] } = JSON.parse(await fs.readFile(dataPath, "utf8"));
const n = (k) => counts[k] || 0;

/* ---------- 描画の道具 ---------- */
const W = 1920, H = 1080, M = 96;
const C = { bg: "#F4F5F6", card: "#FFFFFF", fg: "#1F1E1C", muted: "#6B6E73", faint: "#9A9DA2", line: "#DADDE0", accent: "#C8553D", accentSoft: "#F3DCD5", bar: "#C8553D", barSoft: "#E9D3CC" };
const adv = (f, s, size) => f.getAdvanceWidth(String(s), size, { kerning: true });
const text = (f, s, x, y, size, fill) => `<path fill="${fill}" d="${f.getPath(String(s), x, y, size, { kerning: true }).toPathData(1)}"/>`;
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
const all = exhibitors.map((e) => n(`d:${e.id}`)).sort((a, b) => a - b);
const median = all.length ? all[Math.floor(all.length / 2)] : 0;

function slide(e) {
  const ev = cfg.event, d = n(`d:${e.id}`), p = n(`p:${e.id}`), fav = n(`f+:${e.id}`) - n(`f-:${e.id}`), sh = n(`s:${e.id}`);
  const when = [["開催前", "pre"], ["当日 〜12時", "am"], ["当日 12〜14時", "mid"], ["当日 14時〜", "pm"]].map(([l, k]) => [l, n(`dh:${e.id}:${k}`)]);
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
  s += right(NUM, String(ev.dates || ""), W - M, 104, 30, C.muted);

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

  // 数字4つ
  const ky = 330, kh = 250, gap = 28, kw = (W - M * 2 - gap * 3) / 4;
  const ratio = median ? d / median : 0;
  const kpis = [
    ["お品書きを開かれた回数", d, median ? `全出展者の中央値の ${ratio.toFixed(1)} 倍` : ""],
    ["写真を開かれた回数", p, d ? `開いた人のうち ${Math.round(Math.min(1, p / d) * 100)}% が写真まで` : ""],
    ["お気に入り登録", fav, "追加された数から解除を引いた数"],
    ["共有された回数", sh, "共有ボタンが押された回数"],
  ];
  kpis.forEach(([label, v, sub], i) => {
    const x = M + i * (kw + gap);
    s += card(x, ky, kw, kh) + text(JP_M, label, x + 36, ky + 62, 28, C.muted);
    s += text(NUM, fmt(v), x + 34, ky + 168, 104, i === 0 ? C.accent : C.fg);
    if (sub) s += text(JP_M, sub, x + 36, ky + 218, 22, C.muted);
  });

  // 下段：時間帯（横棒）と写真の何枚目まで（縦棒）
  const by = 612, bh = 330, lw = 900, rw = W - M * 2 - lw - gap;
  s += card(M, by, lw, bh) + text(JP_B, "いつ見られたか", M + 36, by + 58, 30, C.fg) + text(JP_M, "お品書きを開かれた回数", M + 36 + adv(JP_B, "いつ見られたか", 30) + 20, by + 58, 22, C.muted);
  const wmax = Math.max(1, ...when.map((w) => w[1])), lx = M + 36, bx = M + 270, bw = lw - 270 - 130;
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
  s += `<rect x="${px}" y="${pb}" width="${pw}" height="2" fill="${C.line}"/>`;
  pages.forEach(([l, v], i) => {
    const cx = px + colW * (i + 0.5), h = ph * v / pmax;
    if (v) s += `<rect x="${(cx - barW / 2).toFixed(1)}" y="${(pb - h).toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="8" fill="${i ? C.barSoft : C.bar}"/>`;
    s += center(NUM, fmt(v), cx, pb - h - 14, 28, C.fg) + center(JP_M, l, cx, pb + 38, 22, C.muted);
  });

  // 注記
  const org = cfg.org?.name || "";
  ["本サイトでの集計にご協力いただいた来場者の閲覧のみを数えています。個人を特定する情報は含みません。", "他の出展者との順位はお伝えしていません。"]
    .forEach((ln, i) => (s += text(JP_M, ln, M, 996 + i * 32, 21, C.muted)));
  if (org) s += right(JP_M, `運営：${org}`, W - M, 996, 21, C.muted);
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
