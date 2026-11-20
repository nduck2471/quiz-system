// Cấu hình trang thi môn "Lập và Đánh giá kế hoạch xạ trị" (hệ thống riêng, dự án Firebase riêng).
// Các khóa Firebase là công khai theo thiết kế; dữ liệu được bảo vệ bằng firestore.rules.
window.QUIZ_CONFIG = {
  SITE: "Thi Lập và Đánh giá kế hoạch xạ trị",
  // Đơn vị mặc định in trên phiếu khi thêm đề mới (sửa được ở từng đề)
  ORG: "Đại học Bách Khoa Hà Nội",
  // Thông tin sinh viên điền khi vào thi
  FIELDS: {
    idLabel: "Mã số sinh viên", idShort: "MSSV",
    idPattern: "^\\d{6,10}$", idHint: "mã số sinh viên (6–10 chữ số)",
    unitLabel: "Lớp", unitShort: "Lớp"
  },
  // THAY khối dưới bằng firebaseConfig của dự án Firebase MỚI (Bước 1.6 trong hướng dẫn)
  firebase: {
    apiKey: "AIzaSyDxfrwYaDO0HXtSKv1UFwqAeX1qfJsZt9s",
    authDomain: "thitr-e752c.firebaseapp.com",
    projectId: "thitr-e752c",
    storageBucket: "thitr-e752c.firebasestorage.app",
    messagingSenderId: "367613748417",
    appId: "1:367613748417:web:2e1efd043832de969ea040",
    measurementId: "G-TCXEZ9T9L3"
  }
};
