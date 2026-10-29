// Trang làm bài của học viên (Firebase). Không có nút nộp: hết giờ là tự nộp.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, signInAnonymously } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
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

let uid = '', offset = 0, startMs = 0, endMs = 0, view = '';
let tickTimer = null, syncTimer = null, debounce = null, finishing = false, dirty = false;
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
  if (!state.info) return;
  dirty = false;
  const answers = answerString();
  await setDoc(subRef(), {
    session, run: startMs, uid,
    name: state.info.name, birth: state.info.birth, unit: state.info.unit,
    answers, answered: answers.replace(/-/g, '').length,
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

function applyConfig(cfg) {
  if (finishing) return;
  if (!cfg || !cfg.startMs) { msg('Bài kiểm tra chưa bắt đầu.<br>Vui lòng chờ giảng viên — trang sẽ tự mở.'); return; }
  if (state.startMs !== cfg.startMs) {      // lượt mới → làm lại từ đầu, giữ thông tin cá nhân
    state = { startMs: cfg.startMs, info: state.info || null, answers: {}, order: shuffle(Q.map(q => q.id)), finalSent: false };
    saveLocal();
    view = '';
  }
  if (state.finalSent) { showDone(); return; }
  startMs = cfg.startMs; endMs = cfg.endMs;
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
    showQuiz();
    syncClock();
  };
}

function showQuiz() {
  view = 'quiz';
  let html = '<div class="prog"><span id="pTxt"></span><div class="bar2"><span id="pBar"></span></div></div>' +
    '<p class="note">' + esc(state.info.name) + ' · ' + esc(state.info.birth) + ' · ' + esc(state.info.unit) + '</p>';
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

function updateProgress() {
  const n = Object.keys(state.answers).length;
  document.getElementById('pTxt').textContent = 'Đã trả lời ' + n + '/' + N + ' câu';
  document.getElementById('pBar').style.width = (n / N * 100) + '%';
}

async function finish() {
  if (finishing) return;
  finishing = true;
  clearInterval(syncTimer); clearTimeout(debounce); clearInterval(tickTimer);
  timerEl.textContent = '00:00'; timerEl.className = 'timer end';
  document.body.classList.add('locked');
  app.querySelectorAll('input').forEach(i => i.disabled = true);
  const n = Object.keys(state.answers || {}).length;
  const banner = document.createElement('div');
  banner.className = 'card msg';
  banner.innerHTML = 'Hết giờ. Đang nộp bài… <br><span class="note">Giữ nguyên trang này cho đến khi có thông báo đã nộp.</span>';
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
  clearInterval(tickTimer); clearInterval(syncTimer);
  timerEl.textContent = '00:00'; timerEl.className = 'timer end';
  const k = n === undefined ? Object.keys(state.answers || {}).length : n;
  msg('<span class="ok">Bài đã được nộp.</span><br>Bạn đã trả lời ' + k + '/' + N + ' câu.<br><span class="note">Có thể đóng trang này.</span>');
}

// Lưu ngay khi học viên chuyển ứng dụng hoặc khóa màn hình
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && dirty && !finishing && state.info && startMs) save(false).catch(() => { dirty = true; });
});

init();
