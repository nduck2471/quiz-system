// Trang làm bài của học viên (Firebase). Không có nút nộp: hết giờ là tự nộp.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, signInAnonymously, onIdTokenChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFirestore, doc, setDoc, getDocFromServer, onSnapshot, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const C = window.QUIZ_CONFIG, Q = window.QUESTIONS, N = Q.length;
const params = new URLSearchParams(location.search);
const session = params.get('s') === 'post' ? 'post' : 'pre';
const LABEL = { pre: 'Test đầu buổi', post: 'Test cuối buổi' };
const app = document.getElementById('app');
const timerEl = document.getElementById('timer');
document.getElementById('title').textContent = LABEL[session];

const fb = initializeApp(C.firebase);
const auth = getAuth(fb);
const db = getFirestore(fb);

const LS = 'atbx_state_' + session;
let state = {};
try { state = JSON.parse(localStorage.getItem(LS)) || {}; } catch (e) { state = {}; }
const saveLocal = () => { try { localStorage.setItem(LS, JSON.stringify(state)); } catch (e) {} };

let uid = '', cachedToken = '', offset = 0, startMs = 0, endMs = 0, view = '';
let tickTimer = null, syncTimer = null, focusTimer = null, tokenTimer = null, debounce = null, finishing = false, dirty = false, dirtySeq = 0;
let isExited = !!state.isExited, lastExitAt = 0, lastReturnAt = 0, quizFocusedOnce = false;
let shieldOffTimer = null, watermarkEl = null, shieldEl = null, fsOverlayEl = null;
const isDesktop = !/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) && !(navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isFs = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
const canFs = !!(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen);
const now = () => Date.now() + offset;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const msg = html => { view = 'msg'; app.innerHTML = '<div class="card msg">' + html + '</div>'; };
const subRef = () => doc(db, 'subs', session + '_' + startMs + '_' + uid);

function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function answerString() {
  let s = '';
  for (let i = 1; i <= N; i++) { const v = state.answers[i]; s += (v === undefined) ? '-' : 'ABCD'.charAt(v); }
  return s;
}

async function save(final) {
  if (!state.info || !uid || !startMs) return;
  const seq = dirtySeq;
  const answers = answerString();
  const exitCount = Number(state.exitCount || 0);
  await setDoc(subRef(), {
    session, run: startMs, uid,
    name: state.info.name, birth: state.info.birth, unit: state.info.unit,
    answers, answered: answers.replace(/-/g, '').length,
    exitCount,
    final: !!final, updatedAt: serverTimestamp()
  });
  if (dirtySeq === seq) dirty = false;
}

function sendExitBeacon(isFinal) {
  if (!cachedToken || !state.info || !uid || !startMs || !C.firebase || !C.firebase.projectId) return;
  try {
    const docId = session + '_' + startMs + '_' + uid;
    const fields = ['session', 'run', 'uid', 'name', 'birth', 'unit', 'answers', 'answered', 'exitCount', 'final'];
    const mask = fields.map(f => 'updateMask.fieldPaths=' + f).join('&');
    const url = 'https://firestore.googleapis.com/v1/projects/' + encodeURIComponent(C.firebase.projectId) +
      '/databases/(default)/documents/subs/' + encodeURIComponent(docId) + '?' + mask;
    const answers = answerString();
    const payload = {
      fields: {
        session: { stringValue: session },
        run: { integerValue: String(startMs) },
        uid: { stringValue: uid },
        name: { stringValue: String(state.info.name) },
        birth: { stringValue: String(state.info.birth) },
        unit: { stringValue: String(state.info.unit) },
        answers: { stringValue: answers },
        answered: { integerValue: String(answers.replace(/-/g, '').length) },
        exitCount: { integerValue: String(Number(state.exitCount || 0)) },
        final: { booleanValue: !!isFinal }
      }
    };
    fetch(url, {
      method: 'PATCH',
      keepalive: true,
      headers: { 'Authorization': 'Bearer ' + cachedToken, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).catch(() => {});
  } catch (e) {}
}

// Đồng bộ đồng hồ với máy chủ Firebase (chênh lệch giờ điện thoại không ảnh hưởng)
async function syncClock() {
  try {
    const t0 = Date.now();
    await save(false);
    const snap = await getDocFromServer(subRef());
    const t1 = Date.now();
    const ts = snap.data().updatedAt;
    if (ts && ts.toMillis) offset = ts.toMillis() - (t0 + t1) / 2;
  } catch (e) { dirty = true; }
}

async function init() {
  if (!C.firebase || String(C.firebase.apiKey).indexOf('DAN_') === 0) { msg('Chưa cấu hình Firebase (config.js).'); return; }
  msg('Đang kết nối…');
  onIdTokenChanged(auth, user => {
    if (user) user.getIdToken().then(t => { cachedToken = t; }).catch(() => {});
  });
  try {
    const cred = await signInAnonymously(auth);
    uid = cred.user.uid;
    cachedToken = await cred.user.getIdToken();
    clearInterval(tokenTimer);
    tokenTimer = setInterval(() => {
      if (auth.currentUser) auth.currentUser.getIdToken().then(t => { cachedToken = t; }).catch(() => {});
    }, 240000);
  }
  catch (e) { msg('Không kết nối được máy chủ.<br>Kiểm tra mạng rồi tải lại trang.'); return; }
  // Lắng nghe giờ bắt đầu/kết thúc theo thời gian thực
  onSnapshot(doc(db, 'config', session), snap => applyConfig(snap.exists() ? snap.data() : null),
    () => msg('Mất kết nối máy chủ. Tải lại trang.'));
}

function applyConfig(cfg) {
  if (finishing) return;
  if (!cfg || !cfg.startMs) { msg('Bài kiểm tra chưa bắt đầu.<br>Vui lòng chờ giảng viên — trang sẽ tự mở.'); return; }
  if (state.startMs !== cfg.startMs) {      // lượt mới → làm lại từ đầu, giữ thông tin cá nhân
    state = { startMs: cfg.startMs, info: state.info || null, answers: {}, order: shuffle(Q.map(q => q.id)), finalSent: false };
    isExited = false;
    saveLocal();
    view = '';
  }
  if (state.finalSent) { showDone(); return; }
  startMs = cfg.startMs; endMs = cfg.endMs;
  if (state.info && (Number(state.exitCount) || 0) >= 3) { finish('cheat'); return; }
  if (now() >= endMs) { if (state.info) finish(); else msg('Đã hết giờ làm bài.'); return; }
  startTick();
  if (!state.info) { if (view !== 'info') showInfo(); }
  else if (view !== 'quiz') { showQuiz(); syncClock(); }
}

function startTick() {
  clearInterval(tickTimer);
  const tick = () => {
    const left = Math.max(0, endMs - now());
    const m = Math.floor(left / 60000), s = Math.floor(left % 60000 / 1000);
    timerEl.textContent = String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    timerEl.className = 'timer' + (left === 0 ? ' end' : left < 60000 ? ' warn' : '');
    if (left === 0 && !finishing) { clearInterval(tickTimer); if (state.info) finish(); else msg('Đã hết giờ làm bài.'); }
  };
  tick();
  tickTimer = setInterval(tick, 500);
}

function showInfo() {
  view = 'info';
  app.innerHTML =
    '<div class="card"><h2 style="margin-top:0">Thông tin học viên</h2>' +
    '<p class="note">Đồng hồ đã chạy. Điền thông tin rồi bắt đầu làm bài. Hết giờ, bài <b>tự động nộp</b> — không cần bấm nộp. Không đóng trang này.</p>' +
    '<label class="f">Họ và tên</label><input type="text" id="fName" autocomplete="name">' +
    '<label class="f">Năm sinh</label><input type="text" id="fBirth" inputmode="numeric" maxlength="4">' +
    '<label class="f">Đơn vị / khoa</label><input type="text" id="fUnit">' +
    '<p id="fErr" class="err"></p><button id="fGo" style="width:100%">Bắt đầu làm bài</button></div>';
  // Điền sẵn thông tin đã nhập ở lần kiểm tra kia (nếu cùng máy)
  try {
    const other = JSON.parse(localStorage.getItem('atbx_state_' + (session === 'pre' ? 'post' : 'pre')) || '{}').info;
    if (other) { document.getElementById('fName').value = other.name; document.getElementById('fBirth').value = other.birth; document.getElementById('fUnit').value = other.unit; }
  } catch (e) {}
  document.getElementById('fGo').onclick = () => {
    const name = document.getElementById('fName').value.trim().slice(0, 120);
    const birth = document.getElementById('fBirth').value.trim();
    const unit = document.getElementById('fUnit').value.trim().slice(0, 120);
    if (name.length < 3 || !/^\d{4}$/.test(birth) || !unit) {
      document.getElementById('fErr').textContent = 'Vui lòng điền đủ họ tên, năm sinh (4 số) và đơn vị.';
      return;
    }
    state.info = { name, birth, unit }; saveLocal();
    if (isDesktop && canFs) enterFs();
    showQuiz();
    syncClock();
  };
}

function enterFs() {
  const el = document.documentElement;
  const fn = el.requestFullscreen || el.webkitRequestFullscreen;
  if (fn) {
    try { return Promise.resolve(fn.call(el)).catch(() => {}); } catch (e) {}
  }
  return Promise.resolve();
}

function showFsOverlay(isViolation) {
  if (!isDesktop || !canFs || finishing || state.finalSent) return;
  if (!fsOverlayEl) {
    fsOverlayEl = document.createElement('div');
    fsOverlayEl.className = 'fs-overlay';
    fsOverlayEl.innerHTML = '<h2></h2><p></p><button id="btnEnterFs" style="padding:12px 24px;font-size:16px">🖥️ Vào Toàn màn hình để làm bài</button>';
    document.body.appendChild(fsOverlayEl);
    fsOverlayEl.querySelector('#btnEnterFs').onclick = async () => {
      await enterFs();
      if (isFs()) {
        fsOverlayEl.classList.add('hidden');
        document.body.classList.remove('shield-on');
        handleReturn('fullscreen-reenter');
      }
    };
  }
  const h2 = fsOverlayEl.querySelector('h2');
  const p = fsOverlayEl.querySelector('p');
  if (isViolation) {
    h2.textContent = '⛔ CẢNH BÁO: ĐÃ THOÁT TOÀN MÀN HÌNH!';
    p.textContent = 'Bạn vừa thoát khỏi chế độ toàn màn hình. Hành vi này đã được ghi nhận là 1 lần vi phạm (' + (state.exitCount || 0) + '/3). Vui lòng quay lại toàn màn hình ngay!';
  } else {
    h2.textContent = '🖥️ Yêu cầu chế độ Toàn màn hình';
    p.textContent = 'Bài thi trên máy tính bắt buộc thực hiện ở chế độ Toàn màn hình (Fullscreen). Nhấn nút bên dưới để tiếp tục làm bài.';
  }
  fsOverlayEl.classList.remove('hidden');
}

function hideFsOverlay() {
  if (fsOverlayEl) fsOverlayEl.remove();
  fsOverlayEl = null;
}

function ensureShield() {
  if (!shieldEl) {
    shieldEl = document.createElement('div');
    shieldEl.className = 'privacy-shield';
    shieldEl.innerHTML = '<div>🛡️ Đề thi đang được bảo vệ.<br><span style="font-size:15px;font-weight:400;opacity:0.85">Vui lòng quay lại màn hình làm bài. Nghiêm cấm chuyển tab hoặc chụp màn hình.</span></div>';
  }
  if (!shieldEl.parentNode) {
    document.body.appendChild(shieldEl);
  }
}

function renderWatermark() {
  if (!state.info) return;
  if (!watermarkEl) {
    watermarkEl = document.createElement('div');
    watermarkEl.className = 'watermark-layer';
    watermarkEl.setAttribute('aria-hidden', 'true');
  }
  if (!watermarkEl.parentNode) {
    document.body.appendChild(watermarkEl);
  }
  const text = state.info.name + ' - ' + state.info.birth + ' - ' + state.info.unit;
  const tileW = Math.max(320, text.length * 10 + 80);
  const tileH = 160;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');

  const defs = document.createElementNS(ns, 'defs');
  const pat = document.createElementNS(ns, 'pattern');
  pat.setAttribute('id', 'quizWatermarkPattern');
  pat.setAttribute('width', String(tileW));
  pat.setAttribute('height', String(tileH));
  pat.setAttribute('patternUnits', 'userSpaceOnUse');
  pat.setAttribute('patternTransform', 'rotate(-25)');

  const makeText = (x, y) => {
    const t = document.createElementNS(ns, 'text');
    t.setAttribute('x', String(x));
    t.setAttribute('y', String(y));
    t.setAttribute('fill', '#0B3C5D');
    t.setAttribute('font-size', '15');
    t.setAttribute('font-weight', '700');
    t.setAttribute('font-family', '"Be Vietnam Pro", system-ui, -apple-system, sans-serif');
    t.textContent = text;
    return t;
  };

  pat.appendChild(makeText(20, 50));
  pat.appendChild(makeText(20 + tileW / 2, 130));
  pat.appendChild(makeText(20 - tileW / 2, 130));
  defs.appendChild(pat);
  svg.appendChild(defs);

  const rect = document.createElementNS(ns, 'rect');
  rect.setAttribute('width', '100%');
  rect.setAttribute('height', '100%');
  rect.setAttribute('fill', 'url(#quizWatermarkPattern)');
  svg.appendChild(rect);

  watermarkEl.replaceChildren(svg);
}

function cleanupProtection() {
  clearTimeout(shieldOffTimer);
  clearInterval(focusTimer);
  document.body.classList.remove('quiz-active', 'shield-on');
  hideFsOverlay();
  if (isFs() && document.exitFullscreen) {
    document.exitFullscreen().catch(() => {});
  }
  if (watermarkEl) {
    watermarkEl.replaceChildren();
    watermarkEl.remove();
  }
  if (shieldEl) {
    shieldEl.remove();
  }
}

const baseVpMap = {};
function checkKeyboardCheat() {
  if (isDesktop || view !== 'quiz' || finishing || state.finalSent || !window.visualViewport) return;
  if (isTabletSplitView()) return;
  const vv = window.visualViewport;
  if (Math.abs((vv.scale || 1) - 1) > 0.05) return;
  const ori = window.innerWidth > window.innerHeight ? 'L' : 'P';
  if (!baseVpMap[ori] || vv.height > baseVpMap[ori]) baseVpMap[ori] = vv.height;
  if (baseVpMap[ori] > 400 && (baseVpMap[ori] - vv.height) > 180) {
    handleExit('keyboard-or-slideover');
  }
}

function isTabletSplitView() {
  if (isDesktop) return false;
  const sw = screen.width || 0, sh = screen.height || 0;
  const minScreen = Math.min(sw, sh), maxScreen = Math.max(sw, sh);
  if (minScreen < 600 || !window.innerWidth || !window.innerHeight) return false;
  const fullPortrait = window.innerWidth >= minScreen * 0.90 && window.innerHeight >= maxScreen * 0.70;
  const fullLandscape = window.innerWidth >= maxScreen * 0.90 && window.innerHeight >= minScreen * 0.65;
  return !fullPortrait && !fullLandscape;
}

function checkSplitScreen() {
  if (isDesktop || view !== 'quiz' || finishing || state.finalSent) return;
  if (isTabletSplitView()) {
    ensureShield();
    shieldEl.dataset.splitWarn = '1';
    shieldEl.innerHTML = '<div>⛔ PHÁT HIỆN CHIA ĐÔI MÀN HÌNH (Split View / Cửa sổ thu nhỏ)!<br><span style="font-size:15px;font-weight:400;opacity:0.85">Vui lòng tắt chia đôi màn hình và mở trình duyệt toàn màn hình để làm bài.</span></div>';
    document.body.classList.add('shield-on');
    handleExit('split-screen');
  } else if (shieldEl && shieldEl.dataset.splitWarn === '1') {
    shieldEl.dataset.splitWarn = '';
    shieldEl.innerHTML = '<div>🛡️ Đề thi đang được bảo vệ.<br><span style="font-size:15px;font-weight:400;opacity:0.85">Vui lòng quay lại màn hình làm bài. Nghiêm cấm chuyển tab hoặc chụp màn hình.</span></div>';
    handleReturn('split-screen-fixed');
  }
}

function updateExitBadge() {
  const el = document.getElementById('exitPill');
  if (!el) return;
  const c = Number(state.exitCount || 0);
  el.className = 'exit-pill' + (c >= 2 ? ' danger' : c === 1 ? ' warn' : '');
  el.innerHTML = (c === 0 ? '🛡️' : '⚠️') + ' Giám sát rời màn hình: <b>' + c + '/3</b> lần';
}

function showQuiz() {
  view = 'quiz';
  document.body.classList.add('quiz-active');
  ensureShield();
  renderWatermark();
  if (isDesktop && canFs) {
    setTimeout(() => {
      if (view === 'quiz' && !finishing && !state.finalSent && !isFs()) {
        showFsOverlay(false);
      }
    }, 250);
  }
  let html = '<div class="prog"><span id="pTxt"></span><div class="bar2"><span id="pBar"></span></div></div>' +
    '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px;margin-bottom:10px">' +
    '<span class="note" style="margin:0">' + esc(state.info.name) + ' · ' + esc(state.info.birth) + ' · ' + esc(state.info.unit) + '</span>' +
    '<span class="exit-pill" id="exitPill"></span></div>';
  state.order.forEach((id, idx) => {
    const q = Q.find(x => x.id === id);
    html += '<div class="card" data-q="' + id + '"><div class="grp">' + esc(q.g) + '</div>' +
      '<div class="qn">Câu ' + (idx + 1) + '. ' + esc(q.q) + '</div>';
    q.o.forEach((opt, k) => {
      const sel = state.answers[id] === k;
      html += '<label class="opt' + (sel ? ' sel' : '') + '"><input type="radio" name="q' + id + '" value="' + k + '"' + (sel ? ' checked' : '') + '>' +
        '<span><b>' + 'ABCD'.charAt(k) + '.</b> ' + esc(opt) + '</span></label>';
    });
    html += '</div>';
  });
  html += '<div class="card note" style="text-align:center">Hết giờ bài sẽ tự động nộp. Bạn có thể đổi đáp án đến khi hết giờ.</div>';
  app.innerHTML = html;
  updateProgress();
  updateExitBadge();
  checkSplitScreen();
  clearInterval(syncTimer);
  syncTimer = setInterval(() => { if (dirty) save(false).catch(() => { dirty = true; }); }, 30000);
  quizFocusedOnce = document.hasFocus() && document.visibilityState === 'visible';
  clearInterval(focusTimer);
  focusTimer = setInterval(() => {
    if (view !== 'quiz' || finishing || state.finalSent) return;
    checkSplitScreen();
    const splitLocked = !!(shieldEl && shieldEl.dataset.splitWarn === '1');
    const active = document.hasFocus() && document.visibilityState === 'visible';
    if (active) {
      quizFocusedOnce = true;
      if ((isExited || state.isExited) && !splitLocked) {
        handleReturn('focus-poll');
      }
    } else if (quizFocusedOnce) {
      handleExit('focus-poll');
    }
  }, 400);
  if (state.isExited) {
    handleReturn('quiz-mounted');
  }
}

app.addEventListener('change', e => {
  const t = e.target;
  if (finishing || !t.name || t.name[0] !== 'q') return;
  const id = Number(t.name.slice(1));
  state.answers[id] = Number(t.value); saveLocal(); dirtySeq++; dirty = true;
  t.closest('.card').querySelectorAll('.opt').forEach(l => l.classList.toggle('sel', l.querySelector('input').checked));
  updateProgress();
  clearTimeout(debounce);
  debounce = setTimeout(() => { if (dirty) save(false).catch(() => { dirty = true; }); }, 8000);
});

function updateProgress() {
  const n = Object.keys(state.answers).length;
  document.getElementById('pTxt').textContent = 'Đã trả lời ' + n + '/' + N + ' câu';
  document.getElementById('pBar').style.width = (n / N * 100) + '%';
}

async function finish(reason) {
  if (finishing) return;
  finishing = true;
  cleanupProtection();
  clearInterval(syncTimer); clearTimeout(debounce); clearInterval(tickTimer);
  const oldToast = document.getElementById('exitWarnToast');
  if (oldToast) oldToast.remove();
  timerEl.textContent = '00:00'; timerEl.className = 'timer end';
  document.body.classList.add('locked');
  app.querySelectorAll('input').forEach(i => i.disabled = true);
  const n = Object.keys(state.answers || {}).length;
  const isCheat = reason === 'cheat' || (Number(state.exitCount) || 0) >= 3;
  if (view === 'msg') app.innerHTML = '';
  const banner = document.createElement('div');
  banner.className = 'card msg';
  banner.innerHTML = (isCheat
    ? '⛔ VI PHẠM QUY CHẾ (3/3): Bạn đã rời khỏi màn hình làm bài quá số lần quy định. Hệ thống đang tự động thu bài…'
    : 'Hết giờ. Đang nộp bài… ') +
    '<br><span class="note">Giữ nguyên trang này cho đến khi có thông báo đã nộp.</span>';
  app.prepend(banner); window.scrollTo(0, 0);
  await sleep(Math.random() * 3000);
  for (let attempt = 0; attempt < 15; attempt++) {
    try {
      await Promise.race([save(true), sleep(20000).then(() => { throw new Error('timeout'); })]);
      state.finalSent = true; saveLocal(); showDone(n); return;
    } catch (e) {
      if (e && e.code === 'permission-denied') {
        banner.innerHTML = '<span class="err">Không nộp được: đã quá thời hạn nộp bài.</span><br>Hãy báo giảng viên.';
        return;
      }
      banner.innerHTML = 'Đang thử nộp lại (lần ' + (attempt + 2) + ')… <br><span class="note">Kiểm tra wifi/4G và giữ trang mở.</span>';
      await sleep(3000 + attempt * 2000);
    }
  }
  banner.innerHTML = '<span class="err">Chưa nộp được bài.</span><br>Hãy báo ngay giảng viên và giữ nguyên màn hình này.';
}

function showDone(n) {
  cleanupProtection();
  clearInterval(tickTimer); clearInterval(syncTimer);
  const oldToast = document.getElementById('exitWarnToast');
  if (oldToast) oldToast.remove();
  timerEl.textContent = '00:00'; timerEl.className = 'timer end';
  const k = n === undefined ? Object.keys(state.answers || {}).length : n;
  if ((Number(state.exitCount) || 0) >= 3) {
    msg('<span class="err">⛔ ĐÃ THU BÀI DO VI PHẠM (Rời màn hình ' + state.exitCount + ' lần).</span><br>Bài làm của bạn đã bị khóa và tự động nộp (' + k + '/' + N + ' câu).<br><span class="note">Vui lòng báo giảng viên nếu có sự cố ngoài ý muốn.</span>');
  } else {
    msg('<span class="ok">Bài đã được nộp.</span><br>Bạn đã trả lời ' + k + '/' + N + ' câu.<br><span class="note">Có thể đóng trang này.</span>');
  }
}

function showExitWarning(count) {
  const old = document.getElementById('exitWarnToast');
  if (old) old.remove();
  const toast = document.createElement('div');
  toast.id = 'exitWarnToast';
  toast.className = 'exit-warn-toast';
  toast.innerHTML = count >= 2
    ? '🚨 CẢNH BÁO LẦN CUỐI (2/3): Thêm 1 lần rời màn hình nữa bài thi sẽ bị KHÓA và TỰ ĐỘNG NỘP NGAY LẬP TỨC!'
    : '⚠️ CẢNH BÁO (1/3): Bạn vừa rời khỏi màn hình làm bài! Nếu vi phạm đủ 3 lần, hệ thống sẽ TỰ ĐỘNG THU BÀI!';
  document.body.appendChild(toast);
  if (navigator.vibrate) {
    try { navigator.vibrate([200, 100, 200]); } catch (e) {}
  }
  setTimeout(() => { if (toast.parentNode) toast.remove(); }, 6000);
}

// Xử lý sự kiện học viên rời bài thi (chuyển app, ẩn tab, Split View, Slide Over, blur)
function handleExit(source) {
  if (finishing || state.finalSent || !state.info || !startMs) return;
  if (view === 'quiz') {
    clearTimeout(shieldOffTimer);
    document.body.classList.add('shield-on');
  }
  const nowMs = Date.now();
  // Debounce 1000ms: tránh đếm trùng khi nhiều sự kiện (blur, visibilitychange, pagehide) cùng kích hoạt liên tiếp
  if (isExited || (nowMs - lastExitAt < 1000)) return;

  isExited = true;
  lastExitAt = nowMs;
  state.isExited = true;
  state.exitCount = (Number(state.exitCount) || 0) + 1;
  updateExitBadge();
  dirtySeq++;
  dirty = true;
  if (state.exitCount >= 3) {
    isExited = false;
    state.isExited = false;
    saveLocal();
    sendExitBeacon(true);
    finish('cheat');
    return;
  }
  saveLocal();
  sendExitBeacon(false);
  save(false).catch(() => { dirty = true; });
}

// Xử lý sự kiện học viên quay lại màn hình làm bài (visible, focus, pageshow)
function handleReturn(source) {
  if (finishing || state.finalSent || !state.info || !startMs) return;
  if (document.visibilityState === 'hidden') return;
  const splitLocked = !!(shieldEl && shieldEl.dataset.splitWarn === '1');
  const fsLocked = !!(fsOverlayEl && !fsOverlayEl.classList.contains('hidden'));
  if (!splitLocked && !fsLocked) {
    clearTimeout(shieldOffTimer);
    shieldOffTimer = setTimeout(() => {
      document.body.classList.remove('shield-on');
    }, 300);
  }
  const nowMs = Date.now();
  if (!isExited && !state.isExited) return;
  if (nowMs - lastReturnAt < 800) return;

  lastReturnAt = nowMs;
  isExited = false;
  state.isExited = false;
  saveLocal();
  updateExitBadge();

  if ((Number(state.exitCount) || 0) > 0) {
    showExitWarning(state.exitCount);
    save(false).catch(() => { dirty = true; });
  } else if (dirty) {
    save(false).catch(() => { dirty = true; });
  }
}

// 1. Chuyển tab hoặc ẩn trình duyệt (toàn bộ iPhone, Android, Tablet, Máy tính)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    handleExit('visibilitychange-hidden');
  } else if (document.visibilityState === 'visible') {
    handleReturn('visibilitychange-visible');
  }
});

// 2. iOS / Safari WebKit chuyển app, khóa màn hình, dọn ram
window.addEventListener('pagehide', () => handleExit('pagehide'));
window.addEventListener('pageshow', () => handleReturn('pageshow'));

// 3. iPad / Máy tính bảng chia đôi màn hình (Split View), cửa sổ nổi (Slide Over), chạm ra app khác
window.addEventListener('blur', e => {
  if (e && e.target && e.target !== window && e.target !== document) return;
  handleExit('blur');
});
window.addEventListener('focus', e => {
  if (e && e.target && e.target !== window && e.target !== document) return;
  handleReturn('focus');
});

// 4. Chặn chuột phải, sao chép, cắt, kéo thả khi đang làm bài
['contextmenu', 'copy', 'cut', 'dragstart'].forEach(evt => {
  document.addEventListener(evt, e => {
    if (view === 'quiz' && !finishing) e.preventDefault();
  });
});

// 5. Chặn phím tắt chụp màn hình, in ấn, lưu trang, DevTools
function handleProtectedKey(e) {
  if (view !== 'quiz' || finishing) return;
  const k = (e.key || '').toLowerCase();
  const code = e.code || '';
  const mod = e.ctrlKey || e.metaKey;

  const isPrintScreen = e.key === 'PrintScreen' || code === 'PrintScreen';
  const isF12 = e.key === 'F12' || code === 'F12';
  const isScreenCombo = e.metaKey && e.shiftKey && (['s', '3', '4', '5', '#', '$', '%'].includes(k) || ['KeyS', 'Digit3', 'Digit4', 'Digit5'].includes(code));
  const isModShiftCombo = mod && e.shiftKey && (['i', 'j', 's', '3', '4', '5', '#', '$', '%'].includes(k) || ['KeyI', 'KeyJ', 'KeyS', 'Digit3', 'Digit4', 'Digit5'].includes(code));
  const isModBasicCombo = mod && (['p', 's', 'c', 'u'].includes(k) || ['KeyP', 'KeyS', 'KeyC', 'KeyU'].includes(code));

  if (isPrintScreen || isF12 || isScreenCombo || isModShiftCombo || isModBasicCombo) {
    e.preventDefault();
  }

  if (isPrintScreen || isScreenCombo) {
    clearTimeout(shieldOffTimer);
    document.body.classList.add('shield-on');
    handleExit('screenshot-key');
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText('Không được phép chụp màn hình đề thi!').catch(() => {});
    }
    if (!finishing) {
      setTimeout(() => {
        if (!finishing && view === 'quiz' && document.hasFocus() && document.visibilityState === 'visible') {
          handleReturn('screenshot-recover');
        }
      }, 1500);
    }
  }
}

document.addEventListener('keydown', handleProtectedKey);
document.addEventListener('keyup', handleProtectedKey);

// 6. Ép chế độ Toàn màn hình (Fullscreen) trên máy tính
['fullscreenchange', 'webkitfullscreenchange'].forEach(evt => {
  document.addEventListener(evt, () => {
    if (!isDesktop || view !== 'quiz' || finishing || state.finalSent) return;
    if (!isFs()) {
      handleExit('fullscreen-exit');
      if (!finishing && !state.finalSent) {
        showFsOverlay(true);
      }
    } else if (fsOverlayEl) {
      fsOverlayEl.classList.add('hidden');
      document.body.classList.remove('shield-on');
      handleReturn('fullscreen-reenter');
    }
  });
});

window.addEventListener('resize', () => { checkSplitScreen(); checkKeyboardCheat(); });
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => { checkSplitScreen(); checkKeyboardCheat(); });
}

init();
