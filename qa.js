'use strict';
/* MathScan — فحص جودة التفريغ على الجهاز (دون أي طلب إلى Gemini) + وضع المراجعة السريع.
   لكل صفحة درجة ثقة من 100 تُحسب من: صيغ LaTeX لا تُعرض، علامات [?]، قفزات في ترقيم التمارين،
   صفحة شبه فارغة، نص أقصر بكثير من نص ملف PDF، ورقم صفحة مصحَّح تلقائياً. */

const QA_V = 1;
function qaHash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36) + ':' + s.length + ':' + QA_V; }
function plainText(html) {
  const spaced = String(html || '').replace(/<\/(p|h\d|li|div|tr|td|th|ol|ul|table)>|<br\s*\/?>|<hr\s*\/?>/gi, '$& \n');
  const d = new DOMParser().parseFromString('<div>' + spaced + '</div>', 'text/html'); return d.body.textContent || '';
}

// صيغ لا يستطيع MathJax عرضها
function badMath(text) {
  const out = []; if (!window.MathJax || !MathJax.tex2svg) return out;
  const re = /\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]|\$\$([\s\S]*?)\$\$/g; let m, n = 0;
  while ((m = re.exec(text)) && n < 200) {
    n++; const tex = m[1] ?? m[2] ?? m[3] ?? ''; if (!tex.trim()) continue;
    try {
      const node = MathJax.tex2svg(tex, { display: m[2] != null || m[3] != null });
      if (node.querySelector('[data-mjx-error], mjx-merror')) out.push(tex.trim().slice(0, 60));
    } catch (e) { out.push(tex.trim().slice(0, 60)); }
  }
  // \( بلا \) أو العكس
  const opens = (text.match(/\\\(/g) || []).length, closes = (text.match(/\\\)/g) || []).length;
  if (opens !== closes) out.push('أقواس صيغة غير مغلقة');
  return out;
}
// أرقام التمارين والأنشطة بالترتيب في الصفحة
const EX_RE = /(?:^|\s)(exercices?|exercise|activit[ée]s?|application|التمرين|تمرين|النشاط|نشاط)\s*(?:n[°o]\s*)?(\d{1,3})(?!\d)/gi;
function exNumbers(text) {
  const out = []; let m; EX_RE.lastIndex = 0;
  while ((m = EX_RE.exec(text))) out.push({ kind: /^(activ|النشاط|نشاط)/i.test(m[1]) ? 'act' : /^appl/i.test(m[1]) ? 'app' : 'ex', n: +m[2] });
  return out;
}

async function qaPage(p, prevEx) {
  const text = plainText(p.html), issues = []; let score = 100;
  const bm = badMath(text);
  if (bm.length) { score -= Math.min(45, 15 * bm.length); issues.push(`${bm.length} صيغة لا تُعرض: ${bm.slice(0, 3).map(x => '«' + x + '»').join('، ')}`); }
  const q = (text.match(/\[\?\]/g) || []).length;
  if (q) { score -= Math.min(30, 10 * q); issues.push(`${q} موضع لم يُقرأ بوضوح [?]`); }
  const words = text.replace(/\s+/g, ' ').trim().length;
  if (words < 60 && !/class="fig"/.test(p.html || '')) { score -= 25; issues.push('صفحة شبه فارغة'); }
  if (p.textHint && p.textHint.length > 300) {
    const ratio = words / p.textHint.replace(/\s+/g, ' ').length;
    if (ratio < 0.55) { score -= 25; issues.push(`النص أقصر بكثير من نص ملف PDF (${Math.round(ratio * 100)}%) — قد تكون أسطر ناقصة`); }
  }
  // قفزات الترقيم داخل الصفحة ومع الصفحة السابقة
  const ex = exNumbers(text), last = Object.assign({}, prevEx || {}), jumps = [];
  for (const e of ex) {
    const l = last[e.kind];
    if (l != null && e.n > l + 1 && e.n - l <= 6) jumps.push(`${l} ← ${e.n}`);
    if (l == null || e.n > l || e.n === 1) last[e.kind] = e.n;
  }
  if (jumps.length) { score -= Math.min(30, 15 * jumps.length); issues.push('قفزة في ترقيم التمارين/الأنشطة: ' + jumps.join('، ') + ' (قد يكون تمرين ناقص)'); }
  if (typeof p.agree === 'number') {
    const pc = Math.round(p.agree * 1000) / 10;
    if (p.agree < 0.9) { score -= 15; issues.push(`القراءتان المستقلتان اختلفتا كثيراً (اتفاق ${pc}%) — صفحة صعبة، حُسمت آلياً`); }
    else if (p.agree < 0.97) { score -= 5; issues.push(`اتفاق القراءتين ${pc}%؛ حُسمت الفروق آلياً`); }
  }
  if (p.verify && p.verify.result === 'fixed') issues.push('عدّلتها المراجعة الآلية (Gemini) — قارن بالصورة؛ النص السابق محفوظ في المحرر');
  if (p.extFixed) issues.push('عُدّلت بتصحيح مستورد (ChatGPT) — النص السابق محفوظ في المحرر');
  if (p.numFixed) { score -= 5; issues.push(`رقم الصفحة صُحّح تلقائياً (قُرئ «${p.pageNoRead || '؟'}»)`); }
  return { score: Math.max(0, score), issues, ex: last };
}

let qaRunning = false, qaAgain = false;
async function qaBook() {
  if (qaRunning) { qaAgain = true; return; }
  if (!cur) return;
  qaRunning = true;
  try {
    // ننتظر MathJax قليلاً؛ إن لم يُحمَّل تُجرى الفحوص الأخرى دونه
    if (window.MathJax && MathJax.startup && MathJax.startup.promise) await Promise.race([MathJax.startup.promise.catch(() => {}), sleep(8000)]);
    do {
      qaAgain = false;
      const book = cur; let prev = {}, changed = 0;
      for (const p of pages.slice()) {
        if (cur !== book) break;
        if (p.status !== 'done') { continue; }
        const h = qaHash((p.html || '') + '|' + (p.numFixed ? 1 : 0) + '|' + JSON.stringify(prev));
        if (!p.qa || p.qa.h !== h) {
          const r = await qaPage(p, prev);
          p.qa = { h, score: r.score, issues: r.issues, ex: r.ex };
          await DB.put('pages', p); changed++;
          if (changed % 10 === 0) { listPages(); await sleep(0); }
        }
        prev = p.qa.ex || prev;
      }
      if (changed) listPages();
    } while (qaAgain);
  } finally { qaRunning = false; }
}
const qaLevel = p => !p.qa ? '' : p.reviewed ? 'ok' : p.qa.score >= 85 ? 'ok' : p.qa.score >= 60 ? 'mid' : 'low';
function qaBadge(p) {
  const l = qaLevel(p); if (!l) return '';
  const t = p.reviewed ? 'رُوجعت' : l === 'ok' ? 'جيدة' : l === 'mid' ? 'متوسطة' : 'ضعيفة';
  return `<span class="qa qa-${l}" title="درجة الثقة ${p.qa.score}">${p.reviewed ? '✓ ' : ''}${t}</span>`;
}
function qaSummary() {
  const d = pages.filter(p => p.status === 'done' && p.qa); if (!d.length) return '';
  const low = d.filter(p => qaLevel(p) === 'low').length, mid = d.filter(p => qaLevel(p) === 'mid').length, rev = d.filter(p => p.reviewed).length;
  const ag = d.filter(p => typeof p.agree === 'number'), avg = ag.length ? ag.reduce((t, p) => t + p.agree, 0) / ag.length : null;
  return `<div class="alert ${low || mid ? '' : 'ok'}">جودة التفريغ: ${d.length - low - mid} جيدة، <b>${mid} متوسطة، ${low} ضعيفة</b>` + (rev ? `، ${rev} راجعتَها` : '') +
    (avg != null ? `. اتفاق القراءتين المستقلتين: ${(Math.round(avg * 1000) / 10)}% (على ${ag.length} صفحة)` : '') + '.</div>';
}

/* ---------------- وضع المراجعة ---------------- */
let rvList = [], rvAt = 0, rvZoom = 1;
function rvOrder(mode) {
  const d = pages.filter(p => p.status === 'done');
  if (mode === 'all') return d;
  return d.filter(p => qaLevel(p) === 'low' || qaLevel(p) === 'mid').sort((a, b) => (a.qa ? a.qa.score : 100) - (b.qa ? b.qa.score : 100));
}
async function openReview(mode) {
  await qaBook();
  rvList = rvOrder(mode || 'weak');
  if (!rvList.length) { alertBook('لا توجد صفحات ضعيفة أو متوسطة تحتاج مراجعة. يمكنك مراجعة الكل من زر «مراجعة كل الصفحات».', 'ok'); return; }
  rvAt = 0; rvZoom = 1; $('rv').hidden = false; document.body.classList.add('noscroll'); rvShow();
  try { history.pushState({ rv: 1 }, ''); } catch (e) {}
}
function closeReview() {
  if ($('rv').hidden) return;
  $('rv').hidden = true; document.body.classList.remove('noscroll'); listPages();
}
window.addEventListener('popstate', () => closeReview());
async function rvShow() {
  const p = rvList[rvAt]; if (!p) { closeReview(); return; }
  $('rvPos').textContent = `${rvAt + 1} من ${rvList.length}`;
  $('rvTitle').textContent = (p.pageNo ? 'الصفحة ' + p.pageNo : 'صورة ' + (pages.indexOf(p) + 1)) + (p.qa ? ` — الثقة ${p.qa.score}` : '');
  $('rvIssues').innerHTML = p.qa && p.qa.issues.length ? p.qa.issues.map(t => `<li>${esc(t)}</li>`).join('') : '<li>لا ملاحظات آلية؛ قارن بنفسك.</li>';
  $('rvImg').src = thumb(p); $('rvImg').style.width = (rvZoom * 100) + '%';
  $('rvPrev').disabled = rvAt === 0;
  const el = $('rvText'); el.innerHTML = await withFigs(p, p.html || '', false); typeset(el); el.scrollTop = 0; $('rvImgBox').scrollTop = 0;
}
function rvNext() { if (rvAt < rvList.length - 1) { rvAt++; rvShow(); } else { closeReview(); try { if (history.state && history.state.rv) history.back(); } catch (e) {} alertBook('انتهت المراجعة.', 'ok'); } }
$('openReview').onclick = () => openReview('weak');
$('openReviewAll').onclick = () => openReview('all');
$('rvClose').onclick = () => { closeReview(); try { if (history.state && history.state.rv) history.back(); } catch (e) {} };
$('rvPrev').onclick = () => { if (rvAt > 0) { rvAt--; rvShow(); } };
$('rvSkip').onclick = rvNext;
$('rvOk').onclick = async () => { const p = rvList[rvAt]; p.reviewed = true; await DB.put('pages', p); rvNext(); };
$('rvFix').onclick = () => {
  const p = rvList[rvAt], before = p.html + '|' + p.pageNo; openPage(p.id);
  const once = () => {
    $('pageDlg').removeEventListener('close', once); if ($('rv').hidden) return;
    if (p.html + '|' + p.pageNo !== before) rvNext(); else rvShow();
  };
  $('pageDlg').addEventListener('close', once);
};
$('rvZin').onclick = () => { rvZoom = Math.min(4, rvZoom * 1.5); $('rvImg').style.width = (rvZoom * 100) + '%'; };
$('rvZout').onclick = () => { rvZoom = Math.max(1, rvZoom / 1.5); $('rvImg').style.width = (rvZoom * 100) + '%'; };
$('rvSwap').onclick = () => $('rv').classList.toggle('swap');
