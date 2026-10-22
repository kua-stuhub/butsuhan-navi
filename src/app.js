/* 大瓜生山祭 物販ナビ — app
 * data.json（出展者）と layout.json（配置図）を読み込んで、地図と一覧を表示する。
 * 出展者が入力した文字はすべて esc() を通してから画面に出す（不正なHTMLを防ぐため）。
 */
(() => {
"use strict";

/* ---------- helpers ---------- */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeUrl = (u) => (/^https?:\/\//i.test(u) ? u : "#");
const short = (t) => t.replace("（陶芸・木工など）", "").replace("などのアート作品", "");
const wide = () => matchMedia("(min-width:900px)").matches;
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

/* ---------- data (filled by boot) ---------- */
let ROOMS = [], B = [], X = [], CATS = [], DATA = null;
let bySpace = {};
const roomOf = (no) => {
  const b = B.find((b) => String(b[0]) === String(no)); if (!b) return "";
  const cx = (b[1] + b[2]) / 2, cy = (b[3] + b[4]) / 2;
  const r = ROOMS.find((r) => cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h);
  return r ? (r.short || r.name) : "";
};

/* ---------- state ---------- */
let favs = new Set(store.get("bn_favs", []));
let seed = store.get("bn_seed", null); if (seed == null) { seed = Math.floor(Math.random() * 2 ** 31); store.set("bn_seed", seed); }
const S = { q: "", tags: new Set(), sort: store.get("bn_sort", "shuffle"), scope: "all", mode: "list", detail: null,
  proj: store.get("bn_proj", "iso"), zoom: wide() ? 1.1 : 2.2, snap: 1, openCat: null, searchOpen: false };
const SNAPS = [.17, .5, .9]; // visible fraction of the stage

/* ---------- fair order: shuffled per visitor ---------- */
function rng(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const spaceKey = (s) => { const m = String(s).match(/\d+/); return m ? +m[0] : 9999; };
function ordered(list) {
  if (S.sort === "space") return list.slice().sort((a, b) => spaceKey(a.space) - spaceKey(b.space) || a.space.localeCompare(b.space));
  const r = rng(seed), k = new Map(X.map((e) => [e.id, r()]));
  return list.slice().sort((a, b) => k.get(a.id) - k.get(b.id));
}
function matches(e) {
  if (S.tags.size && !e.tags.some((t) => S.tags.has(t))) return false;
  const q = S.q.trim().normalize("NFKC").toLowerCase();
  if (q && !(e.name.normalize("NFKC").toLowerCase().includes(q) || e.space.toLowerCase() === q || e.comment.toLowerCase().includes(q))) return false;
  return true;
}
const filtering = () => S.tags.size > 0 || S.q.trim() !== "";
const visible = () => X.filter((e) => (S.scope === "all" || favs.has(e.id)) && matches(e));

const star = `<svg viewBox="0 0 24 24"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z" stroke-linejoin="round"/></svg>`;
const searchIco = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`;

/* ---------- sheet: list ---------- */
function renderSheet() {
  if (S.mode === "detail") return renderDetail();
  const list = ordered(visible());
  $("#headSlot").innerHTML = `<div class="shead">
    <div class="seg" role="group" aria-label="表示する出展者">
      <button type="button" data-scope="all" aria-pressed="${S.scope === "all"}">すべて <span class="c">${S.scope === "all" ? list.length : X.length}</span></button>
      <button type="button" data-scope="fav" aria-pressed="${S.scope === "fav"}">★ <span class="c">${favs.size}</span></button>
    </div>
    <button type="button" class="pill" id="b-sort" aria-label="並び順を切り替え（今は${S.sort === "shuffle" ? "シャッフル" : "スペース番号順"}）"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4v16M3 16l4 4 4-4M17 20V4M13 8l4-4 4 4"/></svg>${S.sort === "shuffle" ? "シャッフル順" : "番号順"}</button>
    <button type="button" class="iconbtn" id="b-search" aria-pressed="${!!(S.searchOpen || S.q)}" aria-label="検索">${searchIco}</button></div>`;
  const counts = {}; X.forEach((e) => e.tags.forEach((t) => (counts[t] = (counts[t] || 0) + 1)));
  const oc = CATS.find((c) => c.name === S.openCat);
  const updated = DATA ? new Date(DATA.generatedAt).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
  const C = DATA?.contact || {};
  const contact = [C.email ? `<span class="mail">${esc(C.email)}</span>` : "", C.url ? `<a href="${esc(safeUrl(C.url))}" target="_blank" rel="noopener">${esc(C.label || "窓口")}</a>` : ""].filter(Boolean).join(" または ") || "運営";
  const org = DATA?.org?.name ? `運営：${esc(DATA.org.name)}<br>` : "";
  const rest = `
    <div class="cats" role="group" aria-label="頒布するもので絞り込み">
      ${CATS.map((c) => { const n = c.tags.filter((t) => S.tags.has(t)).length;
        return `<button type="button" class="cat${n ? " on" : ""}" data-cat="${esc(c.name)}" aria-expanded="${S.openCat === c.name}"><span class="tri">▸</span>${esc(c.name)}${n ? `<b>${n}</b>` : ""}</button>`; }).join("")}
      ${filtering() ? `<button type="button" class="cat clearc" id="clear">クリア</button>` : ""}
    </div>
    ${oc ? `<div class="chips sub">${oc.tags.filter((t) => counts[t] || known.has(t)).map((t) => `<button type="button" class="chip" data-tag="${esc(t)}" aria-pressed="${S.tags.has(t)}">${esc(short(t))}<small>${counts[t] || 0}</small></button>`).join("")}</div>` : ""}
    <div class="grid">${list.length ? list.map(cardHTML).join("") :
      `<div class="empty">${S.scope === "fav" && !favs.size ? "お気に入りはまだありません。<br>カードの☆を押すと、ここに集まります。<br>この端末のブラウザにだけ保存されます。" : X.length ? "条件に合う出展者はいません。<br>タグを減らすか、検索語を変えてください。" : "掲載中の出展者はまだいません。<br>掲載が始まるまでお待ちください。"}</div>`}</div>
    <p class="foot">${S.sort === "shuffle" ? "並び順は見る人ごとにシャッフルされるので、特定の出展者がいつも上に来ることはありません。<br>" : ""}${updated ? `最終更新 ${esc(updated)}<br>` : ""}${org}有志による非公式の取り組みです。大学・学園祭実行委員会・物販イベント主催とは関係ありません。掲載内容の修正・削除は${contact}までご連絡ください。</p>`;
  // 検索欄は作り直さずに残す（入力中に作り直すと、日本語の変換が壊れて文字が二重になる）
  const body = $("#sbody"), showQ = S.searchOpen || S.q;
  const keep = showQ ? body.querySelector(":scope > .search") : null;
  if (keep) {
    while (keep.previousSibling) keep.previousSibling.remove();
    while (keep.nextSibling) keep.nextSibling.remove();
    keep.insertAdjacentHTML("afterend", rest);
    const q = keep.querySelector("#q");
    if (q && q.value !== S.q && document.activeElement !== q) q.value = S.q; // 地図からスペースを選んだときなど
  } else {
    body.innerHTML = (showQ ? `<div class="search">${searchIco}<input id="q" type="search" placeholder="サークル名・スペース番号" value="${esc(S.q)}" autocomplete="off" enterkeyhint="search"></div>` : "") + rest;
  }
}
let known = new Set();
function thumbHTML(e) {
  const im = e.images[0];
  return im ? `<img class="thumb" src="${esc(im.t)}" alt="${esc(e.name)}のお品書き" loading="lazy" decoding="async" width="${im.w}" height="${im.h}">`
    : `<div class="thumb noimg">お品書き<br>準備中</div>`;
}
function cardHTML(e) {
  return `<div class="card" role="button" tabindex="0" data-id="${esc(e.id)}">${thumbHTML(e)}
    <button type="button" class="favbtn" data-fav="${esc(e.id)}" aria-pressed="${favs.has(e.id)}" aria-label="お気に入り">${star}</button>
    <div class="cbody"><div class="space"><b>${esc(e.space || "—")}</b>${esc(roomOf(e.space))}</div><p class="cname">${esc(e.name)}</p>
    <div class="ctags">${e.tags.slice(0, 2).map((t) => `<span>${esc(short(t))}</span>`).join("")}${e.tags.length > 2 ? `<span>+${e.tags.length - 2}</span>` : ""}</div></div></div>`;
}

/* ---------- sheet: detail ---------- */
function renderDetail() {
  const e = S.detail, n = e.images.length;
  $("#headSlot").innerHTML = `<div class="dhead"><button type="button" class="back" id="back">‹ 一覧</button><h2>${esc(e.name)}</h2></div>`;
  if (e.vacant) { // a space nobody has listed yet
    const form = DATA?.form?.url ? `<p class="foot" style="margin-top:0">出展者の方へ：<a href="${esc(safeUrl(DATA.form.url))}" target="_blank" rel="noopener">${esc(DATA.form.label || "掲載フォーム")}</a>からお品書きを載せられます。</p>` : "";
    $("#sbody").innerHTML = `<p class="dsum" id="dsum"><span>${esc(roomOf(e.space))}</span></p>
      <div class="empty" style="margin-bottom:12px">このスペースのお品書きは、まだ掲載されていません。</div>${form}`;
    $("#sbody").scrollTop = 0; sizeGallery(); return;
  }
  const sns = e.sns.map((u) => `<a href="${esc(safeUrl(u))}" target="_blank" rel="noopener nofollow">${esc(u.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, ""))}</a>`).join("<br>");
  $("#sbody").innerHTML = `
    <p class="dsum" id="dsum"><span><b>${esc(e.space || "—")}</b> ${esc(roomOf(e.space))}</span><span>${e.tags.map((t) => esc(short(t))).join("・")}</span></p>
    ${n ? `<div class="gallery" id="gallery">${e.images.map((im, i) => `<button type="button" data-page="${i}" aria-label="お品書き ${i + 1}枚目を拡大"><img src="${esc(im.t)}" alt="${esc(e.name)}のお品書き ${i + 1}枚目" width="${im.w}" height="${im.h}" decoding="async">${n > 1 ? `<span class="pg">${i + 1}/${n}</span>` : ""}</button>`).join("")}</div>`
      : `<div class="empty" style="margin-bottom:12px">お品書きは準備中です</div>`}
    ${e.comment ? `<dl class="meta"><dt>ひとこと</dt><dd>${esc(e.comment)}</dd></dl>` : ""}
    <div class="actions" style="margin-bottom:14px"><button type="button" class="btn" id="d-fav" aria-pressed="${favs.has(e.id)}">${favs.has(e.id) ? "★ お気に入り済み" : "☆ お気に入り"}</button>
      ${B.some((b) => String(b[0]) === e.space) ? `<button type="button" class="btn alt" id="d-map">地図で見る</button>` : ""}
      ${navigator.share ? `<button type="button" class="btn alt" id="d-share">共有</button>`
        : `<button type="button" class="btn alt" id="d-copy">リンクをコピー</button><a class="btn alt" id="d-post" href="${esc(postUrl(e))}" target="_blank" rel="noopener">Xでポスト</a>`}</div>
    ${e.sns.length ? `<dl class="meta"><dt>SNS</dt><dd>${sns}</dd></dl>` : ""}`;
  $("#sbody").scrollTop = 0;
  sizeGallery();
}
/* fit the お品書き images into the visible part of the sheet, and size the sheet to its content */
let detailFrac = .5;
function contentH() {
  const body = $("#sbody"), last = body.lastElementChild; if (!last) return 0;
  const bottom = last.getBoundingClientRect().bottom - body.getBoundingClientRect().top + body.scrollTop;
  return $("#grab").offsetHeight + bottom + 18;
}
function sizeGallery() {
  const g = $("#gallery"), body = $("#sbody");
  const h = wide() ? $("#sheet").clientHeight : stageH();
  if (g) {
    const ims = S.detail.images.slice(0, 2); // up to two images side by side, both whole
    const ratio = ims.reduce((a, im) => a + im.w / im.h, 0);
    const byWidth = (body.clientWidth - 32 - 10 * (ims.length - 1)) / ratio;
    body.style.setProperty("--gh", Math.min(byWidth, 560) + "px");
    const fixed = contentH() - g.offsetHeight;
    const room = wide() ? h : (S.snap === 2 ? h * SNAPS[2] : h * .74); // keep a quarter of the screen for the map
    body.style.setProperty("--gh", Math.max(120, Math.min(byWidth, room - fixed, 560)) + "px");
  }
  if (!wide() && S.mode === "detail") detailFrac = Math.min(SNAPS[2], Math.max(SNAPS[1], contentH() / h));
}
const frac = (i = S.snap) => (i === 1 && S.mode === "detail" && !wide() ? detailFrac : SNAPS[i]);

/* ---------- album-style photo viewer ---------- */
function openLightbox(e, start) {
  const n = e.images.length, reduce = matchMedia("(prefers-reduced-motion:reduce)").matches;
  const lb = document.createElement("div");
  lb.className = "lb"; lb.setAttribute("role", "dialog"); lb.setAttribute("aria-modal", "true"); lb.setAttribute("aria-label", e.name + "のお品書き");
  lb.innerHTML = `<div class="lb-bg"></div>
    <div class="lb-track">${e.images.map((im, i) => `<div class="lb-page"><div class="lb-img" style="background:url('${esc(im.t)}') center/contain no-repeat"><img src="${esc(im.f)}" alt="${esc(e.name)}のお品書き ${i + 1}枚目" decoding="async"></div></div>`).join("")}</div>
    <div class="lb-ui lb-top"><span class="ttl">${esc(e.name)}</span><span class="num"></span><button type="button" class="lb-x" aria-label="閉じる">×</button></div>
    ${n > 1 ? `<div class="lb-ui lb-bottom"><div class="lb-dots">${"<i></i>".repeat(n)}</div></div>
    <button type="button" class="lb-nav lb-prev" aria-label="前の画像">‹</button><button type="button" class="lb-nav lb-next" aria-label="次の画像">›</button>` : ""}`;
  document.body.appendChild(lb);
  const bg = lb.querySelector(".lb-bg"), track = lb.querySelector(".lb-track"), imgs = [...lb.querySelectorAll(".lb-img")];
  let idx = start, W = 0, H = 0, F = [], closing = false;
  const st = imgs.map(() => ({ s: 1, x: 0, y: 0 }));
  const thumbEl = (i) => document.querySelector(`#gallery [data-page="${i}"]`);

  function fit() {
    W = lb.clientWidth; H = lb.clientHeight;
    F = e.images.map((im, i) => {
      const r = im.w / im.h, aw = W - 24, ah = H - 150;
      let w = aw, h = w / r; if (h > ah) { h = ah; w = h * r; }
      imgs[i].style.width = w + "px"; imgs[i].style.height = h + "px"; return { w, h };
    });
  }
  function setTrack(dx = 0, anim) { track.classList.toggle("anim", !!anim && !reduce); track.style.transform = `translateX(${-idx * W + dx}px)`; }
  function setImg(i, anim, dy = 0, ds = 1) { const s = st[i]; imgs[i].classList.toggle("anim", !!anim && !reduce); imgs[i].style.transform = `translate(${s.x}px,${s.y + dy}px) scale(${s.s * ds})`; }
  function clamp(i) {
    const s = st[i]; if (s.s <= 1.01) { s.s = 1; s.x = 0; s.y = 0; return; } s.s = Math.min(5, s.s);
    const mx = Math.max(0, (F[i].w * s.s - W) / 2), my = Math.max(0, (F[i].h * s.s - H) / 2);
    s.x = Math.min(mx, Math.max(-mx, s.x)); s.y = Math.min(my, Math.max(-my, s.y));
  }
  function ui() {
    lb.querySelector(".num").textContent = n > 1 ? `${idx + 1} / ${n}` : "";
    lb.querySelectorAll(".lb-dots i").forEach((d, i) => d.classList.toggle("on", i === idx));
    const p = lb.querySelector(".lb-prev"), q = lb.querySelector(".lb-next"); if (p) { p.disabled = idx === 0; q.disabled = idx === n - 1; }
  }
  function go(i) {
    if (i < 0 || i >= n) { setTrack(0, true); return; }
    if (i !== idx) { st[idx] = { s: 1, x: 0, y: 0 }; setImg(idx); }
    idx = i; setTrack(0, true); ui(); seePage(i);
  }
  const rectTransform = (r) => `translate(${r.left + r.width / 2 - W / 2}px,${r.top + r.height / 2 - H / 2}px) scale(${r.width / F[idx].w})`;
  function close() {
    if (closing) return; closing = true;
    const t = thumbEl(idx), r = t && t.getBoundingClientRect(), el = imgs[idx];
    lb.classList.remove("open"); bg.style.opacity = "";
    if (!reduce) { el.classList.add("anim"); el.style.transform = r && r.width ? rectTransform(r) : `translate(${st[idx].x}px,${st[idx].y + 60}px) scale(.85)`; if (!r || !r.width) el.style.opacity = "0"; }
    document.removeEventListener("keydown", onKey); window.removeEventListener("resize", onResize);
    setTimeout(() => { lb.remove(); const f = thumbEl(idx); if (f) f.focus(); }, reduce ? 0 : 320);
  }

  const seen = new Set(), seePage = (i) => { if (!seen.has(i)) { seen.add(i); count(`pg:${e.id}:${i + 1}`); } };
  count(`p:${e.id}`); seePage(start);
  fit(); setTrack(0); ui();
  const r0 = thumbEl(start)?.getBoundingClientRect();
  if (r0 && r0.width && !reduce) imgs[idx].style.transform = rectTransform(r0);
  requestAnimationFrame(() => requestAnimationFrame(() => { lb.classList.add("open"); setImg(idx, true); }));

  const ptr = new Map(); let mode = null, moved = false, sx = 0, sy = 0, t0 = 0, last = null, pin = null, lastTap = 0, tapPos = null;
  const rel = (ev) => [ev.clientX - W / 2, ev.clientY - H / 2];
  const pair = () => { const [a, b] = [...ptr.values()]; return { m: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], d: Math.hypot(a[0] - b[0], a[1] - b[1]) }; };
  lb.addEventListener("pointerdown", (ev) => {
    if (closing || ev.target.closest("button")) return;
    lb.setPointerCapture(ev.pointerId); ptr.set(ev.pointerId, rel(ev));
    if (ptr.size === 1) { [sx, sy] = rel(ev); last = [sx, sy]; t0 = performance.now(); moved = false; mode = null; }
    if (ptr.size === 2) { const p = pair(), s = st[idx]; pin = { ...p, s: s.s, x: s.x, y: s.y }; mode = "pinch"; setTrack(0, true); }
  });
  lb.addEventListener("pointermove", (ev) => {
    if (!ptr.has(ev.pointerId)) return; const p = rel(ev); ptr.set(ev.pointerId, p); const s = st[idx];
    if (mode === "pinch" && ptr.size === 2) {
      const q = pair(), ns = Math.max(.7, Math.min(6, pin.s * q.d / pin.d));
      const cx = (pin.m[0] - pin.x) / pin.s, cy = (pin.m[1] - pin.y) / pin.s;
      s.s = ns; s.x = q.m[0] - ns * cx; s.y = q.m[1] - ns * cy; setImg(idx); return;
    }
    if (ptr.size !== 1) return;
    const dx = p[0] - sx, dy = p[1] - sy;
    if (!moved && Math.hypot(dx, dy) > 6) { moved = true; mode = s.s > 1.01 ? "pan" : (Math.abs(dx) > Math.abs(dy) ? "swipe" : (dy > 0 ? "dismiss" : "swipe")); lb.classList.add("dragging"); }
    if (mode === "pan") { s.x += p[0] - last[0]; s.y += p[1] - last[1]; setImg(idx); }
    else if (mode === "swipe") { const edge = (idx === 0 && dx > 0) || (idx === n - 1 && dx < 0); setTrack(edge ? dx * .3 : dx); }
    else if (mode === "dismiss") { const k = Math.min(1, dy / (H * .5)); setImg(idx, false, dy, 1 - k * .25); bg.style.opacity = String(1 - k * .85); }
    last = p;
  });
  const up = (ev) => {
    if (!ptr.has(ev.pointerId)) return; const p = ptr.get(ev.pointerId); ptr.delete(ev.pointerId);
    if (mode === "pinch") { if (ptr.size === 1) { mode = "pan"; last = [...ptr.values()][0]; return; } if (!ptr.size) { clamp(idx); setImg(idx, true); mode = null; lb.classList.remove("dragging"); } return; }
    if (ptr.size) return;
    lb.classList.remove("dragging");
    const dx = p[0] - sx, dy = p[1] - sy, dt = Math.max(1, performance.now() - t0);
    if (mode === "swipe") { const v = dx / dt; if (dx < -W * .18 || v < -.45) go(idx + 1); else if (dx > W * .18 || v > .45) go(idx - 1); else setTrack(0, true); }
    else if (mode === "dismiss") { if (dy > 110 || dy / dt > .6) close(); else { setImg(idx, true); bg.style.opacity = ""; } }
    else if (mode === "pan") { clamp(idx); setImg(idx, true); }
    else if (!moved) {
      const s0 = st[idx], onImg = Math.abs(p[0] - s0.x) < F[idx].w * s0.s / 2 && Math.abs(p[1] - s0.y) < F[idx].h * s0.s / 2;
      if (!onImg) { close(); mode = null; return; } // tap outside the photo closes right away
      const now = performance.now();
      if (now - lastTap < 300 && tapPos && Math.hypot(p[0] - tapPos[0], p[1] - tapPos[1]) < 30) {
        const s = st[idx]; if (s.s > 1.01) { s.s = 1; s.x = 0; s.y = 0; } else { const cx = (p[0] - s.x) / s.s, cy = (p[1] - s.y) / s.s; s.s = 2.5; s.x = p[0] - 2.5 * cx; s.y = p[1] - 2.5 * cy; clamp(idx); }
        setImg(idx, true); lastTap = 0;
      } else { lastTap = now; tapPos = p; }
    }
    mode = null;
  };
  lb.addEventListener("pointerup", up); lb.addEventListener("pointercancel", up);
  lb.addEventListener("wheel", (ev) => {
    ev.preventDefault(); if (closing) return; const p = rel(ev), s = st[idx];
    const f = Math.exp(-ev.deltaY * (ev.ctrlKey ? .01 : .002)), ns = Math.max(1, Math.min(6, s.s * f)), cx = (p[0] - s.x) / s.s, cy = (p[1] - s.y) / s.s;
    s.s = ns; s.x = p[0] - ns * cx; s.y = p[1] - ns * cy; clamp(idx); setImg(idx);
  }, { passive: false });
  lb.addEventListener("click", (ev) => {
    if (ev.target.closest(".lb-x")) close();
    else if (ev.target.closest(".lb-prev")) go(idx - 1);
    else if (ev.target.closest(".lb-next")) go(idx + 1);
  });
  function onKey(ev) { if (ev.key === "Escape") close(); else if (ev.key === "ArrowRight") go(idx + 1); else if (ev.key === "ArrowLeft") go(idx - 1); }
  function onResize() { fit(); st.forEach((_, i) => { clamp(i); setImg(i); }); setTrack(0); }
  document.addEventListener("keydown", onKey); window.addEventListener("resize", onResize);
  lb.querySelector(".lb-x").focus({ preventScroll: true });
}

/* ---------- map: axonometric wireframe ---------- */
let geo = null;
function projector() {
  if (S.proj === "flat") return (x, y) => [x, y];
  const th = -26 * Math.PI / 180, k = .58, c = Math.cos(th), s = Math.sin(th);
  return (x, y, z = 0) => [x * c - y * s, (x * s + y * c) * k - z];
}
function renderMap() {
  if (!ROOMS.length) return;
  const P = projector(), iso = S.proj === "iso", Z = iso ? 9 : 0, WALL = iso ? 14 : 0;
  const pts = (a) => a.map((p) => p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" ");
  const quad = (x1, y1, x2, y2, z) => [P(x1, y1, z), P(x2, y1, z), P(x2, y2, z), P(x1, y2, z)];
  let mnx = 1e9, mny = 1e9, mxx = -1e9, mxy = -1e9;
  ROOMS.forEach((r) => [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]].forEach(([x, y]) => [0, WALL].forEach((z) => { const [a, b] = P(x, y, z); mnx = Math.min(mnx, a); mxx = Math.max(mxx, a); mny = Math.min(mny, b); mxy = Math.max(mxy, b); })));
  const pad = 40, vx = mnx - pad, vy = mny - pad, vw = mxx - mnx + pad * 2, vh = mxy - mny + pad * 2;
  let out = "";
  ROOMS.forEach((r) => (out += `<polygon class="room-floor" points="${pts(quad(r.x, r.y, r.x + r.w, r.y + r.h, 0))}"/>`));
  const hf = filtering() || S.scope === "fav", shown = new Set(visible().map((e) => e.space));
  const sel = S.detail ? S.detail.space : null;
  B.slice().sort((a, b) => P((a[1] + a[2]) / 2, (a[3] + a[4]) / 2)[1] - P((b[1] + b[2]) / 2, (b[3] + b[4]) / 2)[1]).forEach(([no, x1, x2, y1, y2]) => {
    const list = bySpace[String(no)], e = list && list[0], rc = no === "受付", hit = e && hf && shown.has(e.space), dim = hf && !hit && !rc;
    const cls = ["booth", e ? "has" : rc ? "" : "vacant", hit ? "hit" : "", dim ? "dim" : "", rc ? "recept" : "", sel === String(no) ? "sel" : ""].join(" ");
    const label = e ? `スペース${esc(no)} ${esc(list.map((x) => x.name).join("、"))}` : `スペース${esc(no)}（掲載なし）`;
    let g = `<g class="${cls}" ${rc ? "" : `data-space="${esc(no)}" tabindex="0" role="button" aria-label="${label}"`}>`;
    if (iso) g += `<polygon class="s1" points="${pts([P(x1, y2, 0), P(x2, y2, 0), P(x2, y2, Z), P(x1, y2, Z)])}"/><polygon class="s2" points="${pts([P(x1, y1, 0), P(x1, y2, 0), P(x1, y2, Z), P(x1, y1, Z)])}"/>`;
    g += `<polygon class="t" points="${pts(quad(x1, y1, x2, y2, Z))}"/>`;
    const [cx, cy] = P((x1 + x2) / 2, (y1 + y2) / 2, Z), fs = Math.min(13, Math.max(9, Math.min(x2 - x1, y2 - y1) * .55));
    g += `<text x="${cx.toFixed(1)}" y="${(cy + fs * .36).toFixed(1)}" font-size="${fs.toFixed(1)}" text-anchor="middle">${esc(no)}</text>`;
    if (list && list.some((x) => favs.has(x.id))) { const [fx, fy] = P(x2, y1, Z); g += `<circle class="favdot" cx="${fx.toFixed(1)}" cy="${(fy - 2).toFixed(1)}" r="5.5"/>`; }
    out += g + "</g>";
  });
  ROOMS.forEach((r) => {
    const a = [r.x, r.y], b = [r.x + r.w, r.y], d = [r.x, r.y + r.h];
    if (iso) { const upP = (p) => P(p[0], p[1], WALL), dn = (p) => P(p[0], p[1], 0);
      out += `<polyline class="room-wall" points="${pts([upP(d), upP(a), upP(b)])}"/>` + [a, b, d].map((p) => `<line class="room-wall" x1="${dn(p)[0]}" y1="${dn(p)[1]}" x2="${upP(p)[0]}" y2="${upP(p)[1]}"/>`).join(""); }
    const [tx, ty] = P(r.lx ?? r.x + r.w / 2, r.ly ?? r.y + r.h / 2, 0);
    out += `<text class="room-label" x="${tx.toFixed(1)}" y="${ty.toFixed(1)}" font-size="${r.short ? 15 : 20}" text-anchor="middle">${esc(r.name)}</text>`;
  });
  const box = $("#mapbox"), W = box.clientWidth || 400;
  const width = W, height = Math.round(W * vh / vw);
  const keep = geo && (geo.proj !== S.proj || geo.width !== width) ? centerPoint() : null;
  box.innerHTML = `<svg width="${width}" height="${height}" viewBox="${vx.toFixed(0)} ${vy.toFixed(0)} ${vw.toFixed(0)} ${vh.toFixed(0)}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="物販会場の配置図">${out}</svg>`;
  geo = { width, height, vx, vy, vw, vh, P, proj: S.proj };
  if (!MV.init) { MV.init = true; MV.s = S.zoom; MV.tx = (W - width * MV.s) * .3; MV.ty = (visH() - height * MV.s) / 2; }
  else if (keep) { MV.tx = box.clientWidth / 2 - keep.x * width * MV.s; MV.ty = visH() / 2 - keep.y * height * MV.s; }
  applyView();
}

/* ---------- map pan & zoom ---------- */
const MV = { s: 1, tx: 0, ty: 0, init: false };
const stageH = () => $("#stage").clientHeight;
const visH = () => (wide() ? $("#mapbox").clientHeight : stageH() * (1 - frac()));
function centerPoint() { const box = $("#mapbox"); return { x: (box.clientWidth / 2 - MV.tx) / (geo.width * MV.s), y: (visH() / 2 - MV.ty) / (geo.height * MV.s) }; }
function clampView() {
  if (!geo) return; const box = $("#mapbox"), m = 60, w = geo.width * MV.s, h = geo.height * MV.s, bw = box.clientWidth, bh = visH();
  MV.tx = w < bw - 2 * m ? (bw - w) / 2 : Math.min(m, Math.max(bw - w - m, MV.tx));
  MV.ty = h < bh - 2 * m ? (bh - h) / 2 : Math.min(m, Math.max(bh - h - m, MV.ty));
}
function applyView(anim) {
  const svg = $("#mapbox svg"); if (!svg) return; clampView();
  svg.classList.toggle("anim", !!anim);
  svg.style.transform = `translate(${MV.tx}px,${MV.ty}px) scale(${MV.s})`;
}
function zoomAt(px, py, f, anim) {
  const ns = Math.min(6, Math.max(.8, MV.s * f)); f = ns / MV.s;
  MV.tx = px - (px - MV.tx) * f; MV.ty = py - (py - MV.ty) * f; MV.s = ns; applyView(anim);
}
function focusBooth(no) {
  const b = B.find((b) => String(b[0]) === String(no)); if (!b || !geo) return;
  const [px, py] = geo.P((b[1] + b[2]) / 2, (b[3] + b[4]) / 2, 0);
  const sx = (px - geo.vx) / geo.vw * geo.width, sy = (py - geo.vy) / geo.vh * geo.height;
  if (MV.s < 2) MV.s = 2.2;
  MV.tx = $("#mapbox").clientWidth / 2 - sx * MV.s; MV.ty = visH() / 2 - sy * MV.s; applyView(true);
}
function boothTapped(no) {
  const list = bySpace[String(no)];
  if (!list) openDetail({ id: "", name: `スペース ${no}`, space: String(no), tags: [], comment: "", sns: [], images: [], vacant: true }, true);
  else if (list.length === 1) openDetail(list[0], true);
  else { S.q = String(no); S.searchOpen = true; S.mode = "list"; S.detail = null; rerender(); if (!wide()) setSnap(1); }
}
function initMapGestures() {
  const box = $("#mapbox"), pts = new Map(); let moved = 0, last = null, downTarget = null;
  const rel = (e) => { const r = box.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const pair = () => { const [a, b] = [...pts.values()]; return { mx: (a[0] + b[0]) / 2, my: (a[1] + b[1]) / 2, d: Math.hypot(a[0] - b[0], a[1] - b[1]) }; };
  box.addEventListener("pointerdown", (e) => {
    if (e.button > 0) return;
    box.setPointerCapture(e.pointerId); pts.set(e.pointerId, rel(e));
    if (pts.size === 1) { moved = 0; downTarget = e.target.closest(".booth[data-space]"); }
    last = pts.size === 2 ? pair() : null; box.classList.add("panning");
  });
  box.addEventListener("pointermove", (e) => {
    if (!pts.has(e.pointerId)) return;
    const p = rel(e), q = pts.get(e.pointerId); pts.set(e.pointerId, p);
    if (pts.size === 1) { MV.tx += p[0] - q[0]; MV.ty += p[1] - q[1]; moved += Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]); applyView(); }
    else if (pts.size === 2) { const n = pair(); if (last) { MV.tx += n.mx - last.mx; MV.ty += n.my - last.my; zoomAt(n.mx, n.my, n.d / last.d); } last = n; moved = 99; }
  });
  const up = (e) => {
    if (!pts.has(e.pointerId)) return; pts.delete(e.pointerId); last = pts.size === 2 ? pair() : null;
    if (!pts.size) { box.classList.remove("panning"); if (moved < 8 && downTarget) boothTapped(downTarget.dataset.space); downTarget = null; }
  };
  box.addEventListener("pointerup", up); box.addEventListener("pointercancel", up);
  box.addEventListener("wheel", (e) => {
    e.preventDefault(); const [x, y] = rel(e);
    const mouseWheel = !e.ctrlKey && e.deltaX === 0 && Math.abs(e.deltaY) >= 50 && Number.isInteger(e.deltaY);
    if (e.ctrlKey || mouseWheel) zoomAt(x, y, Math.exp(-e.deltaY * (e.ctrlKey ? .01 : .0018)));
    else { MV.tx -= e.deltaX; MV.ty -= e.deltaY; applyView(); }
  }, { passive: false });
  box.addEventListener("dblclick", (e) => { const [x, y] = rel(e); zoomAt(x, y, 1.7, true); });
}

/* ---------- bottom sheet ---------- */
function placeSheet() {
  const sh = $("#sheet");
  if (wide()) { sh.style.height = ""; sh.style.transform = ""; return; }
  const h = stageH(), full = h * SNAPS[2];
  sh.style.height = full + "px";
  sh.style.transform = `translateY(${full - h * frac()}px)`;
}
function setSnap(i) { S.snap = Math.max(0, Math.min(2, i)); sizeGallery(); placeSheet(); renderMap(); if (S.detail) setTimeout(() => focusBooth(S.detail.space), 60); }
function initSheetDrag() {
  const grab = $("#grab"), sh = $("#sheet"); let y0 = 0, t0 = 0, start = 0, moved = false, id = null;
  grab.addEventListener("pointerdown", (e) => {
    if (wide() || e.target.closest("button,input,select,a")) return;
    id = e.pointerId; grab.setPointerCapture(id); y0 = e.clientY; t0 = performance.now(); moved = false;
    const h = stageH(); start = h * SNAPS[2] - h * frac(); sh.classList.add("dragging");
  });
  grab.addEventListener("pointermove", (e) => {
    if (e.pointerId !== id) return; const dy = e.clientY - y0; if (Math.abs(dy) > 4) moved = true;
    const h = stageH(), max = h * SNAPS[2] - h * SNAPS[0] + 20;
    sh.style.transform = `translateY(${Math.max(-10, Math.min(max, start + dy))}px)`;
  });
  const end = (e) => {
    if (e.pointerId !== id) return; id = null; sh.classList.remove("dragging");
    const dy = e.clientY - y0, v = dy / Math.max(1, performance.now() - t0), h = stageH();
    if (!moved) { setSnap(S.snap === 2 ? 0 : S.snap + 1); return; }
    if (v > .5) return setSnap(S.snap - 1);
    if (v < -.5) return setSnap(S.snap + 1);
    const vis = (h * SNAPS[2] - (start + dy)) / h;
    let best = 0; [0, 1, 2].forEach((i) => { if (Math.abs(frac(i) - vis) < Math.abs(frac(best) - vis)) best = i; }); setSnap(best);
  };
  grab.addEventListener("pointerup", end); grab.addEventListener("pointercancel", end);
}

/* ---------- actions ---------- */
/* 共有：出展者ごとのページ e/<id>/ を共有する（SNS ではそのブースの地図カードがプレビューに出る） */
const shareUrl = (e) => new URL(`e/${encodeURIComponent(e.id)}/`, location.href.replace(/[?#].*$/, "")).href;
const shareText = (e) => `${e.name}（スペース${e.space || "—"}）｜${DATA?.event?.siteTitle || document.title}`;
const postUrl = (e) => `https://x.com/intent/post?text=${encodeURIComponent(shareText(e))}&url=${encodeURIComponent(shareUrl(e))}`;
function share(e) { navigator.share({ title: shareText(e), text: shareText(e), url: shareUrl(e) }).catch(() => {}); }
function copyLink(e, btn) {
  const done = (msg) => { btn.textContent = msg; setTimeout(() => (btn.textContent = "リンクをコピー"), 1600); };
  try { navigator.clipboard.writeText(shareUrl(e)).then(() => done("コピーしました"), () => prompt("このリンクをコピーしてください", shareUrl(e))); }
  catch { prompt("このリンクをコピーしてください", shareUrl(e)); }
}
// 開いている出展者を URL（?e=<id>）に残す。再読み込みやアドレスバーからのコピーでも同じ出展者が開く
function syncUrl() {
  try { const u = new URL(location.href); S.detail && !S.detail.vacant ? u.searchParams.set("e", S.detail.id) : u.searchParams.delete("e"); history.replaceState(null, "", u); } catch {}
}

function openDetail(e, fromMap, src) {
  if (!e.vacant) { count(`d:${e.id}`); count(`dh:${e.id}:${dayPart()}`); count(`from:${src || (fromMap ? "map" : "list")}`); }
  S.mode = "detail"; S.detail = e; syncUrl(); renderSheet(); if (!wide()) S.snap = 1; sizeGallery(); placeSheet(); renderMap(); setTimeout(() => focusBooth(e.space), fromMap ? 0 : 80); }
function backToList() { S.mode = "list"; S.detail = null; syncUrl(); renderSheet(); placeSheet(); renderMap(); }
function toggleFav(id) { count(`${favs.has(id) ? "f-" : "f+"}:${id}`); favs.has(id) ? favs.delete(id) : favs.add(id); store.set("bn_favs", [...favs]); renderSheet(); renderMap(); }
function rerender() { renderSheet(); renderMap(); }

function bindEvents() {
  document.addEventListener("click", (ev) => {
    const t = ev.target;
    const fav = t.closest("[data-fav]"); if (fav) { ev.stopPropagation(); toggleFav(fav.dataset.fav); return; }
    const chip = t.closest(".chip"); if (chip) { const g = chip.dataset.tag; S.tags.has(g) ? S.tags.delete(g) : (S.tags.add(g), count(`t:${g}`)); rerender(); if (filtering() && !visible().length) count("zero"); return; }
    const sc = t.closest("[data-scope]"); if (sc) { S.scope = sc.dataset.scope; if (S.scope === "fav") count("scope:fav"); rerender(); return; }
    const card = t.closest(".card"); if (card) { openDetail(X.find((e) => e.id === card.dataset.id)); return; }
    const booth = t.closest(".booth[data-space]"); if (booth) { if (ev.detail === 0) boothTapped(booth.dataset.space); return; } // pointer taps go through the map gestures
    if (t.closest("#back")) { backToList(); return; }
    const pgb = t.closest("[data-page]"); if (pgb && S.detail) { openLightbox(S.detail, +pgb.dataset.page); return; }
    if (t.closest("#d-fav")) { toggleFav(S.detail.id); return; }
    if (t.closest("#d-share")) { count(`s:${S.detail.id}`); share(S.detail); return; }
    if (t.closest("#d-copy")) { count(`s:${S.detail.id}`); copyLink(S.detail, t.closest("#d-copy")); return; }
    if (t.closest("#d-post")) { count(`s:${S.detail.id}`); return; }
    if (t.closest("#d-map")) { if (!wide()) setSnap(0); else focusBooth(S.detail.space); return; }
    const cat = t.closest("[data-cat]"); if (cat) { S.openCat = S.openCat === cat.dataset.cat ? null : cat.dataset.cat; renderSheet(); return; }
    if (t.closest("#b-sort")) { S.sort = S.sort === "shuffle" ? "space" : "shuffle"; store.set("bn_sort", S.sort); count(`sort:${S.sort}`); renderSheet(); return; }
    if (t.closest("#b-search")) { S.searchOpen = !(S.searchOpen || S.q); if (!S.searchOpen) S.q = ""; rerender(); if (S.searchOpen) $("#q")?.focus(); return; }
    if (t.closest("#clear")) { S.tags.clear(); S.q = ""; rerender(); return; }
    if (t.closest("#b-proj")) { S.proj = S.proj === "iso" ? "flat" : "iso"; store.set("bn_proj", S.proj); count(`proj:${S.proj}`); $("#b-proj").textContent = S.proj === "iso" ? "平面" : "立体"; renderMap(); return; }
    if (t.closest("#b-help")) { openHelp(); return; }
    if (t.closest("[data-help-close]")) { closeHelp(); return; }
    if (t.closest("#copyMail")) { copyMail(t.closest("#copyMail")); return; }
    const cs = t.closest("[data-consent]"); if (cs) { setConsent(cs.dataset.consent === "yes"); return; }
    if (t.closest("[data-consent-more]")) { openHelp("policy"); return; }
  });
  document.addEventListener("input", (ev) => {
    if (ev.target.id === "q") { if (!S.q.trim() && ev.target.value.trim()) count("q"); S.q = ev.target.value; renderSheet(); renderMap(); }
  });
  document.addEventListener("keydown", (ev) => {
    if ((ev.key === "Enter" || ev.key === " ") && ev.target.matches(".card,.booth[data-space]")) { ev.preventDefault(); ev.target.click(); }
    if (ev.key === "Escape" && !$("#help").hidden) { closeHelp(); return; }
    if (ev.key === "Escape" && $(".consent")) return;
    if (ev.key === "Escape" && S.mode === "detail" && !document.querySelector(".lb")) backToList();
  });
  let rt; window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => { placeSheet(); renderMap(); sizeGallery(); }, 120); });
  // the browser must never scroll the app shell itself (it would push the map off screen)
  ["#stage", ".app"].forEach((s) => { const el = $(s); el.addEventListener("scroll", () => { el.scrollTop = 0; el.scrollLeft = 0; }); });
}


/* ---------- アクセス解析 ----------
 * 同意した人だけ。操作の回数を端末（localStorage の bn_q）で数えておき、画面が隠れたとき
 * （ホーム画面に戻る・アプリやタブの切り替え・画面ロック）に、前回から30分以上たっていればまとめて送る。
 * 送れなかった分は残り、次の機会に送る。端末を見分ける番号は付けない。
 * 送り先は config.json の analytics.endpoint（Cloudflare Workers、worker/analytics.js）。空なら何もしない。 */
const AN = { url: "", on: false, ld: 0 }, SEND_GAP = 30 * 60 * 1000;
function count(k) {
  if (!AN.on) return;
  const q = store.get("bn_q", {}); q[k] = (q[k] || 0) + 1; store.set("bn_q", q);
}
// 日本時間で、開催前／当日の午前・昼・午後のどれか
function dayPart() {
  const j = new Date(Date.now() + 9 * 3600e3), day = j.toISOString().slice(0, 10), h = j.getUTCHours(), start = DATA?.event?.start || "";
  return start && day < start ? "pre" : h < 12 ? "am" : h < 14 ? "mid" : "pm";
}
function flush(force) {
  if (!AN.on || !navigator.sendBeacon) return;
  const q = store.get("bn_q", {}), keys = Object.keys(q);
  if (!keys.length || (!force && Date.now() - store.get("bn_qt", 0) < SEND_GAP)) return;
  const left = {};
  for (let i = 0; i < keys.length; i += 150) { // 1回に送る量を小さく保つ
    const part = Object.fromEntries(keys.slice(i, i + 150).map((k) => [k, q[k]]));
    if (!navigator.sendBeacon(AN.url, new Blob([JSON.stringify(part)], { type: "text/plain" }))) Object.assign(left, part);
  }
  // 送っている間に増えた分も残す
  const now = store.get("bn_q", {}); for (const k of Object.keys(now)) if (now[k] !== q[k]) left[k] = (left[k] || 0) + now[k] - (q[k] || 0);
  store.set("bn_q", left); store.set("bn_qt", Date.now());
}
function startAnalytics() {
  if (!AN.on) return;
  count("pv"); count(`h:${new Date(Date.now() + 9 * 3600e3).getUTCHours()}`);
  count(`ld:${AN.ld}`);
  flush(false);
}
function setConsent(yes) {
  store.set("bn_consent", yes ? "yes" : "no");
  const was = AN.on; AN.on = yes && !!AN.url;
  if (!yes) { store.set("bn_q", {}); }
  $(".consent")?.remove();
  if (AN.on && !was) startAnalytics();
  if (!$("#help").hidden) renderHelp();
}
function initAnalytics() {
  AN.url = /^https:\/\//.test(DATA?.analytics?.endpoint || "") ? DATA.analytics.endpoint : "";
  if (!AN.url) return;
  // ページを開いてから地図と一覧が出るまでの秒数。同意のお知らせを読む時間は含めない
  AN.ld = Math.min(30, Math.round(performance.now() / 1000));
  const c = store.get("bn_consent", null);
  AN.on = c === "yes";
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(false); });
  window.addEventListener("pagehide", () => flush(false));
  document.addEventListener("error", (ev) => { if (ev.target?.tagName === "IMG") count("imgerr"); }, true);
  if (c == null) showConsent(); else startAnalytics();
}
function showConsent() {
  const d = document.createElement("div");
  d.className = "consent";
  d.innerHTML = `<div class="consent-scrim"></div><section class="consent-card" role="dialog" aria-modal="true" aria-labelledby="cs-t" tabindex="-1">
    <h2 id="cs-t">出展者支援のためのご協力のお願い</h2>
    <p>本サイトでは、各お品書きの閲覧回数やお気に入り登録数を集計し、イベント終了後に出展者の皆さまへお届けしています。今後の制作・頒布活動の参考としていただくためのものです。氏名・連絡先・位置情報など、個人を特定できる情報は取得いたしません。</p>
    <div class="consent-btns"><button type="button" class="btn alt" data-consent="no">協力しない</button><button type="button" class="btn" data-consent="yes">協力する</button></div>
    <p class="consent-note">ご協力いただけない場合も、本サイトの機能はすべてご利用いただけます。設定は「？」メニューからいつでも変更できます。<br><button type="button" class="linkish" data-consent-more>データの取り扱いについて</button></p>
  </section>`;
  document.body.appendChild(d);
  requestAnimationFrame(() => requestAnimationFrame(() => d.classList.add("open")));
  d.querySelector(".consent-card").focus({ preventScroll: true });
}
const POLICY = `<div class="policy-body">
<p>KUA StuHUB（非公式）（以下「当団体」といいます）は、当団体が運営する「大瓜生山祭 物販ナビ（非公式）」（以下「本サイト」といいます）における閲覧状況に関する情報（以下「統計情報」といいます）の取り扱いについて、以下のとおり定めます。</p>
<h4>第1条（取得する情報）</h4><p>当団体は、利用者が本サイト上で統計情報の取得に同意した場合に限り、次の情報を取得します。</p>
<ol><li>各出展者の詳細情報およびお品書き画像の表示回数</li><li>各出展者のお気に入り登録および解除の回数、ならびに共有機能の利用回数</li><li>絞り込み・検索・並び替え等の機能の利用回数（検索語句は含みません）、出展者情報の表示元（地図、一覧または共有リンク）、閲覧した時間帯、ページの表示に要した時間、および画像の読み込みに失敗した回数</li></ol>
<h4>第2条（取得しない情報）</h4><p>当団体は、氏名、連絡先、位置情報、検索語句その他利用者個人を特定できる情報、および端末を識別する情報を取得しません。お気に入りの登録内容は、利用者の端末内にのみ保存され、当団体に送信されません。</p>
<h4>第3条（利用目的）</h4><p>当団体は、統計情報を次の目的のために利用します。</p><ol><li>各出展者に対する、当該出展者に係る集計結果の提供</li><li>本サイトの利用状況の把握および改善</li><li>当団体の活動記録の作成</li></ol>
<h4>第4条（第三者提供）</h4><p>当団体は、前条第1号に定める場合を除き、統計情報を第三者に提供しません。また、出展者ごとの集計結果の順位付けその他の比較情報を公開しません。</p>
<h4>第5条（外部サービスの利用）</h4><p>当団体は、統計情報の受信および保存にあたり、Cloudflare, Inc.（米国）が提供するサービスを利用します。通信の性質上、送信元の IP アドレスが同社のサーバーに送信されますが、当団体はこれを保存しません。</p>
<h4>第6条（保存期間）</h4><p>当団体は、取得した統計情報を2026年12月31日までに削除し、以後は集計後の数値のみを保持します。</p>
<h4>第7条（同意の撤回）</h4><p>利用者は、「？」メニューから設定を変更することにより、いつでも同意を撤回することができます。撤回後、当団体は当該端末から統計情報を取得しません。</p>
<h4>第8条（改定）</h4><p>当団体は、必要に応じて本規定を改定することがあります。改定後の内容は、本サイトに掲載した時点から効力を生じるものとします。</p>
<h4>第9条（お問い合わせ）</h4><p>本規定に関するお問い合わせは、kua.stuhub@gmail.com までご連絡ください。</p>
<p class="policy-date">制定日：2026年10月</p></div>`;

/* ---------- help modal: how to use + contact ---------- */
let helpReturn = null;
function renderHelp() {
  const C = DATA?.contact || {}, org = DATA?.org?.name || "", form = DATA?.form?.url;
  const updated = DATA ? new Date(DATA.generatedAt).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
  const row = (g, text) => `<li><span class="g">${g}</span><span>${text}</span></li>`;
  $("#helpBody").innerHTML = `
    <h3>地図</h3>
    <ul class="help-list">
      ${row("ドラッグ", "地図を動かす")}
      ${row("2本指", "広げて拡大、つまんで縮小")}
      ${row("ダブルタップ", "その場所を拡大")}
      ${row("タップ", "スペースを押すと、そのサークルの詳細が開きます")}
      ${row("平面／立体", "右上のボタンで、地図の見え方を切り替え")}
    </ul>
    <h3>お問い合わせ</h3>
    <div class="help-contact">
      ${org ? `<div class="org">運営：${esc(org)}</div>` : ""}
      <p>掲載内容の修正・削除、そのほかのお問い合わせはこちらへ。修正・削除は、掲載時の連絡先で本人確認をしてから対応します。</p>
      ${C.email ? `<div class="mailrow"><span class="addr" id="mailAddr">${esc(C.email)}</span><button type="button" id="copyMail">コピー</button></div>` : ""}
      ${C.url ? `<p><a href="${esc(safeUrl(C.url))}" target="_blank" rel="noopener">${esc(C.label || C.url)}</a></p>` : ""}
    </div>
    ${AN.url ? `<h3 id="policy">データの取り扱い</h3>
    <div class="help-contact">
      <p>出展者支援のための集計：<b>${AN.on ? "協力しています" : "協力していません"}</b></p>
      <button type="button" class="btn alt" data-consent="${AN.on ? "no" : "yes"}">${AN.on ? "協力をやめる" : "協力する"}</button>
      <details class="policy" id="policyText"><summary>データの取り扱いについて</summary>${POLICY}</details>
    </div>` : ""}
    ${form ? `<h3>出展者の方へ</h3><a class="help-form" href="${esc(safeUrl(form))}" target="_blank" rel="noopener">掲載フォームを開く ›</a>` : ""}
    <p class="help-note">有志による非公式の取り組みです。大学・学園祭実行委員会・物販イベント主催とは関係ありません。${updated ? `<br>最終更新 ${esc(updated)}` : ""}</p>`;
}
function openHelp(section) {
  helpReturn = document.activeElement; renderHelp(); count("help");
  const h = $("#help"); h.hidden = false;
  requestAnimationFrame(() => requestAnimationFrame(() => h.classList.add("open")));
  $("#help .help-card").focus({ preventScroll: true });
  if (section === "policy" && $("#policyText")) { $("#policyText").open = true; $("#policy").scrollIntoView(); }
}
function closeHelp() {
  const h = $("#help"); if (h.hidden) return;
  h.classList.remove("open");
  setTimeout(() => { h.hidden = true; helpReturn?.focus?.(); }, matchMedia("(prefers-reduced-motion:reduce)").matches ? 0 : 230);
}
function copyMail(btn) {
  const addr = $("#mailAddr")?.textContent || "";
  const done = () => { btn.textContent = "コピーしました"; setTimeout(() => (btn.textContent = "コピー"), 1600); };
  const fallback = () => { const r = document.createRange(); r.selectNodeContents($("#mailAddr")); const s = getSelection(); s.removeAllRanges(); s.addRange(r); btn.textContent = "選択しました"; setTimeout(() => (btn.textContent = "コピー"), 1600); };
  try { navigator.clipboard.writeText(addr).then(done, fallback); } catch { fallback(); }
}

/* ---------- boot ---------- */
async function boot() {
  bindEvents(); initMapGestures(); initSheetDrag();
  $("#b-proj").textContent = S.proj === "iso" ? "平面" : "立体";
  placeSheet();
  try {
    const [data, layout] = await Promise.all([
      fetch("data.json", { cache: "no-cache" }).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); }),
      fetch("layout.json").then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); }),
    ]);
    DATA = data; ROOMS = layout.rooms; B = layout.booths; X = data.exhibitors; CATS = data.categories;
    known = new Set(CATS.flatMap((c) => c.tags));
    bySpace = {}; X.forEach((e) => { if (e.space) (bySpace[e.space] ||= []).push(e); });
    $("#sampleBar").hidden = data.mode !== "sample";
    // forget favourites of exhibitors that are no longer listed
    favs = new Set([...favs].filter((id) => X.some((e) => e.id === id)));
  } catch (err) {
    $("#sbody").innerHTML = `<p class="loading">出展者の情報を読み込めませんでした。<br>電波の良いところで、ページを再読み込みしてください。</p>`;
    return;
  }
  renderSheet(); placeSheet(); renderMap();
  // 共有リンク（?e=<id>）から来たら、その出展者を開く。もう掲載されていなければ一覧のまま
  const want = new URLSearchParams(location.search).get("e"), hit = want && X.find((e) => e.id === want);
  initAnalytics();
  if (hit) openDetail(hit, false, "link"); else if (want) syncUrl();
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
