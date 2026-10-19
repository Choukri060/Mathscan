'use strict';
/* MathScan — المرحلة 1: مكتبة كتب + تحويل صور الصفحات إلى HTML رياضي عبر Gemini (مجاني) */

const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------------- الإعدادات ---------------- */
const DEF = { key: '', model: 'gemini-3.1-flash-lite', gap: 7, school: '', teacher: 'Prof : Sadiki Choukri' };
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

/* ---------------- تنظيف HTML الوارد ---------------- */
const OK = new Set(['H2', 'H3', 'P', 'STRONG', 'EM', 'B', 'I', 'OL', 'UL', 'LI', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'BR', 'DIV', 'SPAN', 'SUP', 'SUB']);
function clean(html) {
  html = String(html || '').replace(/^\s*```[a-z]*\s*/i, '').replace(/```\s*$/, '');
  const doc = new DOMParser().parseFromString('<div>' + html + '</div>', 'text/html');
  const root = doc.body.firstChild;
  const walk = n => {
    for (const c of [...n.children]) {
      if (/^(SCRIPT|STYLE|IFRAME|OBJECT|EMBED|TEMPLATE)$/.test(c.tagName)) { c.remove(); continue; }
      if (!OK.has(c.tagName)) { c.replaceWith(...c.childNodes); return walk(n); }
      const isFig = c.tagName === 'DIV' && c.getAttribute('class') === 'fig';
      for (const a of [...c.attributes]) if (!['colspan', 'rowspan'].includes(a.name)) c.removeAttribute(a.name);
      if (isFig) c.className = 'fig';
      if (/^(P|H2|H3|LI|TD|TH|DIV)$/.test(c.tagName)) c.setAttribute('dir', 'auto');
      walk(c);
    }
  };
  walk(root);
  return root.innerHTML.trim();
}

/* ---------------- Gemini ---------------- */
const PROMPT = `You are transcribing ONE scanned page of a school math textbook or worksheet into clean HTML.
Rules:
- Transcribe faithfully, in the page's own language(s) (Arabic and/or French). Do not translate, solve, summarize or add anything.
- Output ONLY an HTML fragment. No <html>, <body>, no Markdown, no code fences, no comments.
- Allowed tags: h2, h3, p, strong, em, ol, ul, li, table, thead, tbody, tr, th, td, br, and <div class="fig">.
- Every mathematical expression is LaTeX: inline as \\( ... \\), standalone lines as \\[ ... \\]. Use \\dfrac, \\sqrt, \\times, \\overrightarrow, \\widehat etc. as needed.
- Exercise titles (Exercice 1, التمرين 1, ...) as <h3>. Numbered questions as <ol><li>.
- Figures, graphs or drawings: <div class="fig">شكل: one-line description of the figure</div>.
- Skip running headers, footers, page numbers and decorations.
The image is the page.`;

const toB64 = blob => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(',')[1]);
  r.onerror = () => rej(r.error);
  r.readAsDataURL(blob);
});

async function gemini(parts) {
  if (!S.key) throw { kind: 'auth', msg: 'لا يوجد مفتاح Gemini. أضفه من «الإعدادات».' };
  let r;
  try {
    r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(S.model)}:generateContent`, {
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
    if (r.status === 404) throw { kind: 'auth', msg: `النموذج «${S.model}» غير متاح لحسابك. اختر نموذجاً آخر في «الإعدادات».` };
    if (r.status >= 500) throw { kind: 'transient', msg: 'خادم Gemini مشغول.' };
    throw { kind: 'fail', msg: m || ('خطأ ' + r.status) };
  }
  const c = j.candidates && j.candidates[0];
  const t = c && c.content && c.content.parts ? c.content.parts.map(p => p.text || '').join('') : '';
  if (!t.trim()) throw { kind: 'fail', msg: 'لم يُستخرج نص' + (c && c.finishReason ? ` (${c.finishReason})` : '') + '.' };
  return t;
}
async function convertPage(p) {
  return gemini([{ text: PROMPT }, { inline_data: { mime_type: 'image/jpeg', data: await toB64(p.blob) } }]);
}

/* ---------------- تصغير الصورة قبل الحفظ ---------------- */
async function shrink(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => null);
  if (!bmp) return file;
  const k = Math.min(1, 1800 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close && bmp.close();
  return await new Promise(r => c.toBlob(b => r(b || file), 'image/jpeg', 0.86));
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
      <div class="meta"><span>ص ${i + 1}</span><span class="pill s-${p.status}">${LBL[p.status]}</span></div>
      ${p.err ? `<div class="note s-err" style="padding:0 8px 6px">${esc(p.err)}</div>` : ''}</div>`).join('')
    : '<div class="empty">أضف صور الصفحات بالترتيب، من المعرض أو بالتصوير المباشر.</div>';
  const d = pages.filter(p => p.status === 'done').length;
  $('prog').style.width = (pages.length ? 100 * d / pages.length : 0) + '%';
  const left = pages.filter(p => p.status === 'wait').length, errs = pages.filter(p => p.status === 'err').length;
  if (!running) $('status').textContent = pages.length ? `${d} من ${pages.length} جاهزة` + (left ? ` — ${left} في الانتظار` : '') + (errs ? ` — ${errs} بها خطأ` : '') : '';
  $('run').disabled = !(left || errs);
  $('run').textContent = errs && !left ? 'إعادة الصفحات الخاطئة' : 'بدء التحويل';
}
$('pages').addEventListener('click', e => { const g = e.target.closest('.pg'); if (g) openPage(g.dataset.id); });
$('pages').addEventListener('keydown', e => { const g = e.target.closest('.pg'); if (g && e.key === 'Enter') openPage(g.dataset.id); });

async function addFiles(files) {
  if (!cur) return;
  files = [...files].filter(f => f.type.startsWith('image/'))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  let idx = pages.reduce((m, p) => Math.max(m, p.idx), 0);
  for (const [i, f] of files.entries()) {
    $('status').textContent = `تجهيز الصورة ${i + 1} من ${files.length}…`;
    const p = { id: uid(), bookId: cur.id, idx: ++idx, blob: await shrink(f), status: 'wait', html: '', err: '' };
    await DB.put('pages', p); pages.push(p);
  }
  listPages();
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
      p.html = clean(await convertPage(p)); p.status = 'done'; p.err = ''; p.tries = 0;
    } catch (e) {
      if (e.kind === 'daily' || e.kind === 'auth') { p.status = 'wait'; await DB.put('pages', p); alertBook(e.msg, e.kind === 'auth' ? 'err' : ''); break; }
      if (e.kind === 'rate') { p.status = 'wait'; nextAt = Date.now() + 60000; alertBook(e.msg); await DB.put('pages', p); continue; }
      p.tries = (p.tries || 0) + 1;
      if (e.kind === 'transient' && p.tries < 3) { p.status = 'wait'; nextAt = Date.now() + 20000; alertBook(e.msg + ' سأعيد المحاولة.'); await DB.put('pages', p); continue; }
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
function miniPreview() { clearTimeout(prevT); prevT = setTimeout(() => { const el = $('pgPrev'); el.innerHTML = clean($('pgSrc').value) || '<span class="note">لا يوجد نص بعد.</span>'; typeset(el); }, 350); }
function openPage(id) {
  editing = pages.find(p => p.id === id); if (!editing) return;
  const i = pages.indexOf(editing);
  $('pgTitle').textContent = `الصفحة ${i + 1} — ${LBL[editing.status]}`;
  $('pgImg').src = thumb(editing);
  $('pgSrc').value = editing.html || '';
  $('pgRedo').disabled = running;
  miniPreview(); $('pageDlg').showModal();
}
$('pgSrc').addEventListener('input', miniPreview);
$('pgClose').onclick = () => $('pageDlg').close();
$('pgImg').onclick = () => window.open(thumb(editing), '_blank');
$('pgSave').onclick = async () => {
  editing.html = clean($('pgSrc').value);
  if (editing.html && editing.status !== 'run') { editing.status = 'done'; editing.err = ''; }
  await DB.put('pages', editing); $('pageDlg').close(); listPages();
};
$('pgRedo').onclick = async () => {
  editing.status = 'wait'; editing.err = ''; editing.tries = 0; await DB.put('pages', editing);
  $('pageDlg').close(); listPages(); run();
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

function bodyHTML(pbHtml) {
  return pages.filter(p => p.status === 'done' && p.html).map((p, i) => (i && $('pbk').checked ? pbHtml : '') + p.html).join('\n');
}
function headHTML() {
  return `<div class="hd"><div dir="auto">${esc(S.school)}</div><div class="t" dir="auto">${esc(cur.name)}</div><div class="r" dir="auto">${esc(S.teacher)}</div></div>`;
}
async function renderSheet() {
  const el = $('sheet'); const body = bodyHTML('<hr class="pb">');
  el.innerHTML = headHTML() + (body || '<p class="note">لا توجد صفحات محوّلة بعد.</p>');
  await typeset(el);
}
function standalone(autoPrint) {
  const body = bodyHTML('<div style="break-before:page"></div>');
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(cur.name)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Naskh+Arabic:wght@400;700&family=Lora:wght@400;600&display=swap">
<style>@page{size:A4;margin:14mm 13mm}body{font-family:"Noto Naskh Arabic","Lora",Georgia,serif;font-size:15.5px;line-height:1.8;color:#111;max-width:184mm;margin:0 auto;padding:8px}
.hd{display:grid;grid-template-columns:1fr auto 1fr;gap:8px;border-bottom:1.5px solid #111;padding-bottom:6px;margin-bottom:14px;font-size:13.5px;align-items:end}.t{font-weight:700;font-size:17px;text-align:center}.r{text-align:left}
h2{font-size:18px}h3{font-size:16px;margin:14px 0 4px;text-decoration:underline;text-underline-offset:4px;break-after:avoid}p{margin:4px 0}ol,ul{margin:4px 0;padding-inline-start:26px}li{break-inside:avoid}
table{border-collapse:collapse;margin:8px auto}td,th{border:1px solid #333;padding:4px 10px;text-align:center}.fig{border:1px dashed #888;color:#555;padding:14px;margin:8px 0;text-align:center;font-size:13px}</style>
<script>window.MathJax={tex:{inlineMath:[['\\\\(','\\\\)'],['$','$']]}${autoPrint ? ",startup:{pageReady:()=>MathJax.startup.defaultPageReady().then(()=>setTimeout(()=>window.print(),500))}" : ''}};<\/script>
<script src="https://cdn.jsdelivr.net/npm/mathjax@3.2.2/es5/tex-chtml.js"><\/script></head><body>${headHTML()}${body}</body></html>`;
}
function fileName() { return (cur.name || 'book').replace(/[\\/:*?"<>|]+/g, '').trim().slice(0, 80) || 'book'; }
$('exportHtml').onclick = () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([standalone(false)], { type: 'text/html' }));
  a.download = fileName() + '.html'; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};
$('print').onclick = () => {
  const w = window.open('', '_blank');
  if (!w) { alertBook('اسمح بفتح النوافذ المنبثقة لهذا الموقع، أو استعمل «تنزيل HTML».', 'err'); return; }
  w.document.open(); w.document.write(standalone(true)); w.document.close();
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
function readSettingsForm() {
  S.key = $('sKey').value.trim(); S.model = $('sModel').value;
  S.gap = Math.max(2, Math.min(120, +$('sGap').value || 7));
  S.school = $('sSchool').value; S.teacher = $('sTeacher').value;
}
$('openSettings').onclick = () => {
  $('sKey').value = S.key; $('sModel').value = S.model; $('sGap').value = S.gap;
  $('sSchool').value = S.school; $('sTeacher').value = S.teacher; setMsg('');
  $('setDlg').showModal();
};
$('setClose').onclick = () => $('setDlg').close();
$('sShow').onclick = () => { const k = $('sKey'); k.type = k.type === 'password' ? 'text' : 'password'; $('sShow').textContent = k.type === 'password' ? 'إظهار' : 'إخفاء'; };
$('sSave').onclick = () => { readSettingsForm(); saveSettings(); $('nokey').hidden = !!S.key; setMsg('تم الحفظ.', 'ok'); };
$('sTest').onclick = async () => {
  readSettingsForm(); setMsg('جارٍ الاختبار…');
  try { await gemini([{ text: 'Reply with the single word: OK' }]); saveSettings(); $('nokey').hidden = true; setMsg('المفتاح يعمل مع ' + S.model + '. تم الحفظ.', 'ok'); }
  catch (e) { setMsg(e.msg || 'فشل الاختبار.', 'err'); }
};

/* ---------------- التشغيل ---------------- */
(async () => {
  $('nokey').hidden = !!S.key;
  try { await DB.open(); } catch (e) { document.querySelector('.app').insertAdjacentHTML('beforeend', '<div class="alert err">تعذّر فتح التخزين في هذا المتصفح. لا تستعمل نافذة التصفح الخفي.</div>'); return; }
  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) {}
  await loadBooks();
  const m = location.hash.match(/^#b-(.+)$/); if (m) openBook(m[1]);
})();
