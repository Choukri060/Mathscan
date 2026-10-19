'use strict';
/* صوري — المرحلة 1: جمع الصور من عدة مصادر وترتيبها حسب تاريخ الالتقاط، مع تجاهل النسخ المتطابقة.
   لا يحذف ولا ينقل أي ملف أصلي: ينسخ فقط إلى مجلد الوجهة. */

const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtN = n => n.toLocaleString('ar-MA');
const fmtSize = b => b > 1e9 ? (b / 1e9).toFixed(1) + ' جيغابايت' : (b / 1e6).toFixed(0) + ' ميغابايت';

const IMG = /\.(jpe?g|png|heic|heif|webp|gif|bmp|tiff?|dng|avif)$/i;
const VID = /\.(mp4|mov|m4v|3gp|mkv|avi|webm)$/i;
const MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'ماي', 'يونيو', 'يوليوز', 'غشت', 'شتنبر', 'أكتوبر', 'نونبر', 'دجنبر'];
const INDEX_NAME = 'صوري-فهرس.json';

/* ---------------- تخزين المقابض والإعدادات والذاكرة المؤقتة ---------------- */
const DB = (() => {
  let db;
  const open = () => new Promise((res, rej) => {
    const r = indexedDB.open('sowari', 1);
    r.onupgradeneeded = () => { const d = r.result; d.createObjectStore('kv'); d.createObjectStore('meta'); };
    r.onsuccess = () => { db = r.result; res(); };
    r.onerror = () => rej(r.error);
  });
  const tx = (store, mode, fn) => new Promise((res, rej) => {
    const t = db.transaction(store, mode); let out; const q = fn(t.objectStore(store));
    if (q) q.onsuccess = () => { out = q.result; };
    t.oncomplete = () => res(out); t.onerror = () => rej(t.error);
  });
  return {
    open,
    get: (s, k) => tx(s, 'readonly', st => st.get(k)),
    put: (s, k, v) => tx(s, 'readwrite', st => st.put(v, k)),
  };
})();

let sources = [], dest = null, items = [], index = { version: 1, items: {} }, stop = false, busy = false;
const opts = () => ({ layout: $('oLayout').value, month: $('oMonth').value, video: $('oVideo').checked, uncertain: $('oUncertain').checked });

function log(t) { const l = $('log'); l.textContent = (new Date().toLocaleTimeString('ar-MA') + ' — ' + t + '\n' + l.textContent).slice(0, 20000); }
function status(t) { $('status').textContent = t; }
function prog(f) { $('prog').style.width = Math.max(0, Math.min(100, f * 100)) + '%'; }
function msg(t, cls = '') { const m = $('msg'); m.hidden = !t; m.className = 'alert ' + cls; m.textContent = t || ''; }

async function savePrefs() { await DB.put('kv', 'sources', sources); await DB.put('kv', 'dest', dest); await DB.put('kv', 'opts', opts()); }
async function ensurePerm(h, mode) {
  try {
    if ((await h.queryPermission({ mode })) === 'granted') return true;
    return (await h.requestPermission({ mode })) === 'granted';
  } catch (e) { return false; }
}

/* ---------------- الواجهة: المصادر والوجهة ---------------- */
function renderLists() {
  $('srcList').innerHTML = sources.length ? sources.map((h, i) => `<div class="item"><span class="grow"><b>${esc(h.name)}</b></span><button class="sm" data-rm="${i}">إزالة</button></div>`).join('')
    : '<div class="empty">لم تُضف أي مصدر بعد.</div>';
  $('destList').innerHTML = dest ? `<div class="item"><span class="grow"><b>${esc(dest.name)}</b></span></div>` : '<div class="empty">لم تختر الوجهة بعد.</div>';
}
$('srcList').addEventListener('click', async e => {
  const i = e.target.dataset.rm; if (i === undefined || busy) return;
  sources.splice(+i, 1); await savePrefs(); renderLists(); resetScan();
});
$('addSrc').onclick = async () => {
  try {
    const h = await window.showDirectoryPicker({ id: 'sowari-src', mode: 'read' });
    for (const s of sources) if (await s.isSameEntry(h)) { msg('هذا المجلد مضاف من قبل.'); return; }
    sources.push(h); await savePrefs(); renderLists(); resetScan(); msg('');
  } catch (e) { if (e.name !== 'AbortError') msg('تعذّر فتح المجلد: ' + e.message, 'err'); }
};
$('pickDest').onclick = async () => {
  try {
    const h = await window.showDirectoryPicker({ id: 'sowari-dest', mode: 'readwrite' });
    dest = h; await savePrefs(); renderLists(); resetScan(); msg('');
  } catch (e) { if (e.name !== 'AbortError') msg('تعذّر فتح المجلد: ' + e.message, 'err'); }
};
['oLayout', 'oMonth', 'oVideo', 'oUncertain'].forEach(id => $(id).addEventListener('change', () => { savePrefs(); if (items.length) summarize(); }));
function resetScan() { items = []; $('summary').hidden = true; $('copy').disabled = true; prog(0); }

/* ---------------- قراءة التاريخ ---------------- */
function exifDate(s) {
  const m = s && s.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/); if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (y < 1990 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return new Date(y, mo - 1, d, +m[4], +m[5], +m[6]);
}
// يقرأ تاريخ الالتقاط من بنية TIFF/EXIF تبدأ عند start
function tiffDate(dv, start) {
  if (start + 8 > dv.byteLength) return null;
  const le = dv.getUint16(start) === 0x4949;
  const u16 = o => dv.getUint16(start + o, le), u32 = o => dv.getUint32(start + o, le);
  if (u16(2) !== 42) return null;
  const str = (off, count) => { let s = ''; for (let i = 0; i < count - 1 && start + off + i < dv.byteLength; i++) s += String.fromCharCode(dv.getUint8(start + off + i)); return s; };
  const ifd = (off, cb) => {
    if (start + off + 2 > dv.byteLength) return; const n = u16(off);
    for (let i = 0; i < n && i < 400; i++) { const e = off + 2 + i * 12; if (start + e + 12 > dv.byteLength) return; cb(u16(e), u32(e + 4), u32(e + 8)); }
  };
  let exifOff = 0, dt0 = null, dto = null, dtd = null;
  ifd(u32(4), (tag, count, val) => { if (tag === 0x8769) exifOff = val; if (tag === 0x0132 && count >= 19) dt0 = str(val, count); });
  if (exifOff) ifd(exifOff, (tag, count, val) => { if (count >= 19) { if (tag === 0x9003) dto = str(val, count); if (tag === 0x9004) dtd = str(val, count); } });
  return exifDate(dto) || exifDate(dtd) || exifDate(dt0);
}
function findBytes(u8, pat, from = 0) {
  outer: for (let i = from; i <= u8.length - pat.length; i++) { for (let j = 0; j < pat.length; j++) if (u8[i + j] !== pat[j]) continue outer; return i; }
  return -1;
}
const EXIF_SIG = [0x45, 0x78, 0x69, 0x66, 0, 0]; // "Exif\0\0"
function dateFromImageHead(buf) {
  const u8 = new Uint8Array(buf), dv = new DataView(buf);
  let i = findBytes(u8, EXIF_SIG);
  while (i >= 0) { const d = tiffDate(dv, i + 6); if (d) return d; i = findBytes(u8, EXIF_SIG, i + 1); }
  const p = findBytes(u8, [0x65, 0x58, 0x49, 0x66]); // PNG eXIf
  if (p >= 0) { const d = tiffDate(dv, p + 4); if (d) return d; }
  return null;
}
// تاريخ إنشاء الفيديو من صندوق mvhd (ثوانٍ منذ 1904 بتوقيت UTC)
function dateFromVideo(buf) {
  const u8 = new Uint8Array(buf), dv = new DataView(buf);
  const i = findBytes(u8, [0x6d, 0x76, 0x68, 0x64]); if (i < 0 || i + 16 > u8.length) return null;
  const v = u8[i + 4]; let t = v === 1 ? Number(dv.getBigUint64(i + 8)) : dv.getUint32(i + 8);
  if (!t) return null; t -= 2082844800;
  const d = new Date(t * 1000); return d.getFullYear() >= 1990 && d.getFullYear() <= 2100 ? d : null;
}
function dateFromName(name) {
  const m = name.match(/(?:^|[^\d])((?:19|20)\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?:[-_. T]?([01]\d|2[0-3])[-_.]?([0-5]\d)[-_.]?([0-5]\d))?/);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 12), +(m[5] || 0), +(m[6] || 0));
  return d.getFullYear() >= 1990 && d <= new Date(Date.now() + 864e5) ? d : null;
}
// ملفات Google Takeout الجانبية: IMG.jpg.json أو IMG.jpg.supplemental-metadata.json (قد تُقتطع الأسماء)
function takeoutJsonFor(name, jsons) {
  if (!jsons || !jsons.size) return null;
  const base = name.replace(/-(edited|modifié|bearbeitet)(?=\.[^.]+$)/i, '');
  const numbered = base.match(/^(.*)\((\d+)\)(\.[^.]+)$/);
  const keys = [base];
  if (numbered) keys.push(numbered[1] + numbered[3] + '(' + numbered[2] + ')');
  for (const k of keys) {
    for (const [jn, h] of jsons) {
      const stem = jn.replace(/\.json$/i, '');
      if (stem === k || stem.startsWith(k + '.') || (k.length > 40 && stem.startsWith(k.slice(0, 40)))) return h;
    }
  }
  return null;
}
async function takeoutDate(h) {
  try {
    const j = JSON.parse(await (await h.getFile()).text());
    const t = +(j.photoTakenTime && j.photoTakenTime.timestamp); if (!t) return null;
    const d = new Date(t * 1000); return d.getFullYear() >= 1990 ? d : null;
  } catch (e) { return null; }
}

/* ---------------- البصمة: الحجم + SHA-256 لثلاث قطع ---------------- */
const CH = 256 * 1024;
async function fingerprint(file) {
  const s = file.size, parts = [file.slice(0, CH)];
  if (s > 3 * CH) parts.push(file.slice(Math.floor(s / 2) - CH / 2, Math.floor(s / 2) + CH / 2), file.slice(s - CH));
  else if (s > CH) parts.push(file.slice(CH));
  const buf = await new Blob(parts).arrayBuffer();
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  return s.toString(36) + '-' + [...h.slice(0, 16)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/* ---------------- المسح ---------------- */
async function walk(dir, srcName, path, out, jsonMaps) {
  const jsons = new Map(), files = [], dirs = [];
  for await (const [name, h] of dir.entries()) {
    if (name.startsWith('.')) continue;
    if (h.kind === 'directory') {
      if (dest && await h.isSameEntry(dest)) { log('تجاهلتُ مجلد الوجهة داخل المصدر: ' + path + name); continue; }
      dirs.push([name, h]);
    } else if (/\.json$/i.test(name)) jsons.set(name, h);
    else if (IMG.test(name) || VID.test(name)) files.push([name, h]);
  }
  for (const [name, h] of files) out.push({ src: srcName, rel: path + name, name, handle: h, jsons, video: VID.test(name) });
  if (out.length % 200 < files.length) status(`جارٍ البحث عن الملفات… ${fmtN(out.length)}`);
  for (const [name, h] of dirs) await walk(h, srcName, path + name + '/', out, jsonMaps);
}

async function analyze(it) {
  const f = await it.handle.getFile();
  it.size = f.size; it.mtime = f.lastModified;
  const key = it.src + '|' + it.rel + '|' + f.size + '|' + f.lastModified;
  const cached = await DB.get('meta', key);
  if (cached) { Object.assign(it, cached, { date: cached.date ? new Date(cached.date) : null }); return; }
  let date = null, how = '';
  try {
    if (it.video) {
      date = dateFromVideo(await f.slice(0, 4 * 1024 * 1024).arrayBuffer());
      if (!date && f.size > 4 * 1024 * 1024) date = dateFromVideo(await f.slice(f.size - 4 * 1024 * 1024).arrayBuffer());
      if (date) how = 'فيديو';
    } else {
      date = dateFromImageHead(await f.slice(0, 512 * 1024).arrayBuffer());
      if (date) how = 'EXIF';
    }
  } catch (e) {}
  if (!date) { const jh = takeoutJsonFor(it.name, it.jsons); if (jh) { date = await takeoutDate(jh); if (date) how = 'Google Takeout'; } }
  if (!date) { date = dateFromName(it.name); if (date) how = 'اسم الملف'; }
  let sure = !!date;
  if (!date) { date = new Date(f.lastModified); how = 'تاريخ تعديل الملف'; sure = false; }
  const fp = await fingerprint(f);
  Object.assign(it, { date, how, sure, fp });
  await DB.put('meta', key, { date: date.getTime(), how, sure, fp });
}

const pad = n => String(n).padStart(2, '0');
function destPath(it, o) {
  const d = it.date, y = String(d.getFullYear()), m = pad(d.getMonth() + 1), dd = pad(d.getDate());
  const month = o.month === 'ma' ? `${y}-${m} ${MONTHS[d.getMonth()]}` : `${y}-${m}`;
  const parts = [y, month]; if (o.layout === 'ymd') parts.push(`${y}-${m}-${dd}`);
  if (!it.sure && o.uncertain) parts.unshift('تاريخ غير مؤكد');
  return parts;
}

async function loadIndex() {
  index = { version: 1, items: {} };
  try { const h = await dest.getFileHandle(INDEX_NAME); const j = JSON.parse(await (await h.getFile()).text()); if (j && j.items) index = j; } catch (e) {}
}
async function saveIndex() {
  const h = await dest.getFileHandle(INDEX_NAME, { create: true }); const w = await h.createWritable();
  await w.write(JSON.stringify(index)); await w.close();
}

$('scan').onclick = async () => {
  if (busy) return;
  if (!sources.length) { msg('أضف مجلد مصدر واحداً على الأقل.', 'err'); return; }
  if (!dest) { msg('اختر مجلد الوجهة أولاً.', 'err'); return; }
  for (const s of sources) if (!(await ensurePerm(s, 'read'))) { msg('لم يُسمح بقراءة «' + s.name + '». اضغط «فحص الصور» مرة أخرى واسمح بالوصول.', 'err'); return; }
  if (!(await ensurePerm(dest, 'readwrite'))) { msg('لم يُسمح بالكتابة في مجلد الوجهة.', 'err'); return; }
  busy = true; stop = false; msg(''); resetScan(); $('scan').disabled = true; $('pause').hidden = false;
  try {
    const all = [];
    for (const s of sources) { status('جارٍ البحث في «' + s.name + '»…'); await walk(s, s.name, '', all, null); }
    log(`وُجد ${fmtN(all.length)} ملف صورة وفيديو.`);
    await loadIndex();
    let done = 0; const t0 = Date.now();
    const queue = all.slice();
    const worker = async () => {
      while (queue.length && !stop) {
        const it = queue.shift();
        try { await analyze(it); } catch (e) { it.error = e.message; log('تعذّرت قراءة ' + it.src + '/' + it.rel); }
        done++;
        if (done % 10 === 0 || done === all.length) {
          const left = (Date.now() - t0) / done * (all.length - done) / 1000;
          status(`فحص ${fmtN(done)} من ${fmtN(all.length)}` + (done > 30 && left > 5 ? ` — بقي حوالي ${left > 90 ? Math.round(left / 60) + ' دقيقة' : Math.round(left) + ' ثانية'}` : ''));
          prog(done / all.length);
        }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    items = all.filter(it => it.fp);
    if (stop) { status('تم إيقاف الفحص. يمكنك إعادة الفحص لاحقاً وسيتذكر ما فحصه.'); return; }
    summarize();
    $('copy').disabled = false;
    status('انتهى الفحص. راجع الملخص ثم اضغط «بدء النسخ».');
  } catch (e) { msg('حدث خطأ أثناء الفحص: ' + e.message, 'err'); }
  finally { busy = false; $('scan').disabled = false; $('pause').hidden = true; }
};

function plan() {
  const o = opts(), seen = new Set(), list = [];
  let dupSrc = 0, inIndex = 0, vidSkip = 0;
  for (const it of items) {
    if (it.video && !o.video) { vidSkip++; continue; }
    if (index.items[it.fp]) { inIndex++; continue; }
    if (seen.has(it.fp)) { dupSrc++; continue; }
    seen.add(it.fp); list.push(it);
  }
  return { list, dupSrc, inIndex, vidSkip };
}
function summarize() {
  const o = opts(), { list, dupSrc, inIndex } = plan();
  const uncertain = list.filter(i => !i.sure).length, size = list.reduce((a, i) => a + i.size, 0);
  const vids = list.filter(i => i.video).length;
  $('stats').innerHTML = [
    [fmtN(items.length), 'ملف وُجد في المصادر'],
    [fmtN(list.length), 'سيُنسخ (' + fmtSize(size) + ')'],
    [fmtN(dupSrc), 'نسخ متطابقة سيُتجاهل'],
    [fmtN(inIndex), 'موجود في الوجهة من قبل'],
    [fmtN(uncertain), 'تاريخه غير مؤكد'],
    [fmtN(vids), 'فيديو'],
  ].map(([n, l]) => `<div class="stat"><b>${n}</b><span>${l}</span></div>`).join('');
  const by = new Map();
  for (const it of list) { const y = it.sure || !o.uncertain ? String(it.date.getFullYear()) : 'تاريخ غير مؤكد'; by.set(y, (by.get(y) || 0) + 1); }
  const rows = [...by].sort((a, b) => a[0].localeCompare(b[0]));
  $('years').innerHTML = '<tr><th>السنة</th><th>عدد الملفات</th></tr>' + rows.map(([y, n]) => `<tr><td>${esc(y)}</td><td>${fmtN(n)}</td></tr>`).join('');
  const hows = {}; for (const it of list) hows[it.how] = (hows[it.how] || 0) + 1;
  log('مصدر التاريخ: ' + Object.entries(hows).map(([k, v]) => k + ' ' + fmtN(v)).join('، '));
  $('summary').hidden = false;
}

/* ---------------- النسخ ---------------- */
const dirCache = new Map();
async function getDir(parts) {
  const key = parts.join('/'); if (dirCache.has(key)) return dirCache.get(key);
  let d = dest; for (const p of parts) d = await d.getDirectoryHandle(p, { create: true });
  dirCache.set(key, d); return d;
}
async function freeName(dir, name, fp) {
  const dot = name.lastIndexOf('.'), stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
  for (let k = 1; k < 1000; k++) {
    const n = k === 1 ? name : `${stem} (${k})${ext}`;
    let h; try { h = await dir.getFileHandle(n); } catch (e) { return { name: n }; }
    try { if (await fingerprint(await h.getFile()) === fp) return { name: n, same: true }; } catch (e) {}
  }
  return { name: `${stem} (${Date.now()})${ext}` };
}
function csvCell(s) { return '"' + String(s ?? '').replace(/"/g, '""') + '"'; }

$('copy').onclick = async () => {
  if (busy || !items.length) return;
  if (!(await ensurePerm(dest, 'readwrite'))) { msg('لم يُسمح بالكتابة في مجلد الوجهة.', 'err'); return; }
  busy = true; stop = false; msg(''); $('copy').disabled = true; $('scan').disabled = true; $('pause').hidden = false;
  dirCache.clear();
  const o = opts(), { list, dupSrc, inIndex } = plan();
  const report = [['الحالة', 'المصدر', 'المسار الأصلي', 'الوجهة', 'تاريخ الالتقاط', 'مصدر التاريخ'].map(csvCell).join(',')];
  let copied = 0, skipped = 0, failed = 0, done = 0, lastSave = Date.now(); const t0 = Date.now();
  const queue = list.slice();
  const worker = async () => {
    while (queue.length && !stop) {
      const it = queue.shift();
      const parts = destPath(it, o), when = it.date.toLocaleString('ar-MA');
      try {
        if (index.items[it.fp]) { skipped++; }
        else {
          index.items[it.fp] = 'pending';
          const dir = await getDir(parts), target = await freeName(dir, it.name, it.fp);
          if (target.same) { skipped++; }
          else {
            const fh = await dir.getFileHandle(target.name, { create: true }), w = await fh.createWritable();
            await (await it.handle.getFile()).stream().pipeTo(w);
            copied++;
          }
          index.items[it.fp] = parts.join('/') + '/' + target.name;
          report.push(['نُسخ', it.src, it.rel, index.items[it.fp], when, it.how].map(csvCell).join(','));
        }
      } catch (e) {
        delete index.items[it.fp]; failed++;
        report.push(['خطأ: ' + e.message, it.src, it.rel, '', when, it.how].map(csvCell).join(','));
        log('تعذّر نسخ ' + it.src + '/' + it.rel + ': ' + e.message);
      }
      done++;
      if (done % 5 === 0 || !queue.length) {
        const left = (Date.now() - t0) / done * (list.length - done) / 1000;
        status(`نسخ ${fmtN(done)} من ${fmtN(list.length)}` + (done > 20 && left > 5 ? ` — بقي حوالي ${left > 90 ? Math.round(left / 60) + ' دقيقة' : Math.round(left) + ' ثانية'}` : ''));
        prog(done / list.length);
      }
      if (Date.now() - lastSave > 15000) { lastSave = Date.now(); try { await saveIndex(); } catch (e) {} }
    }
  };
  try {
    await Promise.all([worker(), worker()]);
    for (const k of Object.keys(index.items)) if (index.items[k] === 'pending') delete index.items[k];
    await saveIndex();
    const rep = await (await getDir(['تقارير'])).getFileHandle(`تقرير ${new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '-')}.csv`, { create: true });
    const w = await rep.createWritable(); await w.write('﻿' + report.join('\n')); await w.close();
    const text = `${stop ? 'تم الإيقاف المؤقت' : 'انتهى النسخ'}: نُسخ ${fmtN(copied)} ملف` +
      (skipped ? `، وتُجوهل ${fmtN(skipped)} موجود من قبل` : '') + (dupSrc ? `، و${fmtN(dupSrc)} نسخة متطابقة` : '') +
      (failed ? `، وتعذّر ${fmtN(failed)} (التفاصيل في مجلد «تقارير»)` : '') + '.' + (stop ? ' اضغط «بدء النسخ» للمتابعة؛ لن يُعاد نسخ ما تم.' : '');
    msg(text, failed ? 'err' : 'ok'); status(text); log(text);
  } catch (e) { msg('حدث خطأ أثناء النسخ: ' + e.message, 'err'); }
  finally { busy = false; $('scan').disabled = false; $('copy').disabled = false; $('pause').hidden = true; summarize(); }
};
$('pause').onclick = () => { stop = true; status('جارٍ الإيقاف بعد الملف الحالي…'); };
window.addEventListener('beforeunload', e => { if (busy) { e.preventDefault(); e.returnValue = ''; } });

/* ---------------- التشغيل ---------------- */
(async () => {
  if (!window.showDirectoryPicker) {
    $('unsupported').hidden = false;
    ['addSrc', 'pickDest', 'scan'].forEach(id => $(id).disabled = true);
  }
  try {
    await DB.open();
    sources = (await DB.get('kv', 'sources')) || []; dest = (await DB.get('kv', 'dest')) || null;
    const o = await DB.get('kv', 'opts');
    if (o) { $('oLayout').value = o.layout; $('oMonth').value = o.month; $('oVideo').checked = o.video; $('oUncertain').checked = o.uncertain; }
  } catch (e) {}
  renderLists();
})();
