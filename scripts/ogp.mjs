// 共有用のプレビュー画像（OGP、1200×630）を作る
//
// - 出展者ごと：左に「スペース番号・部屋・サークル名・頒布物」、右に会場の立体地図（そのブースを朱色＋ピン）
// - サイト全体：左にサイト名と説明、右に会場全体の地図
// 文字と地図は左右の欄で分けていて、地図は右の欄からはみ出した分を切るので重ならない。
// 長いサークル名は、行数が増えるごとに文字を小さくして最大4行。それでも入らなければ末尾を「…」にする。
// 文字は opentype.js で図形（パス）にしてから描くので、ビルド環境にフォントを入れなくても同じ見た目になる。
// フォントは assets/fonts/ にある（SIL Open Font License）。

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const W = 1200, H = 630, SPLIT = 680;           // 左 0〜680 が文字、右 680〜1200 が地図
const TX = 56, TW = SPLIT - TX - 40;             // 文字の左端と最大幅
// 色は2026年の配置図（ベージュの床・紺の壁・朱の枠の机・青い目印）に合わせる。サイトの地図（src/style.css の --map-*）と同じ値
const C = { panel: "#F3EFE7", mapBg: "#D6CFC1", path: "#DFD9CD", floor: "#E8E3D9", wall: "#2A2C48", top: "#EBCFC2", side: "#D3AE9E", side2: "#C29B8A", stroke: "#A32C2E", marker: "#DCEBF8", markerStroke: "#30599F", fg: "#1F1E1C", muted: "#6E6A62", line: "#D9D2C4", accent: "#C8553D" };
const hash = (s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 12);

/* ---------- 文字 ---------- */
let JP_B, JP_M, NUM;
const adv = (font, s, size) => font.getAdvanceWidth(s, size, { kerning: true });
const text = (font, s, x, y, size, fill) => `<path fill="${fill}" d="${font.getPath(s, x, y, size, { kerning: true }).toPathData(1)}"/>`;

// 日本語は文字ごと、英数字は単語ごとに折り返す。行頭に来てはいけない記号は前の行にぶら下げる。
// 空白のあとが短ければ、空白の位置で改行する（「〜研究会 有／志サークル」のような切れ方を避ける）
const NO_START = "、。，．・ー〜）」』】〕！？!?,.)]ぁぃぅぇぉっゃゅょァィゥェォッャュョ";
const tokens = (s) => s.match(/[A-Za-z0-9'&\-]+|\s+|./gu) || [];
function wrap(font, s, size, maxW) {
  const lines = []; let cur = "";
  for (const t of tokens(s)) {
    const blank = /^\s+$/.test(t);
    if (blank && !cur) continue;
    if (adv(font, cur + t, size) <= maxW) { cur += t; continue; }
    if (NO_START.includes(t[0]) && cur) { cur += t; continue; }
    const sp = cur.lastIndexOf(" ");
    if (!blank && sp > 0 && cur.length - sp <= 8) { lines.push(cur.slice(0, sp)); cur = cur.slice(sp + 1) + t; }
    else { if (cur) lines.push(cur.trimEnd()); cur = blank ? "" : t; }
    while (adv(font, cur, size) > maxW) { // 1行に入らない長い単語は文字の途中で割る
      let i = cur.length; while (i > 1 && adv(font, cur.slice(0, i), size) > maxW) i--;
      lines.push(cur.slice(0, i)); cur = cur.slice(i);
    }
  }
  if (cur) lines.push(cur.trimEnd());
  return lines;
}
function fitName(s, maxW, maxH) {
  for (const [size, maxLines] of [[88, 1], [76, 1], [64, 2], [54, 2], [46, 3], [40, 3], [34, 4]]) {
    const lines = wrap(JP_B, s, size, maxW), lh = size * 1.28;
    if (lines.length <= maxLines && lines.length * lh <= maxH) return { size, lines, lh };
  }
  const size = 34, lh = size * 1.28, n = Math.min(4, Math.floor(maxH / lh)), lines = wrap(JP_B, s, size, maxW).slice(0, n);
  let last = lines[n - 1]; while (last && adv(JP_B, last + "…", size) > maxW) last = last.slice(0, -1);
  lines[n - 1] = last + "…";
  return { size, lines, lh };
}

/* ---------- 地図（サイトと同じ見下ろし立体図） ---------- */
const th = -26 * Math.PI / 180, K = .58, cs = Math.cos(th), sn = Math.sin(th);
const P = (x, y, z = 0) => [x * cs - y * sn, (x * sn + y * cs) * K - z];
const pts = (a) => a.map((p) => p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" ");
const quad = (x1, y1, x2, y2, z) => [P(x1, y1, z), P(x2, y1, z), P(x2, y2, z), P(x1, y2, z)];
const center = (b) => [(b[1] + b[2]) / 2, (b[3] + b[4]) / 2];
const roomAt = (L, b) => { const [cx, cy] = center(b); return L.rooms.find((r) => cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h); };

function mapSvg(L, booth) {
  const Z = 9, WALL = 14, sel = booth ? String(booth[0]) : null;
  // 見せる範囲：ブースがあればその部屋（横に長い部屋はブースの周りだけ）、なければ会場全体
  let fr;
  if (booth) {
    const r = roomAt(L, booth) || { x: 0, y: 0, w: 1e5, h: 1e5 }, [cx, cy] = center(booth);
    const x1 = Math.max(r.x, cx - 260), x2 = Math.min(r.x + r.w, cx + 260), y1 = Math.max(r.y, cy - 200), y2 = Math.min(r.y + r.h, cy + 200);
    fr = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  } else {
    const all = L.rooms.concat(L.paths || []), xs = all.flatMap((r) => [r.x, r.x + r.w]), ys = all.flatMap((r) => [r.y, r.y + r.h]);
    fr = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  }
  let mnx = 1e9, mny = 1e9, mxx = -1e9, mxy = -1e9;
  [[fr.x, fr.y], [fr.x + fr.w, fr.y], [fr.x, fr.y + fr.h], [fr.x + fr.w, fr.y + fr.h]].forEach(([x, y]) => [0, WALL].forEach((z) => {
    const [a, c] = P(x, y, z); mnx = Math.min(mnx, a); mxx = Math.max(mxx, a); mny = Math.min(mny, c); mxy = Math.max(mxy, c);
  }));
  const areaW = W - SPLIT, padX = booth ? 56 : 40, padY = booth ? 90 : 60;
  // 会場全体は横に長くて小さくなるので、左右は少し切れてもよいことにして大きく見せる
  const s = Math.min((areaW - padX * 2) / (mxx - mnx) * (booth ? 1 : 1.7), (H - padY * 2) / (mxy - mny));
  const ox = SPLIT + areaW / 2 - s * (mnx + mxx) / 2, oy = H / 2 - s * (mny + mxy) / 2 + (booth ? 14 : 0);
  const sw = (w) => `vector-effect="non-scaling-stroke" stroke-width="${w}"`;
  let g = "";
  for (const r of L.paths || []) g += `<polygon fill="${C.path}" points="${pts(quad(r.x, r.y, r.x + r.w, r.y + r.h, 0))}"/>`;
  for (const r of L.rooms) g += `<polygon fill="${C.floor}" stroke="${C.wall}" ${sw(1.2)} points="${pts(quad(r.x, r.y, r.x + r.w, r.y + r.h, 0))}"/>`;
  // 奥から順に描く。選んだブースは手前のブースに隠れないよう最後に描く
  const order = L.booths.slice().sort((p, q) => P(...center(p))[1] - P(...center(q))[1]).sort((p, q) => (String(p[0]) === sel) - (String(q[0]) === sel));
  for (const [no, x1, x2, y1, y2] of order) {
    const on = String(no) === sel, mk = !/^\d+$/.test(String(no));
    const [t, s1, s2, st] = on ? [C.accent, "#A8432E", "#923826", "#7E2F1F"] : mk ? [C.marker, C.marker, C.marker, C.markerStroke] : [C.top, C.side, C.side2, C.stroke];
    g += `<polygon fill="${s1}" stroke="${st}" ${sw(.8)} points="${pts([P(x1, y2, 0), P(x2, y2, 0), P(x2, y2, Z), P(x1, y2, Z)])}"/>`;
    g += `<polygon fill="${s2}" stroke="${st}" ${sw(.8)} points="${pts([P(x1, y1, 0), P(x1, y2, 0), P(x1, y2, Z), P(x1, y1, Z)])}"/>`;
    g += `<polygon fill="${t}" stroke="${st}" ${sw(.8)} points="${pts(quad(x1, y1, x2, y2, Z))}"/>`;
  }
  for (const r of L.rooms) {
    const a = [r.x, r.y], b = [r.x + r.w, r.y], d = [r.x, r.y + r.h], up = (p) => P(p[0], p[1], WALL), dn = (p) => P(p[0], p[1], 0);
    g += `<polyline fill="none" stroke="${C.wall}" ${sw(1.2)} points="${pts([up(d), up(a), up(b)])}"/>`;
    g += [a, b, d].map((p) => `<line stroke="${C.wall}" ${sw(1.2)} x1="${dn(p)[0].toFixed(1)}" y1="${dn(p)[1].toFixed(1)}" x2="${up(p)[0].toFixed(1)}" y2="${up(p)[1].toFixed(1)}"/>`).join("");
  }
  let out = `<g transform="translate(${ox.toFixed(1)},${oy.toFixed(1)}) scale(${s.toFixed(4)})">${g}</g>`;
  if (booth) {
    const [px, py] = P(...center(booth), Z), X = ox + px * s, Y = oy + py * s;
    out += `<path d="M${X.toFixed(1)} ${(Y - 6).toFixed(1)} c-6 -14 -22 -24 -22 -40 a22 22 0 0 1 44 0 c0 16 -16 26 -22 40z" fill="${C.accent}" stroke="#fff" stroke-width="3"/><circle cx="${X.toFixed(1)}" cy="${(Y - 46).toFixed(1)}" r="8" fill="#fff"/>`;
  }
  return out;
}

/* ---------- カード ---------- */
function frame(L, booth, body, cfg) {
  const ev = cfg.event, year = String(ev.year);
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="${C.mapBg}"/>`;
  s += `<defs><clipPath id="m"><rect x="${SPLIT}" y="0" width="${W - SPLIT}" height="${H}"/></clipPath></defs><g clip-path="url(#m)">${mapSvg(L, booth)}</g>`;
  s += `<rect width="${SPLIT}" height="${H}" fill="${C.panel}"/><rect x="${SPLIT}" width="2" height="${H}" fill="${C.line}"/>`;
  // ヘッダー：「大瓜生山祭 [2026] 物販ナビ（非公式）」
  // スマホでは画像が小さく表示されるので、文字は大きめにする
  s += text(JP_B, ev.name, TX, 92, 36, C.fg);
  let hx = TX + adv(JP_B, ev.name, 36) + 10;
  s += `<rect x="${hx.toFixed(1)}" y="58" width="${(adv(NUM, year, 34) + 18).toFixed(1)}" height="44" rx="7" fill="${C.wall}"/>` + text(NUM, year, hx + 9, 92, 34, C.panel);
  hx += adv(NUM, year, 34) + 30;
  s += text(JP_B, "物販ナビ", hx, 92, 36, C.fg) + text(JP_M, "（非公式）", hx + adv(JP_B, "物販ナビ", 36) + 2, 92, 22, C.muted);
  s += body;
  // フッター：日程と運営
  const org = cfg.org?.name ? `運営：${cfg.org.name}` : "";
  s += text(NUM, String(ev.dates || ""), TX, 594, 30, C.muted);
  if (org) { let os = 22; while (os > 16 && adv(JP_M, org, os) > TW - adv(NUM, String(ev.dates || ""), 30) - 24) os -= 2; s += text(JP_M, org, TX + TW - adv(JP_M, org, os), 592, os, C.muted); }
  return s + "</svg>";
}

function exhibitorCard(L, e, cfg) {
  const booth = L.booths.find((b) => String(b[0]) === e.space), room = booth && roomAt(L, booth);
  let s = "";
  // スペース番号と部屋
  const noY = 236, no = e.space || "—";
  s += text(NUM, "SPACE", TX + 2, noY - 86, 24, C.muted) + text(NUM, no, TX, noY, 96, C.accent);
  if (room) {
    const rx = TX + adv(NUM, no, 96) + 26, avail = TX + TW - rx;
    let label = room.name, size = 36;
    while (size > 22 && adv(JP_B, label, size) > avail) size -= 2;
    if (adv(JP_B, label, size) > avail && room.short) { label = room.short; size = 36; while (size > 22 && adv(JP_B, label, size) > avail) size -= 2; }
    s += text(JP_B, label, rx, noY - 8, size, C.fg);
  }
  // サークル名（y 262〜452 の中）
  const top = 262, nm = fitName(e.name, TW, 452 - top);
  nm.lines.forEach((ln, i) => (s += text(JP_B, ln, TX, top + nm.size + i * nm.lh, nm.size, C.fg)));
  // 頒布物：1行に入る分だけ。残りは「+N」
  const tags = (e.tags || []).map((t) => t.replace("（陶芸・木工など）", "").replace("などのアート作品", ""));
  let tx = TX; const ty = 470, fs = 28, th = 52, pad = 20;
  for (let i = 0; i < tags.length; i++) {
    const w = adv(JP_M, tags[i], fs) + pad * 2, rest = tags.length - i - 1, more = rest ? adv(NUM, `+${rest}`, fs) + pad * 2 + 10 : 0;
    if (tx + w + more > TX + TW) {
      const m = `+${tags.length - i}`;
      s += `<rect x="${tx.toFixed(1)}" y="${ty}" width="${(adv(NUM, m, fs) + pad * 2).toFixed(1)}" height="${th}" rx="${th / 2}" fill="none" stroke="${C.muted}" stroke-width="2"/>` + text(NUM, m, tx + pad, ty + 36, fs, C.muted);
      break;
    }
    s += `<rect x="${tx.toFixed(1)}" y="${ty}" width="${w.toFixed(1)}" height="${th}" rx="${th / 2}" fill="#fff" stroke="${C.line}" stroke-width="2"/>` + text(JP_M, tags[i], tx + pad, ty + 36, fs, C.fg);
    tx += w + 10;
  }
  return frame(L, booth, s, cfg);
}

function siteCard(L, cfg) {
  let s = text(JP_B, "物販ナビ", TX, 250, 84, C.fg);
  const desc = wrap(JP_M, "有志物販に出展するサークル・作家のお品書きを、会場の地図といっしょに探せます。", 28, TW);
  desc.slice(0, 4).forEach((ln, i) => (s += text(JP_M, ln, TX, 330 + i * 44, 28, C.muted)));
  return frame(L, null, s, cfg);
}

/* ---------- まとめて書き出す ---------- */
// 返り値：{ site: "ogp/site.png?v=…", [出展者id]: "ogp/<id>.png?v=…" }。作れなかったものは入らない
export async function buildOgp({ root, out, cache, exhibitors, layout, cfg, sharp, warn }) {
  let opentype;
  try { opentype = (await import("opentype.js")).default; }
  catch { warn("opentype.js が見つからないため、共有用のプレビュー画像を作りません"); return {}; }
  if (!sharp) { warn("sharp が見つからないため、共有用のプレビュー画像を作りません"); return {}; }
  const font = async (n) => { const b = await fs.readFile(path.join(root, "assets", "fonts", n + ".ttf")); return opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
  [JP_B, JP_M, NUM] = await Promise.all([font("ZenKakuGothicNew-Bold"), font("ZenKakuGothicNew-Medium"), font("Barlow-SemiBold")]);
  await fs.mkdir(path.join(out, "ogp"), { recursive: true });
  await fs.mkdir(cache, { recursive: true });

  // このファイル・配置図・イベント情報が変わったら、全部作り直す
  const self = await fs.readFile(new URL(import.meta.url), "utf8");
  const base = JSON.stringify({ self: hash(self), layout, ev: cfg.event, org: cfg.org?.name });
  const jobs = [{ id: "site", key: hash(base), svg: () => siteCard(layout, cfg) },
    ...exhibitors.map((e) => ({ id: e.id, key: hash(base + JSON.stringify([e.name, e.space, e.tags])), svg: () => exhibitorCard(layout, e, cfg) }))];
  const urls = {};
  for (const j of jobs) {
    const cached = path.join(cache, j.key + ".png"), file = `ogp/${j.id}.png`;
    try {
      if (!(await fs.access(cached).then(() => true, () => false)))
        await sharp(Buffer.from(j.svg())).png({ palette: true, quality: 90 }).toFile(cached);
      await fs.copyFile(cached, path.join(out, file));
      urls[j.id] = `${file}?v=${j.key}`;
    } catch (err) { warn(`プレビュー画像（${j.id}）を作れませんでした: ${err.message}`); }
  }
  return urls;
}
