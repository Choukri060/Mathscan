/**
 * MathScan — المعالجة في الخلفية على خوادم Google (Apps Script)
 * يعمل في حسابك أنت: يستقبل صور الصفحات من تطبيق MathScan، ويحفظها في Google Drive،
 * ثم يرسلها إلى Gemini كل بضع دقائق ولو كان هاتفك مطفأً، ويحفظ النتائج حتى يجلبها التطبيق.
 *
 * التثبيت (مرة واحدة):
 *   1) script.google.com ← مشروع جديد ← احذف ما فيه والصق هذا الملف كاملاً ← حفظ.
 *   2) نشر (Deploy) ← نشر جديد ← النوع: تطبيق ويب (Web app)
 *      التنفيذ باسم: أنا (Me) — من يمكنه الوصول: أي شخص (Anyone) ← نشر ← السماح بالأذونات.
 *   3) انسخ رابط تطبيق الويب والصقه في إعدادات MathScan ← «ربط».
 * لا تشارك هذا الرابط مع أحد.
 */

const PROPS = PropertiesService.getScriptProperties();
const DEFAULT_MODELS = ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemini-3.8-flash'];
const BATCH = 3;          // صفحات تُرسل إلى Gemini في الوقت نفسه
const RUN_BUDGET = 270e3; // مدة التشغيل الواحد (أقل من حد 6 دقائق)

function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

function root_() {
  const id = PROPS.getProperty('ROOT');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  const f = DriveApp.createFolder('MathScan — خلفية');
  PROPS.setProperty('ROOT', f.getId());
  return f;
}
function folder_(name) {
  const r = root_(), it = r.getFoldersByName(name);
  return it.hasNext() ? it.next() : r.createFolder(name);
}
function file_(folder, name) { const it = folder.getFilesByName(name); return it.hasNext() ? it.next() : null; }

function ensureTrigger_() {
  const has = ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'processQueue');
  if (!has) ScriptApp.newTrigger('processQueue').timeBased().everyMinutes(5).create();
}

function doGet() { return json_({ ok: true, app: 'mathscan-backend', version: 1 }); }

function doPost(e) {
  let b;
  try { b = JSON.parse(e.postData.contents); } catch (x) { return json_({ ok: false, error: 'bad_request' }); }
  const token = PROPS.getProperty('TOKEN');

  if (b.action === 'init') {
    if (token && token !== b.token) return json_({ ok: false, error: 'already_linked' });
    if (!b.token || String(b.token).length < 20) return json_({ ok: false, error: 'bad_token' });
    PROPS.setProperty('TOKEN', b.token);
    if (b.key) PROPS.setProperty('GEMINI_KEY', b.key);
    if (b.models) PROPS.setProperty('MODELS', JSON.stringify(b.models));
    PROPS.deleteProperty('PAUSE_UNTIL'); PROPS.deleteProperty('LAST_ERROR');
    root_(); folder_('queue'); folder_('done'); ensureTrigger_();
    return json_({ ok: true });
  }
  if (!token || b.token !== token) return json_({ ok: false, error: 'unauthorized' });

  if (b.action === 'setkey') {
    if (b.key) PROPS.setProperty('GEMINI_KEY', b.key);
    if (b.models) PROPS.setProperty('MODELS', JSON.stringify(b.models));
    PROPS.deleteProperty('PAUSE_UNTIL'); PROPS.deleteProperty('LAST_ERROR');
    return json_({ ok: true });
  }
  if (b.action === 'enqueue') {
    const id = String(b.id || '').replace(/[^\w-]/g, '');
    if (!id || !b.image) return json_({ ok: false, error: 'bad_request' });
    const q = folder_('queue');
    if (!file_(q, id + '.json') && !file_(folder_('done'), id + '.json')) {
      q.createFile(Utilities.newBlob(Utilities.base64Decode(b.image), b.mime || 'image/jpeg', id + '.img'));
      q.createFile(Utilities.newBlob(JSON.stringify({ id: id, prompt: b.prompt || '', hint: b.hint || '', mime: b.mime || 'image/jpeg' }), 'application/json', id + '.json'));
    }
    return json_({ ok: true });
  }
  if (b.action === 'results') {
    const d = folder_('done'), out = {};
    (b.ids || []).slice(0, 60).forEach(id => {
      const f = file_(d, String(id).replace(/[^\w-]/g, '') + '.json');
      if (f) { try { out[id] = JSON.parse(f.getBlob().getDataAsString()); } catch (x) { out[id] = { error: 'corrupt' }; } }
    });
    return json_({ ok: true, results: out });
  }
  if (b.action === 'ack') {
    const d = folder_('done');
    (b.ids || []).slice(0, 60).forEach(id => { const f = file_(d, String(id).replace(/[^\w-]/g, '') + '.json'); if (f) f.setTrashed(true); });
    return json_({ ok: true });
  }
  if (b.action === 'status') {
    let queued = 0; const it = folder_('queue').getFiles();
    while (it.hasNext()) if (/\.json$/.test(it.next().getName())) queued++;
    return json_({
      ok: true, queued: queued,
      lastRun: +PROPS.getProperty('LAST_RUN') || 0,
      pauseUntil: +PROPS.getProperty('PAUSE_UNTIL') || 0,
      lastError: PROPS.getProperty('LAST_ERROR') || '',
      hasKey: !!PROPS.getProperty('GEMINI_KEY'),
    });
  }
  return json_({ ok: false, error: 'unknown_action' });
}

/* ---------- Gemini ---------- */
function geminiRequest_(key, model, parts) {
  return {
    url: 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent',
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'x-goog-api-key': key },
    payload: JSON.stringify({ contents: [{ role: 'user', parts: parts }], generationConfig: { temperature: 0.1 } }),
  };
}
function readGemini_(resp, model, dailyOut) {
  const code = resp.getResponseCode(), body = resp.getContentText();
  let j = {}; try { j = JSON.parse(body); } catch (e) {}
  const msg = (j.error && j.error.message) || ('HTTP ' + code);
  if (code === 200) {
    const c = j.candidates && j.candidates[0];
    const t = c && c.content && c.content.parts ? c.content.parts.map(p => p.text || '').join('') : '';
    return t.trim() ? { text: t, model: model } : { kind: 'fail', msg: 'empty ' + ((c && c.finishReason) || '') };
  }
  if (code === 429) {
    if (/PerDay|per day|daily/i.test(body)) { dailyOut[model] = Date.now(); return { kind: 'daily', msg: msg }; }
    return { kind: 'rate', msg: msg };
  }
  if (code === 404) return { kind: 'missing', msg: msg };
  if (code >= 500) return { kind: 'transient', msg: msg };
  if (code === 400 || code === 403) return /API key|API_KEY|permission/i.test(body) ? { kind: 'auth', msg: msg } : { kind: 'fail', msg: msg };
  return { kind: 'fail', msg: msg };
}

function processQueue() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    if (Date.now() < (+PROPS.getProperty('PAUSE_UNTIL') || 0)) return;
    const key = PROPS.getProperty('GEMINI_KEY'); if (!key) return;
    const models = JSON.parse(PROPS.getProperty('MODELS') || 'null') || DEFAULT_MODELS;
    let dailyOut = JSON.parse(PROPS.getProperty('DAILY_OUT') || '{}');
    Object.keys(dailyOut).forEach(m => { if (Date.now() - dailyOut[m] > 6 * 3600e3) delete dailyOut[m]; });
    const q = folder_('queue'), d = folder_('done'), t0 = Date.now();
    const metas = []; const it = q.getFiles();
    while (it.hasNext()) { const f = it.next(); if (/\.json$/.test(f.getName())) metas.push(f); }
    if (!metas.length) return;
    metas.sort((a, b) => a.getDateCreated() - b.getDateCreated());

    let stop = false;
    for (let i = 0; i < metas.length && !stop && Date.now() - t0 < RUN_BUDGET; i += BATCH) {
      const jobs = metas.slice(i, i + BATCH).map(mf => {
        const m = JSON.parse(mf.getBlob().getDataAsString()), img = file_(q, m.id + '.img');
        if (!img) { mf.setTrashed(true); return null; }
        const parts = [{ text: m.prompt }, { inline_data: { mime_type: m.mime, data: Utilities.base64Encode(img.getBlob().getBytes()) } }];
        if (m.hint) parts.push({ text: 'Text layer extracted from this PDF page (may be incomplete; math symbols and order may be broken). Use it only to confirm words and numbers — the image is authoritative:\n' + m.hint });
        return { m: m, mf: mf, img: img, parts: parts };
      }).filter(Boolean);
      if (!jobs.length) continue;

      const avail = models.filter(m => !dailyOut[m]);
      if (!avail.length) { stop = true; PROPS.setProperty('PAUSE_UNTIL', String(Date.now() + 3600e3)); PROPS.setProperty('LAST_ERROR', 'daily'); break; }

      // المحاولة الأولى بالتوازي، ثم النماذج الاحتياطية واحداً واحداً عند الحاجة
      const first = UrlFetchApp.fetchAll(jobs.map(j => geminiRequest_(key, avail[0], j.parts)));
      jobs.forEach((job, k) => {
        if (stop) return;
        let r = readGemini_(first[k], avail[0], dailyOut);
        for (let n = 1; n < avail.length && !r.text && ['daily', 'transient', 'missing'].indexOf(r.kind) >= 0; n++) {
          if (dailyOut[avail[n]]) continue;
          r = readGemini_(UrlFetchApp.fetchAll([geminiRequest_(key, avail[n], job.parts)])[0], avail[n], dailyOut);
        }
        if (r.text || r.kind === 'fail' || r.kind === 'missing') {
          d.createFile(Utilities.newBlob(JSON.stringify(r.text ? { text: r.text, model: r.model } : { error: r.msg }), 'application/json', job.m.id + '.json'));
          job.mf.setTrashed(true); job.img.setTrashed(true);
          PROPS.deleteProperty('LAST_ERROR');
        } else {
          PROPS.setProperty('LAST_ERROR', r.kind + ': ' + (r.msg || ''));
          if (r.kind === 'auth') { stop = true; PROPS.setProperty('PAUSE_UNTIL', String(Date.now() + 3600e3)); }
          if (r.kind === 'daily') { stop = true; PROPS.setProperty('PAUSE_UNTIL', String(Date.now() + 3600e3)); }
          if (r.kind === 'rate' || r.kind === 'transient') stop = true; // نعيد في التشغيل التالي
        }
      });
      PROPS.setProperty('DAILY_OUT', JSON.stringify(dailyOut));
    }
  } finally {
    PROPS.setProperty('LAST_RUN', String(Date.now()));
    lock.releaseLock();
  }
}
