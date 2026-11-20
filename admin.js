// Trang giảng viên (Firebase) — nhiều môn thi.
// Ngân hàng đề (câu hỏi + đáp án + tự luận) chỉ nằm trong Firestore (exams/*), không có trên GitHub.
// Khi bấm Bắt đầu: đề KHÔNG kèm đáp án được công bố vào paper/{lần}, học viên chỉ đọc được trong giờ thi.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, signInWithEmailAndPassword, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFirestore, doc, setDoc, getDocFromServer, getDocs, deleteDoc, writeBatch, onSnapshot, collection, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { sha256Hex, canonical, fmtTime, buildSubmissionPdf, buildExamPdf, buildManifestPdf, receiptData } from './archive-pdf.js';

const C = window.QUIZ_CONFIG;
const F = Object.assign({ idLabel: 'Năm sinh', idShort: 'Năm sinh', idPattern: '^\\d{4}$', idHint: 'năm sinh (4 số)', unitLabel: 'Đơn vị / khoa', unitShort: 'Đơn vị' }, (window.QUIZ_CONFIG || {}).FIELDS || {});
const fb = initializeApp(C.firebase);
const auth = getAuth(fb);
const db = getFirestore(fb);
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const LABEL = { pre: 'Test đầu buổi', post: 'Test cuối buổi' };
const GRACE = 5 * 60000;               // chờ bài nộp trễ do mạng trước khi cho lập hồ sơ
const ms = t => t && t.toMillis ? t.toMillis() : (typeof t === 'number' ? t : null);
const num = x => (x === null || x === undefined || x === '') ? '—' : String(Math.round(x * 100) / 100).replace('.', ',');
const slug = s => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

let offset = 0, status = { pre: null, post: null }, subs = [], grades = {}, archives = [], exams = {}, tick = null, qr = null, started = false;
let ADMIN = '', curGrade = null, sel = '', imported = null, editId = '';
const base = location.href.replace(/admin\.html.*$/, '').replace(/[?#].*$/, '');
const quizUrl = s => base + 'index.html?s=' + s;
const now = () => Date.now() + offset;
const fmt = t => { t = Math.max(0, t); return String(Math.floor(t / 60000)).padStart(2, '0') + ':' + String(Math.floor(t % 60000 / 1000)).padStart(2, '0'); };

// ---------- Đề thi ----------
const EX = () => exams[sel] || null;
const nQ = ex => ex ? ex.questions.length : 0;
const pts = ex => Number(ex && ex.mcqPoints) || 0;
const mcqMax = ex => Math.round(nQ(ex) * pts(ex) * 100) / 100;
const sessionsOf = ex => ex && ex.mode === 'single' ? ['pre'] : ['pre', 'post'];
const labelOf = (ex, s) => ex && ex.mode === 'single' ? 'Bài thi' : LABEL[s];
const essaysOn = (ex, s) => !!(ex && ex.essays && ex.essays.length) && !(ex.mode !== 'single' && s === 'pre' && ex.essayPre === false);
const essayMax = (ex, s) => essaysOn(ex, s) ? ex.essays.reduce((a, e) => a + Number(e.points), 0) : 0;
const totalMax = (ex, s) => mcqMax(ex) + essayMax(ex, s);
const runOf = (ex, s) => ex && ex.runs && ex.runs[s] ? ex.runs[s].startMs : null;
// Nội dung đề dùng để tính "Mã đề" (SHA-256): đổi bất kỳ chữ nào trong đề/đáp án/barem → mã đổi
const examObject = (id, ex) => ({
  id, title: ex.title, org: ex.org || '', mcqPoints: pts(ex), answerKey: ex.key,
  questions: ex.questions.map(q => ({ id: q.id, g: q.g || '', q: q.q, o: q.o })),
  essays: (ex.essays || []).map(e => ({ id: e.id, q: e.q, points: Number(e.points), rubric: e.rubric || '' }))
});

async function login() {
  $('loginErr').textContent = '';
  try { await signInWithEmailAndPassword(auth, $('email').value.trim(), $('pass').value); }
  catch (e) { $('loginErr').textContent = 'Đăng nhập không thành công: ' + (e.code || e.message); }
}

onAuthStateChanged(auth, async user => {
  if (!user || user.isAnonymous || started) return;
  try {
    const t0 = Date.now();
    await setDoc(doc(db, 'secret', 'clock'), { t: serverTimestamp() });
    const snap = await getDocFromServer(doc(db, 'secret', 'clock'));
    offset = snap.data().t.toMillis() - (t0 + Date.now()) / 2;
  } catch (e) {
    console.error(e);
    $('loginErr').textContent = 'Tài khoản này không có quyền giảng viên (kiểm tra email trong firestore.rules).';
    return;
  }
  started = true; ADMIN = user.email || 'giảng viên';
  try { sel = localStorage.getItem('qz_sel') || ''; } catch (e) {}
  $('login').classList.add('hidden'); $('panel').classList.remove('hidden');
  const all = () => { renderExams(); render(); renderResults(); renderGrading(); };
  let first = true;
  onSnapshot(collection(db, 'exams'), snap => { exams = {}; snap.docs.forEach(d => exams[d.id] = d.data()); all(); if (first && EX()) { first = false; $('minutes').value = EX().minutes || 15; } });
  ['pre', 'post'].forEach(s => onSnapshot(doc(db, 'config', s), snap => { status[s] = snap.exists() ? snap.data() : null; all(); }));
  onSnapshot(collection(db, 'subs'), snap => { subs = snap.docs.map(d => Object.assign({ _id: d.id }, d.data())); all(); });
  onSnapshot(collection(db, 'grades'), snap => { grades = {}; snap.docs.forEach(d => grades[d.id] = d.data()); all(); });
  onSnapshot(collection(db, 'archive'), snap => { archives = snap.docs.map(d => Object.assign({ _id: d.id }, d.data())); renderGrading(); renderArchive(); });
  clearInterval(tick); tick = setInterval(render, 500);
});

// ---------- Ngân hàng đề ----------
function renderExams() {
  const ids = Object.keys(exams).sort();
  if (sel && !exams[sel]) sel = '';
  if (!sel && ids.length) sel = ids[0];
  const opts = ids.map(id => '<option value="' + esc(id) + '"' + (id === sel ? ' selected' : '') + '>' + esc(exams[id].title) + ' (' + esc(id) + ')</option>').join('');
  $('examSel').innerHTML = opts || '<option value="">— chưa có đề, hãy thêm đề —</option>';
  const ex = EX();
  const ss = sessionsOf(ex), cur = $('session').value;
  $('session').innerHTML = ss.map(s => '<option value="' + s + '"' + (s === cur ? ' selected' : '') + '>' + labelOf(ex, s) + '</option>').join('');
  $('sessionWrap').classList.toggle('hidden', ss.length < 2);
  document.querySelectorAll('.exTitle').forEach(e => e.textContent = ex ? ex.title : '');

  let h = '<tr><th>Mã</th><th>Tên đề</th><th>Hình thức</th><th class="num">TN</th><th class="num">TL</th><th class="num">Thang điểm</th><th>Cập nhật</th><th></th></tr>';
  ids.forEach(id => {
    const e = exams[id];
    h += '<tr' + (id === sel ? ' style="background:#EAF3FB"' : '') + '><td style="font-family:monospace">' + esc(id) + '</td><td>' + esc(e.title) + '</td>' +
      '<td>' + (e.mode === 'single' ? 'Một lần thi' : 'Đầu + cuối buổi') + '</td><td class="num">' + nQ(e) + '</td><td class="num">' + (e.essays || []).length + '</td>' +
      '<td class="num">' + num(totalMax(e, 'post')) + '</td><td>' + (e.updatedAtMs ? fmtTime(e.updatedAtMs) : '') + '</td>' +
      '<td style="white-space:nowrap"><button class="sec" data-xs="' + esc(id) + '">Chọn</button> <button class="sec" data-xe="' + esc(id) + '">Sửa</button> ' +
      '<button class="sec" data-xp="' + esc(id) + '">PDF đề + đáp án</button> <button class="sec" data-xd="' + esc(id) + '">Xóa</button></td></tr>';
  });
  $('xtbl').innerHTML = ids.length ? h : '<tr><td class="note">Chưa có đề nào. Bấm “Thêm đề mới”.</td></tr>';
}

function selectExam(id) {
  sel = id; try { localStorage.setItem('qz_sel', id); } catch (e) {}
  if (exams[id]) $('minutes').value = exams[id].minutes || 15;
  qr = null; $('gpanel').classList.add('hidden'); curGrade = null;
  renderExams(); render(); renderResults(); renderGrading();
}

// Đọc file Word (.docx): lấy văn bản từng đoạn
async function docxLines(file) {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const f = zip.file('word/document.xml');
  if (!f) throw new Error('Không phải file Word .docx');
  const xml = new DOMParser().parseFromString(await f.async('string'), 'application/xml');
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const out = [];
  for (const p of xml.getElementsByTagNameNS(W, 'p')) {
    let t = '';
    const walk = n => {
      for (const c of n.childNodes) {
        if (c.namespaceURI === W && c.localName === 't') t += c.textContent;
        else if (c.namespaceURI === W && (c.localName === 'tab')) t += ' ';
        else if (c.namespaceURI === W && (c.localName === 'br' || c.localName === 'cr')) t += '\n';
        else if (c.nodeType === 1 && !(c.namespaceURI === W && c.localName === 'p')) walk(c);
      }
    };
    walk(p);
    t.split('\n').forEach(x => out.push(x.replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').trim()));
  }
  return out;
}

// Mẫu: "Câu 1. …" / "A. … B. …" / "Đáp án: C"; "PHẦN II – TỰ LUẬN"; "Câu 51 (10 điểm). …"; "Hướng dẫn chấm: …"
function parseExam(lines) {
  const questions = [], essays = [], errors = [];
  let mode = 'mcq', cur = null, title = '', group = '', field = 'q';
  const closeQ = () => {
    if (!cur) return;
    if (cur.type === 'mcq') {
      const n = questions.length + 1;
      if (cur.o.some(x => x === undefined || !String(x).trim())) errors.push('Câu ' + cur.no + ': thiếu phương án (cần đủ A, B, C, D).');
      if (!/^[ABCD]$/.test(cur.ans || '')) errors.push('Câu ' + cur.no + ': thiếu dòng "Đáp án: …".');
      if (!cur.q.trim()) errors.push('Câu ' + cur.no + ': thiếu nội dung câu hỏi.');
      questions.push({ id: n, g: cur.g || '', q: cur.q.trim(), o: [0, 1, 2, 3].map(k => String(cur.o[k] || '').trim()), ans: cur.ans || '?', no: cur.no });
    } else {
      if (!(cur.points > 0)) errors.push('Câu ' + cur.no + ' (tự luận): ghi điểm dạng "Câu ' + cur.no + ' (10 điểm). …".');
      if (!cur.q.trim()) errors.push('Câu ' + cur.no + ' (tự luận): thiếu nội dung.');
      essays.push({ id: 'E' + (essays.length + 1), q: cur.q.trim(), points: cur.points || 0, rubric: (cur.rubric || '').trim(), no: cur.no });
    }
    cur = null;
  };
  const addOpts = line => {
    // Tách nhiều phương án trên cùng một dòng: "A. x   B. y"
    const parts = line.split(/\s+(?=[A-Da-d][.)]\s)/);
    parts.forEach(pt => {
      const m = pt.match(/^([A-Da-d])[.)]\s*(.*)$/);
      if (m) { const k = 'ABCD'.indexOf(m[1].toUpperCase()); cur.o[k] = m[2]; cur.lastOpt = k; }
      else if (cur.lastOpt !== undefined) cur.o[cur.lastOpt] += ' ' + pt;
    });
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { continue; }
    let m;
    if (/^PH[ẦA]N\b.*T[ỰU]\s*LU[ẬA]N/i.test(line)) { closeQ(); mode = 'essay'; continue; }
    if (/^PH[ẦA]N\b.*TR[ẮA]C\s*NGHI[ỆE]M/i.test(line)) { closeQ(); mode = 'mcq'; continue; }
    if ((m = line.match(/^(?:T[êe]n đề|Ti[êe]u đề)\s*[:：]\s*(.+)$/i))) { title = m[1].trim(); continue; }
    if ((m = line.match(/^(?:Ch[ủu] đề|Nh[óo]m)\s*[:：]\s*(.+)$/i))) { closeQ(); group = m[1].trim(); continue; }
    if ((m = line.match(/^C[âa]u\s*(\d+)\s*(?:\(\s*([\d.,]+)\s*đi[ểe]m\s*\))?\s*[.:)]?\s*(.*)$/i))) {
      closeQ();
      if (mode === 'mcq') cur = { type: 'mcq', no: +m[1], q: m[3] || '', o: [], g: group };
      else cur = { type: 'essay', no: +m[1], q: m[3] || '', points: m[2] ? Number(m[2].replace(',', '.')) : 0, rubric: '' };
      field = 'q'; continue;
    }
    if (!cur) { if (!title && !/^(PH[ẦA]N|ĐỀ|DE)\b/i.test(line)) title = title || ''; continue; }
    if (cur.type === 'mcq') {
      if ((m = line.match(/^Đ[áa]p\s*[áa]n\s*(?:đ[úu]ng)?\s*[:：]?\s*([A-Da-d])\b/i))) { cur.ans = m[1].toUpperCase(); continue; }
      if (/^[A-Da-d][.)]\s/.test(line)) { addOpts(line); continue; }
      if (cur.lastOpt !== undefined) cur.o[cur.lastOpt] += ' ' + line; else cur.q += (cur.q ? '\n' : '') + line;
    } else {
      if ((m = line.match(/^(?:Hướng dẫn chấm|Barem|Đáp án|Gợi ý chấm)\s*[:：]?\s*(.*)$/i))) { field = 'rubric'; cur.rubric += m[1]; continue; }
      if (field === 'rubric') cur.rubric += (cur.rubric ? '\n' : '') + line; else cur.q += (cur.q ? '\n' : '') + line;
    }
  }
  closeQ();
  if (!questions.length && !essays.length) errors.push('Không tìm thấy câu hỏi nào. Kiểm tra file theo đúng mẫu.');
  if (questions.length > 200) errors.push('Tối đa 200 câu trắc nghiệm.');
  if (essays.length > 10) errors.push('Tối đa 10 câu tự luận.');
  return { title, questions, essays, errors };
}

function openEditor(id) {
  editId = id || ''; imported = null;
  const e = id ? exams[id] : null;
  $('xEditor').classList.remove('hidden');
  $('xEdTitle').textContent = e ? 'Sửa đề: ' + id : 'Thêm đề mới';
  $('xId').value = id || ''; $('xId').disabled = !!id;
  $('xTitle').value = e ? e.title : '';
  $('xOrg').value = e ? (e.org || '') : (C.ORG || '');
  $('xMode').value = e ? (e.mode || 'prepost') : 'prepost';
  $('xPoints').value = e ? e.mcqPoints : '';
  $('xMinutes').value = e ? (e.minutes || 15) : 15;
  $('xEssayPre').checked = e ? e.essayPre !== false : true;
  const pr = (e && e.proctor) || { maxN: 3, maxSec: 30 };
  $('xAwayN').value = pr.maxN; $('xAwaySec').value = pr.maxSec;
  $('xShuffle').checked = e ? e.shuffleOpts !== false : true;
  $('xFile').value = ''; $('xPreview').innerHTML = e ? '<p class="note">Đề hiện có ' + nQ(e) + ' câu trắc nghiệm, ' + (e.essays || []).length + ' câu tự luận. Chọn file Word mới nếu muốn thay nội dung đề.</p>' : '';
  $('xErr').textContent = '';
  $('xEditor').scrollIntoView({ behavior: 'smooth' });
}

async function onFile() {
  const f = $('xFile').files[0]; if (!f) return;
  $('xErr').textContent = ''; imported = null;
  try {
    const r = parseExam(await docxLines(f));
    r.fileName = f.name;
    if (!$('xTitle').value.trim() && r.title) $('xTitle').value = r.title;
    if (!$('xPoints').value && r.questions.length) $('xPoints').value = Math.round(100 / r.questions.length * 100) / 100;
    let h = '<p><b>' + r.questions.length + '</b> câu trắc nghiệm · <b>' + r.essays.length + '</b> câu tự luận (' + num(r.essays.reduce((a, e) => a + e.points, 0)) + ' điểm)</p>';
    if (r.errors.length) h += '<div class="err"><b>Cần sửa trong file Word rồi chọn lại:</b><br>' + r.errors.map(esc).join('<br>') + '</div>';
    h += '<div style="max-height:420px;overflow:auto;border:1px solid #e3e9ef;border-radius:8px;padding:8px 12px">';
    r.questions.forEach((q, i) => {
      h += '<div style="margin:8px 0">' + (q.g ? '<div class="grp">' + esc(q.g) + '</div>' : '') + '<b>Câu ' + (i + 1) + '.</b> ' + esc(q.q) + '<br>' +
        q.o.map((o, k) => '<span style="' + ('ABCD'[k] === q.ans ? 'color:#2E7D4F;font-weight:700' : '') + '">' + 'ABCD'[k] + '. ' + esc(o) + '</span>').join('<br>') + '</div>';
    });
    r.essays.forEach((e, i) => {
      h += '<div style="margin:8px 0"><b>Câu ' + (r.questions.length + i + 1) + ' (tự luận, ' + num(e.points) + ' điểm).</b> ' + esc(e.q).replace(/\n/g, '<br>') +
        (e.rubric ? '<br><span style="color:#2E7D4F">Hướng dẫn chấm: ' + esc(e.rubric).replace(/\n/g, '<br>') + '</span>' : '') + '</div>';
    });
    h += '</div>';
    $('xPreview').innerHTML = h;
    if (!r.errors.length) imported = r;
  } catch (e) { console.error(e); $('xErr').textContent = 'Không đọc được file: ' + e.message; }
}

async function saveExam() {
  $('xErr').textContent = '';
  const id = (editId || $('xId').value.trim().toLowerCase());
  if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(id)) { $('xErr').textContent = 'Mã đề: 2–40 ký tự a–z, 0–9, dấu gạch ngang (ví dụ atbx-ktv).'; return; }
  if (!editId && exams[id]) { $('xErr').textContent = 'Mã đề đã tồn tại.'; return; }
  const title = $('xTitle').value.trim();
  const p = Number(String($('xPoints').value).replace(',', '.'));
  const minutes = Math.min(Math.max(Number($('xMinutes').value) || 15, 1), 180);
  if (!title) { $('xErr').textContent = 'Nhập tên đề.'; return; }
  const old = editId ? exams[editId] : null;
  if (!old && !imported) { $('xErr').textContent = 'Chọn file Word đề thi (đọc không lỗi) trước khi lưu.'; return; }
  const qs = imported ? imported.questions : old.questions;
  if (qs.length && !(p > 0)) { $('xErr').textContent = 'Nhập số điểm mỗi câu trắc nghiệm.'; return; }
  if (old && imported) {
    const used = subs.some(r => r.examId === editId);
    if (used && !confirm('Đề này đã có bài làm. Thay nội dung đề sẽ làm mã đề thay đổi và KHÔNG lập hồ sơ được cho các bài cũ.\nHãy lập hồ sơ các bài cũ trước. Vẫn thay?')) return;
  }
  const data = {
    title, org: $('xOrg').value.trim(), mode: $('xMode').value, mcqPoints: qs.length ? p : 0, minutes,
    essayPre: $('xEssayPre').checked,
    proctor: { maxN: Math.min(Math.max(parseInt($('xAwayN').value, 10) || 0, 0), 50), maxSec: Math.min(Math.max(parseInt($('xAwaySec').value, 10) || 0, 0), 3600) },
    shuffleOpts: $('xShuffle').checked,
    questions: imported ? imported.questions.map(q => ({ id: q.id, g: q.g, q: q.q, o: q.o })) : old.questions,
    key: imported ? imported.questions.map(q => q.ans).join('') : old.key,
    essays: imported ? imported.essays.map(e => ({ id: e.id, q: e.q, points: e.points, rubric: e.rubric })) : (old.essays || []),
    source: imported ? imported.fileName : (old.source || ''),
    runs: old ? (imported ? {} : (old.runs || {})) : {},
    updatedAtMs: Math.round(now()), updatedBy: ADMIN
  };
  if (old && !imported && (old.mcqPoints !== data.mcqPoints || old.title !== data.title || (old.org || '') !== data.org) && subs.some(r => r.examId === editId) &&
    !confirm('Đổi tên đề/đơn vị/điểm mỗi câu sẽ làm mã đề thay đổi; bài đã làm chưa lập hồ sơ sẽ không lập được. Vẫn lưu?')) return;
  if (old && !imported && (old.mcqPoints !== data.mcqPoints || old.title !== data.title || (old.org || '') !== data.org)) data.runs = {};
  try { await setDoc(doc(db, 'exams', id), data); }
  catch (e) { $('xErr').textContent = 'Không lưu được: ' + (e.code || e.message); return; }
  $('xEditor').classList.add('hidden'); imported = null;
  selectExam(id);
  alert('Đã lưu đề "' + title + '" vào Firebase.');
}

async function deleteExam(id) {
  const running = ['pre', 'post'].some(s => status[s] && status[s].examId === id && now() < status[s].endMs);
  if (running) { alert('Đề đang được thi.'); return; }
  const n = subs.filter(r => r.examId === id).length;
  if (!confirm('Xóa đề "' + exams[id].title + '" khỏi ngân hàng đề?' + (n ? '\n(' + n + ' bài làm của đề này vẫn còn cho đến khi bấm Lớp mới.)' : '') + '\nHồ sơ đã lập vẫn giữ nguyên (có file de-thi.json trong ZIP).')) return;
  if (prompt('Gõ mã đề "' + id + '" để xác nhận xóa:') !== id) return;
  try { await deleteDoc(doc(db, 'exams', id)); } catch (e) { alert('Lỗi: ' + (e.code || e.message)); }
}

async function examPdf(id) {
  const ex = exams[id];
  const obj = examObject(id, ex), json = canonical(obj), h = await sha256Hex(json);
  saveBlob(await buildExamPdf(obj, h, ex.updatedAtMs || 0), 'de-va-dap-an_' + id + '.pdf', 'application/pdf');
}

// ---------- Điều khiển lượt thi ----------
const curS = () => $('session').value || 'pre';
function render() {
  if (!$('panel') || $('panel').classList.contains('hidden')) return;
  const s = curS(), st = status[s], ex = EX();
  const mine = !!(st && st.startMs && st.examId === sel);
  const running = !!(st && st.startMs && now() < st.endMs);
  const left = mine ? st.endMs - now() : 0;
  const txt = mine ? fmt(left) : '--:--';
  $('timer').textContent = txt; $('bigTimer').textContent = txt;
  $('bigTimer').style.color = mine && running ? (left < 60000 ? '#C0392B' : '#0B3C5D') : '#5F6B76';
  const other = st && st.startMs && st.examId !== sel && running ? (exams[st.examId] ? exams[st.examId].title : st.examId) : '';
  $('stInfo').textContent = !ex ? 'Chưa chọn đề.' : other ? 'Mục "' + labelOf(ex, s) + '" đang được dùng cho đề khác: ' + other + '.' :
    !mine ? 'Lần này chưa bắt đầu.' :
      running ? 'Đang diễn ra — bắt đầu lúc ' + new Date(st.startMs).toLocaleTimeString('vi-VN') + '.' :
        'Đã kết thúc lúc ' + new Date(st.endMs).toLocaleTimeString('vi-VN') + '.';
  $('live').classList.toggle('hidden', !mine);
  const rows = subs.filter(r => mine && r.session === s && r.run === st.startMs);
  $('nJoin').textContent = rows.length;
  $('nDone').textContent = rows.filter(r => r.final).length;
  $('nAway').textContent = rows.filter(r => r.awayN > 0).length;
  if (mine) showQr(s);
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
  const ex = EX(), s = curS(), st = status[s];
  if (!ex) { alert('Chọn hoặc thêm đề trước.'); return; }
  if (!/^[ABCD]*$/.test(ex.key) || ex.key.length !== nQ(ex)) { alert('Đề chưa đủ đáp án — sửa lại file Word.'); return; }
  if (st && st.startMs && now() < st.endMs) { alert('Mục "' + labelOf(ex, s) + '" đang có lượt thi chạy. Chờ hết giờ hoặc Kết thúc sớm trước.'); return; }
  if (runOf(ex, s) && !confirm(labelOf(ex, s) + ' của đề này đã từng chạy. Bắt đầu lượt MỚI? (Bài lượt cũ vẫn lưu nhưng không hiện ở đây — hãy lập hồ sơ trước.)')) return;
  const mins = Math.min(Math.max(Number($('minutes').value) || ex.minutes || 15, 1), 180);
  const t = Math.round(now()), end = t + mins * 60000;
  try {
    const examHash = await sha256Hex(canonical(examObject(sel, ex)));
    const on = essaysOn(ex, s);
    // 1) Công bố đề KHÔNG có đáp án, không có barem
    await setDoc(doc(db, 'paper', s), {
      examId: sel, startMs: t, endMs: end, title: ex.title, org: ex.org || '', label: labelOf(ex, s),
      questions: ex.questions.map(q => ({ id: q.id, g: q.g || '', q: q.q, o: q.o })),
      essays: on ? ex.essays.map(e => ({ id: e.id, q: e.q, points: Number(e.points) })) : [],
      proctor: ex.proctor || { maxN: 3, maxSec: 30 }, shuffleOpts: ex.shuffleOpts !== false
    });
    // 2) Ghi nhận lượt thi vào đề (để chấm và lập hồ sơ đúng phiên bản đề)
    const runs = Object.assign({}, ex.runs || {}); runs[s] = { startMs: t, examHash };
    await setDoc(doc(db, 'exams', sel), Object.assign({}, ex, { runs }));
    // 3) Bấm giờ — học viên thấy ngay
    await setDoc(doc(db, 'config', s), { startMs: t, endMs: end, examId: sel, n: nQ(ex) });
  } catch (e) { console.error(e); alert('Không bắt đầu được: ' + (e.code || e.message)); }
}

async function stop() {
  const s = curS(), st = status[s];
  if (!st || !st.startMs || st.examId !== sel || now() >= st.endMs) return;
  if (!confirm('Kết thúc ngay? Bài của học viên sẽ tự nộp.')) return;
  const t = Math.round(now());
  try {
    await setDoc(doc(db, 'config', s), Object.assign({}, st, { endMs: t }));
    const p = await getDocFromServer(doc(db, 'paper', s));
    if (p.exists() && p.data().startMs === st.startMs) await setDoc(doc(db, 'paper', s), Object.assign({}, p.data(), { endMs: t }));
  } catch (e) { alert('Lỗi: ' + (e.code || e.message)); }
}

// ---------- Chấm điểm ----------
function grade(r) {
  const ex = exams[r.examId], key = ex ? ex.key : '', N = nQ(ex);
  let c = 0, mask = '';
  for (let i = 0; i < N; i++) { const ok = r.answers.charAt(i) === key.charAt(i); if (ok) c++; mask += ok ? '1' : '0'; }
  const on = essaysOn(ex, r.session), g = grades[r._id], ne = on ? ex.essays.length : 0;
  let essayScore = null, graded = !on;
  if (on && g && Array.isArray(g.scores) && g.scores.length === ne && g.scores.every(x => typeof x === 'number')) {
    essayScore = Math.round(g.scores.reduce((a, b) => a + b, 0) * 100) / 100; graded = true;
  }
  const mcqScore = Math.round(c * pts(ex) * 100) / 100;
  return { correct: c, mcqScore, mask, essayOn: on, essayScore, graded, score: Math.round((mcqScore + (essayScore || 0)) * 100) / 100, totalMax: totalMax(ex, r.session) };
}
const currentSubs = () => {
  const ex = EX(); if (!ex) return [];
  return subs.filter(r => r.examId === sel && r.run === runOf(ex, r.session)).map(r => Object.assign({}, r, grade(r)));
};

function merged() {
  const pick = s => currentSubs().filter(r => r.session === s);
  const norm = r => String(r.name).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/\s+/g, ' ').trim() + '|' + r.birth;
  const map = new Map();
  pick('pre').forEach(r => map.set(r.uid, { pre: r, post: null }));
  pick('post').forEach(r => {
    const k = map.has(r.uid) ? r.uid : [...map.keys()].find(k => !map.get(k).post && map.get(k).pre && norm(map.get(k).pre) === norm(r));
    if (k) map.get(k).post = r; else map.set('p_' + r.uid, { pre: null, post: r });
  });
  return [...map.values()].sort((a, b) => String((a.pre || a.post).name).localeCompare(String((b.pre || b.post).name), 'vi'));
}

function cellScore(x) {
  if (!x) return '—';
  const t = x.essayOn ? (x.graded ? num(x.score) : num(x.mcqScore) + ' + ?') : num(x.score);
  return t + (x.final ? '' : '*');
}

function awayCell(x, full) {
  if (!x) return '—';
  if (!x.awayN) return '<span class="note">0</span>';
  const t = x.awayN + ' lần · ' + Math.round((x.awayMs || 0) / 1000) + 's' + (x.lockedAway ? ' 🔒' : '');
  return '<span class="pill ' + (x.lockedAway ? 'bad' : 'wait') + '" title="' + esc(x.awayLog || '') + '">' + t + '</span>' + (full && x.awayLog ? '<div class="note">' + esc(x.awayLog) + '</div>' : '');
}

function renderResults() {
  if (!$('panel') || $('panel').classList.contains('hidden')) return;
  const ex = EX(), single = ex && ex.mode === 'single', N = nQ(ex);
  if (!ex) { $('tbl').innerHTML = ''; $('summary').innerHTML = ''; $('qstats').innerHTML = ''; return; }
  const list = merged();
  const mx = s => '/' + num(totalMax(ex, s));
  let h = '<tr><th>#</th><th>Họ tên</th><th>' + F.idShort + '</th><th>' + F.unitShort + '</th>' + (single ? '<th class="num">Điểm (' + mx('pre') + ')</th><th>Rời trang</th>' :
    '<th class="num">Đầu buổi (' + mx('pre') + ')</th><th class="num">Cuối buổi (' + mx('post') + ')</th><th class="num">Thay đổi</th><th>Rời trang (đầu / cuối)</th>') + '</tr>';
  list.forEach((m, i) => {
    const r = m.pre || m.post;
    const d = (m.pre && m.post && m.pre.graded && m.post.graded) ? (m.post.score - m.pre.score) : null;
    h += '<tr><td>' + (i + 1) + '</td><td>' + esc(r.name) + '</td><td>' + esc(r.birth) + '</td><td>' + esc(r.unit) + '</td>' +
      '<td class="num">' + cellScore(m.pre) + '</td>' + (single ? '' : '<td class="num">' + cellScore(m.post) + '</td>' +
      '<td class="num">' + (d === null ? '' : (d > 0 ? '+' : '') + num(d)) + '</td>') +
      '<td>' + (single ? awayCell(m.pre) : awayCell(m.pre) + ' / ' + awayCell(m.post)) + '</td></tr>';
  });
  $('tbl').innerHTML = h;

  const avg = s => { const a = list.map(m => m[s]).filter(x => x && x.graded); return a.length ? num(a.reduce((x, y) => x + y.score, 0) / a.length) : '—'; };
  const cnt = s => list.filter(m => m[s]).length;
  $('summary').innerHTML = single ?
    '<div class="stat"><b>' + cnt('pre') + '</b>bài</div><div class="stat"><b>' + avg('pre') + '</b>điểm TB (' + mx('pre') + ')</div>' :
    '<div class="stat"><b>' + cnt('pre') + '</b>bài đầu buổi</div><div class="stat"><b>' + avg('pre') + '</b>điểm TB đầu buổi (' + mx('pre') + ')</div>' +
    '<div class="stat"><b>' + cnt('post') + '</b>bài cuối buổi</div><div class="stat"><b>' + avg('post') + '</b>điểm TB cuối buổi (' + mx('post') + ')</div>';

  const rate = s => {
    const rows = list.map(m => m[s]).filter(Boolean);
    return Array.from({ length: N }, (_, i) => rows.length ? Math.round(rows.filter(r => r.mask.charAt(i) === '1').length / rows.length * 100) : null);
  };
  const a = rate('pre'), b = rate('post');
  let q = '';
  for (let i = 0; i < N; i++) {
    if (single) { const low = a[i] !== null && a[i] < 70; q += '<div class="qcell">Câu ' + (i + 1) + '<br><span class="' + (low ? 'lo' : '') + '">' + (a[i] === null ? '—' : a[i] + '%') + '</span></div>'; continue; }
    const low = b[i] !== null && b[i] < 70;
    q += '<div class="qcell">Câu ' + (i + 1) + '<br>' + (a[i] === null ? '—' : a[i] + '%') + ' → <span class="' + (low ? 'lo' : '') + '">' + (b[i] === null ? '—' : b[i] + '%') + '</span></div>';
  }
  $('qstats').innerHTML = q;
  $('qnote').textContent = single ? 'Câu tô đỏ: dưới 70% trả lời đúng.' : 'Đầu buổi → Cuối buổi. Câu tô đỏ: cuối buổi vẫn dưới 70% đúng — nên chữa lại.';
}

// ---------- Chấm tự luận ----------
const latestArchive = id => archives.filter(a => a.subId === id).sort((x, y) => (y.record.version || 0) - (x.record.version || 0))[0];

function renderGrading() {
  if (!$('panel') || $('panel').classList.contains('hidden')) return;
  const ex = EX();
  const list = currentSubs().sort((a, b) => a.session.localeCompare(b.session) * -1 || String(a.name).localeCompare(String(b.name), 'vi'));
  let h = '<tr><th>Lần</th><th>Họ tên</th><th>' + F.idShort + '</th><th class="num">Trắc nghiệm</th><th class="num">Tự luận</th><th class="num">Tổng</th><th>Rời trang</th><th>Chấm tự luận</th><th>Hồ sơ</th><th></th></tr>';
  list.forEach(r => {
    const a = latestArchive(r._id);
    const arch = a ? (upToDate(r) ? '<span class="pill arch">Đã lưu v' + a.record.version + '</span>' : '<span class="pill wait">Đã chấm lại — lưu v' + (a.record.version + 1) + '</span>') : '<span class="pill wait">Chưa lưu</span>';
    const gs = !r.essayOn ? '<span class="note">Không có</span>' : r.graded ? '<span class="pill ok">Đã chấm</span>' : '<span class="pill wait">Chưa chấm</span>';
    h += '<tr><td>' + labelOf(ex, r.session) + '</td><td>' + esc(r.name) + (r.final ? '' : ' *') + '</td><td>' + esc(r.birth) + '</td>' +
      '<td class="num">' + num(r.mcqScore) + '/' + num(mcqMax(ex)) + '</td><td class="num">' + (r.essayOn ? num(r.essayScore) + '/' + num(essayMax(ex, r.session)) : '—') + '</td>' +
      '<td class="num"><b>' + (r.graded ? num(r.score) : '—') + '</b>/' + num(r.totalMax) + '</td><td>' + awayCell(r) + '</td><td>' + gs + '</td><td>' + arch + '</td>' +
      '<td style="white-space:nowrap">' + (r.essayOn ? '<button class="sec" data-g="' + esc(r._id) + '">Chấm</button> ' : '') +
      '<button class="sec" data-p="' + esc(r._id) + '">Xem PDF</button></td></tr>';
  });
  $('gtbl').innerHTML = h;
  const pend = list.filter(r => !r.graded).length, ready = list.filter(r => r.graded && !upToDate(r)).length;
  $('gInfo').textContent = list.length ? ('Chưa chấm tự luận: ' + pend + ' bài · Đã chấm, chưa lưu hồ sơ (hoặc đã chấm lại): ' + ready + ' bài') : 'Chưa có bài làm của đề này.';
}

function upToDate(r) {
  const a = latestArchive(r._id);
  if (!a) return false;
  const g = grades[r._id];
  const gAt = g ? ms(g.gradedAt) : null;
  const ex = exams[r.examId];
  return a.record.submittedAtMs === ms(r.updatedAt) && (a.record.gradedAtMs || null) === (gAt || null) && (!ex || a.record.answerKey === ex.key);
}

function openGrade(id) {
  const r = currentSubs().find(x => x._id === id), ex = EX();
  if (!r) return;
  curGrade = id;
  const g = grades[id] || {}, N = nQ(ex);
  let h = '<h3 style="margin-top:0">' + esc(r.name) + ' · ' + esc(r.birth) + ' · ' + labelOf(ex, r.session) + '</h3>' +
    '<p class="note">Trắc nghiệm: ' + r.correct + '/' + N + ' câu đúng = ' + num(r.mcqScore) + ' điểm.' + (r.final ? '' : ' Bài là bản lưu gần nhất (học viên rời trang trước giờ).') + '</p>' +
    (r.awayN ? '<p>Rời trang trong khi làm bài: ' + awayCell(r, true) + '</p>' : '');
  ex.essays.forEach((e, i) => {
    const ans = (r.essays || [])[i] || '';
    const sc = g.scores && typeof g.scores[i] === 'number' ? String(g.scores[i]).replace('.', ',') : '';
    h += '<div class="card" style="box-shadow:none;border:1px solid #e3e9ef"><div class="qn">Câu ' + (N + i + 1) + ' (' + num(e.points) + ' điểm). ' + esc(e.q) + '</div>' +
      (e.rubric ? '<details style="margin:6px 0"><summary class="note" style="cursor:pointer">Hướng dẫn chấm</summary><div class="note" style="white-space:pre-wrap;color:#2E7D4F">' + esc(e.rubric) + '</div></details>' : '') +
      '<div class="essayBox">' + (ans.trim() ? esc(ans) : '<i>(bỏ trống)</i>') + '</div>' +
      '<div class="gradeRow"><label>Điểm (0–' + num(e.points) + '): <input type="text" inputmode="decimal" style="width:90px" id="gs' + i + '" value="' + sc + '"></label></div>' +
      '<label class="f">Nhận xét</label><textarea id="gc' + i + '" rows="2" maxlength="1000">' + esc((g.comments || [])[i] || '') + '</textarea></div>';
  });
  h += '<p id="gErr" class="err"></p><div style="display:flex;gap:8px;flex-wrap:wrap">' +
    '<button id="gSave">Lưu điểm</button><button id="gNext">Lưu &amp; bài tiếp theo</button><button class="sec" id="gClose">Đóng</button></div>';
  $('gpanel').innerHTML = h; $('gpanel').classList.remove('hidden');
  $('gSave').onclick = () => saveGrade(false);
  $('gNext').onclick = () => saveGrade(true);
  $('gClose').onclick = () => { $('gpanel').classList.add('hidden'); curGrade = null; };
  $('gpanel').scrollIntoView({ behavior: 'smooth' });
}

async function saveGrade(next) {
  const ex = EX(), scores = [], comments = [], N = nQ(ex);
  for (let i = 0; i < ex.essays.length; i++) {
    const v = $('gs' + i).value.trim().replace(',', '.');
    const x = Number(v);
    if (v === '' || isNaN(x) || x < 0 || x > Number(ex.essays[i].points)) { $('gErr').textContent = 'Câu ' + (N + i + 1) + ': nhập điểm từ 0 đến ' + num(ex.essays[i].points) + '.'; return; }
    scores.push(Math.round(x * 100) / 100);
    comments.push($('gc' + i).value.trim().slice(0, 1000));
  }
  try {
    await setDoc(doc(db, 'grades', curGrade), { scores, comments, grader: ADMIN, gradedAt: serverTimestamp() });
  } catch (e) { $('gErr').textContent = 'Không lưu được: ' + (e.code || e.message); return; }
  if (next) {
    const list = currentSubs().filter(r => r.essayOn && !r.graded && r._id !== curGrade);
    if (list.length) { openGrade(list[0]._id); return; }
    alert('Đã chấm xong tất cả bài tự luận.');
  }
  $('gpanel').classList.add('hidden'); curGrade = null;
}

// ---------- Hồ sơ ----------
async function buildRecord(r, archivedAtMs, preview) {
  const ex = exams[r.examId], g = grades[r._id] || {};
  const examHash = await sha256Hex(canonical(examObject(r.examId, ex)));
  const version = preview ? 0 : archives.filter(a => a.subId === r._id).length + 1;
  const essays = r.essayOn ? ex.essays.map((e, i) => ({
    q: e.q, points: Number(e.points), answer: String((r.essays || [])[i] || ''),
    score: g.scores && typeof g.scores[i] === 'number' ? g.scores[i] : null, comment: (g.comments || [])[i] || ''
  })) : [];
  const st = status[r.session] && status[r.session].startMs === r.run ? status[r.session] : {};
  const receiptHash = await sha256Hex(canonical(receiptData({ subId: r._id, examId: r.examId, session: r.session, name: r.name, birth: r.birth, unit: r.unit,
    answers: r.answers, essays: r.essays || [], submittedAtMs: ms(r.updatedAt) })));
  return {
    archiveId: preview ? 'XEM-TRUOC' : r._id + '_v' + version, version, subId: r._id, examId: r.examId,
    title: ex.title, org: ex.org || '', session: r.session, sessionLabel: labelOf(ex, r.session),
    runStartMs: r.run, runEndMs: st.endMs || null,
    name: r.name, birth: r.birth, unit: r.unit,
    submittedAtMs: ms(r.updatedAt), finalSubmit: !!r.final, receiptHash: r.final ? receiptHash : '',
    awayN: r.awayN || 0, awayMs: r.awayMs || 0, awayLog: r.awayLog || '', lockedAway: !!r.lockedAway,
    examVersion: examHash, answerKey: ex.key, answers: r.answers,
    mcqCorrect: r.correct, mcqScore: r.mcqScore, mcqMax: mcqMax(ex),
    essays, essayScore: r.essayOn ? r.essayScore : null, essayMax: essayMax(ex, r.session),
    total: r.score, totalMax: r.totalMax,
    grader: g.grader || (r.essayOn ? '' : 'Chấm tự động'), gradedAtMs: ms(g.gradedAt) || null,
    idLabel: F.idShort, unitLabel: F.unitShort,
    archivedAtMs, archivedBy: ADMIN
  };
}

function saveBlob(bytes, name, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes], { type }));
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

async function previewPdf(id) {
  const r = currentSubs().find(x => x._id === id);
  if (!r) return;
  try {
    const a = latestArchive(id);
    if (a && upToDate(r)) { await downloadArchived(a._id); return; }
    const rec = await buildRecord(r, Math.round(now()), true);
    const bytes = await buildSubmissionPdf(rec, await sha256Hex(canonical(rec)), { preview: true });
    saveBlob(bytes, 'xem-truoc_' + slug(r.name) + '.pdf', 'application/pdf');
  } catch (e) { console.error(e); alert('Không tạo được PDF: ' + e.message); }
}

async function archiveAll() {
  const ex = EX();
  if (!ex) return;
  const list = currentSubs();
  if (!list.length) { alert('Chưa có bài làm của đề này.'); return; }
  const ended = s => status[s] && status[s].startMs === runOf(ex, s) ? now() > status[s].endMs + GRACE : true;   // ô này đã chuyển sang đề khác → lượt của đề này đã xong từ trước
  if (list.some(r => !ended(r.session))) { alert('Cần chờ 5 phút sau khi lượt kiểm tra kết thúc (nhận bài nộp trễ do mạng) rồi mới lập hồ sơ.'); return; }
  const examHash = await sha256Hex(canonical(examObject(sel, ex)));
  const changed = list.filter(r => ex.runs[r.session] && ex.runs[r.session].examHash !== examHash);
  if (changed.length) { alert('Đề đã bị sửa sau khi thi (mã đề khác lúc bắt đầu). Không thể lập hồ sơ đúng — hãy khôi phục đề như lúc thi (tải lại đúng file Word cũ).'); return; }
  const todo = list.filter(r => r.graded && !upToDate(r));
  const pend = list.filter(r => !r.graded).length;
  if (!todo.length) { alert(pend ? 'Còn ' + pend + ' bài chưa chấm tự luận; không có bài nào sẵn sàng lập hồ sơ.' : 'Tất cả bài đã có hồ sơ mới nhất.'); return; }
  if (!confirm('Lập hồ sơ cho ' + todo.length + ' bài' + (pend ? ' (còn ' + pend + ' bài chưa chấm sẽ bỏ qua)' : '') + '?\nHồ sơ đã lập KHÔNG sửa/xóa được; chấm lại sẽ tạo phiên bản mới.')) return;

  const btn = $('btnArchive'); btn.disabled = true;
  const t = Math.round(now());
  const zip = new JSZip();
  const items = [];
  try {
    const exam = examObject(sel, ex), examJson = canonical(exam);
    zip.file('de-thi/de-thi.json', examJson);
    zip.file('de-thi/de-thi-va-dap-an.pdf', await buildExamPdf(exam, examHash, t));
    for (let i = 0; i < todo.length; i++) {
      const r = todo[i];
      btn.textContent = 'Đang lập hồ sơ ' + (i + 1) + '/' + todo.length + '…';
      const rec = await buildRecord(r, t, false);
      const dataHash = await sha256Hex(canonical(rec));
      const bytes = await buildSubmissionPdf(rec, dataHash);
      const pdfHash = await sha256Hex(bytes);
      await setDoc(doc(db, 'archive', rec.archiveId), {
        subId: r._id, examId: sel, name: rec.name, birth: rec.birth, session: r.session, total: rec.total, totalMax: rec.totalMax,
        record: rec, dataHash, pdfHash, createdAt: serverTimestamp(), createdBy: ADMIN
      });
      const folder = ex.mode === 'single' ? 'bai-lam/' : (r.session === 'pre' ? '1-dau-buoi/' : '2-cuoi-buoi/');
      const fname = folder + slug(rec.name) + '_' + rec.birth + '_' + rec.archiveId + '.pdf';
      zip.file(fname, bytes);
      items.push({ name: rec.name, birth: rec.birth, sessionLabel: rec.sessionLabel, total: num(rec.total) + '/' + num(rec.totalMax), archiveId: rec.archiveId, pdfHash, dataHash, receiptHash: rec.receiptHash, file: fname });
    }
    const csvRows = [['STT', 'Họ tên', F.idShort, 'Lần', 'Tổng điểm', 'Mã hồ sơ', 'File', 'SHA-256 file PDF', 'SHA-256 dữ liệu', 'Mã biên nhận học viên']]
      .concat(items.map((it, i) => [i + 1, it.name, it.birth, it.sessionLabel, it.total, it.archiveId, it.file, it.pdfHash, it.dataHash, it.receiptHash]));
    zip.file('bang-ke-ma-bam.csv', '\ufeff' + csvRows.map(l => l.map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',')).join('\r\n'));
    zip.file('bang-ke-ma-bam.pdf', await buildManifestPdf({ title: ex.title, org: ex.org || '', idLabel: F.idShort }, items, t));
    zip.file('HUONG-DAN-KIEM-TRA.txt',
      'HỒ SƠ BÀI THI — ' + ex.title + ' (mã đề ' + sel + ')\r\nLập lúc: ' + fmtTime(t) + ' bởi ' + ADMIN + '\r\n\r\n' +
      'Kiểm tra một file PDF chưa bị sửa:\r\n  Windows:  certutil -hashfile "<file.pdf>" SHA256\r\n  macOS/Linux:  shasum -a 256 "<file.pdf>"\r\n' +
      'So kết quả với cột "SHA-256 file PDF" trong bang-ke-ma-bam.pdf (bản in đã ký).\r\n' +
      'Có thể kiểm tra nhanh trên trang giảng viên: mục Kho hồ sơ → Kiểm tra file PDF.\r\n\r\n' +
      'Mã đề: SHA-256 của de-thi/de-thi.json phải trùng "Mã đề thi" in trong từng phiếu bài làm.\r\n' +
      'Mã biên nhận: in trên biên nhận PDF học viên tự tải khi nộp bài; trùng với "Mã biên nhận của học viên" trong phiếu bài làm.\r\n');
    btn.textContent = 'Đang nén ZIP…';
    const blob = await zip.generateAsync({ type: 'uint8array' });
    const d = new Date(t);
    saveBlob(blob, 'ho-so_' + sel + '_' + d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0') + '_' + String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0') + '.zip', 'application/zip');
    alert('Đã lập ' + items.length + ' hồ sơ và tải file ZIP. Hãy lưu ZIP vào nơi an toàn và in bảng kê để ký xác nhận.');
  } catch (e) {
    console.error(e);
    alert('Lập hồ sơ bị dừng: ' + (e.code || e.message) + (items.length ? '\nĐã lưu ' + items.length + ' hồ sơ trước khi lỗi; bấm lại để tiếp tục các bài còn lại.' : ''));
  }
  btn.disabled = false; btn.textContent = 'Lập hồ sơ PDF (bài đã chấm xong)';
}

// ---------- Kho hồ sơ ----------
const archCheck = {};
let checking = false;
async function renderArchive() {
  if (!$('atbl')) return;
  const q = slug($('aSearch').value || '').toLowerCase();
  const list = archives.slice().sort((a, b) => (b.record.archivedAtMs || 0) - (a.record.archivedAtMs || 0))
    .filter(a => !q || slug(a.name).toLowerCase().includes(q) || a._id.toLowerCase().includes(q) || slug(a.record.title).toLowerCase().includes(q));
  $('aCount').textContent = archives.length + ' hồ sơ trong kho (mọi đề thi)';
  let h = '<tr><th>Lập lúc</th><th>Đề thi</th><th>Họ tên</th><th>' + F.idShort + '</th><th>Lần</th><th class="num">Tổng</th><th>Mã hồ sơ</th><th>Toàn vẹn dữ liệu</th><th></th></tr>';
  list.slice(0, 300).forEach(a => {
    const ck = archCheck[a._id];
    const integ = ck === undefined ? '…' : ck ? '<span class="pill ok">Khớp</span>' : '<span class="pill wait" style="background:#F4C7C3;color:#7A1F16">KHÔNG KHỚP</span>';
    h += '<tr><td>' + fmtTime(a.record.archivedAtMs) + '</td><td>' + esc(a.record.title) + '</td><td>' + esc(a.name) + '</td><td>' + esc(a.birth) + '</td><td>' + esc(a.record.sessionLabel) + '</td>' +
      '<td class="num">' + num(a.total) + '/' + num(a.totalMax) + '</td><td style="font-family:monospace;font-size:12px">' + esc(a._id) + '</td><td>' + integ + '</td>' +
      '<td><button class="sec" data-a="' + esc(a._id) + '">Tải PDF</button></td></tr>';
  });
  $('atbl').innerHTML = h;
  // Tính lại mã băm dữ liệu từ bản ghi trong kho để phát hiện chỉnh sửa trái phép
  if (checking) return;
  const next = list.slice(0, 300).find(a => archCheck[a._id] === undefined);
  if (!next) return;
  checking = true;
  archCheck[next._id] = (await sha256Hex(canonical(next.record))) === next.dataHash;
  checking = false;
  setTimeout(renderArchive, 0);
}

async function downloadArchived(id) {
  const a = archives.find(x => x._id === id); if (!a) return;
  try {
    const bytes = await buildSubmissionPdf(a.record, a.dataHash);
    const h = await sha256Hex(bytes);
    saveBlob(bytes, a._id + '.pdf', 'application/pdf');
    if (h !== a.pdfHash) alert('Lưu ý: file tạo lại có mã băm khác bảng kê (font hoặc thư viện đã thay đổi). Dữ liệu vẫn nguyên vẹn; file gốc nằm trong ZIP lúc lập hồ sơ.');
  } catch (e) { alert('Không tạo được PDF: ' + e.message); }
}

async function verifyFiles(files) {
  let h = '';
  for (const f of files) {
    const hash = await sha256Hex(new Uint8Array(await f.arrayBuffer()));
    const a = archives.find(x => x.pdfHash === hash);
    h += '<div class="qcell" style="margin:6px 0"><b>' + esc(f.name) + '</b><br><span style="font-family:monospace;font-size:12px">' + hash + '</span><br>' +
      (a ? '<span class="pill ok">KHỚP</span> hồ sơ ' + esc(a._id) + ' · ' + esc(a.name) + ' · ' + esc(a.record.title) + ' · lập lúc ' + fmtTime(a.record.archivedAtMs)
        : '<span class="pill wait" style="background:#F4C7C3;color:#7A1F16">KHÔNG KHỚP</span> không có hồ sơ nào trùng mã băm — file đã bị thay đổi hoặc không thuộc kho này') + '</div>';
  }
  $('verifyOut').innerHTML = h;
}

async function checkReceipt() {
  const h = $('rcHash').value.trim().toLowerCase();
  const a = archives.filter(x => x.record.receiptHash && x.record.receiptHash === h);
  $('rcOut').innerHTML = !/^[0-9a-f]{64}$/.test(h) ? '<span class="err">Mã biên nhận gồm 64 ký tự 0–9, a–f.</span>' :
    a.length ? '<span class="pill ok">KHỚP</span> ' + a.map(x => esc(x.name) + ' · ' + esc(x.record.title) + ' · ' + esc(x.record.sessionLabel) + ' · hồ sơ ' + esc(x._id)).join('<br>') :
      '<span class="pill wait" style="background:#F4C7C3;color:#7A1F16">KHÔNG TÌM THẤY</span> chưa có hồ sơ nào mang mã biên nhận này (bài chưa lập hồ sơ, hoặc biên nhận không đúng).';
}

function csvAll() {
  const lines = [['Lập lúc', 'Mã đề', 'Đề thi', 'Họ tên', F.idShort, F.unitShort, 'Lần', 'Tổng', 'Tối đa', 'Mã hồ sơ', 'SHA-256 file PDF', 'SHA-256 dữ liệu', 'Mã biên nhận', 'Người lập']];
  archives.slice().sort((a, b) => a.record.archivedAtMs - b.record.archivedAtMs).forEach(a => lines.push([fmtTime(a.record.archivedAtMs), a.record.examId || '', a.record.title, a.name, a.birth, a.record.unit, a.record.sessionLabel, a.total, a.totalMax, a._id, a.pdfHash, a.dataHash, a.record.receiptHash || '', a.createdBy]));
  download(lines, 'bang-ke-toan-bo-ho-so');
}

// ---------- CSV điểm ----------
function download(lines, name) {
  const text = '\ufeff' + lines.map(l => l.map(v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"').join(',')).join('\r\n');
  saveBlob(text, name + '-' + new Date().toISOString().slice(0, 10) + '.csv', 'text/csv;charset=utf-8');
}
function csv() {
  const ex = EX(); if (!ex) return;
  const tl = x => x && x.essayOn ? (x.graded ? x.essayScore : 'chưa chấm') : '';
  const tot = x => x ? (x.graded ? x.score : '') : '';
  const single = ex.mode === 'single';
  const aw = x => x ? (x.awayN || 0) + ' lần/' + Math.round((x.awayMs || 0) / 1000) + 's' + (x.lockedAway ? ' (khóa)' : '') : '';
  const lines = [single ? ['Họ tên', F.idShort, F.unitShort, 'Trắc nghiệm', 'Tự luận', 'Tổng', 'Rời trang'] :
    ['Họ tên', F.idShort, F.unitShort, 'TN đầu buổi', 'TL đầu buổi', 'Tổng đầu buổi', 'TN cuối buổi', 'TL cuối buổi', 'Tổng cuối buổi', 'Thay đổi', 'Rời trang đầu buổi', 'Rời trang cuối buổi']];
  merged().forEach(m => {
    const r = m.pre || m.post, p = m.pre, q = m.post;
    lines.push(single ? [r.name, r.birth, r.unit, p ? p.mcqScore : '', tl(p), tot(p), aw(p)] :
      [r.name, r.birth, r.unit, p ? p.mcqScore : '', tl(p), tot(p), q ? q.mcqScore : '', tl(q), tot(q), (p && q && p.graded && q.graded) ? (q.score - p.score) : '', aw(p), aw(q)]);
  });
  download(lines, 'diem_' + sel);
}
function csvFull() {
  const ex = EX(); if (!ex) return;
  const N = nQ(ex);
  const head = ['Lần', 'Họ tên', F.idShort, F.unitShort, 'Số câu TN đúng', 'Điểm TN', 'Điểm TL', 'Tổng', 'Nộp chính thức', 'Số lần rời trang', 'Tổng giây rời trang', 'Bị khóa', 'Chi tiết rời trang'];
  for (let i = 1; i <= N; i++) head.push('C' + i);
  ex.essays.forEach((e, i) => head.push('Tự luận ' + (N + i + 1)));
  const lines = [head];
  merged().forEach(m => ['pre', 'post'].forEach(s => {
    const r = m[s]; if (!r) return;
    lines.push([labelOf(ex, s), r.name, r.birth, r.unit, r.correct, r.mcqScore, r.essayOn ? (r.graded ? r.essayScore : 'chưa chấm') : '', r.graded ? r.score : '', r.final ? 'Có' : 'Chưa', r.awayN || 0, Math.round((r.awayMs || 0) / 1000), r.lockedAway ? 'Có' : '', r.awayLog || '']
      .concat(r.answers.split('')).concat(ex.essays.map((e, i) => (r.essays || [])[i] || '')));
  }));
  download(lines, 'chi-tiet-bai-lam_' + sel);
}

// ---------- Lớp mới (theo đề đang chọn) ----------
async function clearClass() {
  const ex = EX(); if (!ex) return;
  const running = ['pre', 'post'].some(s => status[s] && status[s].examId === sel && now() < status[s].endMs);
  if (running) { alert('Đang có bài kiểm tra của đề này diễn ra. Hãy chờ hết giờ hoặc bấm "Kết thúc sớm" trước.'); return; }
  const mine = subs.filter(r => r.examId === sel);
  const notArch = currentSubs().filter(r => !upToDate(r)).length;
  if (notArch && !confirm('CẢNH BÁO: ' + notArch + ' bài chưa được lập hồ sơ (hoặc đã chấm lại sau khi lập).\nNếu xóa bây giờ, các bài này sẽ KHÔNG có hồ sơ lưu trữ.\nVẫn tiếp tục?')) return;
  if (mine.length && confirm('Tải file CSV điểm của lớp này trước khi xóa?')) csv();
  if (!confirm('XÓA ' + mine.length + ' bài làm của đề "' + ex.title + '" và đặt lại cho lớp mới?\nĐề thi và kho hồ sơ được GIỮ NGUYÊN.')) return;
  $('btnClear').disabled = true; $('btnClear').textContent = 'Đang xóa…';
  try {
    let batch = writeBatch(db), k = 0;
    const del = async ref => { batch.delete(ref); if (++k % 400 === 0) { await batch.commit(); batch = writeBatch(db); } };
    for (const r of mine) {
      await del(doc(db, 'subs', r._id));
      if (grades[r._id]) await del(doc(db, 'grades', r._id));
    }
    await batch.commit();
    for (const s of ['pre', 'post']) if (status[s] && status[s].examId === sel) { await deleteDoc(doc(db, 'config', s)); await deleteDoc(doc(db, 'paper', s)); }
    await setDoc(doc(db, 'exams', sel), Object.assign({}, ex, { runs: {} }));
    qr = null; $('gpanel').classList.add('hidden');
    alert('Đã xóa ' + mine.length + ' bài làm. Đề thi và kho hồ sơ vẫn giữ nguyên. Sẵn sàng cho lớp mới.');
  } catch (e) {
    console.error(e);
    alert('Xóa không thành công: ' + (e.code || e.message));
  }
  $('btnClear').disabled = false; $('btnClear').textContent = 'Lớp mới — xóa danh sách';
}

$('btnLogin').onclick = login;
$('pass').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });
$('btnStart').onclick = start;
$('btnStop').onclick = stop;
$('btnCsv').onclick = csv;
$('btnCsvFull').onclick = csvFull;
$('btnClear').onclick = clearClass;
$('btnArchive').onclick = archiveAll;
$('btnCsvAll').onclick = csvAll;
$('btnNewExam').onclick = () => openEditor('');
$('xFile').onchange = onFile;
$('xSave').onclick = saveExam;
$('xCancel').onclick = () => { $('xEditor').classList.add('hidden'); imported = null; };
$('rcBtn').onclick = checkReceipt;
$('aSearch').oninput = renderArchive;
$('verifyFile').onchange = e => verifyFiles([...e.target.files]);
$('examSel').onchange = e => selectExam(e.target.value);
$('xtbl').onclick = e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.xs) selectExam(b.dataset.xs);
  if (b.dataset.xe) openEditor(b.dataset.xe);
  if (b.dataset.xp) examPdf(b.dataset.xp).catch(err => alert(err.message));
  if (b.dataset.xd) deleteExam(b.dataset.xd);
};
$('gtbl').onclick = e => { const b = e.target.closest('button'); if (!b) return; if (b.dataset.g) openGrade(b.dataset.g); if (b.dataset.p) previewPdf(b.dataset.p); };
$('atbl').onclick = e => { const b = e.target.closest('button'); if (b && b.dataset.a) downloadArchived(b.dataset.a); };
$('session').onchange = () => { qr = null; render(); };
