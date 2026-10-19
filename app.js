'use strict';
/* MathScan — المرحلة 1: مكتبة كتب + تحويل صور الصفحات إلى HTML رياضي عبر Gemini (مجاني) */

const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------------- الإعدادات ---------------- */
const DEF = { key: '', model: 'gemini-3.1-flash-lite', gap: 7, school: '', teacher: 'Prof : Sadiki Choukri',
  fallback: true, lang: 'auto', res: 2600, figs: true, enh: true, autoRun: true, autoShot: true, sound: true,
  font: 'm', frames: true, scan: true };
let S = { ...DEF };
try { S = { ...DEF, ...JSON.parse(localStorage.getItem('ms-settings') || '{}') }; } catch (e) {}
function saveSettings() { try { localStorage.setItem('ms-settings', JSON.stringify(S)); } catch (e) {} }

/* ---------------- قاعدة البيانات (IndexedDB) ---------------- */
const DB = (() => {
  let db;
  const open = () => new Promise((res, rej) => {
    const r = indexedDB.open('mathscan', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('books', { keyPath: 'id' });
      d.createObjectStore('pages', { keyPath: 'id' }).createIndex('book', 'bookId');
    };
    r.onsuccess = () => { db = r.result; res(); };
    r.onerror = () => rej(r.error);
  });
  const tx = (store, mode, fn) => new Promise((res, rej) => {
    const t = db.transaction(store, mode); let out;
    const q = fn(t.objectStore(store));
    if (q) q.onsuccess = () => { out = q.result; };
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
  return {
    open,
    all: s => tx(s, 'readonly', st => st.getAll()),
    put: (s, v) => tx(s, 'readwrite', st => st.put(v)),
    del: (s, k) => tx(s, 'readwrite', st => st.delete(k)),
    pagesOf: b => tx('pages', 'readonly', st => st.index('book').getAll(b)),
  };
})();
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/* ---------------- الحالة ---------------- */
let books = [], cur = null, pages = [], running = false, nextAt = 0, wakeLock = null, editing = null;
const thumbs = new Map();
const thumb = p => { if (!thumbs.has(p.id)) thumbs.set(p.id, URL.createObjectURL(p.blob)); return thumbs.get(p.id); };
const dropThumb = p => { if (thumbs.has(p.id)) { URL.revokeObjectURL(thumbs.get(p.id)); thumbs.delete(p.id); } };

/* ---------------- تنظيف HTML الوارد ---------------- */
const OK = new Set(['H2', 'H3', 'P', 'STRONG', 'EM', 'B', 'I', 'OL', 'UL', 'LI', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'BR', 'HR', 'DIV', 'SPAN', 'SUP', 'SUB']);
function clean(html) {
  html = String(html || '').replace(/^\s*```[a-z]*\s*/i, '').replace(/```\s*$/, '');
  const doc = new DOMParser().parseFromString('<div>' + html + '</div>', 'text/html');
  const root = doc.body.firstChild;
  const walk = n => {
    for (const c of [...n.children]) {
      if (/^(SCRIPT|STYLE|IFRAME|OBJECT|EMBED|TEMPLATE)$/.test(c.tagName)) { c.remove(); continue; }
      if (!OK.has(c.tagName)) { c.replaceWith(...c.childNodes); return walk(n); }
      const isFig = c.tagName === 'DIV' && c.getAttribute('class') === 'fig';
      const isBox = c.tagName === 'DIV' && c.getAttribute('class') === 'box';
      const box = isFig ? c.getAttribute('data-box') : null, fid = isFig ? c.getAttribute('data-fig') : null;
      for (const a of [...c.attributes]) if (!['colspan', 'rowspan'].includes(a.name)) c.removeAttribute(a.name);
      if (isBox) c.className = 'box';
      if (isFig) {
        c.className = 'fig';
        if (fid && /^f\d{1,3}$/.test(fid)) c.setAttribute('data-fig', fid);
        else if (box && /^\s*[\d.]+(\s*[ ,]\s*[\d.]+){3}\s*$/.test(box)) c.setAttribute('data-box', box.trim());
      }
      if (/^(P|H2|H3|LI|TD|TH|DIV)$/.test(c.tagName)) c.setAttribute('dir', 'auto');
      walk(c);
    }
  };
  walk(root);
  return root.innerHTML.trim();
}

/* ---------------- Gemini ---------------- */
function buildPrompt() {
  const LANG = { ar: '- The page is mainly in Arabic (right-to-left). Keep Arabic text exactly; math stays in LaTeX.\n', fr: '- The page is in French.\n', mix: '- The page mixes Arabic and French: keep each part in its own language.\n' }[S.lang] || '';
  const FIG = S.figs ? '' : '- For figures, do NOT give data-box; just <div class="fig">شكل: description</div>.\n';
  return `You are transcribing ONE scanned page of a school math textbook or worksheet into clean HTML.
Rules:
- Transcribe faithfully, in the page's own language(s) (Arabic and/or French). Do not translate, solve, summarize or add anything.
- Output ONLY an HTML fragment. No <html>, <body>, no Markdown, no code fences, no comments.
- Allowed tags: h2, h3, p, strong, em, ol, ul, li, table, thead, tbody, tr, th, td, br, <div class="fig"> and <div class="box">.
- Every mathematical expression is LaTeX: inline as \\( ... \\), standalone lines as \\[ ... \\]. Use \\dfrac, \\sqrt, \\times, \\overrightarrow, \\widehat etc. as needed.
- Exercise titles (Exercice 1, التمرين 1, ...) as <h3>. Numbered questions as <ol><li>.
- Figures, graphs, geometric drawings, number lines, tables printed as pictures: <div class="fig" data-box="ymin xmin ymax xmax">شكل: one-line description</div>, placed where the figure appears in reading order. The four numbers are the figure's bounding box in the WHOLE image, normalized 0-1000, y first. The box must contain the whole figure with all its letters, labels and arrows, and nothing else. Do not box purely decorative images (banners, logos, background art).
- The photo may be rotated (sideways, upside-down) or taken at an angle: always read the page in its correct orientation. Figure boxes always refer to the image exactly as given.
- Text written vertically, diagonally, in the margins, or inside framed or coloured boxes (Rappel, Remarque, À retenir, Méthode, Attention, تذكير, ملاحظة, خاصية...) is transcribed at its logical place. A framed box becomes <div class="box">...</div>.
- The FIRST line of your answer is the page number printed on the page: PAGE: 18 (two facing pages: PAGE: 18-19; none visible: PAGE: ?).
- The SECOND line is the clockwise rotation needed to make the photo upright: ROTATE: 0 (or 90, 180, 270). Then the HTML.
- Decimal comma inside LaTeX is written {,} : \\(7{,}5 \\times 10^{4}\\).
- If the photo shows two facing pages, transcribe the LEFT page completely first, then <hr>, then the RIGHT page. Never move content between pages, boxes or activities.
- Keep every exercise/activity title and every numbering exactly as printed (1., 2., a., b., c.). Keep the QCM options a., b., c. with their exact content.
- Read small exponents, fractions, signs and indices carefully. If something is unreadable, write [?] instead of guessing.
- Skip running headers, footers and decorations (the page number goes only in the PAGE line).
${LANG}${FIG}The image is the page.`;
}

const toB64 = blob => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(',')[1]);
  r.onerror = () => rej(r.error);
  r.readAsDataURL(blob);
});

async function gemini(parts, model = S.model) {
  if (!S.key) throw { kind: 'auth', msg: 'لا يوجد مفتاح Gemini. أضفه من «الإعدادات».' };
  let r;
  try {
    r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': S.key },
      body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { temperature: 0.1 } }),
    });
  } catch (e) { throw { kind: 'transient', msg: 'لا يوجد اتصال بالإنترنت.' }; }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const m = (j.error && j.error.message) || '';
    const all = JSON.stringify(j);
    if (r.status === 429) {
      if (/PerDay|per day|daily/i.test(all)) throw { kind: 'daily', msg: 'انتهى الحد اليومي المجاني. أكمل غداً (بعد الثامنة صباحاً تقريباً)، وسيتابع من حيث توقف.' };
      throw { kind: 'rate', msg: 'طلبات كثيرة في الدقيقة. سأنتظر دقيقة ثم أتابع.' };
    }
    if (r.status === 403 || (r.status === 400 && /API key|API_KEY/i.test(all))) throw { kind: 'auth', msg: 'مفتاح Gemini غير صالح. تحقق منه في «الإعدادات».' };
    if (r.status === 404) throw { kind: 'auth', notFound: true, msg: `النموذج «${model}» غير متاح لحسابك. اختر نموذجاً آخر في «الإعدادات».` };
    if (r.status >= 500) throw { kind: 'transient', msg: `خادم Gemini مشغول أو غير متاح (${r.status})` + (m ? ': ' + m.slice(0, 160) : '.') };
    throw { kind: 'fail', msg: m || ('خطأ ' + r.status) };
  }
  const c = j.candidates && j.candidates[0];
  const t = c && c.content && c.content.parts ? c.content.parts.map(p => p.text || '').join('') : '';
  if (!t.trim()) throw { kind: 'fail', msg: 'لم يُستخرج نص' + (c && c.finishReason ? ` (${c.finishReason})` : '') + '.' };
  return t;
}
/* نموذج احتياطي: إذا كان النموذج المختار مشغولاً أو انتهى حدّه اليومي، نجرّب الآخرين.
   لكل نموذج حدّه اليومي الخاص في الحساب نفسه. */
const MODELS = ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemini-3.8-flash'];
let dailyOut = {};
try { const d = JSON.parse(localStorage.getItem('ms-daily') || '{}'); if (Date.now() - (d.t || 0) < 12 * 3600e3) dailyOut = d.m || {}; } catch (e) {}
function markDaily(m) { dailyOut[m] = 1; try { localStorage.setItem('ms-daily', JSON.stringify({ t: Date.now(), m: dailyOut })); } catch (e) {} }
async function convertPage(p) {
  const parts = [{ text: buildPrompt() }, { inline_data: { mime_type: 'image/jpeg', data: await toB64(p.blob) } }];
  const order = (S.fallback ? [S.model, ...MODELS.filter(m => m !== S.model)] : [S.model]).filter(m => !dailyOut[m]);
  if (!order.length) throw { kind: 'daily', msg: 'انتهى الحد اليومي المجاني لكل النماذج. أكمل غداً (بعد الثامنة صباحاً تقريباً)، وسيتابع من حيث توقف.' };
  let last;
  for (const m of order) {
    try { const t = await gemini(parts, m); p.model = m; return t; }
    catch (e) {
      last = e;
      if (e.kind === 'daily') { markDaily(m); continue; }
      if (e.kind === 'transient' || (e.kind === 'auth' && e.notFound)) continue;
      throw e;
    }
  }
  if (last && last.kind === 'daily') last.msg = 'انتهى الحد اليومي المجاني لكل النماذج. أكمل غداً (بعد الثامنة صباحاً تقريباً)، وسيتابع من حيث توقف.';
  throw last;
}

/* ---------------- رقم الصفحة والأشكال ---------------- */
function takePageNo(p, raw) {
  let t = String(raw).replace(/^\s*```[a-z]*\s*/i, '');
  p.rot = 0;
  for (let k = 0; k < 3; k++) {
    const m = t.match(/^\s*(PAGE|ROTATE)\s*:\s*([^\n<]*)\n?/i); if (!m) break;
    const v = m[2].trim();
    if (/^page$/i.test(m[1])) { if (v && v !== '?' && v.length <= 12) p.pageNo = v; }
    else { const r = parseInt(v, 10); if ([90, 180, 270].includes(r)) p.rot = r; }
    t = t.slice(m[0].length);
  }
  return t;
}
/* تدوير صورة بزاوية 90/180/270 في اتجاه عقارب الساعة */
async function rotateBlob(blob, deg) {
  const bmp = await createImageBitmap(blob).catch(() => null); if (!bmp) return blob;
  const c = document.createElement('canvas'), q = deg % 180 !== 0;
  c.width = q ? bmp.height : bmp.width; c.height = q ? bmp.width : bmp.height;
  const ctx = c.getContext('2d'); ctx.translate(c.width / 2, c.height / 2); ctx.rotate(deg * Math.PI / 180);
  ctx.drawImage(bmp, -bmp.width / 2, -bmp.height / 2); bmp.close && bmp.close();
  return await new Promise(r => c.toBlob(b => r(b || blob), 'image/jpeg', 0.92));
}
function enhance(ctx, w, h) {
  const d = ctx.getImageData(0, 0, w, h), a = d.data, hist = new Uint32Array(256), n = w * h;
  for (let i = 0; i < a.length; i += 4) hist[(a[i] * 299 + a[i + 1] * 587 + a[i + 2] * 114) / 1000 | 0]++;
  let acc = 0, lo = 0, hi = 255;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc <= n * 0.01) lo = v; if (acc >= n * 0.5) { hi = v; break; } }
  if (hi - lo < 40) return;
  const k = 255 / (hi - lo);
  for (let i = 0; i < a.length; i += 4) for (let j = 0; j < 3; j++) a[i + j] = Math.max(0, Math.min(255, (a[i + j] - lo) * k));
  ctx.putImageData(d, 0, 0);
}
async function cropFig(blob, nums) {
  let [y0, x0, y1, x1] = nums;
  const sc = Math.max(y0, x0, y1, x1) <= 1.001 ? 1 : 1000;
  [y0, x0, y1, x1] = [y0 / sc, x0 / sc, y1 / sc, x1 / sc];
  if (y1 < y0) [y0, y1] = [y1, y0]; if (x1 < x0) [x0, x1] = [x1, x0];
  const pad = 0.012; x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(1, x1 + pad); y1 = Math.min(1, y1 + pad);
  const bmp = await createImageBitmap(blob).catch(() => null); if (!bmp) return null;
  const sx = Math.round(x0 * bmp.width), sy = Math.round(y0 * bmp.height);
  const sw = Math.round((x1 - x0) * bmp.width), sh = Math.round((y1 - y0) * bmp.height);
  if (sw < 24 || sh < 24 || sw * sh > 0.9 * bmp.width * bmp.height) { bmp.close && bmp.close(); return null; }
  const c = document.createElement('canvas'); c.width = sw; c.height = sh;
  const ctx = c.getContext('2d'); ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, sw, sh); bmp.close && bmp.close();
  if (S.enh) try { enhance(ctx, sw, sh); } catch (e) {}
  return await new Promise(r => c.toBlob(r, 'image/jpeg', 0.92));
}
async function extractFigs(p, html) {
  const doc = new DOMParser().parseFromString('<div>' + html + '</div>', 'text/html'), root = doc.body.firstChild;
  p.figs = []; let k = 0;
  for (const el of root.querySelectorAll('div.fig[data-box]')) {
    const nums = el.getAttribute('data-box').split(/[\s,]+/).map(Number);
    el.removeAttribute('data-box');
    if (nums.length !== 4 || nums.some(isNaN)) continue;
    let b = await cropFig(p.blob, nums);
    if (b && p.rot) b = await rotateBlob(b, p.rot);
    if (b) { const id = 'f' + (++k); p.figs.push({ id, blob: b }); el.setAttribute('data-fig', id); }
  }
  return root.innerHTML.trim();
}
const figUrls = new Map();
function figUrl(p, f) { const key = p.id + '/' + f.id; if (!figUrls.has(key)) figUrls.set(key, URL.createObjectURL(f.blob)); return figUrls.get(key); }
async function figData(f) { return 'data:image/jpeg;base64,' + await toB64(f.blob); }
/* يستبدل كل إطار شكل مرتبط بصورته المقصوصة */
async function withFigs(p, html, inline) {
  if (!p.figs || !p.figs.length || html.indexOf('data-fig') < 0) return html;
  const doc = new DOMParser().parseFromString('<div>' + html + '</div>', 'text/html'), root = doc.body.firstChild;
  for (const el of root.querySelectorAll('div.fig[data-fig]')) {
    const f = p.figs.find(x => x.id === el.getAttribute('data-fig')); if (!f) continue;
    const fig = doc.createElement('figure'); fig.className = 'figc';
    const img = doc.createElement('img'); img.src = inline ? await figData(f) : figUrl(p, f); img.alt = el.textContent.trim();
    fig.appendChild(img); el.replaceWith(fig);
  }
  return root.innerHTML;
}
function pageLabel(p, i) { return p.pageNo ? 'الصفحة ' + p.pageNo : 'الصورة ' + (i + 1); }

/* ---------------- تصغير الصورة قبل الحفظ ---------------- */
async function shrink(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => null);
  if (!bmp) return file;
  const k = Math.min(1, (+S.res || 2600) / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close && bmp.close();
  return await new Promise(r => c.toBlob(b => r(b || file), 'image/jpeg', 0.9));
}

/* ---------------- المكتبة ---------------- */
async function loadBooks() {
  books = (await DB.all('books')).sort((a, b) => b.created - a.created);
  const allPages = await DB.all('pages');
  const box = $('books');
  if (!books.length) { box.innerHTML = '<div class="empty">لا توجد كتب بعد. اكتب اسم كتاب واضغط «إنشاء كتاب».</div>'; return; }
  box.innerHTML = books.map(b => {
    const ps = allPages.filter(p => p.bookId === b.id), d = ps.filter(p => p.status === 'done').length;
    return `<div class="book" data-id="${b.id}" tabindex="0" role="button">
      <div class="grow"><b>${esc(b.name)}</b><span class="note">${d} من ${ps.length} صفحة محوّلة</span>
      <div class="bar" style="margin-top:6px"><i style="width:${ps.length ? 100 * d / ps.length : 0}%"></i></div></div><span>←</span></div>`;
  }).join('');
}
$('books').addEventListener('click', e => { const b = e.target.closest('.book'); if (b) openBook(b.dataset.id); });
$('books').addEventListener('keydown', e => { const b = e.target.closest('.book'); if (b && e.key === 'Enter') openBook(b.dataset.id); });
$('addBook').onclick = async () => {
  const name = $('newName').value.trim() || 'كتاب بدون اسم';
  const b = { id: uid(), name, created: Date.now() };
  await DB.put('books', b); $('newName').value = '';
  await loadBooks(); openBook(b.id);
};

/* ---------------- عرض الكتاب ---------------- */
async function openBook(id) {
  cur = books.find(b => b.id === id); if (!cur) return;
  pages = (await DB.pagesOf(id)).sort((a, b) => a.idx - b.idx);
  for (const p of pages) if (p.status === 'run') { p.status = 'wait'; await DB.put('pages', p); }
  $('lib').hidden = true; $('bookView').hidden = false; $('back').hidden = false;
  $('title').textContent = cur.name;
  $('bookAlert').hidden = true;
  tab('pages'); listPages(); location.hash = 'b-' + id;
}
async function closeBook() {
  if (running) pause();
  cur = null; pages = []; thumbs.forEach(u => URL.revokeObjectURL(u)); thumbs.clear();
  $('lib').hidden = false; $('bookView').hidden = true; $('back').hidden = true;
  $('title').textContent = 'MathScan'; history.replaceState(null, '', location.pathname);
  loadBooks();
}
$('back').onclick = closeBook;

const LBL = { wait: 'في الانتظار', run: 'جارٍ…', done: 'جاهزة', err: 'خطأ' };
function listPages() {
  const box = $('pages');
  box.innerHTML = pages.length ? pages.map((p, i) => `<div class="pg" data-id="${p.id}" tabindex="0" role="button">
      <img src="${thumb(p)}" alt="صفحة ${i + 1}" loading="lazy">
      <div class="meta"><span>${p.pageNo ? 'ص ' + esc(p.pageNo) : 'صورة ' + (i + 1)}</span><span class="pill s-${p.status}">${LBL[p.status]}</span></div>
      ${p.err ? `<div class="note s-err" style="padding:0 8px 6px">${esc(p.err)}</div>` : ''}</div>`).join('')
    : '<div class="empty">أضف صور الصفحات بالترتيب، من المعرض أو بالتصوير المباشر.</div>';
  const d = pages.filter(p => p.status === 'done').length;
  $('prog').style.width = (pages.length ? 100 * d / pages.length : 0) + '%';
  const left = pages.filter(p => p.status === 'wait').length, errs = pages.filter(p => p.status === 'err').length;
  if (!running) $('status').textContent = pages.length ? `${d} من ${pages.length} جاهزة` + (left ? ` — ${left} في الانتظار` : '') + (errs ? ` — ${errs} بها خطأ` : '') : '';
  $('run').disabled = !(left || errs);
  if (!$('cam').hidden) camInfo();
  $('run').textContent = errs && !left ? 'إعادة الصفحات الخاطئة' : 'بدء التحويل';
}
$('pages').addEventListener('click', e => { const g = e.target.closest('.pg'); if (g) openPage(g.dataset.id); });
$('pages').addEventListener('keydown', e => { const g = e.target.closest('.pg'); if (g && e.key === 'Enter') openPage(g.dataset.id); });

async function addPage(blob) {
  const idx = pages.reduce((m, p) => Math.max(m, p.idx), 0) + 1;
  const p = { id: uid(), bookId: cur.id, idx, blob, status: 'wait', html: '', err: '' };
  await DB.put('pages', p); pages.push(p);
  return p;
}
function autoRun() { if (S.autoRun && S.key && !running) run(); }
async function addFiles(files) {
  if (!cur) return;
  files = [...files].filter(f => f.type.startsWith('image/'))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  for (const [i, f] of files.entries()) {
    if (!running) $('status').textContent = `تجهيز الصورة ${i + 1} من ${files.length}…`;
    await addPage(await shrink(f));
    listPages(); autoRun();
  }
}
$('pick').onchange = e => { addFiles(e.target.files); e.target.value = ''; };
$('shoot').onchange = e => { addFiles(e.target.files); e.target.value = ''; };

/* ---------------- طابور التحويل ---------------- */
function alertBook(msg, cls = '') { const a = $('bookAlert'); a.hidden = !msg; a.className = 'alert ' + cls; a.textContent = msg || ''; }
async function wake(on) {
  try {
    if (on && 'wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); }
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (e) {}
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && running) wake(true); });

async function run() {
  if (running || !cur) return;
  if (!S.key) { alertBook('أضف مفتاح Gemini أولاً من «الإعدادات».', 'err'); return; }
  if (!pages.some(p => p.status === 'wait')) for (const p of pages) if (p.status === 'err') { p.status = 'wait'; p.err = ''; await DB.put('pages', p); }
  running = true; alertBook(''); $('run').hidden = true; $('pause').hidden = false; wake(true);
  const book = cur;
  while (running && cur === book) {
    const p = pages.find(x => x.status === 'wait'); if (!p) break;
    let w = nextAt - Date.now();
    while (running && w > 0) { $('status').textContent = `الصفحة الموالية بعد ${Math.ceil(w / 1000)} ث…`; await sleep(Math.min(w, 1000)); w = nextAt - Date.now(); }
    if (!running) break;
    nextAt = Date.now() + Math.max(2, +S.gap || 7) * 1000;
    p.status = 'run'; listPages();
    $('status').textContent = `تحويل الصفحة ${pages.indexOf(p) + 1} من ${pages.length}…`;
    try {
      p.html = await extractFigs(p, clean(takePageNo(p, await convertPage(p))));
      if (p.rot) { p.blob = await rotateBlob(p.blob, p.rot); dropThumb(p); p.rot = 0; }
      p.status = 'done'; p.err = ''; p.tries = 0;
    } catch (e) {
      if (e.kind === 'daily' || e.kind === 'auth') { p.status = 'wait'; await DB.put('pages', p); alertBook(e.msg, e.kind === 'auth' ? 'err' : ''); break; }
      if (e.kind === 'rate') { p.status = 'wait'; nextAt = Date.now() + 60000; alertBook(e.msg); await DB.put('pages', p); continue; }
      p.tries = (p.tries || 0) + 1;
      if (e.kind === 'transient' && p.tries < 5) { p.status = 'wait'; nextAt = Date.now() + 30000 * p.tries; alertBook('خوادم Gemini مشغولة الآن (جرّبتُ كل النماذج). سأعيد المحاولة بعد قليل — المحاولة ' + p.tries + ' من 5.'); await DB.put('pages', p); continue; }
      p.status = 'err'; p.err = e.msg || 'خطأ غير معروف';
    }
    await DB.put('pages', p);
    if (cur === book) listPages();
  }
  running = false; wake(false);
  $('run').hidden = false; $('pause').hidden = true;
  if (cur === book) {
    listPages();
    if (!pages.some(p => p.status === 'wait') && pages.length && $('bookAlert').hidden)
      alertBook(pages.some(p => p.status === 'err') ? 'انتهى التحويل، وبعض الصفحات بها خطأ. اضغط «إعادة الصفحات الخاطئة».' : 'انتهى تحويل كل الصفحات. راجعها في «معاينة الكتاب».', 'ok');
  }
}
function pause() { running = false; $('status').textContent = 'تم الإيقاف المؤقت. اضغط «بدء التحويل» للمتابعة.'; }
$('run').onclick = run;
$('pause').onclick = pause;

/* ---------------- محرر الصفحة ---------------- */
let prevT;
async function typeset(el) { if (window.MathJax && MathJax.typesetPromise) { try { await MathJax.startup.promise; MathJax.typesetClear([el]); await MathJax.typesetPromise([el]); } catch (e) {} } }
function miniPreview() { clearTimeout(prevT); prevT = setTimeout(async () => { const el = $('pgPrev'); el.innerHTML = (await withFigs(editing, clean($('pgSrc').value), false)) || '<span class="note">لا يوجد نص بعد.</span>'; typeset(el); }, 350); }
function openPage(id) {
  editing = pages.find(p => p.id === id); if (!editing) return;
  const i = pages.indexOf(editing);
  $('pgTitle').textContent = `الصفحة ${i + 1} — ${LBL[editing.status]}` + (editing.model ? ` (${editing.model})` : '');
  $('pgImg').src = thumb(editing);
  $('pgSrc').value = editing.html || '';
  $('pgNo').value = editing.pageNo || '';
  $('pgRedo').disabled = running;
  miniPreview(); $('pageDlg').showModal();
}
$('pgSrc').addEventListener('input', miniPreview);
$('pgClose').onclick = () => $('pageDlg').close();
$('pgImg').onclick = () => window.open(thumb(editing), '_blank');
$('pgSave').onclick = async () => {
  editing.html = clean($('pgSrc').value);
  editing.pageNo = $('pgNo').value.trim().slice(0, 12);
  if (editing.html && editing.status !== 'run') { editing.status = 'done'; editing.err = ''; }
  await DB.put('pages', editing); $('pageDlg').close(); listPages();
};
$('pgRedo').onclick = async () => {
  editing.status = 'wait'; editing.err = ''; editing.tries = 0; await DB.put('pages', editing);
  $('pageDlg').close(); listPages(); run();
};
$('pgRot').onclick = async () => {
  editing.blob = await rotateBlob(editing.blob, 90); dropThumb(editing);
  await DB.put('pages', editing); $('pgImg').src = thumb(editing); listPages();
};
async function move(d) {
  const i = pages.indexOf(editing), j = i + d; if (j < 0 || j >= pages.length) return;
  [pages[i].idx, pages[j].idx] = [pages[j].idx, pages[i].idx];
  await DB.put('pages', pages[i]); await DB.put('pages', pages[j]);
  pages.sort((a, b) => a.idx - b.idx); listPages();
  $('pgTitle').textContent = `الصفحة ${pages.indexOf(editing) + 1} — ${LBL[editing.status]}`;
}
$('pgUp').onclick = () => move(-1);
$('pgDown').onclick = () => move(1);
$('pgDel').onclick = async () => {
  const b = $('pgDel');
  if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'تأكيد الحذف'; setTimeout(() => { b.dataset.armed = ''; b.textContent = 'حذف الصفحة'; }, 3000); return; }
  b.dataset.armed = ''; b.textContent = 'حذف الصفحة';
  await DB.del('pages', editing.id); pages = pages.filter(p => p !== editing);
  $('pageDlg').close(); listPages();
};

/* ---------------- المعاينة والتصدير ---------------- */
function tab(which) {
  $('tPages').setAttribute('aria-selected', which === 'pages'); $('tSheet').setAttribute('aria-selected', which === 'sheet');
  $('pagesPane').hidden = which !== 'pages'; $('sheetPane').hidden = which !== 'sheet';
  if (which === 'sheet') renderSheet();
}
$('tPages').onclick = () => tab('pages');
$('tSheet').onclick = () => tab('sheet');
$('pbk').onchange = renderSheet;

function splitAtHr(html) {
  const doc = new DOMParser().parseFromString('<div>' + html + '</div>', 'text/html'), root = doc.body.firstChild;
  const hr = [...root.children].find(c => c.tagName === 'HR'); if (!hr) return null;
  const left = [], right = []; let after = false;
  for (const n of [...root.childNodes]) { if (n === hr) { after = true; continue; } (after ? right : left).push(n.outerHTML ?? n.textContent); }
  const L = left.join('').trim(), R = right.join('').trim();
  return L && R ? [L, R] : null;
}
async function bodyHTML(pbHtml, inline) {
  const out = [];
  for (const [i, p] of pages.entries()) {
    if (p.status !== 'done' || !p.html) continue;
    const html = await withFigs(p, p.html, inline);
    /* صورة فيها صفحتان متقابلتان (PAGE: 18-19): إطار مستقل لكل صفحة */
    const two = String(p.pageNo || '').match(/^(\d+)\s*-\s*(\d+)$/);
    const parts = two ? splitAtHr(html) : null;
    const frames = parts ? [[parts[0], 'الصفحة ' + two[1]], [parts[1], 'الصفحة ' + two[2]]] : [[html, pageLabel(p, i)]];
    for (const [h, label] of frames) {
      out.push((out.length && $('pbk').checked ? pbHtml : '') + (S.frames
        ? `<section class="bp"><div class="bpc">${h}</div><div class="bpn">${esc(label)}</div></section>` : h));
    }
  }
  return out.join('\n');
}
function headHTML() {
  return `<div class="hd"><div dir="auto">${esc(S.school)}</div><div class="t" dir="auto">${esc(cur.name)}</div><div class="r" dir="auto">${esc(S.teacher)}</div></div>`;
}
async function renderSheet() {
  const el = $('sheet'); const body = await bodyHTML('<hr class="pb">', false);
  el.style.fontSize = FONT[S.font] || FONT.m;
  el.innerHTML = headHTML() + (body || '<p class="note">لا توجد صفحات محوّلة بعد.</p>');
  await typeset(el);
}
const FONT = { s: '14px', m: '15.5px', l: '17.5px' };
async function standalone(autoPrint) {
  const body = await bodyHTML('<div style="break-before:page"></div>', true);
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(cur.name)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Naskh+Arabic:wght@400;700&family=Lora:wght@400;600&display=swap">
<style>@page{size:A4;margin:14mm 13mm}body{font-family:"Noto Naskh Arabic","Lora",Georgia,serif;font-size:${FONT[S.font] || FONT.m};line-height:1.8;color:#111;max-width:184mm;margin:0 auto;padding:8px}
.hd{display:grid;grid-template-columns:1fr 1.3fr 1fr;gap:8px;border-bottom:1.5px solid #111;padding-bottom:6px;margin-bottom:14px;font-size:13.5px;align-items:end}.t{font-weight:700;font-size:17px;text-align:center}.r{text-align:left}
h2{font-size:18px}h3{font-size:16px;margin:14px 0 4px;text-decoration:underline;text-underline-offset:4px;break-after:avoid}p{margin:4px 0}ol,ul{margin:4px 0;padding-inline-start:26px}li{break-inside:avoid}
table{border-collapse:collapse;margin:8px auto}td,th{border:1px solid #333;padding:4px 10px;text-align:center}.fig{border:1px dashed #888;color:#555;padding:14px;margin:8px 0;text-align:center;font-size:13px}
.bp{border:1px solid #9aa;border-radius:6px;padding:10px 14px 4px;margin:10px 0}.bpn{text-align:center;font-size:12px;color:#555;border-top:1px dashed #bbb;margin-top:8px;padding-top:3px}
.figc{margin:8px auto;text-align:center;break-inside:avoid}.figc img{max-width:100%;max-height:120mm}
.box{border:1.5px solid #555;border-radius:8px;padding:6px 12px;margin:8px 0;background:#f5f6f7;break-inside:avoid}</style>
<script>window.MathJax={tex:{inlineMath:[['\\\\(','\\\\)'],['$','$']]}${autoPrint ? ",startup:{pageReady:()=>MathJax.startup.defaultPageReady().then(()=>setTimeout(()=>window.print(),500))}" : ''}};<\/script>
<script src="https://cdn.jsdelivr.net/npm/mathjax@3.2.2/es5/tex-chtml.js"><\/script></head><body>${headHTML()}${body}</body></html>`;
}
function fileName() { return (cur.name || 'book').replace(/[\\/:*?"<>|]+/g, '').trim().slice(0, 80) || 'book'; }
$('exportHtml').onclick = async () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([await standalone(false)], { type: 'text/html' }));
  a.download = fileName() + '.html'; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};
$('print').onclick = async () => {
  const w = window.open('', '_blank');
  if (!w) { alertBook('اسمح بفتح النوافذ المنبثقة لهذا الموقع، أو استعمل «تنزيل HTML».', 'err'); return; }
  w.document.write('<p style="font-family:sans-serif">جارٍ التحضير…</p>');
  const html = await standalone(true);
  w.document.open(); w.document.write(html); w.document.close();
};
$('delBook').onclick = async () => {
  const b = $('delBook');
  if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'تأكيد حذف الكتاب وكل صفحاته'; setTimeout(() => { b.dataset.armed = ''; b.textContent = 'حذف الكتاب'; }, 4000); return; }
  b.dataset.armed = ''; b.textContent = 'حذف الكتاب';
  if (running) pause();
  for (const p of pages) await DB.del('pages', p.id);
  await DB.del('books', cur.id); closeBook();
};

/* ---------------- الإعدادات ---------------- */
function setMsg(msg, cls = '') { const m = $('sMsg'); m.hidden = !msg; m.className = 'alert ' + cls; m.textContent = msg || ''; }
const FORM = { sKey: 'key', sModel: 'model', sGap: 'gap', sSchool: 'school', sTeacher: 'teacher', sLang: 'lang', sRes: 'res', sFont: 'font',
  sFallback: 'fallback', sFigs: 'figs', sEnh: 'enh', sAutoRun: 'autoRun', sAutoShot: 'autoShot', sSound: 'sound', sFrames: 'frames', sScan: 'scan' };
function readSettingsForm() {
  for (const [id, k] of Object.entries(FORM)) { const el = $(id); S[k] = el.type === 'checkbox' ? el.checked : el.value; }
  S.key = S.key.trim(); S.gap = Math.max(2, Math.min(120, +S.gap || 7)); S.res = +S.res || 2600;
  $('qAuto').checked = S.autoRun;
}
$('openSettings').onclick = () => {
  for (const [id, k] of Object.entries(FORM)) { const el = $(id); if (el.type === 'checkbox') el.checked = !!S[k]; else el.value = S[k]; }
  setMsg(''); $('setDlg').showModal();
};
$('qAuto').onchange = () => { S.autoRun = $('qAuto').checked; saveSettings(); if (S.autoRun) autoRun(); };
$('setClose').onclick = () => $('setDlg').close();
$('sShow').onclick = () => { const k = $('sKey'); k.type = k.type === 'password' ? 'text' : 'password'; $('sShow').textContent = k.type === 'password' ? 'إظهار' : 'إخفاء'; };
$('sSave').onclick = () => { readSettingsForm(); saveSettings(); $('nokey').hidden = !!S.key; setMsg('تم الحفظ.', 'ok'); if (cur && $('sheetPane').hidden === false) renderSheet(); };
$('sTest').onclick = async () => {
  readSettingsForm(); setMsg('جارٍ الاختبار…');
  try { await gemini([{ text: 'Reply with the single word: OK' }]); saveSettings(); $('nokey').hidden = true; setMsg('المفتاح يعمل مع ' + S.model + '. تم الحفظ.', 'ok'); }
  catch (e) { setMsg(e.msg || 'فشل الاختبار.', 'err'); }
};

/* ---------------- الكاميرا المباشرة ---------------- */
let camStream = null, camTimer = null, camBusy = false, audioCtx = null, camState = {}, lastShotUrl = '';
const sigCanvas = document.createElement('canvas'); sigCanvas.width = 32; sigCanvas.height = 24;
const sigCtx = sigCanvas.getContext('2d', { willReadFrequently: true });
function frameSig() {
  const v = $('camVid'); if (!v.videoWidth) return null;
  sigCtx.drawImage(v, 0, 0, 32, 24);
  const d = sigCtx.getImageData(0, 0, 32, 24).data, g = new Uint8Array(32 * 24);
  for (let i = 0; i < g.length; i++) g[i] = (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 3;
  return g;
}
const sigDiff = (a, b) => { let t = 0; for (let i = 0; i < a.length; i++) t += Math.abs(a[i] - b[i]); return t / a.length; };
function camHint(t) { $('camHint').textContent = t || ''; }
function camInfo() {
  const d = pages.filter(p => p.status === 'done').length, w = pages.filter(p => p.status === 'wait' || p.status === 'run').length;
  $('camInfo').innerHTML = `${pages.length} صفحة<br>${d} جاهزة` + (w ? `<br>${w} قيد التحويل` : '');
}
function beep() {
  if (!S.sound) return;
  try { navigator.vibrate && navigator.vibrate(50); } catch (e) {}
  try {
    if (!audioCtx) return; const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = 1100; g.gain.value = 0.15; o.connect(g); g.connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + 0.07);
  } catch (e) {}
}
async function openCam() {
  if (!cur) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { alertBook('الكاميرا المباشرة غير متاحة في هذا المتصفح. استعمل «صورة واحدة».', 'err'); return; }
  try {
    camStream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } } });
  } catch (e) { alertBook('لم يُسمح باستعمال الكاميرا. اسمح بها لهذا الموقع من إعدادات المتصفح ثم أعد المحاولة.', 'err'); return; }
  $('camVid').srcObject = camStream; $('cam').hidden = false; document.body.classList.add('noscroll');
  $('camAuto').checked = S.autoShot; wake(true);
  try {
    const tr = camStream.getVideoTracks()[0], caps = tr.getCapabilities ? tr.getCapabilities() : {};
    $('camTorch').hidden = !caps.torch; $('camTorch').dataset.on = '';
    if (caps.focusMode && caps.focusMode.includes('continuous')) tr.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
  } catch (e) {}
  try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume && audioCtx.resume(); } catch (e) {}
  camState = { prev: null, since: 0, lastSig: null, cool: Date.now() + 1500 };
  camTimer = setInterval(camTick, 250); camInfo(); camHint(S.autoShot ? 'ضع الصفحة أمام الكاميرا وثبّت الهاتف' : '');
  try { history.pushState({ cam: 1 }, ''); } catch (e) {}
}
function closeCam() {
  if ($('cam').hidden) return;
  clearInterval(camTimer); camTimer = null;
  if (camStream) camStream.getTracks().forEach(t => t.stop()); camStream = null;
  $('cam').hidden = true; document.body.classList.remove('noscroll');
  if (!running) wake(false); listPages();
}
window.addEventListener('popstate', () => closeCam());
$('openCam').onclick = openCam;
$('camClose').onclick = () => { closeCam(); try { if (history.state && history.state.cam) history.back(); } catch (e) {} };
$('camAuto').onchange = () => { S.autoShot = $('camAuto').checked; saveSettings(); camState.since = 0; camHint(S.autoShot ? 'ثبّت الهاتف فوق الصفحة' : ''); };
$('camTorch').onclick = () => {
  try { const on = !$('camTorch').dataset.on; camStream.getVideoTracks()[0].applyConstraints({ advanced: [{ torch: on }] }); $('camTorch').dataset.on = on ? '1' : ''; } catch (e) {}
};
function camTick() {
  const s = frameSig(); if (!s) return;
  const st = camState, now = Date.now(), motion = st.prev ? sigDiff(s, st.prev) : 255; st.prev = s;
  if (!$('camAuto').checked || camBusy || now < st.cool) return;
  if (motion < 5) {
    if (!st.since) st.since = now;
    if (st.lastSig && sigDiff(s, st.lastSig) < 12) { camHint('اقلب الصفحة…'); st.since = 0; return; }
    if (now - st.since > 1100) { st.lastSig = s; st.since = 0; capture(); }
    else camHint('ثبّت الهاتف…');
  } else { st.since = 0; camHint(''); }
}
async function capture() {
  const v = $('camVid'); if (camBusy || !v.videoWidth) return;
  camBusy = true;
  try {
    const k = Math.min(1, (+S.res || 2600) / Math.max(v.videoWidth, v.videoHeight));
    const c = document.createElement('canvas'); c.width = Math.round(v.videoWidth * k); c.height = Math.round(v.videoHeight * k);
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    const f = $('camFlash'); f.classList.add('on'); setTimeout(() => f.classList.remove('on'), 60); beep();
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
    if (lastShotUrl) URL.revokeObjectURL(lastShotUrl); lastShotUrl = URL.createObjectURL(blob); $('camLast').src = lastShotUrl;
    await addPage(blob); camHint('تم ✓ — اقلب الصفحة'); camInfo(); autoRun();
  } finally { camBusy = false; camState.cool = Date.now() + 1500; }
}
$('camShot').onclick = () => { camState.lastSig = frameSig(); capture(); };
$('camLast').onclick = () => { closeCam(); try { if (history.state && history.state.cam) history.back(); } catch (e) {} tab('pages'); };

/* ---------------- PDF من صور الصفحات ---------------- */
function loadScript(src) { return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('load')); document.head.appendChild(s); }); }
$('imgPdf').onclick = async () => {
  if (!pages.length) { alertBook('لا توجد صفحات بعد.', 'err'); return; }
  const b = $('imgPdf'); b.disabled = true;
  try {
    if (!window.jspdf) await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js');
    const { jsPDF } = window.jspdf; let doc = null;
    for (const [i, p] of pages.entries()) {
      b.textContent = `جارٍ إنشاء PDF… ${i + 1}/${pages.length}`;
      const bmp = await createImageBitmap(p.blob), w = bmp.width, h = bmp.height;
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const ctx = c.getContext('2d'); ctx.drawImage(bmp, 0, 0); bmp.close && bmp.close();
      if (S.scan) try { enhance(ctx, w, h); } catch (e) {}
      const land = w > h, pw = land ? 297 : 210, ph = land ? 210 : 297, m = 5;
      if (!doc) doc = new jsPDF({ orientation: land ? 'l' : 'p', unit: 'mm', format: 'a4', compress: true });
      else doc.addPage('a4', land ? 'l' : 'p');
      const sc = Math.min((pw - 2 * m) / w, (ph - 2 * m) / h), iw = w * sc, ih = h * sc;
      doc.addImage(c.toDataURL('image/jpeg', 0.85), 'JPEG', (pw - iw) / 2, (ph - ih) / 2, iw, ih);
      await sleep(0);
    }
    doc.save(fileName() + ' - صور.pdf');
    alertBook('تم إنشاء ملف PDF من ' + pages.length + ' صفحة.', 'ok');
  } catch (e) { alertBook('تعذّر إنشاء PDF. تحقق من الاتصال بالإنترنت ثم أعد المحاولة.', 'err'); }
  b.disabled = false; b.textContent = 'PDF من صور الصفحات';
};

/* ---------------- التشغيل ---------------- */
(async () => {
  $('nokey').hidden = !!S.key; $('qAuto').checked = S.autoRun;
  try { await DB.open(); } catch (e) { document.querySelector('.app').insertAdjacentHTML('beforeend', '<div class="alert err">تعذّر فتح التخزين في هذا المتصفح. لا تستعمل نافذة التصفح الخفي.</div>'); return; }
  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) {}
  await loadBooks();
  const m = location.hash.match(/^#b-(.+)$/); if (m) openBook(m[1]);
})();
