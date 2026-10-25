// 大瓜生山祭 物販ナビ — ビルドスクリプト
//
// やること:
//   1. 出展者データを集める
//      - 環境変数 NOTION_TOKEN があれば Notion の「出展者」DBから「審査」が公開の行だけ取得（本番）
//      - なければ data/sample.json のダミーデータを使う（試運転）
//   2. お品書き画像をダウンロードして、一覧用（小）と拡大用（大）の webp に圧縮する
//   3. dist/ に公開用ファイル一式（index.html, app.js, style.css, data.json, layout.json, img/）を書き出す
//   4. 共有用に、出展者ごとのページ（e/<id>/）とプレビュー画像（ogp/）を作る（scripts/ogp.mjs）
//
// 連絡先（非公開）の列は読み込まないので、サイトに出ることはない。
//
// 使い方:
//   node scripts/build.mjs              … NOTION_TOKEN があれば本番データ、なければダミー
//   USE_SAMPLE=1 node scripts/build.mjs … 強制的にダミーデータ

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { buildOgp } from "./ogp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "dist");
const CACHE = path.join(ROOT, ".cache", "img");
const cfg = JSON.parse(await fs.readFile(path.join(ROOT, "config.json"), "utf8"));

const warnings = [];
const warn = (msg) => { warnings.push(msg); console.warn("⚠ " + msg); };

/* ---------------- helpers ---------------- */
const hash = (s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 12);
const exists = (p) => fs.access(p).then(() => true, () => false);
const escXml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// 「Ａ－１２」「 12 」などの表記ゆれをそろえる
function normalizeSpace(s) {
  return String(s || "").normalize("NFKC").replace(/\s+/g, "").replace(/[‐‑‒–—―ー－]/g, "-").replace(/番$/, "").toUpperCase();
}
// SNS欄: URL と @ID を拾う。http(s) 以外のリンクは捨てる（安全のため）
function parseSns(text) {
  const out = [];
  for (let tok of String(text || "").normalize("NFKC").split(/[\s、,]+/)) {
    tok = tok.trim();
    if (!tok) continue;
    if (/^https?:\/\/[^\s<>"']+$/i.test(tok)) out.push(tok);
    else if (/^@[A-Za-z0-9_]{1,15}$/.test(tok)) out.push("https://x.com/" + tok.slice(1));
  }
  return [...new Set(out)].slice(0, 4);
}
const clip = (s, n) => { s = String(s || "").trim(); return s.length > n ? s.slice(0, n) + "…" : s; };

// 画像の縦横サイズを読む（sharp が無いときの予備）
function imageSize(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), ext: "png" };
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1], len = buf.readUInt16BE(i + 2);
      if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7), ext: "jpg" };
      i += 2 + len;
    }
  }
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    const kind = buf.toString("ascii", 12, 16);
    if (kind === "VP8X") return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3), ext: "webp" };
    if (kind === "VP8 ") return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff, ext: "webp" };
    if (kind === "VP8L") { const b = buf.readUInt32LE(21); return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1, ext: "webp" }; }
  }
  if (buf.toString("ascii", 0, 3) === "GIF") return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8), ext: "gif" };
  return null;
}

async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

/* ---------------- images ---------------- */
let sharp = null;
async function loadSharp() {
  try { sharp = (await import("sharp")).default; }
  catch { warn("画像圧縮ライブラリ(sharp)が見つからないため、画像を圧縮せずにそのまま使います。"); }
}

// 1枚の画像 → { t: 一覧用, f: 拡大用, w, h }。同じ画像は .cache から再利用する
async function processImage(url, key, label) {
  const metaPath = path.join(CACHE, key + ".json");
  if (await exists(metaPath)) {
    const meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
    for (const f of new Set([meta.t, meta.f])) await fs.copyFile(path.join(CACHE, path.basename(f)), path.join(OUT, f));
    return meta;
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`ダウンロード失敗 (HTTP ${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 30 * 1024 * 1024) throw new Error("画像が大きすぎます（30MB超）");
  let meta;
  if (sharp) {
    const full = await sharp(buf, { failOn: "none" }).rotate()
      .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 80 }).toBuffer({ resolveWithObject: true });
    const thumb = await sharp(buf, { failOn: "none" }).rotate()
      .resize({ width: 480, withoutEnlargement: true }).webp({ quality: 72 }).toBuffer();
    meta = { t: `img/${key}-t.webp`, f: `img/${key}-f.webp`, w: full.info.width, h: full.info.height };
    await fs.writeFile(path.join(CACHE, `${key}-t.webp`), thumb);
    await fs.writeFile(path.join(CACHE, `${key}-f.webp`), full.data);
  } else {
    const size = imageSize(buf);
    if (!size) throw new Error("対応していない画像形式です（HEICなど）");
    meta = { t: `img/${key}.${size.ext}`, f: `img/${key}.${size.ext}`, w: size.w, h: size.h };
    await fs.writeFile(path.join(CACHE, `${key}.${size.ext}`), buf);
  }
  await fs.writeFile(metaPath, JSON.stringify(meta));
  for (const f of new Set([meta.t, meta.f])) await fs.copyFile(path.join(CACHE, path.basename(f)), path.join(OUT, f));
  return meta;
}

/* ---------------- data: Notion ---------------- */
const NOTION = () => process.env.NOTION_API_BASE || "https://api.notion.com";
const notionHeaders = (token) => ({ Authorization: `Bearer ${token}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" });

// config.json の databaseId で見つからないとき（ワークスペースを移したときなど）は、
// 連携キーが見られるデータベースの中から名前（例：「出展者」）で探す。
async function resolveDatabase(token, dbId) {
  if (dbId) {
    const res = await fetch(`${NOTION()}/v1/databases/${dbId}`, { headers: notionHeaders(token), signal: AbortSignal.timeout(30000) });
    if (res.ok) return dbId;
    if (res.status === 401) throw new Error("Notionの連携キーが正しくありません（GitHubの NOTION_TOKEN を確認してください）");
  }
  const title = cfg.notion.databaseTitle || "出展者";
  const res = await fetch(`${NOTION()}/v1/search`, {
    method: "POST", headers: notionHeaders(token), signal: AbortSignal.timeout(30000),
    body: JSON.stringify({ query: title, filter: { property: "object", value: "database" }, page_size: 20 }),
  });
  if (!res.ok) throw new Error(`Notionの検索に失敗しました (HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`);
  const hits = (await res.json()).results.filter((d) => (d.title || []).map((t) => t.plain_text).join("").trim() === title);
  if (!hits.length) throw new Error(`データベース「${title}」が見つかりません。Notionでページに連携（接続）を追加したか確認してください`);
  if (hits.length > 1) warn(`「${title}」という名前のデータベースが${hits.length}個あります。最初のものを使います`);
  const id = hits[0].id.replace(/-/g, "");
  warn(`config.json の databaseId を ${id} に書き換えておくと、次から探す手間が省けます`);
  return id;
}

async function fromNotion(token, dbId) {
  dbId = await resolveDatabase(token, dbId);
  const P = cfg.notion.props;
  // 「審査」がステータス列なら値が publishValue（公開）の行だけ、チェックボックス列ならチェック済みだけを読む
  const publishFilter = P.publishValue
    ? { property: P.publish, status: { equals: P.publishValue } }
    : { property: P.publish, checkbox: { equals: true } };
  const pages = [];
  let cursor;
  do {
    const res = await fetch(`${NOTION()}/v1/databases/${dbId}/query`, {
      method: "POST",
      headers: notionHeaders(token),
      body: JSON.stringify({ page_size: 100, start_cursor: cursor, filter: publishFilter }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`Notionの読み込みに失敗しました (HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`);
    const j = await res.json();
    pages.push(...j.results);
    cursor = j.has_more ? j.next_cursor : undefined;
  } while (cursor);

  const text = (p) => p?.select ? p.select.name : (p?.title || p?.rich_text || []).map((t) => t.plain_text).join("");
  const fixedTags = new Set(cfg.categories.flatMap((c) => c.tags));
  const multi = (p) => (p?.multi_select || []).map((o) => o.name);
  const files = (p) => (p?.files || []).map((f) => ({ url: f.file?.url || f.external?.url, name: f.name || "" })).filter((f) => f.url);

  await loadSharp();
  const list = [];
  for (const pg of pages) {
    const pr = pg.properties;
    // フォームのプルダウン（Notion では選択の列）は「15　アニクエ」の形。番号と名前に分け、名前欄が空なら選んだ名前を使う
    const rawSpace = text(pr[P.space]);
    const picked = rawSpace.match(/^\s*([0-9０-９]+)[\s　]+(.+?)\s*$/);
    const name = clip(text(pr[P.name]).trim() || (picked ? picked[2] : ""), 60);
    if (!name) { warn(`サークル名が空の行をスキップしました (${pg.url})`); continue; }
    // 「その他」の自由入力は「スクイーズ、ミニアルバム」のように1つにまとまって届くので、区切りで分ける
    const tags = [...new Set(P.tags.flatMap((k) => multi(pr[k])).flatMap((t) => fixedTags.has(t) ? [t] : t.split(/[、,，/／\s　]+/)).filter(Boolean))];
    const imgs = files(pr[P.images]).slice(0, 5);
    const images = (await pool(imgs, 4, async (f, i) => {
      const key = hash(`${pg.id}|${i}|${f.name}|${pg.last_edited_time}`);
      try { return await processImage(f.url, key, name); }
      catch (e) { warn(`「${name}」の画像${i + 1}枚目を使えませんでした: ${e.message}`); return null; }
    })).filter(Boolean);
    list.push({
      id: hash(pg.id),
      name,
      space: normalizeSpace(picked ? picked[1] : rawSpace),
      tags,
      comment: clip(text(pr[P.comment]), 200),
      sns: parseSns(text(pr[P.sns])),
      images,
    });
  }
  return list;
}

/* ---------------- data: sample ---------------- */
function sampleSvg(e, i, w, h) {
  const hue = (parseInt(hash(e.id), 16) % 360 + i * 28) % 360;
  const jp = "Zen Kaku Gothic New,Hiragino Sans,Noto Sans JP,Yu Gothic,Meiryo,sans-serif", num = "Barlow,Helvetica Neue,Arial,sans-serif";
  const s = w / 600;
  const rows = e.tags.slice(0, 4).map((t, k) => `<g transform="translate(${60 * s} ${(h * 0.6 + k * 95 * s) | 0})"><rect width="${140 * s}" height="${80 * s}" rx="8" fill="hsl(${hue} 30% 82%)"/><text x="${175 * s}" y="${36 * s}" font-size="${32 * s}" fill="#2a2a2a" font-family="${jp}">${escXml(t.replace(/（.*?）|などのアート作品/g, "").slice(0, 10))}</text><text x="${175 * s}" y="${72 * s}" font-size="${28 * s}" fill="#666" font-family="${num}">¥${500 + ((hue + k * 7) % 10) * 100}</text></g>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<rect width="${w}" height="${h}" fill="hsl(${hue} 35% 94%)"/><rect width="${w}" height="${h * 0.38}" fill="hsl(${hue} 42% 58%)"/>
<text x="${60 * s}" y="${h * 0.1}" font-size="${30 * s}" fill="#fff" font-family="${num}" letter-spacing="4">MENU ${String(i + 1).padStart(2, "0")}</text>
<text x="${60 * s}" y="${h * 0.27}" font-size="${62 * s}" font-weight="900" fill="#fff" font-family="${jp}">${escXml(e.name.length > 9 ? e.name.slice(0, 9) + "…" : e.name)}</text>
<text x="${60 * s}" y="${h * 0.5}" font-size="${30 * s}" fill="#555" font-family="${num}">SPACE ${escXml(e.space)}</text>${rows}
<text x="${w - 40 * s}" y="${h - 36 * s}" text-anchor="end" font-size="${26 * s}" fill="#888" font-family="${jp}">サンプル画像</text></svg>`;
}
async function fromSample() {
  const { exhibitors } = JSON.parse(await fs.readFile(path.join(ROOT, "data", "sample.json"), "utf8"));
  const list = [];
  for (const e of exhibitors) {
    const images = [];
    for (const [i, im] of (e.images || []).entries()) {
      const f = `img/${e.id}-${i}.svg`;
      await fs.writeFile(path.join(OUT, f), sampleSvg(e, i, im.w, im.h));
      images.push({ t: f, f, w: im.w, h: im.h });
    }
    list.push({ id: e.id, name: e.name, space: normalizeSpace(e.space), tags: e.tags, comment: e.comment || "", sns: parseSns((e.sns || []).join(" ")), images });
  }
  return list;
}

/* ---------------- main ---------------- */
await fs.rm(OUT, { recursive: true, force: true });
await fs.mkdir(path.join(OUT, "img"), { recursive: true });
await fs.mkdir(CACHE, { recursive: true });

const token = process.env.NOTION_TOKEN;
const dbId = process.env.NOTION_DATABASE_ID || cfg.notion.databaseId;
const live = !!(token && dbId) && process.env.USE_SAMPLE !== "1";
console.log(live ? "▶ Notionから本番データを取得します" : "▶ ダミーデータでビルドします");
const exhibitors = live ? await fromNotion(token, dbId) : await fromSample();

// フォームの「その他（自由入力）」で増えたタグを「その他」に足す
const categories = structuredClone(cfg.categories);
const known = new Set(categories.flatMap((c) => c.tags));
const extra = [...new Set(exhibitors.flatMap((e) => e.tags).filter((t) => !known.has(t)))];
const other = categories.find((c) => c.name === "その他");
if (other) other.tags.push(...extra);

// 同じスペース番号が複数あると地図で区別できないので知らせる
const seen = new Map();
for (const e of exhibitors) { if (!e.space) warn(`「${e.name}」のスペース番号が空です`); else if (seen.has(e.space)) warn(`スペース ${e.space} が重複: 「${seen.get(e.space)}」と「${e.name}」`); else seen.set(e.space, e.name); }

// 配置図にないスペース番号は地図に出ないので知らせる（配置図を差し替えたあとの番号ずれ対策）
const layoutJson = JSON.parse(await fs.readFile(path.join(ROOT, "data", "layout.json"), "utf8"));
const onMap = new Set(layoutJson.booths.map((b) => normalizeSpace(b[0])));
for (const e of exhibitors) if (e.space && !onMap.has(e.space)) warn(`「${e.name}」のスペース ${e.space} は配置図にありません（地図に出ません）`);

// 配置図の出展者リスト（data/roster.json）。読み取りが確定した名前（check なし・〓なし）だけ、未掲載のスペースに出す
// 本番データのときは、投稿の名前と配置図の名前を照合する（ダミーデータは名前が合わないので照合しない）
let roster = {};
try {
  const rj = JSON.parse(await fs.readFile(path.join(ROOT, "data", "roster.json"), "utf8"));
  for (const r of rj.entries || []) if (r.name && !r.check && !r.name.includes("〓")) roster[normalizeSpace(r.no)] = r.name;
  const flat = (t) => String(t).normalize("NFKC").toLowerCase().replace(/[\s・、。,.!?！？「」『』（）()&＆'’]/g, "");
  if (live) for (const e of exhibitors) { const n = roster[e.space]; if (n && !flat(e.name).includes(flat(n)) && !flat(n).includes(flat(e.name))) warn(`スペース ${e.space}：投稿の名前「${e.name}」が配置図の「${n}」と違います（番号の書き間違いかも）`); }
} catch (err) { if (err.code !== "ENOENT") warn(`data/roster.json を読めませんでした: ${err.message}`); }

// 共有用のプレビュー画像。og:image は絶対URLが必要なので、config.json の site.url が空なら作らない
const siteUrl = String(cfg.site?.url || "").replace(/\/?$/, "/");
const okId = (id) => /^[A-Za-z0-9_-]+$/.test(id);
let ogp = {};
if (/^https?:\/\//.test(siteUrl)) {
  if (!sharp) await loadSharp();
  ogp = await buildOgp({ root: ROOT, out: OUT, cache: path.join(ROOT, ".cache", "ogp"), exhibitors: exhibitors.filter((e) => okId(e.id)), layout: layoutJson, cfg, sharp, warn });
} else warn("config.json の site.url が空のため、共有用のプレビュー画像を作りません");

// 共有リンクに付ける版（e/<id>/?v=…）。名前などが変わると別のURLになり、Discord や X が新しいプレビューを読みに行く
for (const e of exhibitors) if (ogp[e.id]) e.v = ogp[e.id].v.slice(0, 6);

const data = {
  mode: live ? "live" : "sample",
  generatedAt: new Date().toISOString(),
  event: cfg.event,
  org: cfg.org,
  contact: cfg.contact,
  form: cfg.form,
  analytics: { endpoint: cfg.analytics?.endpoint || "" },
  categories,
  exhibitors,
  roster,
};
await fs.writeFile(path.join(OUT, "data.json"), JSON.stringify(data));
await fs.copyFile(path.join(ROOT, "data", "layout.json"), path.join(OUT, "layout.json"));

// 静的ファイル（キャッシュ対策にファイル内容のハッシュを付ける）
const assets = {};
for (const f of ["app.js", "style.css"]) {
  const body = await fs.readFile(path.join(ROOT, "src", f));
  assets[f] = `${f}?v=${hash(body)}`;
  await fs.writeFile(path.join(OUT, f), body);
}
for (const f of ["favicon.svg"]) await fs.copyFile(path.join(ROOT, "src", f), path.join(OUT, f));
const ev = cfg.event;
// ヘッダー右上の「by KUA StuHUB」。url が http(s) ならリンクにして別タブで開く
const byline = (org = {}) => {
  const name = org.shortName || org.name;
  if (!name) return "";
  // 狭い画面では先頭の語（KUA）を省いて「by StuHUB」にする
  const [head, ...rest] = String(name).split(" ");
  const label = rest.length
    ? `<span class="by-pre">by</span> <span class="by-head">${escXml(head)} </span>${escXml(rest.join(" "))}`
    : `<span class="by-pre">by</span> ${escXml(name)}`;
  return /^https?:\/\//.test(org.url || "")
    ? `<a class="byline" href="${escXml(org.url)}" target="_blank" rel="noopener">${label}<svg width="9" height="9" viewBox="0 0 12 12" aria-hidden="true"><path d="M4 2h6v6M10 2 3 9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></a>`
    : `<span class="byline">${label}</span>`;
};
let html = await fs.readFile(path.join(ROOT, "src", "index.html"), "utf8");
html = html
  .replaceAll("{{TITLE}}", escXml(ev.siteTitle))
  .replaceAll("{{DESCRIPTION}}", escXml(ev.description))
  .replaceAll("{{NAME}}", escXml(ev.name))
  .replaceAll("{{YEAR}}", escXml(ev.year))
  .replaceAll("{{DATES}}", escXml(ev.dates))
  .replaceAll("{{BYLINE}}", byline(cfg.org))
  .replaceAll("{{APP_JS}}", assets["app.js"])
  .replaceAll("{{STYLE_CSS}}", assets["style.css"])
  .replaceAll("{{OG_EXTRA}}", ogMeta(siteUrl, ogp.site?.img));
await fs.writeFile(path.join(OUT, "index.html"), html);

// 出展者ごとの共有ページ e/<id>/。SNS がプレビューを作るときに読む情報だけを書いて、人が開いたら本体の詳細へ移る
function ogMeta(pageUrl, img) {
  if (!/^https?:\/\//.test(siteUrl)) return "";
  return `<meta property="og:url" content="${escXml(pageUrl)}">` + (img
    ? `\n<meta property="og:image" content="${escXml(siteUrl + img)}">\n<meta property="og:image:width" content="1200">\n<meta property="og:image:height" content="630">\n<meta name="twitter:card" content="summary_large_image">`
    : `\n<meta name="twitter:card" content="summary">`);
}
for (const e of exhibitors) {
  if (!okId(e.id)) { warn(`「${e.name}」のIDに使えない文字があるため、共有ページを作りません`); continue; }
  const title = `${e.name}（スペース${e.space || "—"}）｜${ev.siteTitle}`;
  const desc = e.comment || (e.tags.length ? `頒布：${e.tags.join("・")}` : ev.description);
  const target = `../../?e=${e.id}`;
  await fs.mkdir(path.join(OUT, "e", e.id), { recursive: true });
  await fs.writeFile(path.join(OUT, "e", e.id, "index.html"), `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escXml(title)}</title>
<meta name="description" content="${escXml(desc)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${escXml(ev.siteTitle)}">
<meta property="og:title" content="${escXml(title)}">
<meta property="og:description" content="${escXml(desc)}">
<meta property="og:locale" content="ja_JP">
${ogMeta(`${siteUrl}e/${e.id}/${e.v ? `?v=${e.v}` : ""}`, (ogp[e.id] || ogp.site)?.img)}
<meta http-equiv="refresh" content="0; url=${target}">
<script>location.replace(${JSON.stringify(target)} + location.hash)</script>
</head>
<body><p><a href="${target}">${escXml(ev.siteTitle)}で開く</a></p></body>
</html>
`);
}
await fs.writeFile(path.join(OUT, ".nojekyll"), "");

console.log(`✔ ${exhibitors.length}件の出展者、画像${exhibitors.reduce((n, e) => n + e.images.length, 0)}枚で dist/ を作成しました`);
if (warnings.length) console.log(`  注意 ${warnings.length}件（上の ⚠ を確認してください）`);
