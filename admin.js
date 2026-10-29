// Trang giảng viên (Firebase): bắt đầu lượt thi, hiện QR + đồng hồ, chấm điểm, xuất CSV.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, signInWithEmailAndPassword, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFirestore, doc, setDoc, getDoc, getDocFromServer, onSnapshot, collection, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const C = window.QUIZ_CONFIG;
const fb = initializeApp(C.firebase);
const auth = getAuth(fb);
const db = getFirestore(fb);
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const N = (window.QUESTIONS && window.QUESTIONS.length) || 50;

let offset = 0, KEY = '', status = { pre: null, post: null }, subs = [], tick = null, qr = null, started = false;
const base = location.href.replace(/admin\.html.*$/, '').replace(/[?#].*$/, '');
const quizUrl = s => base + 'index.html?s=' + s;
const now = () => Date.now() + offset;
const fmt = ms => { ms = Math.max(0, ms); return String(Math.floor(ms / 60000)).padStart(2, '0') + ':' + String(Math.floor(ms % 60000 / 1000)).padStart(2, '0'); };

async function login() {
  $('loginErr').textContent = '';
  try { await signInWithEmailAndPassword(auth, $('email').value.trim(), $('pass').value); }
  catch (e) { $('loginErr').textContent = 'Đăng nhập không thành công: ' + (e.code || e.message); }
}

onAuthStateChanged(auth, async user => {
  if (!user || user.isAnonymous || started) return;
  // Kiểm tra quyền giảng viên bằng cách đọc khu vực bí mật
  try {
    const t0 = Date.now();
    await setDoc(doc(db, 'secret', 'clock'), { t: serverTimestamp() });
    const snap = await getDocFromServer(doc(db, 'secret', 'clock'));
    offset = snap.data().t.toMillis() - (t0 + Date.now()) / 2;
    const k = await getDoc(doc(db, 'secret', 'answerKey'));
    KEY = k.exists() ? String(k.data().key || '') : '';
  } catch (e) {
    console.error(e);
    $('loginErr').textContent = 'Tài khoản này không có quyền giảng viên (kiểm tra email trong firestore.rules).';
    return;
  }
  started = true;
  $('login').classList.add('hidden'); $('panel').classList.remove('hidden');
  $('keyBox').classList.toggle('hidden', /^[ABCD]{50}$/.test(KEY));
  $('keyInput').value = KEY;
  ['pre', 'post'].forEach(s => onSnapshot(doc(db, 'config', s), snap => { status[s] = snap.exists() ? snap.data() : null; render(); renderResults(); }));
  onSnapshot(collection(db, 'subs'), snap => { subs = snap.docs.map(d => d.data()); render(); renderResults(); });
  clearInterval(tick); tick = setInterval(render, 500);
});

async function saveKey() {
  const k = $('keyInput').value.trim().toUpperCase();
  if (!new RegExp('^[ABCD]{' + N + '}$').test(k)) { $('keyErr').textContent = 'Cần đúng ' + N + ' ký tự A/B/C/D.'; return; }
  await setDoc(doc(db, 'secret', 'answerKey'), { key: k });
  KEY = k; $('keyErr').textContent = ''; $('keyBox').classList.add('hidden'); renderResults();
}

function cur() { return status[$('session').value]; }

function render() {
  const s = $('session').value, st = cur();
  const running = !!(st && st.startMs && now() < st.endMs);
  const left = st && st.startMs ? st.endMs - now() : 0;
  const txt = st && st.startMs ? fmt(left) : '--:--';
  $('timer').textContent = txt; $('bigTimer').textContent = txt;
  $('bigTimer').style.color = running ? (left < 60000 ? '#C0392B' : '#0B3C5D') : '#5F6B76';
  $('stInfo').textContent = !(st && st.startMs) ? 'Lần này chưa bắt đầu.' :
    running ? 'Đang diễn ra — bắt đầu lúc ' + new Date(st.startMs).toLocaleTimeString('vi-VN') + '.' :
      'Đã kết thúc lúc ' + new Date(st.endMs).toLocaleTimeString('vi-VN') + '.';
  $('live').classList.toggle('hidden', !(st && st.startMs));
  const rows = subs.filter(r => st && r.session === s && r.run === st.startMs);
  $('nJoin').textContent = rows.length;
  $('nDone').textContent = rows.filter(r => r.final).length;
  if (st && st.startMs) showQr(s);
}

function showQr(s) {
  const u = quizUrl(s);
  if (qr && qr._u === u) return;
  $('qr').innerHTML = ''; $('url').textContent = u;
  if (!window.QRCode) { $('qr').textContent = 'Không tải được thư viện QR — kiểm tra mạng.'; qr = { _u: u }; return; }
  qr = new QRCode($('qr'), { text: u, width: 360, height: 360, correctLevel: QRCode.CorrectLevel.M });
  qr._u = u;
}

async function start() {
  const s = $('session').value, st = cur();
  const label = s === 'pre' ? 'TEST ĐẦU BUỔI' : 'TEST CUỐI BUỔI';
  if (!/^[ABCD]{50}$/.test(KEY) && !confirm('Chưa lưu đáp án — vẫn bắt đầu? (Có thể lưu đáp án sau, điểm sẽ được chấm lại.)')) return;
  if (st && st.startMs && !confirm(label + ' đã từng chạy. Bắt đầu lượt MỚI? (Bài của lượt cũ vẫn lưu nhưng không hiện ở đây.)')) return;
  const mins = Math.min(Math.max(Number($('minutes').value) || 15, 1), 180);
  const t = Math.round(now());
  try { await setDoc(doc(db, 'config', s), { startMs: t, endMs: t + mins * 60000 }); }
  catch (e) { alert('Không bắt đầu được: ' + (e.code || e.message)); }
}

async function stop() {
  const s = $('session').value, st = cur();
  if (!st || !st.startMs) return;
  if (!confirm('Kết thúc ngay? Bài của học viên sẽ tự nộp.')) return;
  try { await setDoc(doc(db, 'config', s), { startMs: st.startMs, endMs: Math.round(now()) }); }
  catch (e) { alert('Lỗi: ' + (e.code || e.message)); }
}

function grade(r) {
  let c = 0, mask = '';
  for (let i = 0; i < N; i++) { const ok = KEY && r.answers.charAt(i) === KEY.charAt(i); if (ok) c++; mask += ok ? '1' : '0'; }
  return { correct: c, score: Math.round(c / N * 100) / 10, mask };
}

// Ghép đầu/cuối buổi: cùng máy (cùng uid), khác máy thì theo họ tên + năm sinh
function merged() {
  const pick = s => subs.filter(r => r.session === s && status[s] && r.run === status[s].startMs).map(r => Object.assign({}, r, grade(r)));
  const norm = r => String(r.name).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/\s+/g, ' ').trim() + '|' + r.birth;
  const map = new Map();
  pick('pre').forEach(r => map.set(r.uid, { pre: r, post: null }));
  pick('post').forEach(r => {
    const k = map.has(r.uid) ? r.uid : [...map.keys()].find(k => !map.get(k).post && map.get(k).pre && norm(map.get(k).pre) === norm(r));
    if (k) map.get(k).post = r; else map.set('p_' + r.uid, { pre: null, post: r });
  });
  return [...map.values()].sort((a, b) => String((a.pre || a.post).name).localeCompare(String((b.pre || b.post).name), 'vi'));
}

function renderResults() {
  if (!$('panel') || $('panel').classList.contains('hidden')) return;
  const list = merged();
  const sc = x => x ? x.score.toFixed(1) + (x.final ? '' : '*') : '—';
  let h = '<tr><th>#</th><th>Họ tên</th><th>Năm sinh</th><th>Đơn vị</th><th class="num">Đầu buổi</th><th class="num">Cuối buổi</th><th class="num">Thay đổi</th></tr>';
  list.forEach((m, i) => {
    const r = m.pre || m.post;
    const d = (m.pre && m.post) ? (m.post.score - m.pre.score) : null;
    h += '<tr><td>' + (i + 1) + '</td><td>' + esc(r.name) + '</td><td>' + esc(r.birth) + '</td><td>' + esc(r.unit) + '</td>' +
      '<td class="num">' + sc(m.pre) + '</td><td class="num">' + sc(m.post) + '</td>' +
      '<td class="num">' + (d === null ? '' : (d > 0 ? '+' : '') + d.toFixed(1)) + '</td></tr>';
  });
  $('tbl').innerHTML = h;

  const avg = s => { const a = list.map(m => m[s]).filter(Boolean); return a.length ? (a.reduce((x, y) => x + y.score, 0) / a.length).toFixed(2) : '—'; };
  const cnt = s => list.filter(m => m[s]).length;
  $('summary').innerHTML = !KEY ? '<p class="err">Chưa lưu đáp án — chưa chấm được điểm.</p>' :
    '<div class="stat"><b>' + cnt('pre') + '</b>bài đầu buổi</div><div class="stat"><b>' + avg('pre') + '</b>điểm TB đầu buổi</div>' +
    '<div class="stat"><b>' + cnt('post') + '</b>bài cuối buổi</div><div class="stat"><b>' + avg('post') + '</b>điểm TB cuối buổi</div>';

  const rate = s => {
    const rows = list.map(m => m[s]).filter(Boolean);
    return Array.from({ length: N }, (_, i) => rows.length ? Math.round(rows.filter(r => r.mask.charAt(i) === '1').length / rows.length * 100) : null);
  };
  const a = rate('pre'), b = rate('post');
  let q = '';
  for (let i = 0; i < N; i++) {
    const low = b[i] !== null && b[i] < 70;
    q += '<div class="qcell">Câu ' + (i + 1) + '<br>' + (a[i] === null ? '—' : a[i] + '%') + ' → <span class="' + (low ? 'lo' : '') + '">' + (b[i] === null ? '—' : b[i] + '%') + '</span></div>';
  }
  $('qstats').innerHTML = q;
}

function download(lines, name) {
  const text = '﻿' + lines.map(l => l.map(v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"').join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  a.download = name + '-' + new Date().toISOString().slice(0, 10) + '.csv';
  a.click();
}
function csv() {
  const lines = [['Họ tên', 'Năm sinh', 'Đơn vị', 'Điểm đầu buổi', 'Số đúng đầu buổi', 'Điểm cuối buổi', 'Số đúng cuối buổi', 'Thay đổi']];
  merged().forEach(m => {
    const r = m.pre || m.post;
    lines.push([r.name, r.birth, r.unit, m.pre ? m.pre.score : '', m.pre ? m.pre.correct : '', m.post ? m.post.score : '', m.post ? m.post.correct : '',
      (m.pre && m.post) ? (m.post.score - m.pre.score).toFixed(1) : '']);
  });
  download(lines, 'diem-atbx');
}
function csvFull() {
  const head = ['Lần', 'Họ tên', 'Năm sinh', 'Đơn vị', 'Số đúng', 'Điểm', 'Nộp chính thức'];
  for (let i = 1; i <= N; i++) head.push('C' + i);
  const lines = [head];
  merged().forEach(m => ['pre', 'post'].forEach(s => {
    const r = m[s]; if (!r) return;
    lines.push([s === 'pre' ? 'Đầu buổi' : 'Cuối buổi', r.name, r.birth, r.unit, r.correct, r.score, r.final ? 'Có' : 'Chưa'].concat(r.answers.split('')));
  }));
  download(lines, 'chi-tiet-dap-an-atbx');
}

$('btnLogin').onclick = login;
$('pass').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });
$('btnKey').onclick = saveKey;
$('btnEditKey').onclick = () => { $('keyBox').classList.remove('hidden'); $('keyInput').focus(); };
$('btnStart').onclick = start;
$('btnStop').onclick = stop;
$('btnCsv').onclick = csv;
$('btnCsvFull').onclick = csvFull;
$('session').onchange = () => { qr = null; render(); };
