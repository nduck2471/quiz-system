// Tạo PDF hồ sơ bài làm, đề thi và bảng kê mã băm (dùng jsPDF + font Be Vietnam Pro).
// PDF được tạo TẤT ĐỊNH từ bản ghi hồ sơ: cùng bản ghi → cùng file → cùng mã SHA-256,
// nên có thể tải lại từ kho và đối chiếu với bảng kê bất cứ lúc nào.

let FONTS = null;
async function loadFonts() {
  if (FONTS) return FONTS;
  const get = async f => {
    const r = await fetch('fonts/' + f);
    if (!r.ok) throw new Error('Không tải được font ' + f);
    const b = new Uint8Array(await r.arrayBuffer());
    let s = '';
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return btoa(s);
  };
  FONTS = { r: await get('BeVietnamPro-Regular.ttf'), b: await get('BeVietnamPro-Bold.ttf') };
  return FONTS;
}

export async function sha256Hex(data) {
  const buf = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map(x => x.toString(16).padStart(2, '0')).join('');
}

// JSON chuẩn hóa: khóa sắp xếp theo thứ tự chữ cái ở mọi cấp → mã băm không phụ thuộc thứ tự lưu
export function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}

const pad = n => String(n).padStart(2, '0');
export function fmtTime(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + ' ' + pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear();
}
const num = x => (x === null || x === undefined) ? '—' : String(Math.round(x * 100) / 100).replace('.', ',');

async function newDoc(fixedMs, idHex, orientation) {
  const f = await loadFonts();
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: orientation || 'portrait', compress: true });
  doc.addFileToVFS('BVP-R.ttf', f.r); doc.addFont('BVP-R.ttf', 'BVP', 'normal');
  doc.addFileToVFS('BVP-B.ttf', f.b); doc.addFont('BVP-B.ttf', 'BVP', 'bold');
  doc.setFont('BVP', 'normal');
  doc.setCreationDate(new Date(fixedMs));
  doc.setFileId(idHex.slice(0, 32).toUpperCase());
  return doc;
}

// Trình viết dòng chữ có tự xuống trang
function writer(doc, margin, footerSpace) {
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight();
  const st = { y: margin, x: margin, w: W - 2 * margin };
  st.need = h => { if (st.y + h > H - footerSpace) { doc.addPage(); st.y = margin; } };
  st.text = (t, o = {}) => {
    const size = o.size || 10, lh = size * 0.42 * (o.lh || 1.35);
    doc.setFont('BVP', o.bold ? 'bold' : 'normal'); doc.setFontSize(size);
    if (o.color) doc.setTextColor(...o.color); else doc.setTextColor(22, 34, 46);
    const x = st.x + (o.indent || 0), w = st.w - (o.indent || 0);
    const lines = doc.splitTextToSize(String(t == null ? '' : t), w);
    lines.forEach(line => {
      st.need(lh);
      doc.text(line, o.center ? st.x + st.w / 2 : x, st.y + size * 0.36, o.center ? { align: 'center' } : undefined);
      st.y += lh;
    });
    st.y += o.after || 0;
  };
  st.rule = () => { st.need(3); doc.setDrawColor(184, 204, 224); doc.line(st.x, st.y, st.x + st.w, st.y); st.y += 3; };
  return st;
}

function footer(doc, left) {
  const n = doc.getNumberOfPages(), W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight();
  for (let i = 1; i <= n; i++) {
    doc.setPage(i);
    doc.setDrawColor(184, 204, 224); doc.line(15, H - 14, W - 15, H - 14);
    doc.setFont('BVP', 'normal'); doc.setFontSize(7); doc.setTextColor(95, 107, 118);
    doc.text(left, 15, H - 10);
    doc.text('Trang ' + i + '/' + n, W - 15, H - 10, { align: 'right' });
  }
}

// ---------- Phiếu bài làm của một học viên ----------
export async function buildSubmissionPdf(rec, dataHash, opts = {}) {
  const doc = await newDoc(rec.archivedAtMs, dataHash);
  const s = writer(doc, 15, 18);
  s.text(rec.org, { size: 9, color: [95, 107, 118] });
  s.text('PHIẾU BÀI LÀM KIỂM TRA', { size: 15, bold: true, center: true, after: 1 });
  s.text(rec.title + ' · ' + rec.sessionLabel, { size: 11, center: true, after: 3 });
  if (opts.preview) s.text('BẢN XEM TRƯỚC — CHƯA PHẢI HỒ SƠ LƯU TRỮ', { size: 11, bold: true, center: true, color: [192, 57, 43], after: 2 });
  s.rule();

  const info = [
    ['Họ và tên', rec.name], [rec.idLabel || 'Năm sinh', rec.birth], [rec.unitLabel || 'Đơn vị', rec.unit],
    ['Thời gian làm bài', fmtTime(rec.runStartMs) + '  →  ' + fmtTime(rec.runEndMs)],
    ['Nộp bài lúc (giờ máy chủ)', fmtTime(rec.submittedAtMs)],
    ['Trạng thái nộp', rec.finalSubmit ? 'Tự động nộp khi hết giờ' : 'Bản lưu gần nhất (học viên rời trang trước khi hết giờ)'],
    ['Mã hồ sơ', rec.archiveId + '  (phiên bản ' + rec.version + ')'],
    ['Mã đề thi (SHA-256)', rec.examVersion]
  ];
  if (rec.receiptHash) info.push(['Mã biên nhận của học viên', rec.receiptHash]);
  if (rec.awayN !== undefined) info.push(['Rời trang khi làm bài', !rec.awayN ? 'Không' :
    rec.awayN + ' lần, tổng ' + Math.round(rec.awayMs / 1000) + ' giây' + (rec.lockedAway ? ' — BÀI BỊ KHÓA TỰ ĐỘNG' : '') + (rec.awayLog ? ' (' + rec.awayLog + ')' : '')]);
  info.forEach(([k, v]) => {
    s.need(6);
    doc.setFont('BVP', 'bold'); doc.setFontSize(10); doc.setTextColor(22, 34, 46);
    doc.text(k + ':', s.x, s.y + 3.6);
    doc.setFont('BVP', 'normal');
    const lines = doc.splitTextToSize(String(v), s.w - 55);
    lines.forEach((l, i) => { doc.text(l, s.x + 55, s.y + 3.6 + i * 4.8); });
    s.y += Math.max(1, lines.length) * 4.8 + 0.6;
  });
  s.y += 2;

  // Bảng điểm tổng hợp
  s.need(26);
  const rows = [['Phần', 'Kết quả', 'Điểm'],
    ['I. Trắc nghiệm', rec.mcqCorrect + '/' + rec.answers.length + ' câu đúng', num(rec.mcqScore) + ' / ' + num(rec.mcqMax)]];
  if (rec.essays.length) rows.push(['II. Tự luận', rec.essays.length + ' câu', num(rec.essayScore) + ' / ' + num(rec.essayMax)]);
  rows.push(['TỔNG', '', num(rec.total) + ' / ' + num(rec.totalMax)]);
  const cw = [70, 60, 50];
  rows.forEach((r, i) => {
    let x = s.x;
    if (i === 0) { doc.setFillColor(11, 60, 93); doc.rect(s.x, s.y, 180, 6.5, 'F'); }
    else if (i === rows.length - 1) { doc.setFillColor(234, 243, 251); doc.rect(s.x, s.y, 180, 6.5, 'F'); }
    r.forEach((c, j) => {
      doc.setFont('BVP', i === 0 || i === rows.length - 1 ? 'bold' : 'normal'); doc.setFontSize(10);
      doc.setTextColor(...(i === 0 ? [245, 248, 251] : [22, 34, 46]));
      doc.text(String(c), x + 2, s.y + 4.5);
      x += cw[j];
    });
    s.y += 6.5;
  });
  s.y += 5;

  // Phần I: lưới trắc nghiệm, mỗi khối 3 cột × tối đa 20 dòng
  s.text('I. PHẦN TRẮC NGHIỆM', { size: 11, bold: true, after: 1 });
  s.text('Chọn = đáp án học viên chọn ("—" là bỏ trống); Đ.án = đáp án đúng; KQ: Đ = đúng, S = sai.', { size: 8, color: [95, 107, 118], after: 1 });
  const total = rec.answers.length, colW = 60, rowH = 5;
  for (let c0 = 0; c0 < total; c0 += 60) {
    const cnt = Math.min(60, total - c0), per = Math.ceil(cnt / 3);
    s.need(rowH * (per + 1) + 2);
    const y0 = s.y;
    for (let b = 0; b < 3; b++) {
      const x0 = s.x + b * colW;
      if (b * per >= cnt) break;
      doc.setFillColor(11, 60, 93); doc.rect(x0, y0, colW - 3, rowH, 'F');
      doc.setFont('BVP', 'bold'); doc.setFontSize(8.5); doc.setTextColor(245, 248, 251);
      ['Câu', 'Chọn', 'Đ.án', 'KQ'].forEach((h, k) => doc.text(h, x0 + 2 + k * 14, y0 + 3.5));
      for (let r = 0; r < per; r++) {
        const i = c0 + b * per + r; if (i >= c0 + cnt) break;
        const y = y0 + rowH * (r + 1);
        const ch = rec.answers.charAt(i), key = rec.answerKey.charAt(i), ok = ch === key;
        if (r % 2) { doc.setFillColor(245, 248, 251); doc.rect(x0, y, colW - 3, rowH, 'F'); }
        doc.setFont('BVP', 'normal'); doc.setFontSize(8.5); doc.setTextColor(22, 34, 46);
        doc.text(String(i + 1), x0 + 2, y + 3.5);
        doc.text(ch === '-' ? '—' : ch, x0 + 16, y + 3.5);
        doc.text(key, x0 + 30, y + 3.5);
        doc.setFont('BVP', 'bold'); doc.setTextColor(...(ok ? [46, 125, 79] : [192, 57, 43]));
        doc.text(ok ? 'Đ' : 'S', x0 + 44, y + 3.5);
      }
    }
    s.y = y0 + rowH * (per + 1) + 4;
  }
  s.y += 2;

  // Phần II: tự luận
  if (rec.essays.length) {
    s.text('II. PHẦN TỰ LUẬN', { size: 11, bold: true, after: 2 });
    rec.essays.forEach((e, i) => {
      s.text('Câu ' + (total + i + 1) + ' (' + num(e.points) + ' điểm). ' + e.q, { size: 10, bold: true, after: 1.5 });
      s.text('Bài làm của học viên:', { size: 9, color: [95, 107, 118], after: 0.5 });
      s.text(e.answer && e.answer.trim() ? e.answer : '(bỏ trống)', { size: 10, indent: 3, after: 1.5 });
      s.text('Điểm: ' + num(e.score) + ' / ' + num(e.points) + (e.comment ? '   ·   Nhận xét: ' + e.comment : ''), { size: 10, bold: true, color: [11, 60, 93], after: 4 });
    });
  }

  // Xác nhận
  s.need(38);
  s.rule();
  s.text('Người chấm: ' + (rec.grader || '—') + (rec.gradedAtMs ? '   ·   Chấm lúc: ' + fmtTime(rec.gradedAtMs) : ''), { size: 9 });
  s.text('Hồ sơ lập lúc: ' + fmtTime(rec.archivedAtMs) + '   ·   Người lập: ' + rec.archivedBy, { size: 9, after: 4 });
  const W = doc.internal.pageSize.getWidth();
  doc.setFont('BVP', 'bold'); doc.setFontSize(10); doc.setTextColor(22, 34, 46);
  doc.text('NGƯỜI CHẤM', s.x + 30, s.y + 4, { align: 'center' });
  doc.text('XÁC NHẬN CỦA ĐƠN VỊ', W - 15 - 35, s.y + 4, { align: 'center' });
  doc.setFont('BVP', 'normal'); doc.setFontSize(8);
  doc.text('(ký, ghi rõ họ tên)', s.x + 30, s.y + 8.5, { align: 'center' });
  doc.text('(ký, đóng dấu)', W - 15 - 35, s.y + 8.5, { align: 'center' });
  s.y += 30;

  footer(doc, 'Mã hồ sơ ' + rec.archiveId + ' · SHA-256 dữ liệu: ' + dataHash);
  return new Uint8Array(doc.output('arraybuffer'));
}

// ---------- Đề thi gốc + đáp án ----------
export async function buildExamPdf(exam, examHash, fixedMs) {
  const doc = await newDoc(fixedMs, examHash);
  const s = writer(doc, 15, 18);
  s.text(exam.org, { size: 9, color: [95, 107, 118] });
  s.text('ĐỀ KIỂM TRA VÀ ĐÁP ÁN', { size: 15, bold: true, center: true });
  s.text(exam.title, { size: 11, center: true });
  s.text('Mã đề (SHA-256 của de-thi.json): ' + examHash, { size: 8, center: true, color: [95, 107, 118], after: 3 });
  s.rule();
  s.text('I. TRẮC NGHIỆM (' + exam.questions.length + ' câu × ' + num(exam.mcqPoints) + ' điểm)', { size: 11, bold: true, after: 2 });
  exam.questions.forEach((q, i) => {
    s.text('Câu ' + (i + 1) + '. ' + q.q, { size: 9.5, bold: true });
    q.o.forEach((o, k) => s.text('ABCD'.charAt(k) + '. ' + o, { size: 9, indent: 4 }));
    s.text('Đáp án: ' + exam.answerKey.charAt(i), { size: 9, bold: true, color: [46, 125, 79], indent: 4, after: 2 });
  });
  if (exam.essays.length) {
    s.text('II. TỰ LUẬN', { size: 11, bold: true, after: 2 });
    exam.essays.forEach((e, i) => {
      s.text('Câu ' + (exam.questions.length + i + 1) + ' (' + num(e.points) + ' điểm). ' + e.q, { size: 9.5, after: e.rubric ? 1 : 2 });
      if (e.rubric) s.text('Hướng dẫn chấm: ' + e.rubric, { size: 9, indent: 4, color: [46, 125, 79], after: 2 });
    });
  }
  footer(doc, 'Đề thi · SHA-256: ' + examHash);
  return new Uint8Array(doc.output('arraybuffer'));
}

// ---------- Bảng kê mã băm (in, ký, lưu cùng hồ sơ) ----------
export async function buildManifestPdf(meta, items, fixedMs) {
  const doc = await newDoc(fixedMs, await sha256Hex(canonical(items)), 'landscape');
  const s = writer(doc, 12, 16);
  s.text(meta.org, { size: 9, color: [95, 107, 118] });
  s.text('BẢNG KÊ HỒ SƠ BÀI THI VÀ MÃ BĂM SHA-256', { size: 14, bold: true, center: true });
  s.text(meta.title + ' · Lập lúc ' + fmtTime(fixedMs) + ' · ' + items.length + ' hồ sơ', { size: 10, center: true, after: 3 });
  const cols = [['STT', 10], ['Họ và tên', 45], [meta.idLabel || 'Năm sinh', 16], ['Lần', 20], ['Tổng điểm', 20], ['Mã hồ sơ', 46], ['SHA-256 của file PDF', 116]];
  const head = () => {
    s.need(7); let x = s.x;
    doc.setFillColor(11, 60, 93); doc.rect(s.x, s.y, 273, 6, 'F');
    doc.setFont('BVP', 'bold'); doc.setFontSize(8); doc.setTextColor(245, 248, 251);
    cols.forEach(([h, w]) => { doc.text(h, x + 1.5, s.y + 4); x += w; });
    s.y += 6;
  };
  head();
  items.forEach((it, i) => {
    if (s.y + 6 > doc.internal.pageSize.getHeight() - 16) { doc.addPage(); s.y = 12; head(); }
    let x = s.x;
    if (i % 2) { doc.setFillColor(245, 248, 251); doc.rect(s.x, s.y, 273, 6, 'F'); }
    doc.setFont('BVP', 'normal'); doc.setFontSize(8); doc.setTextColor(22, 34, 46);
    [String(i + 1), it.name, it.birth, it.sessionLabel, it.total, it.archiveId, it.pdfHash].forEach((v, k) => {
      doc.text(doc.splitTextToSize(String(v), cols[k][1] - 2)[0] || '', x + 1.5, s.y + 4); x += cols[k][1];
    });
    s.y += 6;
  });
  s.y += 4;
  s.text('Cách kiểm tra: tính SHA-256 của từng file PDF (Windows: certutil -hashfile <file> SHA256; macOS/Linux: shasum -a 256 <file>) rồi so với cột cuối. Trùng khớp nghĩa là file chưa bị chỉnh sửa kể từ khi lập hồ sơ.', { size: 8.5, after: 6 });
  s.need(26);
  doc.setFont('BVP', 'bold'); doc.setFontSize(10);
  doc.text('NGƯỜI LẬP BẢNG KÊ', s.x + 40, s.y + 4, { align: 'center' });
  doc.text('XÁC NHẬN CỦA ĐƠN VỊ', s.x + 230, s.y + 4, { align: 'center' });
  footer(doc, 'Bảng kê hồ sơ bài thi · ' + meta.title);
  return new Uint8Array(doc.output('arraybuffer'));
}

// ---------- Biên nhận bài làm (học viên tự tải sau khi nộp; không có điểm, không có đáp án) ----------
// rc: { subId, examId, session, name, birth, unit, answers, essays, submittedAtMs } — mã biên nhận = SHA-256(canonical(rc))
// paper: { title, org, sessionLabel, questions:[{q,o}], essays:[{q,points}] }
export function receiptData(sub) {
  return {
    subId: sub.subId, examId: sub.examId, session: sub.session, name: sub.name, birth: sub.birth, unit: sub.unit,
    answers: sub.answers, essays: (sub.essays || []).map(String), submittedAtMs: sub.submittedAtMs
  };
}
export async function buildReceiptPdf(rc, paper) {
  const hash = await sha256Hex(canonical(rc));
  const doc = await newDoc(rc.submittedAtMs, hash);
  const s = writer(doc, 15, 18);
  s.text(paper.org || '', { size: 9, color: [95, 107, 118] });
  s.text('BIÊN NHẬN BÀI LÀM', { size: 15, bold: true, center: true, after: 1 });
  s.text(paper.title + ' · ' + paper.sessionLabel, { size: 11, center: true, after: 2 });
  s.text('Biên nhận xác nhận nội dung bài đã nộp lên máy chủ. Không gồm điểm và đáp án; kết quả do giảng viên công bố.', { size: 8.5, center: true, color: [95, 107, 118], after: 2 });
  s.rule();
  [['Họ và tên', rc.name], [paper.idLabel || 'Năm sinh', rc.birth], [paper.unitLabel || 'Đơn vị', rc.unit],
   ['Nộp bài lúc (giờ máy chủ)', fmtTime(rc.submittedAtMs)], ['Mã bài làm', rc.subId], ['Mã biên nhận (SHA-256)', hash]].forEach(([k, v]) => {
    s.need(6);
    doc.setFont('BVP', 'bold'); doc.setFontSize(10); doc.setTextColor(22, 34, 46);
    doc.text(k + ':', s.x, s.y + 3.6);
    doc.setFont('BVP', 'normal');
    const lines = doc.splitTextToSize(String(v), s.w - 55);
    lines.forEach((l, i) => doc.text(l, s.x + 55, s.y + 3.6 + i * 4.8));
    s.y += Math.max(1, lines.length) * 4.8 + 0.6;
  });
  s.y += 3;
  const n = rc.answers.length;
  s.text('I. TRẮC NGHIỆM — đã trả lời ' + rc.answers.replace(/-/g, '').length + '/' + n + ' câu', { size: 11, bold: true, after: 1 });
  s.text('Câu và chữ cái A–D theo đề gốc (trên điện thoại thứ tự câu và phương án đã được xáo trộn).', { size: 8, color: [95, 107, 118], after: 1 });
  const rowH = 5, cw = [12, 118, 50];
  const head = () => {
    s.need(rowH * 2); let x = s.x;
    doc.setFillColor(11, 60, 93); doc.rect(s.x, s.y, 180, rowH, 'F');
    doc.setFont('BVP', 'bold'); doc.setFontSize(8.5); doc.setTextColor(245, 248, 251);
    ['Câu', 'Nội dung câu hỏi (rút gọn)', 'Đã chọn'].forEach((h, k) => { doc.text(h, x + 2, s.y + 3.5); x += cw[k]; });
    s.y += rowH;
  };
  head();
  const H = doc.internal.pageSize.getHeight();
  for (let i = 0; i < n; i++) {
    if (s.y + rowH > H - 18) { doc.addPage(); s.y = 15; head(); }
    const q = paper.questions[i] || { q: '', o: [] }, ch = rc.answers.charAt(i), k = 'ABCD'.indexOf(ch);
    if (i % 2) { doc.setFillColor(245, 248, 251); doc.rect(s.x, s.y, 180, rowH, 'F'); }
    doc.setFont('BVP', 'normal'); doc.setFontSize(8); doc.setTextColor(22, 34, 46);
    const cut = (t, w) => { const l = doc.splitTextToSize(String(t), w); return l[0] + (l.length > 1 ? '…' : ''); };
    doc.text(String(i + 1), s.x + 2, s.y + 3.5);
    doc.text(cut(q.q, cw[1] - 5), s.x + cw[0] + 2, s.y + 3.5);
    doc.setFont('BVP', 'bold');
    doc.text(k < 0 ? '— (bỏ trống)' : cut(ch + '. ' + (q.o[k] || ''), cw[2] - 4), s.x + cw[0] + cw[1] + 2, s.y + 3.5);
    s.y += rowH;
  }
  s.y += 5;
  if (rc.essays.length) {
    s.text('II. TỰ LUẬN', { size: 11, bold: true, after: 2 });
    rc.essays.forEach((a, i) => {
      const e = paper.essays[i] || { q: '', points: '' };
      s.text('Câu ' + (n + i + 1) + ' (' + num(e.points) + ' điểm). ' + e.q, { size: 10, bold: true, after: 1.5 });
      s.text(a && a.trim() ? a : '(bỏ trống)', { size: 10, indent: 3, after: 4 });
    });
  }
  s.need(12); s.rule();
  s.text('Giữ file này làm bằng chứng bài đã nộp. Mã biên nhận được in trong hồ sơ lưu trữ của giảng viên để đối chiếu.', { size: 8.5, color: [95, 107, 118] });
  footer(doc, 'Biên nhận · ' + rc.subId + ' · SHA-256: ' + hash);
  return { bytes: new Uint8Array(doc.output('arraybuffer')), hash };
}
