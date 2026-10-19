'use strict';
/* MathScan — قصّ حدود الصفحة وتقويمها (تصحيح المنظور) + كشف الحواف الحيّ في الكاميرا عبر OpenCV.js */

/* ---------- الهندسة: من رباعي مائل إلى مستطيل ---------- */
// يرتّب أربع نقاط [x,y] إلى: أعلى-يسار، أعلى-يمين، أسفل-يمين، أسفل-يسار
function orderQuad(pts) {
  const s = pts.map(p => p[0] + p[1]), d = pts.map(p => p[1] - p[0]);
  return [pts[s.indexOf(Math.min(...s))], pts[d.indexOf(Math.min(...d))], pts[s.indexOf(Math.max(...s))], pts[d.indexOf(Math.max(...d))]];
}
function quadArea(q) {
  let a = 0; for (let i = 0; i < 4; i++) { const [x1, y1] = q[i], [x2, y2] = q[(i + 1) % 4]; a += x1 * y2 - x2 * y1; }
  return Math.abs(a) / 2;
}
function quadConvex(q) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = q[i], [bx, by] = q[(i + 1) % 4], [cx, cy] = q[(i + 2) % 4];
    const z = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    if (Math.abs(z) < 1e-9) return false;
    if (!sign) sign = Math.sign(z); else if (Math.sign(z) !== sign) return false;
  }
  return true;
}
// هل يستحق الرباعي التقويم؟ (معقول المساحة، محدّب، وليس الصورة كلها تقريباً)
function quadUseful(q, W, H) {
  if (!q || q.length !== 4 || q.some(p => !isFinite(p[0]) || !isFinite(p[1]))) return false;
  if (!quadConvex(q)) return false;
  const a = quadArea(q) / (W * H);
  if (a < 0.1) return false;
  const corners = [[0, 0], [W, 0], [W, H], [0, H]], tol = 0.025 * Math.max(W, H);
  const nearFull = q.every((p, i) => Math.hypot(p[0] - corners[i][0], p[1] - corners[i][1]) < tol);
  return !nearFull;
}
function solve8(A, b) {
  const n = 8, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((r, i) => r[n] / r[i]);
}
// مصفوفة تحويل من المستطيل الناتج (u,v) إلى الصورة الأصلية (x,y)
function homography(W, H, q) {
  const dst = [[0, 0], [W, 0], [W, H], [0, H]], A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [u, v] = dst[i], [x, y] = q[i];
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]); b.push(x);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y]); b.push(y);
  }
  return solve8(A, b);
}
// source: canvas أو ImageBitmap؛ q: رباعي بإحداثيات البكسل مرتّب؛ يعيد canvas مستقيماً
function warpQuad(source, q, maxSide) {
  const sw = source.width, sh = source.height;
  const sc = document.createElement('canvas'); sc.width = sw; sc.height = sh;
  const sctx = sc.getContext('2d'); sctx.drawImage(source, 0, 0);
  const S = sctx.getImageData(0, 0, sw, sh).data;
  let W = Math.max(Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]), Math.hypot(q[2][0] - q[3][0], q[2][1] - q[3][1]));
  let H = Math.max(Math.hypot(q[3][0] - q[0][0], q[3][1] - q[0][1]), Math.hypot(q[2][0] - q[1][0], q[2][1] - q[1][1]));
  const k = Math.min(1, (maxSide || 2600) / Math.max(W, H)); W = Math.max(8, Math.round(W * k)); H = Math.max(8, Math.round(H * k));
  const h = homography(W, H, q); if (!h) return null;
  const out = document.createElement('canvas'); out.width = W; out.height = H;
  const octx = out.getContext('2d'), img = octx.createImageData(W, H), D = img.data;
  for (let v = 0; v < H; v++) {
    for (let u = 0; u < W; u++) {
      const z = h[6] * u + h[7] * v + 1, x = (h[0] * u + h[1] * v + h[2]) / z, y = (h[3] * u + h[4] * v + h[5]) / z;
      const o = (v * W + u) * 4;
      if (x < 0 || y < 0 || x > sw - 1 || y > sh - 1) { D[o] = D[o + 1] = D[o + 2] = D[o + 3] = 255; continue; }
      const x0 = x | 0, y0 = y | 0, x1 = Math.min(x0 + 1, sw - 1), y1 = Math.min(y0 + 1, sh - 1), fx = x - x0, fy = y - y0;
      const i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4, i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
      for (let c = 0; c < 3; c++) {
        const a = S[i00 + c] + (S[i10 + c] - S[i00 + c]) * fx, b2 = S[i01 + c] + (S[i11 + c] - S[i01 + c]) * fx;
        D[o + c] = a + (b2 - a) * fy;
      }
      D[o + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  return out;
}

/* ---------- OpenCV.js (اختياري، يُحمَّل عند فتح الكاميرا فقط) ---------- */
const CV_URLS = ['https://docs.opencv.org/4.10.0/opencv.js', 'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js'];
let cvState = 'idle'; // idle | loading | ready | failed
let cvPromise = null;
function loadCV() {
  if (cvPromise) return cvPromise;
  cvState = 'loading';
  cvPromise = (async () => {
    for (const url of CV_URLS) {
      try {
        await new Promise((res, rej) => { const s = document.createElement('script'); s.src = url; s.async = true; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
        let c = window.cv;
        if (c && !c.Mat && typeof c.then === 'function') {
          c = await new Promise(r => c.then(mod => { try { delete mod.then; } catch (e) {} r(mod); }));
          window.cv = c;
        }
        const t0 = Date.now();
        while (!(window.cv && window.cv.Mat && window.cv.imread) && Date.now() - t0 < 30000) await new Promise(r => setTimeout(r, 150));
        if (window.cv && window.cv.Mat) { cvState = 'ready'; return true; }
      } catch (e) {}
    }
    cvState = 'failed'; return false;
  })();
  return cvPromise;
}
const dCanvas = document.createElement('canvas'), dCtx = dCanvas.getContext('2d', { willReadFrequently: true });
// يكشف أكبر رباعي (الصفحة) في إطار الفيديو؛ يعيد النقاط بإحداثيات الفيديو الأصلية أو null
function detectQuad(video) {
  if (cvState !== 'ready' || !video.videoWidth) return null;
  const cv = window.cv, vw = video.videoWidth, vh = video.videoHeight, s = 480 / Math.max(vw, vh);
  const w = Math.round(vw * s), h = Math.round(vh * s);
  dCanvas.width = w; dCanvas.height = h; dCtx.drawImage(video, 0, 0, w, h);
  let src, gray, edges, kernel, contours, hier, best = null, bestArea = 0;
  try {
    src = cv.imread(dCanvas); gray = new cv.Mat(); edges = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
    cv.Canny(gray, edges, 40, 120);
    kernel = cv.Mat.ones(3, 3, cv.CV_8U);
    cv.dilate(edges, edges, kernel);
    contours = new cv.MatVector(); hier = new cv.Mat();
    cv.findContours(edges, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i), area = cv.contourArea(cnt);
      if (area > 0.12 * w * h && area > bestArea) {
        const approx = new cv.Mat(); cv.approxPolyDP(cnt, approx, 0.02 * cv.arcLength(cnt, true), true);
        if (approx.rows === 4 && cv.isContourConvex(approx)) {
          const d = approx.data32S; best = [[d[0], d[1]], [d[2], d[3]], [d[4], d[5]], [d[6], d[7]]]; bestArea = area;
        }
        approx.delete();
      }
      cnt.delete();
    }
  } catch (e) { best = null; }
  finally { [src, gray, edges, kernel, contours, hier].forEach(m => { try { m && m.delete(); } catch (e) {} }); }
  return best ? orderQuad(best.map(([x, y]) => [x / s, y / s])) : null;
}
// يرسم إطار الصفحة فوق الفيديو (الفيديو معروض بنمط contain)
function drawQuad(overlay, video, q) {
  const r = overlay.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  if (overlay.width !== Math.round(r.width * dpr) || overlay.height !== Math.round(r.height * dpr)) { overlay.width = Math.round(r.width * dpr); overlay.height = Math.round(r.height * dpr); }
  const ctx = overlay.getContext('2d'); ctx.clearRect(0, 0, overlay.width, overlay.height);
  if (!q || !video.videoWidth) return;
  const sc = Math.min(overlay.width / video.videoWidth, overlay.height / video.videoHeight);
  const ox = (overlay.width - video.videoWidth * sc) / 2, oy = (overlay.height - video.videoHeight * sc) / 2;
  ctx.beginPath(); q.forEach(([x, y], i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, ox + x * sc, oy + y * sc)); ctx.closePath();
  ctx.fillStyle = 'rgba(46,204,113,.16)'; ctx.fill();
  ctx.lineWidth = 3 * dpr; ctx.strokeStyle = '#2ecc71'; ctx.stroke();
}
