'use strict';
/* MathScan — رفع المطابقة بعد التفريغ:
   1) مراجعة آلية ثانية بـ Gemini للصفحات المتوسطة والضعيفة (مجانية، مباشرة أو عبر Google في الخلفية).
   2) ذهاب وإياب مع ChatGPT يدوياً: تصدير حزمة مراجعة (صور + HTML + تعليمات) ثم استيراد التصحيحات إلى مكانها. */

/* ---------------- 1) المراجعة الآلية ---------------- */
function verifyPrompt(html) {
  return `You are proofreading an automatic transcription of ONE page of a school math textbook (French and/or Arabic).
Compare the HTML transcription below with the page image(s) very carefully: every number, sign, exponent, index, fraction, root, vector arrow, angle hat, letter and word, the numbering of exercises, questions and QCM options, and the reading order. Check that nothing is missing, duplicated or invented.
Answer in exactly one of these two forms:
- If the transcription is fully correct: a single line VERDICT: OK
- Otherwise: first line VERDICT: FIXED, then the complete corrected HTML fragment and nothing else.
Rules for the corrected HTML: same allowed tags as the input (h2, h3, p, strong, em, ol, ul, li, table, thead, tbody, tr, th, td, br, hr, <div class="box">, <div class="fig">); all mathematics in LaTeX inside \\( ... \\) or \\[ ... \\]; decimal comma written {,}; keep every <div class="fig" data-fig="..."> element exactly as it is, in the same place; keep the <hr> between two facing pages; no explanations, no Markdown, no code fences.
TRANSCRIPTION:
${html}`;
}
async function verifyParts(p) {
  const hv = await halves(p, +S.res || 2600);
  const parts = [{ text: verifyPrompt(p.html) }];
  if (hv) parts.push({ text: LBL1 }, { inline_data: { mime_type: 'image/jpeg', data: await toB64(hv[0].blob) } }, { text: LBL2 }, { inline_data: { mime_type: 'image/jpeg', data: await toB64(hv[1].blob) } });
  else parts.push({ inline_data: { mime_type: 'image/jpeg', data: await toB64(p.blob) } });
  return { parts, hv };
}
// يطبّق ردّ المراجعة على الصفحة؛ يعيد 'ok' أو 'fixed' أو 'rejected'
async function applyVerify(p, text, model) {
  const t = String(text || '').replace(/^\s*```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
  let result = 'rejected';
  if (/^VERDICT:\s*OK\b/i.test(t)) result = 'ok';
  else if (/^VERDICT:\s*FIXED\b/i.test(t)) {
    let fixed = clean(t.replace(/^VERDICT:\s*FIXED[^\n]*\n?/i, ''));
    const oldLen = plainText(p.html).replace(/\s+/g, '').length, newLen = plainText(fixed).replace(/\s+/g, '').length;
    if (fixed && newLen >= oldLen * 0.7) {
      // لا نفقد أي شكل: ما أسقطته المراجعة يُعاد في آخر الصفحة
      const ids = html => [...String(html).matchAll(/data-fig="(f\d+)"/g)].map(m => m[1]);
      const now = new Set(ids(fixed));
      for (const id of ids(p.html)) if (!now.has(id)) { const m = p.html.match(new RegExp('<div[^>]*data-fig="' + id + '"[^>]*>[\\s\\S]*?</div>')); if (m) fixed += m[0]; }
      if (fixed.trim() !== String(p.html).trim()) {
        if (p.htmlBefore == null) p.htmlBefore = p.html;
        p.html = fixed; p.reviewed = false; result = 'fixed';
      } else result = 'ok';
    }
  }
  p.verify = { h: qaHash(p.html), result, model: model || '', at: Date.now() };
  await DB.put('pages', p);
  return result;
}
const needsVerify = p => p.status === 'done' && !p.reviewed && (qaLevel(p) === 'low' || qaLevel(p) === 'mid') && !(p.verify && p.verify.h === qaHash(p.html));
let verifying = false, vStop = false;
function vPending() { try { return JSON.parse(localStorage.getItem('ms-vfy') || '{}'); } catch (e) { return {}; } }
function vSave(m) { try { localStorage.setItem('ms-vfy', JSON.stringify(m)); } catch (e) {} }
async function runVerify() {
  if (verifying) { vStop = true; return; }
  if (!cur) return;
  if (!S.key) { alertBook('أضف مفتاح Gemini أولاً من «الإعدادات».', 'err'); return; }
  await qaBook();
  const list = pages.filter(needsVerify), book = cur;
  if (!list.length) { alertBook('لا توجد صفحات متوسطة أو ضعيفة تحتاج مراجعة آلية (أو رُوجعت كلها).', 'ok'); return; }
  verifying = true; vStop = false; $('verifyBtn').textContent = 'إيقاف المراجعة الآلية'; wake(true);
  let ok = 0, fixed = 0, rej = 0, sent = 0, fail = 0;
  try {
    const pend = vPending();
    for (const [i, p] of list.entries()) {
      if (vStop || cur !== book) break;
      $('status').textContent = `مراجعة آلية ${i + 1} من ${list.length}…`;
      try {
        if (bgOn() && (!bgInfo || (bgInfo.version || 1) >= 3)) {
          const { parts, hv } = await verifyParts(p);
          const images = hv ? [{ data: parts[2].inline_data.data, mime: 'image/jpeg', label: LBL1 }, { data: parts[4].inline_data.data, mime: 'image/jpeg', label: LBL2 }]
            : [{ data: parts[1].inline_data.data, mime: 'image/jpeg', label: '' }];
          const r = await bgCall('enqueue', { id: p.id + '-vfy', prompt: parts[0].text, hint: '', mime: 'image/jpeg', images });
          if (!r.ok) throw { kind: r.error === 'drive_limit' ? 'limit' : 'fail', msg: BG_ERR[r.error] || r.error };
          pend[p.id + '-vfy'] = 1; vSave(pend); sent++;
        } else {
          const w = nextAt - Date.now(); if (w > 0) await sleep(w);
          nextAt = Date.now() + Math.max(2, +S.gap || 7) * 1000;
          const { parts } = await verifyParts(p);
          const rr = await callOrder(parts, [...STRONG, 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']);
          const text = rr.text, model = rr.model;
          const r = await applyVerify(p, text, model);
          if (r === 'ok') ok++; else if (r === 'fixed') fixed++; else rej++;
          listPages();
        }
      } catch (e) {
        fail++;
        if (e.kind === 'auth' || e.kind === 'daily' || e.kind === 'limit' || fail >= 5) { alertBook('توقفت المراجعة الآلية: ' + (e.msg || 'خطأ'), 'err'); break; }
      }
    }
  } finally {
    verifying = false; $('verifyBtn').textContent = 'مراجعة آلية (Gemini)'; if (!running && !importing) wake(false);
    setTimeout(qaBook, 200); listPages();
  }
  if (sent) alertBook(`أُرسلت ${sent} صفحة للمراجعة الآلية في Google. ستُطبَّق التصحيحات حين تفتح التطبيق لاحقاً.`, 'ok');
  else if (ok + fixed + rej) alertBook(`المراجعة الآلية: ${fixed} صفحة صُحّحت، ${ok} صحيحة كما هي` + (rej ? `، ${rej} ردّ مرفوض (بقي النص كما هو)` : '') + '. الصفحات المصحَّحة معلَّمة لتلقي عليها نظرة في «مراجعة الصفحات الضعيفة».', 'ok');
}
// يُستدعى من syncRemote: يجلب نتائج المراجعة من Google ويطبّقها
async function syncVerify() {
  const pend = vPending(), ids = Object.keys(pend); if (!ids.length || !bgOn()) return;
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50), r = await bgCall('results', { ids: chunk }); if (!r.ok) return;
    const ack = [];
    for (const vid of chunk) {
      const res = r.results && r.results[vid]; if (!res) continue;
      const pid = vid.replace(/-vfy$/, ''), p = (cur && pages.find(x => x.id === pid)) || await DB.get(pid);
      if (p && p.status === 'done' && res.text) await applyVerify(p, res.text, res.model);
      delete pend[vid]; ack.push(vid);
    }
    vSave(pend);
    if (ack.length) { try { await bgCall('ack', { ids: ack }); } catch (e) {} if (cur) setTimeout(qaBook, 300); }
  }
}
$('verifyBtn').onclick = runVerify;

/* ---------------- استرجاع النص السابق ---------------- */
$('pgUndo').onclick = async () => {
  if (!editing || editing.htmlBefore == null) return;
  editing.html = editing.htmlBefore; delete editing.htmlBefore; delete editing.verify; editing.reviewed = false;
  await DB.put('pages', editing); $('pgSrc').value = editing.html; $('pgUndo').hidden = true; miniPreview(); listPages(); setTimeout(qaBook, 200);
};

/* ---------------- 2) الذهاب والإياب مع ChatGPT ---------------- */
const EXT_INSTR = `مهمة مراجعة تفريغ كتاب رياضيات (Tâche de relecture)

في هذه الحزمة:
- review.html : تفريغ الصفحات، كل صفحة داخل <section data-ms-id="..."> مستقل.
- images/ : صورة كل صفحة؛ اسم الصورة مكتوب في data-ms-img للقسم نفسه.

المطلوب:
1. قارن كل قسم <section> بصورته حرفاً حرفاً: الأرقام، الإشارات، الأسس، الكسور، الجذور، المتجهات، ترقيم التمارين والأسئلة، وخيارات QCM. أضف ما سقط واحذف ما تكرر.
2. صحّح التفريغ فقط؛ لا تحلّ التمارين ولا تترجم ولا تضف شيئاً من عندك.
3. كل الرياضيات بصيغة LaTeX داخل \\( ... \\) أو \\[ ... \\]، والفاصلة العشرية {,} مثل \\(7{,}5\\).
4. لا تغيّر أبداً الوسوم <section data-ms-id="..."> ولا خاصياتها، ولا تحذف أي <div class="fig" data-fig="..."> (تبقى كما هي في مكانها).
5. أعد ملف review.html كاملاً بعد التصحيح، بالبنية نفسها، دون أي شرح.

Consignes (FR) : compare chaque <section> à son image, corrige uniquement la transcription (nombres, signes, exposants, fractions, numérotation), LaTeX entre \\( \\), virgule décimale {,}, ne modifie jamais les balises <section data-ms-id> ni les <div class="fig" data-fig>, et renvoie le fichier review.html complet.`;
const imgName = (p, i) => 'images/' + String(i + 1).padStart(3, '0') + (p.pageNo ? '_p' + String(p.pageNo).replace(/[^\w-]/g, '') : '') + '.jpg';
async function smallJpeg(blob, max) {
  const bmp = await createImageBitmap(blob).catch(() => null); if (!bmp) return blob;
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height)), c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k); c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height); bmp.close && bmp.close();
  return await new Promise(r => c.toBlob(r, 'image/jpeg', 0.82));
}
function extSelection() {
  const rg = exportRange(), done = pages.filter(p => p.status === 'done');
  if (!rg) return done;
  return done.filter(p => { const ns = pageNums(p); return ns.some(n => n >= rg[0] && n <= rg[1]); });
}
$('extExport').onclick = async () => {
  const b = $('extExport'), label = b.textContent;
  const sel = extSelection();
  if (!sel.length) { alertBook('لا توجد صفحات محوّلة في النطاق المختار.', 'err'); return; }
  if (sel.length > 40) alertBook(`اخترت ${sel.length} صفحة. ChatGPT يراجع بدقة أفضل حين تكون الحزمة صغيرة (10 إلى 20 صفحة)؛ استعمل خانتي «من … إلى …».`);
  b.disabled = true;
  try {
    await ensureZip();
    const zip = new JSZip(), sections = [];
    for (const [k, p] of sel.entries()) {
      b.textContent = `تجهيز ${k + 1} من ${sel.length}…`;
      const name = imgName(p, pages.indexOf(p));
      zip.file(name, await smallJpeg(p.blob, 2000));
      sections.push(`<section data-ms-id="${p.id}" data-ms-page="${esc(p.pageNo || '')}" data-ms-img="${name}">\n${p.html}\n</section>`);
      await sleep(0);
    }
    zip.file('review.html', `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${esc(cur.name)} — review</title></head><body>\n${sections.join('\n\n')}\n</body></html>`);
    zip.file('INSTRUCTIONS.txt', EXT_INSTR);
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = fileName() + ' - مراجعة.zip'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 8000);
    try { await navigator.clipboard.writeText(EXT_INSTR); } catch (e) {}
    alertBook(`جُهّزت حزمة المراجعة (${sel.length} صفحة) ونُسخت التعليمات. في ChatGPT: ارفع الملف المضغوط، والصق التعليمات، ثم نزّل review.html المصحَّح واستورده هنا بزر «استيراد التصحيحات».`, 'ok');
  } catch (e) { alertBook('تعذّر تجهيز الحزمة: ' + (e.message || e), 'err'); }
  finally { b.disabled = false; b.textContent = label; }
};
$('extImportFile').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f || !cur) return;
  try {
    let html;
    if (/\.zip$/i.test(f.name)) {
      await ensureZip(); const z = await JSZip.loadAsync(f);
      const entry = Object.values(z.files).find(x => !x.dir && /\.html?$/i.test(x.name)); if (!entry) throw new Error('لا يوجد ملف HTML داخل الملف المضغوط');
      html = await entry.async('string');
    } else html = await f.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const secs = [...doc.querySelectorAll('section[data-ms-id]')];
    if (!secs.length) { alertBook('لم أجد أقسام <section data-ms-id> في الملف. تأكد أن ChatGPT أعاد review.html بالبنية نفسها.', 'err'); return; }
    let changed = 0, same = 0, unknown = 0, rejected = 0;
    for (const s of secs) {
      const p = pages.find(x => x.id === s.getAttribute('data-ms-id'));
      if (!p) { unknown++; continue; }
      const nh = clean(s.innerHTML);
      if (!nh || plainText(nh).replace(/\s+/g, '').length < plainText(p.html).replace(/\s+/g, '').length * 0.6) { rejected++; continue; }
      if (nh.trim() === String(p.html).trim()) { same++; continue; }
      if (p.htmlBefore == null) p.htmlBefore = p.html;
      p.html = nh; p.reviewed = false; p.extFixed = true; delete p.verify;
      await DB.put('pages', p); changed++;
    }
    listPages(); setTimeout(qaBook, 200);
    alertBook(`استُورد التصحيح: ${changed} صفحة تغيّرت، ${same} كما هي` + (rejected ? `، ${rejected} رُفضت لأنها أقصر بكثير من الأصل (قد يكون ChatGPT اختصرها)` : '') + (unknown ? `، ${unknown} لا تنتمي لهذا الكتاب` : '') + '. يمكنك استرجاع النص السابق لأي صفحة من محررها.', changed || same ? 'ok' : 'err');
  } catch (er) { alertBook('تعذّر قراءة الملف: ' + (er.message || er), 'err'); }
};

/* ---------------- إعادة تحويل كتاب كامل بالدقة القصوى ---------------- */
$('reconvAll').onclick = async () => {
  const b = $('reconvAll');
  // لا نمسّ الصفحات التي صحّحتها أو راجعتها بنفسك
  const list = pages.filter(p => p.status === 'done' && !p.reviewed && p.htmlBefore == null && !p.extFixed && !(typeof p.agree === 'number'));
  if (!list.length) { alertBook('كل صفحات هذا الكتاب حُوّلت بالدقة القصوى، أو عدّلتها بنفسك.', 'ok'); return; }
  if (b.dataset.armed !== '1') {
    b.dataset.armed = '1'; b.textContent = `تأكيد: إعادة تحويل ${list.length} صفحة (حتى ${list.length * 3} طلب)`;
    setTimeout(() => { b.dataset.armed = ''; b.textContent = 'إعادة تحويل الكتاب بالدقة القصوى'; }, 5000); return;
  }
  b.dataset.armed = ''; b.textContent = 'إعادة تحويل الكتاب بالدقة القصوى';
  if (!S.consensus) { S.consensus = true; saveSettings(); }
  for (const p of list) { p.status = 'wait'; p.err = ''; p.tries = 0; delete p.gutter; await DB.put('pages', p); }
  listPages(); alertBook(`أُعيدت ${list.length} صفحة إلى الانتظار لتُحوَّل بالدقة القصوى. تختفي كل صفحة من المعاينة أثناء إعادة تحويلها ثم تعود بالنص الجديد.`, 'ok');
  run();
};
