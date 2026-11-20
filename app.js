// Trang làm bài của học viên (Firebase). Không có nút nộp: hết giờ là tự nộp.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, signInAnonymously } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFirestore, doc, setDoc, getDoc, getDocFromServer, onSnapshot, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { receiptData, buildReceiptPdf } from './archive-pdf.js';

// Đề thi KHÔNG nằm trong mã nguồn: tải từ Firebase (paper/{lần}) khi giảng viên bấm Bắt đầu.
const C = window.QUIZ_CONFIG;
const F = Object.assign({ idLabel: 'Năm sinh', idShort: 'Năm sinh', idPattern: '^\\d{4}$', idHint: 'năm sinh (4 số)', unitLabel: 'Đơn vị / khoa', unitShort: 'Đơn vị' }, (window.QUIZ_CONFIG || {}).FIELDS || {});
let Q = [], N = 0, ESSAYS = [], E = 0;
const MAXLEN = 8000;
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

let uid = '', offset = 0, startMs = 0, endMs = 0, examId = '', view = '', loadingPaper = 0;
let tickTimer = null, syncTimer = null, debounce = null, finishing = false, dirty = false;
const now = () => Date.now() + offset;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const msg = html => { view = 'msg'; app.innerHTML = '<div class="card msg">' + html + '</div>'; };
const subRef = () => doc(db, 'subs', session + '_' + startMs + '_' + uid);

function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
// Xáo trộn thứ tự A–D trên từng máy; giữ nguyên câu có phương án kiểu "Tất cả các ý trên", "A và B"…
const FIXED = /(tất cả|cả (ba|bốn|3|4)|các (ý|phương án|đáp án) (trên|đều)|không (có )?(ý|phương án|đáp án) nào|\b[ABCD] (và|hoặc) [ABCD]\b|^\s*[ABCD]\s*[,;]|cả [ABCD])/i;
function makePerm(qs, on) {
  const p = {};
  qs.forEach(q => { p[q.id] = (on && !q.o.some(o => FIXED.test(o))) ? shuffle([0, 1, 2, 3]) : [0, 1, 2, 3]; });
  return p;
}
function answerString() {
  let s = '';
  for (let i = 1; i <= N; i++) { const v = state.answers[i]; s += (v === undefined) ? '-' : 'ABCD'.charAt(v); }
  return s;
}

function essayList() {
  const out = [];
  for (let i = 0; i < E; i++) out.push(String((state.essays || [])[i] || '').slice(0, MAXLEN));
  return out;
}

async function save(final) {
  if (!state.info) return;
  dirty = false;
  const answers = answerString();
  await setDoc(subRef(), {
    session, run: startMs, examId, uid,
    name: state.info.name, birth: state.info.birth, unit: state.info.unit,
    answers, answered: answers.replace(/-/g, '').length,
    essays: essayList(),
    awayN: (state.away && state.away.n) || 0, awayMs: Math.round((state.away && state.away.ms) || 0),
    awayLog: ((state.away && state.away.log) || '').slice(-2000), lockedAway: !!state.lockedAway,
    final: !!final, updatedAt: serverTimestamp()
  });
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
  try { uid = (await signInAnonymously(auth)).user.uid; }
  catch (e) { msg('Không kết nối được máy chủ.<br>Kiểm tra mạng rồi tải lại trang.'); return; }
  // Lắng nghe giờ bắt đầu/kết thúc theo thời gian thực
  onSnapshot(doc(db, 'config', session), snap => applyConfig(snap.exists() ? snap.data() : null),
    () => msg('Mất kết nối máy chủ. Tải lại trang.'));
}

function usePaper(p) {
  Q = p.questions; N = Q.length; ESSAYS = p.essays || []; E = ESSAYS.length;
  document.getElementById('title').textContent = (p.title ? p.title + ' · ' : '') + (p.label || LABEL[session]);
}

// Tải đề của lượt đang chạy; máy chủ chỉ cho đọc trong giờ thi nên thử lại nếu vừa bắt đầu
async function loadPaper(cfg) {
  const my = ++loadingPaper;
  msg('Đang tải đề…');
  for (let i = 0; i < 20 && my === loadingPaper; i++) {
    try {
      const snap = await getDocFromServer(doc(db, 'paper', session));
      const p = snap.exists() ? snap.data() : null;
      if (p && p.startMs === cfg.startMs) {
        state = { startMs: cfg.startMs, examId: p.examId, info: state.info || null, answers: {}, essays: [],
          paper: { title: p.title || '', org: p.org || '', label: p.label || '', questions: p.questions, essays: p.essays || [], proctor: p.proctor || null, shuffleOpts: p.shuffleOpts !== false },
          order: shuffle(p.questions.map(q => q.id)), perm: makePerm(p.questions, p.shuffleOpts !== false), away: { n: 0, ms: 0, log: '' }, finalSent: false };
        saveLocal(); view = '';
        applyConfig(lastCfg);
        return;
      }
    } catch (e) { /* chưa tới giờ hoặc mạng chập chờn */ }
    await sleep(1500);
  }
  if (my === loadingPaper) msg('Không tải được đề. Kiểm tra mạng rồi tải lại trang.');
}

let lastCfg = null;
function applyConfig(cfg) {
  lastCfg = cfg;
  if (finishing) return;
  if (!cfg || !cfg.startMs) { msg('Bài kiểm tra chưa bắt đầu.<br>Vui lòng chờ giảng viên — trang sẽ tự mở.'); return; }
  if (state.startMs !== cfg.startMs || !state.paper) {      // lượt mới → tải đề, làm lại từ đầu, giữ thông tin cá nhân
    if (cfg.endMs + 300000 < now() && state.startMs !== cfg.startMs) { msg('Đã hết giờ làm bài.'); return; }
    loadPaper(cfg); return;
  }
  usePaper(state.paper);
  examId = state.examId;
  if (state.finalSent) { startMs = cfg.startMs; showDone(); return; }
  startMs = cfg.startMs; endMs = cfg.endMs;
  if (now() >= endMs) { if (state.info) finish(); else msg('Đã hết giờ làm bài.'); return; }
  startTick();
  if (!state.info) { if (view !== 'info') showInfo(); }
  else if (view !== 'quiz') { showQuiz(); syncClock(); if (state.awayAt) awayEnd(); }
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
    '<label class="f">' + F.idLabel + '</label><input type="text" id="fBirth" inputmode="numeric" maxlength="12">' +
    '<label class="f">' + F.unitLabel + '</label><input type="text" id="fUnit">' +
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
    if (name.length < 3 || !new RegExp(F.idPattern).test(birth) || !unit) {
      document.getElementById('fErr').textContent = 'Vui lòng điền đủ họ tên, ' + F.idHint + ' và ' + F.unitShort.toLowerCase() + '.';
      return;
    }
    state.info = { name, birth, unit }; saveLocal();
    showQuiz();
    syncClock();
  };
}

function showQuiz() {
  view = 'quiz';
  const pr = proctor();
  let html = '<div class="prog"><span id="pTxt"></span><span id="pAway" class="awayTag"></span><div class="bar2"><span id="pBar"></span></div></div>' +
    '<p class="note">' + esc(state.info.name) + ' · ' + esc(state.info.birth) + ' · ' + esc(state.info.unit) + '</p>' +
    '<div class="card rules"><b>Quy định:</b> không rời khỏi trang này (chuyển ứng dụng, mở tab khác, khóa màn hình) trong khi làm bài. Mỗi lần rời trang đều được ghi lại và báo cho giảng viên' +
    (pr.maxN || pr.maxSec ? '; <b>bài tự động khóa và nộp</b> khi rời trang ' + [pr.maxN ? 'quá ' + pr.maxN + ' lần' : '', pr.maxSec ? 'tổng quá ' + pr.maxSec + ' giây' : ''].filter(Boolean).join(' hoặc ') : '') +
    '. Không sao chép, không dán được nội dung.</div>';
  state.order.forEach((id, idx) => {
    const q = Q.find(x => x.id === id);
    html += '<div class="card" data-q="' + id + '">' + (q.g ? '<div class="grp">' + esc(q.g) + '</div>' : '') +
      '<div class="qn">Câu ' + (idx + 1) + '. ' + esc(q.q) + '</div>';
    const perm = (state.perm && state.perm[id]) || [0, 1, 2, 3];
    perm.forEach((k, pos) => {                 // k = phương án gốc (dùng để chấm), pos = vị trí hiển thị
      const sel = state.answers[id] === k;
      html += '<label class="opt' + (sel ? ' sel' : '') + '"><input type="radio" name="q' + id + '" value="' + k + '"' + (sel ? ' checked' : '') + '>' +
        '<span><b>' + 'ABCD'.charAt(pos) + '.</b> ' + esc(q.o[k]) + '</span></label>';
    });
    html += '</div>';
  });
  if (E) {
    if (!state.essays) state.essays = [];
    html += '<div class="card" style="background:#0B3C5D;color:#F5F8FB"><b>PHẦN II — TỰ LUẬN</b><br><span style="font-size:14px">Trả lời ngắn gọn, đủ ý. Bài được tự lưu trong lúc gõ.</span></div>';
    ESSAYS.forEach((e, i) => {
      const v = state.essays[i] || '';
      html += '<div class="card"><div class="grp">Tự luận · ' + String(e.points).replace('.', ',') + ' điểm</div>' +
        '<div class="qn">Câu ' + (N + i + 1) + '. ' + esc(e.q) + '</div>' +
        '<textarea class="essay" data-e="' + i + '" maxlength="' + MAXLEN + '" rows="8" placeholder="Nhập câu trả lời…">' + esc(v) + '</textarea>' +
        '<div class="note" style="text-align:right"><span id="cnt' + i + '">' + v.length + '</span>/' + MAXLEN + ' ký tự</div></div>';
    });
  }
  html += '<div class="card note" style="text-align:center">Hết giờ bài sẽ tự động nộp. Bạn có thể sửa bài đến khi hết giờ.</div>';
  app.innerHTML = html;
  document.body.classList.add('exam');
  setWatermark();
  updateProgress(); showAwayTag();
  clearInterval(syncTimer);
  syncTimer = setInterval(() => { if (dirty) save(false).catch(() => { dirty = true; }); }, 30000);
}

app.addEventListener('change', e => {
  const t = e.target;
  if (finishing || !t.name || t.name[0] !== 'q') return;
  const id = Number(t.name.slice(1));
  state.answers[id] = Number(t.value); saveLocal(); dirty = true;
  t.closest('.card').querySelectorAll('.opt').forEach(l => l.classList.toggle('sel', l.querySelector('input').checked));
  updateProgress();
  clearTimeout(debounce);
  debounce = setTimeout(() => { if (dirty) save(false).catch(() => { dirty = true; }); }, 8000);
});

app.addEventListener('input', e => {
  const t = e.target;
  if (finishing || !t.classList || !t.classList.contains('essay')) return;
  const i = Number(t.dataset.e);
  if (!state.essays) state.essays = [];
  state.essays[i] = t.value.slice(0, MAXLEN); saveLocal(); dirty = true;
  const c = document.getElementById('cnt' + i); if (c) c.textContent = t.value.length;
  updateProgress();
  clearTimeout(debounce);
  debounce = setTimeout(() => { if (dirty) save(false).catch(() => { dirty = true; }); }, 8000);
});

function updateProgress() {
  const n = Object.keys(state.answers).length;
  const ne = E ? (state.essays || []).filter(x => x && x.trim()).length : 0;
  document.getElementById('pTxt').textContent = 'Trắc nghiệm ' + n + '/' + N + (E ? ' · Tự luận ' + ne + '/' + E : '');
  document.getElementById('pBar').style.width = (n / N * 100) + '%';
}

async function finish() {
  if (finishing) return;
  finishing = true;
  clearInterval(syncTimer); clearTimeout(debounce); clearInterval(tickTimer);
  timerEl.textContent = '00:00'; timerEl.className = 'timer end';
  document.body.classList.add('locked');
  app.querySelectorAll('input, textarea').forEach(i => i.disabled = true);
  const n = Object.keys(state.answers || {}).length;
  const banner = document.createElement('div');
  banner.className = 'card msg';
  banner.innerHTML = (state.lockedAway ? 'Bài bị khóa do rời trang quá giới hạn. ' : 'Hết giờ. ') + 'Đang nộp bài… <br><span class="note">Giữ nguyên trang này cho đến khi có thông báo đã nộp.</span>';
  app.prepend(banner); window.scrollTo(0, 0);
  await sleep(Math.random() * 3000);
  for (let attempt = 0; attempt < 15; attempt++) {
    try {
      await Promise.race([save(true), sleep(20000).then(() => { throw new Error('timeout'); })]);
      state.finalSent = true; saveLocal(); showDone(n); return;
    } catch (e) {
      if (e && e.code === 'permission-denied') {
        // Có thể lần gửi trước đã tới máy chủ nhưng mất phản hồi → kiểm tra bài trên máy chủ
        try { const d = await getDocFromServer(subRef()); if (d.exists() && d.data().final) { state.finalSent = true; saveLocal(); showDone(n); return; } } catch (x) {}
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
  clearInterval(tickTimer); clearInterval(syncTimer);
  document.body.classList.remove('exam'); setWatermark(true);
  timerEl.textContent = '00:00'; timerEl.className = 'timer end';
  const k = n === undefined ? Object.keys(state.answers || {}).length : n;
  const ke = E ? (state.essays || []).filter(x => x && x.trim()).length : 0;
  msg((state.lockedAway ? '<span class="err">Bài bị khóa do rời khỏi trang quá giới hạn cho phép.</span><br>' : '') +
    '<span class="ok">Bài đã được nộp.</span><br>' + (state.away && state.away.n ? '<span class="note">Rời trang: ' + state.away.n + ' lần, tổng ' + Math.round(state.away.ms / 1000) + ' giây (đã báo giảng viên).</span><br>' : '') + 'Trắc nghiệm: ' + k + '/' + N + ' câu' + (E ? '<br>Tự luận: ' + ke + '/' + E + ' câu' : '') +
    '<br><button id="btnReceipt" style="margin-top:14px">Tải biên nhận bài làm (PDF)</button><div id="rcInfo" class="note" style="margin-top:8px"></div>' +
    '<span class="note">Biên nhận không có điểm. Lưu file để đối chiếu khi cần.</span>');
  document.getElementById('btnReceipt').onclick = downloadReceipt;
}

function loadScript(src) {
  return new Promise((ok, bad) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => bad(new Error('Không tải được ' + src)); document.head.appendChild(s); });
}

async function downloadReceipt() {
  const btn = document.getElementById('btnReceipt'), info = document.getElementById('rcInfo');
  btn.disabled = true; btn.textContent = 'Đang tạo biên nhận…';
  try {
    if (!state.receipt) {
      // Lấy đúng bản bài làm đã lưu trên máy chủ (kể cả giờ nộp do máy chủ ghi)
      const d = (await getDocFromServer(subRef())).data();
      state.receipt = receiptData({ subId: subRef().id, examId: d.examId, session: d.session, name: d.name, birth: d.birth, unit: d.unit,
        answers: d.answers, essays: d.essays || [], submittedAtMs: d.updatedAt.toMillis() });
      saveLocal();
    }
    if (!window.jspdf) await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js');
    const p = state.paper;
    const { bytes, hash } = await buildReceiptPdf(state.receipt, { title: p.title, org: p.org, sessionLabel: p.label || LABEL[session], idLabel: F.idShort, unitLabel: F.unitShort, questions: p.questions, essays: p.essays });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    a.download = 'bien-nhan_' + String(state.info.name).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').replace(/[^A-Za-z0-9]+/g, '-') + '_' + session + '.pdf';
    document.body.appendChild(a); a.click(); a.remove();
    info.innerHTML = 'Mã biên nhận: <span style="font-family:monospace;word-break:break-all">' + hash + '</span>';
  } catch (e) {
    console.error(e);
    info.innerHTML = '<span class="err">Chưa tạo được biên nhận: ' + esc(e.message || e) + '. Thử lại.</span>';
  }
  btn.disabled = false; btn.textContent = 'Tải biên nhận bài làm (PDF)';
}

// ---------- Giám sát rời trang ----------
// Một lần "rời trang" = trang bị ẩn (chuyển ứng dụng/tab, khóa màn hình) hoặc mất tiêu điểm (cửa sổ khác) ≥ 2 giây.
// Đóng trang rồi mở lại cũng được tính (thời điểm rời được lưu trên máy).
const MIN_AWAY = 2000;
function proctor() { const p = (state.paper && state.paper.proctor) || {}; return { maxN: Number(p.maxN) || 0, maxSec: Number(p.maxSec) || 0 }; }
const inExam = () => view === 'quiz' && !finishing && !state.finalSent && state.info && startMs && now() < endMs;

function awayStart() {
  if (!inExam() || state.awayAt) return;
  state.awayAt = now(); saveLocal();
  if (dirty) save(false).catch(() => { dirty = true; });
}
function awayEnd() {
  if (!state.awayAt) return;
  const t0 = state.awayAt, end = Math.min(now(), endMs || now()), d = Math.max(0, end - t0);
  delete state.awayAt;
  if (d < MIN_AWAY || !state.info || state.finalSent) { saveLocal(); return; }
  if (!state.away) state.away = { n: 0, ms: 0, log: '' };
  state.away.n++; state.away.ms += d;
  const at = new Date(t0).toTimeString().slice(0, 8);
  state.away.log = (state.away.log ? state.away.log + '; ' : '') + at + ' ' + Math.round(d / 1000) + 's';
  const pr = proctor();
  const over = (pr.maxN && state.away.n > pr.maxN) || (pr.maxSec && state.away.ms > pr.maxSec * 1000);
  if (over) state.lockedAway = true;
  saveLocal(); dirty = true;
  if (finishing || state.finalSent) return;
  if (over) { finish(); return; }
  save(false).catch(() => { dirty = true; });
  showAwayTag();
  warnAway(d);
}
function showAwayTag() {
  const el = document.getElementById('pAway'); if (!el) return;
  const n = (state.away && state.away.n) || 0;
  el.textContent = n ? ' · Rời trang ' + n + ' lần' : '';
}
function warnAway(d) {
  const pr = proctor(), a = state.away;
  const left = [];
  if (pr.maxN) left.push('còn ' + Math.max(0, pr.maxN - a.n) + ' lần');
  if (pr.maxSec) left.push('còn ' + Math.max(0, Math.round(pr.maxSec - a.ms / 1000)) + ' giây');
  let box = document.getElementById('awayBox');
  if (!box) { box = document.createElement('div'); box.id = 'awayBox'; document.body.appendChild(box); }
  box.innerHTML = '<div class="awayCard"><div class="err" style="font-size:20px">Bạn vừa rời khỏi trang thi</div>' +
    '<p>Lần thứ <b>' + a.n + '</b> · ' + Math.round(d / 1000) + ' giây. Đã ghi lại và báo giảng viên.</p>' +
    (left.length ? '<p>Trước khi bài bị <b>tự động khóa và nộp</b>: ' + left.join(', ') + '.</p>' : '') +
    '<button id="awayOk" style="width:100%">Tôi đã hiểu — tiếp tục làm bài</button></div>';
  box.classList.remove('hidden');
  document.getElementById('awayOk').onclick = () => box.classList.add('hidden');
}
let blurTimer = null;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    awayStart();
    if (dirty && !finishing && state.info && startMs) save(false).catch(() => { dirty = true; });
  } else awayEnd();
});
window.addEventListener('pagehide', awayStart);
// Máy tính: chuyển sang cửa sổ khác mà trang vẫn hiện (chia đôi màn hình)
window.addEventListener('blur', () => { clearTimeout(blurTimer); blurTimer = setTimeout(() => { if (!document.hasFocus()) awayStart(); }, 300); });
window.addEventListener('focus', () => { clearTimeout(blurTimer); if (document.visibilityState === 'visible') awayEnd(); });

// ---------- Chặn sao chép / dán ----------
['copy', 'cut', 'paste', 'drop', 'dragstart', 'contextmenu', 'selectstart'].forEach(ev => document.addEventListener(ev, e => {
  if (!document.body.classList.contains('exam')) return;
  if (ev === 'selectstart' && e.target.closest && e.target.closest('textarea, input')) return;   // vẫn chọn được chữ trong ô mình gõ để sửa
  e.preventDefault();
  if (ev === 'paste' || ev === 'drop') flash('Không được dán nội dung vào bài thi.');
}, true));
document.addEventListener('beforeinput', e => {
  if (document.body.classList.contains('exam') && /^insertFrom(Paste|Drop|Yank)/.test(e.inputType || '')) { e.preventDefault(); flash('Không được dán nội dung vào bài thi.'); }
}, true);
document.addEventListener('keydown', e => {
  if (!document.body.classList.contains('exam')) return;
  const k = (e.key || '').toLowerCase();
  if ((e.ctrlKey || e.metaKey) && ['c', 'x', 'v', 'a', 'p', 's', 'u'].includes(k) && !(k === 'a' && e.target.closest && e.target.closest('textarea'))) { e.preventDefault(); if (k === 'v') flash('Không được dán nội dung vào bài thi.'); }
}, true);
function flash(t) {
  let f = document.getElementById('flash');
  if (!f) { f = document.createElement('div'); f.id = 'flash'; document.body.appendChild(f); }
  f.textContent = t; f.classList.add('on'); clearTimeout(f._t); f._t = setTimeout(() => f.classList.remove('on'), 2000);
}

// ---------- Hình mờ họ tên trên nền đề ----------
function setWatermark(off) {
  let w = document.getElementById('wm');
  if (off) { if (w) w.remove(); return; }
  if (!state.info) return;
  if (!w) { w = document.createElement('div'); w.id = 'wm'; document.body.appendChild(w); }
  const t = (state.info.name + ' · ' + state.info.birth + ' · ' + new Date(startMs).toLocaleDateString('vi-VN')).replace(/[<>&"]/g, '');
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="200"><text x="10" y="120" transform="rotate(-25 180 100)" font-family="Arial, sans-serif" font-size="17" font-weight="700" fill="#0B3C5D" fill-opacity="0.10">' + t + '</text></svg>';
  w.style.backgroundImage = 'url("data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg) + '")';
}

init();
