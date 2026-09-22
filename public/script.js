/* ============================================================================
 *  隐患治理台账系统 — 前端单页应用
 * ============================================================================
 *
 * 【技术选型】
 *   原生 HTML/CSS/JS（无框架、无构建、无 CDN 依赖）——
 *   因为系统部署在内网、可能完全离线，任何外部资源都不可靠。
 *   图表也是纯手写 SVG（见「图表」一节），不引入 ECharts/Chart.js。
 *
 * 【页面组织】
 *   用 hash 路由（#/dashboard、#/hazards ...）。router() 根据 location.hash
 *   决定渲染哪个页面；页面函数统一渲染到 #app 容器。
 *
 * 【数据流】
 *   页面函数 → api.get/post/patch/del → 服务端 /api/* →
 *   返回 JSON → 拼 HTML 字符串写入容器 → 事件用 onclick 就地绑定。
 *
 * 【安全约定（重要）】
 *   所有来自服务端/用户的数据在拼进 HTML 前**必须**用 esc() 转义，
 *   否则存在 XSS 风险（例如用户姓名、隐患描述里带 <script>）。
 *   唯一例外是可枚举的枚举值（level/status/role）用于拼 class 名。
 *
 * 【代码结构导航】
 *   1. 常量与字典      CATEGORY/LEVEL/STATUS/ROLE 的中文映射、图标库
 *   2. 通用工具        $ / esc / 日期格式化 / toast / openModal
 *   3. API 封装        apiFetch（自动附带 Bearer 令牌与操作人头）
 *   4. 会话状态        session（localStorage 持久化）
 *   5. 图片处理        compressImage（canvas 压缩）/ 照片上传控件 / 照片展示
 *   6. 图表            环形图 / 横向条形图 / 双折线图 / 分布柱状图
 *   7. 页面            登录 / 看板 / 台账 / 登记 / 详情 / 用户管理 / 操作日志 / 个人中心
 *   8. 路由与启动
 * ============================================================================ */


/* ---------- 常量：枚举中文映射 ----------
 * 这些 key 必须与服务端 server.js 里的 LEVELS/CATEGORIES/STATUSES/ROLES 完全一致。
 * 前端的 role-* / lv-* / st-* CSS 类名也是由这些 key 拼出来的。 */
const CATEGORY_LABELS = {
  equipment: "设备设施", operation: "作业行为", fire: "消防安全",
  electrical: "电气安全", environment: "环境安全", management: "管理缺陷",
};
const LEVEL_LABELS = { major: "重大", serious: "较大", general: "一般", minor: "轻微" };
const STATUS_LABELS = { pending: "待整改", rectifying: "整改中", closed: "已闭环", overdue: "逾期" };
/* 列表筛选用：额外支持「未闭环」伪状态（= 非已闭环，由后端 matchStatus 处理） */
const STATUS_FILTER_LABELS = { unclosed: "未闭环", pending: "待整改", rectifying: "整改中", closed: "已闭环", overdue: "逾期" };
const ROLE_LABELS = { entry: "录入人员", safety_admin: "安全管理员", reviewer: "复查人员", admin: "系统管理员" };
const LEVEL_COLORS = { major: "#dc2626", serious: "#ea580c", general: "#ca8a04", minor: "#16a34a" };

/* ---------- 通用工具 ---------- */

/** 选择器简写 */
const $ = (sel, root = document) => root.querySelector(sel);

/** HTML 转义 —— 所有拼进 innerHTML 的动态内容都必须经过它（防 XSS） */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** 时间戳 → "YYYY-MM-DD HH:mm"（用于展示，空值显示 —） */
function fmtDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 本地时区今天 YYYY-MM-DD（与后端 localDateStr 口径一致） */
function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ---------- 图片压缩与上传 ----------
 * 为什么在前端压缩？手机拍的照片动辄 3~8MB，直接上传既慢又占空间。
 * 这里用 canvas 把长边压到 1600px、JPEG 质量 0.82，通常降到几百 KB，
 * 对台账留证清晰度足够，同时显著降低存储与传输压力。
 */
const MAX_PHOTOS = 6;   // 每个照片字段最多张数（与服务端 normalizePhotos 的 max 保持一致）
// 上传前用 canvas 压缩（长边 1600px、JPEG 0.82），体积通常降到几百 KB
function compressImage(file, maxSide = 1600, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objUrl = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(objUrl);
      let w = img.naturalWidth, h = img.naturalHeight;
      const scale = Math.min(1, maxSide / Math.max(w, h));
      w = Math.max(1, Math.round(w * scale));
      h = Math.max(1, Math.round(h * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      try { resolve(canvas.toDataURL("image/jpeg", quality)); }
      catch { reject(new Error("图片处理失败")); }
    };
    img.onerror = () => { URL.revokeObjectURL(objUrl); reject(new Error("图片读取失败")); };
    img.src = objUrl;
  });
}

// 照片上传控件：选择即上传，返回 state.urls
function photoUploaderHtml(key, label, hint) {
  return `<div class="field span-2">
    <label>${esc(label)}</label>
    <div class="photo-grid" id="${key}Grid"></div>
    <div style="display:flex;align-items:center;gap:10px;margin-top:10px">
      <button type="button" class="btn btn-outline btn-sm" id="${key}Btn">${icon("plus", 14)}选择照片</button>
      <span style="font-size:12px;color:#9ca3af">${esc(hint)}</span>
    </div>
    <input type="file" accept="image/*" multiple id="${key}Input" style="display:none">
  </div>`;
}

function initPhotoUploader(key) {
  const state = { urls: [] };
  const grid = $("#" + key + "Grid");
  const input = $("#" + key + "Input");
  const btn = $("#" + key + "Btn");

  const render = () => {
    grid.innerHTML = state.urls.length
      ? state.urls.map((u, i) => `<div class="photo-item"><img src="${esc(u)}" alt="" data-preview="${esc(u)}"><button type="button" class="photo-del" data-i="${i}" title="移除">×</button></div>`).join("")
      : `<span style="font-size:12px;color:#cbd5e1">暂无照片</span>`;
    grid.querySelectorAll(".photo-del").forEach((b) => {
      b.onclick = (e) => { e.stopPropagation(); state.urls.splice(Number(b.dataset.i), 1); render(); };
    });
  };

  btn.onclick = () => input.click();
  input.onchange = async () => {
    const files = [...input.files];
    input.value = "";
    for (const f of files) {
      if (!f.type.startsWith("image/")) { toast("已跳过非图片文件", f.name, "err"); continue; }
      if (state.urls.length >= MAX_PHOTOS) { toast(`最多 ${MAX_PHOTOS} 张`, "请先移除部分照片", "err"); break; }
      btn.disabled = true; btn.textContent = "上传中...";
      try {
        const dataUrl = await compressImage(f);
        const r = await api.post("/upload", { name: f.name, dataUrl });
        state.urls.push(r.url);
        render();
      } catch (err) {
        toast("上传失败", err.message, "err");
      } finally {
        btn.disabled = false; btn.innerHTML = `${icon("plus", 14)}选择照片`;
      }
    }
  };
  render();
  return state;
}

// 详情页照片展示
function photoViewer(label, urls) {
  const list = Array.isArray(urls) ? urls : [];
  return `<div class="info-item full"><div class="i-label">${esc(label)}</div>
    <div class="i-value">${list.length
      ? `<div class="photo-grid">${list.map((u) => `<div class="photo-item"><img src="${esc(u)}" alt="" data-preview="${esc(u)}"></div>`).join("")}</div>`
      : "—"}</div></div>`;
}

/* ---------- 图标 ---------- */
const ICONS = {
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
  chart: '<line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/>',
  list: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
  plus: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  chevronDown: '<polyline points="6 9 12 15 18 9"/>',
  chevronLeft: '<polyline points="15 18 9 12 15 6"/>',
  chevronRight: '<polyline points="9 18 15 12 9 6"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
  search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  alert: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  check: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
  trend: '<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>',
  back: '<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>',
  userPlus: '<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/>',
  pencil: '<path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  reset: '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>',
  close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  menu: '<line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
  fileText: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  play: '<polygon points="5 3 19 12 5 21 5 3"/>',
  printer: '<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
};

/* 操作日志类型标签 */
const ACTION_LABELS = {
  login: "登录系统",
  create_hazard: "登记隐患",
  update_hazard: "修改隐患",
  start_rectify: "开始整改",
  review_hazard: "复查闭环",
  delete_hazard: "删除隐患",
  export_hazard: "导出隐患台账",
  create_user: "新增用户",
  update_user_role: "修改角色",
  reset_password: "重置密码",
  delete_user: "删除用户",
};
function icon(name, size = 18) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ""}</svg>`;
}

/* ---------- Toast / Modal ---------- */
function toast(title, desc = "", type = "ok", duration = 2600) {
  const host = $("#toast-host");
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.innerHTML = `<div class="t-title">${esc(title)}</div>${desc ? `<div class="t-desc">${esc(desc)}</div>` : ""}`;
  host.appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; el.style.transform = "translateX(20px)"; el.style.transition = "all .25s"; setTimeout(() => el.remove(), 260); }, duration);
}

/* 打印时的一次性提示：浏览器自带页脚（网址/页码）需在打印设置里关闭 */
let printHintShown = false;
function showPrintHintOnce() {
  if (printHintShown) return;
  printHintShown = true;
  setTimeout(() => {
    toast("打印提示", "如打印件底部有网址/页码，请在打印设置中取消勾选「页眉和页脚」", "ok", 6000);
  }, 600);
}

function openModal({ title, desc, bodyHtml, confirmText = "确认", cancelText = "取消", danger = false, onConfirm }) {
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-head"><h3>${esc(title)}</h3>${desc ? `<p>${esc(desc)}</p>` : ""}</div>
      <div class="modal-body">${bodyHtml}</div>
      <div class="modal-foot">
        <button class="btn btn-outline" data-act="cancel">${esc(cancelText)}</button>
        <button class="btn ${danger ? "btn-danger" : "btn-primary"}" data-act="ok">${esc(confirmText)}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  $('[data-act="cancel"]', overlay).onclick = close;
  $('[data-act="ok"]', overlay).onclick = async () => {
    const ok = await onConfirm(overlay);
    if (ok !== false) close();
  };
  return overlay;
}

/* ---------- API 封装 ---------- */
/**
 * 统一的接口请求函数。
 *  - 自动拼接 /api 前缀；
 *  - 自动附带 `Authorization: Bearer <token>`（服务端据此鉴权）；
 *  - 自动附带 X-Operator* 头：服务端用它记录"操作人"，
 *    （本地版以令牌为准；云端演示版无服务端会话，才依赖这个头）；
 *  - 401（登录过期）→ 清除本地会话并跳回登录页；
 *  - 其他错误 → 抛出服务端返回的 error.message（中文），由调用处 toast 展示。
 */
async function apiFetch(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (session?.token) headers["Authorization"] = `Bearer ${session.token}`;
  // 操作人标识（供无服务端会话的部署方式记录操作日志）
  if (session?.user) {
    headers["X-Operator-Id"] = session.user.id || "";
    headers["X-Operator"] = encodeURIComponent(session.user.userName || "");
    headers["X-Operator-Role"] = session.user.role || "";
  }
  const res = await fetch(`/api${path}`, { ...options, headers });
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  if (res.status === 401) {
    clearSession(); session = null;
    if (location.hash !== "#/login") location.hash = "#/login";
    throw new Error("登录已过期，请重新登录");
  }
  if (!res.ok) {
    const msg = data?.error?.message || `请求失败 (${res.status})`;
    throw new Error(msg);
  }
  return data;
}
const api = {
  get: (p) => apiFetch(p),
  post: (p, body) => apiFetch(p, { method: "POST", body: JSON.stringify(body) }),
  patch: (p, body) => apiFetch(p, { method: "PATCH", body: JSON.stringify(body) }),
  del: (p) => apiFetch(p, { method: "DELETE" }),
};

/* ---------- 应用级信息（公司名称等） ----------
 * 设计说明：本仓库**不包含任何公司标识**。公司名称由部署方的 config.json 提供，
 * 服务端通过公开接口 /api/app-info 下发；这里只做缓存与渲染。
 * 取不到（或配置为空）时，界面照常工作，只是不显示公司名。
 */
const APP = { companyName: "" };

/** 启动时拉取一次应用信息（登录前即可调用，接口无需鉴权） */
async function loadAppInfo() {
  try {
    const res = await fetch("/api/app-info");
    if (!res.ok) return;
    const info = await res.json();
    APP.companyName = (info && info.companyName) || "";
  } catch { /* 网络异常时静默降级，不影响使用 */ }
}

/* ---------- 会话（localStorage 持久化） ----------
 * session 形如 { token, user:{id,userId,userName,role,createdAt}, mustChangePassword }
 * 注意：这只是"前端缓存的登录态"，真正的鉴权在服务端（令牌校验）。
 */
const SESSION_KEY = "hazard_session";
function loadSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch { return null; }
}
function saveSession(s) { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); }
function clearSession() { localStorage.removeItem(SESSION_KEY); }
let session = loadSession();
/** 当前登录用户（未登录为 null） */
const currentUser = () => session?.user || null;
/** 仅系统管理员 admin 可见「用户管理 / 操作日志」 */
const canManageUsers = () => currentUser()?.role === "admin";
/** 是否系统管理员（用于隐患删除等按钮显隐） */
const isAdmin = () => currentUser()?.role === "admin";

/* ================= 图表（纯 SVG 手写，无任何外部依赖） =================
 * 为什么不用图表库？内网/离线环境无法加载 CDN；而 4 种图形都能用 SVG 直接画。
 * 返回值均为 **HTML 字符串**，由调用方插入到卡片里；样式由 style.css 的 .chart-box 控制。
 *   donutChart      隐患等级分布（环形图）
 *   hBarChart       隐患类别分布（横向条形图，用 div 实现更简单）
 *   lineChart       月度趋势（双折线 + 数值标注）
 *   closureBarChart 闭环时长分布（柱状图：横轴耗时天数、纵轴隐患条数）
 */

/** 环形图：用 stroke-dasharray/dashoffset 画弧，圆环中心显示总数 */
function donutChart(data, total) {
  const size = 220, cx = 110, cy = 110, r = 74, sw = 26;
  const circ = 2 * Math.PI * r;
  let acc = 0;
  const segs = data.filter((d) => d.value > 0).map((d) => {
    const frac = total ? d.value / total : 0;
    const len = frac * circ;
    const s = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${d.color}" stroke-width="${sw}"
      stroke-dasharray="${len} ${circ - len}" stroke-dashoffset="${-acc}" transform="rotate(-90 ${cx} ${cy})"/>`;
    acc += len;
    return s;
  }).join("");
  const ring = segs || `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#e5e7eb" stroke-width="${sw}"/>`;
  const legend = data.map((d) => `<div class="lg-item"><span class="dot" style="background:${d.color}"></span>${esc(d.label)} · ${d.value}</div>`).join("");
  return `<div class="chart-box">
    <svg viewBox="0 0 ${size} ${size}" style="max-width:${size}px;margin:0 auto">
      <g>${ring}</g>
      <text x="${cx}" y="${cy - 2}" text-anchor="middle" font-size="30" font-weight="700" fill="#1f2937">${total}</text>
      <text x="${cx}" y="${cy + 20}" text-anchor="middle" font-size="12" fill="#6b7280">隐患总数</text>
    </svg>
    <div class="legend">${legend}</div>
  </div>`;
}

function hBarChart(data) {
  const max = Math.max(1, ...data.map((d) => d.value));
  const rows = data.map((d) => {
    const w = Math.round((d.value / max) * 100);
    return `<div style="display:grid;grid-template-columns:82px 1fr 34px;align-items:center;gap:10px;margin-bottom:12px">
      <span style="font-size:12.5px;color:#4b5563;text-align:right">${esc(d.label)}</span>
      <span style="height:16px;background:#f1f5f9;border-radius:4px;overflow:hidden">
        <span style="display:block;height:100%;width:${w}%;background:linear-gradient(90deg,#3b82f6,#1e40af);border-radius:4px;transition:width .4s"></span>
      </span>
      <span style="font-size:12.5px;color:#374151;font-weight:600">${d.value}</span>
    </div>`;
  }).join("");
  return `<div class="chart-box" style="padding:6px 4px">${rows}</div>`;
}

function lineChart(trend) {
  const W = 640, H = 240, padL = 34, padR = 14, padT = 24, padB = 30;
  const iw = W - padL - padR, ih = H - padT - padB;
  const maxV = Math.max(1, ...trend.map((t) => Math.max(t.newCount, t.closedCount)));
  const step = trend.length > 1 ? iw / (trend.length - 1) : iw;
  const px = (i) => padL + i * step;
  const py = (v) => padT + ih - (v / maxV) * ih;

  const gridLines = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const y = padT + ih - f * ih;
    const v = Math.round(f * maxV);
    return `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="#f1f5f9"/>
      <text x="${padL - 6}" y="${y + 4}" text-anchor="end" font-size="10" fill="#9ca3af">${v}</text>`;
  }).join("");

  const xLabels = trend.map((t, i) => {
    if (i % 2 !== 0 && i !== trend.length - 1) return "";
    return `<text x="${px(i)}" y="${H - 10}" text-anchor="middle" font-size="10" fill="#9ca3af">${t.month.slice(5)}月</text>`;
  }).join("");

  const line = (key, color, dy) => {
    const pts = trend.map((t, i) => `${px(i)},${py(t[key])}`).join(" ");
    const dots = trend.map((t, i) => `<circle cx="${px(i)}" cy="${py(t[key])}" r="2.5" fill="${color}"/>`).join("");
    const nums = trend.map((t, i) => (t[key] > 0
      ? `<text x="${px(i)}" y="${py(t[key]) + dy}" text-anchor="middle" font-size="10" font-weight="700" fill="${color}">${t[key]}</text>`
      : "")).join("");
    return `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2.2" stroke-linejoin="round"/>${dots}${nums}`;
  };

  return `<div class="chart-box">
    <svg viewBox="0 0 ${W} ${H}">
      ${gridLines}
      ${line("newCount", "#1e40af", -8)}
      ${line("closedCount", "#16a34a", 15)}
      ${xLabels}
    </svg>
    <div class="legend">
      <div class="lg-item"><span class="dot" style="background:#1e40af"></span>新增隐患</div>
      <div class="lg-item"><span class="dot" style="background:#16a34a"></span>闭环隐患</div>
    </div>
  </div>`;
}

/* 完成率分级：<30 红 / 30-60 橙 / 60-85 黄 / ≥85 绿 */
function rateLevel(rate) {
  const r = Number(rate) || 0;
  if (r >= 85) return { cls: "bg-green", label: "优秀" };
  if (r >= 60) return { cls: "bg-yellow", label: "良好" };
  if (r >= 30) return { cls: "bg-orange", label: "一般" };
  return { cls: "bg-red", label: "偏低" };
}

/* ---------- 闭环时长分布（横轴=闭环耗时天数，纵轴=隐患条数） ---------- */
function closureBarChart(dist) {
  const list = Array.isArray(dist) ? dist : [];
  if (list.length === 0) {
    return `<div class="empty" style="padding:44px 12px">${icon("trend", 34)}
      <div class="e-title">暂无闭环数据</div>
      <div class="e-sub">有隐患完成闭环后，即显示各耗时时长对应的隐患条数</div></div>`;
  }

  const W = 640, H = 250, padL = 40, padR = 16, padT = 28, padB = 44;
  const iw = W - padL - padR, ih = H - padT - padB;
  const maxV = Math.max(1, ...list.map((d) => d.count));
  const slot = iw / list.length;
  const bw = Math.min(48, slot * 0.58);
  const px = (i) => padL + slot * i + slot / 2;
  const py = (v) => padT + ih - (v / maxV) * ih;

  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const y = padT + ih - f * ih;
    const v = Math.round(f * maxV);
    return `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="#f1f5f9"/>
      <text x="${padL - 6}" y="${y + 4}" text-anchor="end" font-size="10" fill="#9ca3af">${v}</text>`;
  }).join("");

  const bars = list.map((d, i) => {
    const y = py(d.count);
    const hgt = padT + ih - y;
    return `<rect x="${px(i) - bw / 2}" y="${y}" width="${bw}" height="${Math.max(1, hgt)}" rx="3" fill="#ea580c" opacity=".9"/>
      <text x="${px(i)}" y="${y - 7}" text-anchor="middle" font-size="11.5" font-weight="700" fill="#c2410c">${d.count}</text>
      <text x="${px(i)}" y="${padT + ih + 18}" text-anchor="middle" font-size="11" fill="#4b5563">${d.days}</text>`;
  }).join("");

  return `<div class="chart-box">
    <svg viewBox="0 0 ${W} ${H}">
      <text x="${padL}" y="${padT - 12}" font-size="10.5" fill="#9ca3af">隐患条数</text>
      ${grid}${bars}
      <text x="${padL + iw / 2}" y="${H - 6}" text-anchor="middle" font-size="10.5" fill="#9ca3af">闭环耗时（天）</text>
    </svg>
    <div class="legend">
      <div class="lg-item"><span class="dot" style="background:#ea580c"></span>各耗时天数对应的隐患条数</div>
      <div class="lg-item">已闭环 ${list.reduce((s, d) => s + d.count, 0)} 条</div>
    </div>
  </div>`;
}

/* ================= 页面 =================
 * 每个 renderXxx() 的职责：
 *   ① 用 layout() 生成"侧边栏 + 顶栏 + 内容占位"的骨架并写入 #app；
 *   ② bindLayout() 绑定公共交互（用户菜单、抽屉菜单、待办角标）；
 *   ③ 拉取数据后把内容渲染进 #content。
 * 页面之间通过 location.hash 跳转，由 router() 统一调度。
 */

/**
 * 生成应用骨架。
 * @param activeNav 当前高亮的菜单 key（dashboard/hazards/new/profile/users/logs）
 * @param contentHtml 内容区 HTML
 */
function layout(activeNav, contentHtml) {
  const u = currentUser();
  const navItems = [
    { key: "dashboard", href: "#/dashboard", label: "统计看板", icon: "chart" },
    { key: "hazards", href: "#/hazards", label: "隐患台账", icon: "list" },
    { key: "new", href: "#/hazards/new", label: "隐患登记", icon: "plus" },
    { key: "profile", href: "#/profile", label: "个人中心", icon: "user", badge: true },
  ];
  if (canManageUsers()) navItems.push({ key: "users", href: "#/users", label: "用户管理", icon: "users" });
  if (canManageUsers()) navItems.push({ key: "logs", href: "#/logs", label: "操作日志", icon: "fileText" });

  return `<div class="app">
    <aside class="sidebar" id="sidebar">
      <div class="sidebar-brand"><img class="brand-logo" src="/logo.jpg" alt=""><span>${esc(APP.companyName)}</span></div>
      <nav class="sidebar-nav">
        ${navItems.map((n) => `<a class="nav-item ${n.key === activeNav ? "active" : ""}" href="${n.href}">${icon(n.icon)}<span>${n.label}</span>${n.badge ? `<span class="nav-badge" id="navBadgeProfile" style="display:none"></span>` : ""}</a>`).join("")}
      </nav>
    </aside>
    <div class="main">
      <header class="topbar">
        <div style="display:flex;align-items:center;gap:10px">
          <button class="menu-toggle" id="menuToggle">${icon("menu")}</button>
          <h1>隐患治理台账系统</h1>
        </div>
        <div class="topbar-right">
          <div class="user-menu">
            <div class="user-trigger" id="userTrigger">
              <div class="avatar">${esc((u?.userName || "?").charAt(0))}</div>
              <span style="font-size:13.5px;color:#374151">${esc(u?.userName || "")}</span>
              ${icon("chevronDown", 15)}
            </div>
            <div class="user-dropdown" id="userDropdown" style="display:none">
              <div class="u-info"><b>${esc(u?.userName || "")}</b><span>${esc(ROLE_LABELS[u?.role] || "")}</span></div>
              <button data-act="profile">${icon("user")}个人中心</button>
              <button data-act="change-pwd">${icon("lock")}修改密码</button>
              <button data-act="logout">${icon("logout")}退出登录</button>
            </div>
          </div>
        </div>
      </header>
      <main class="content" id="content">${contentHtml}</main>
    </div>
  </div>`;
}

function bindLayout() {
  const trig = $("#userTrigger"), drop = $("#userDropdown");
  if (trig) {
    trig.onclick = (e) => { e.stopPropagation(); drop.style.display = drop.style.display === "none" ? "block" : "none"; };
    document.addEventListener("click", () => { if (drop) drop.style.display = "none"; }, { once: true });
    drop.querySelector('[data-act="profile"]').onclick = () => { location.hash = "#/profile"; };
    drop.querySelector('[data-act="change-pwd"]').onclick = () => openChangePassword();
    drop.querySelector('[data-act="logout"]').onclick = async () => {
      try { await api.post("/auth?action=logout", {}); } catch { /* 忽略 */ }
      clearSession(); session = null; location.hash = "#/login";
    };
  }
  const mt = $("#menuToggle");
  if (mt) mt.onclick = () => $("#sidebar")?.classList.toggle("open");
  refreshReminderBadge();   // 刷新「个人中心」待办角标
}

/* ---------- 登录 ---------- */
function renderLogin() {
  $("#app").innerHTML = `<div class="login-wrap">
    <div class="login-card">
      <div class="login-logo"><img src="/logo.jpg" alt=""></div>
      <div class="login-title">隐患治理台账系统</div>
      <div class="login-sub">${esc(APP.companyName) || "用户登录"}</div>
      <form id="loginForm" style="display:flex;flex-direction:column;gap:16px">
        <div class="field"><label>账号</label><input class="input" id="loginUser" placeholder="请输入账号" autocomplete="username" value="admin"></div>
        <div class="field"><label>密码</label><input class="input" id="loginPwd" type="password" placeholder="请输入密码" autocomplete="current-password" value="123456"></div>
        <div class="err-text" id="loginErr" style="display:none"></div>
        <button class="btn btn-primary btn-block" type="submit" id="loginBtn" style="height:40px">登 录</button>
        <div style="font-size:12px;color:#9ca3af;text-align:center">默认账号 admin / 123456</div>
      </form>
    </div>
  </div>`;

  $("#loginForm").onsubmit = async (e) => {
    e.preventDefault();
    const userName = $("#loginUser").value.trim();
    const password = $("#loginPwd").value;
    const errEl = $("#loginErr"); errEl.style.display = "none";
    if (!userName) { errEl.textContent = "请输入账号"; errEl.style.display = "block"; return; }
    if (!password) { errEl.textContent = "请输入密码"; errEl.style.display = "block"; return; }
    const btn = $("#loginBtn"); btn.disabled = true; btn.textContent = "登录中...";
    try {
      const res = await api.post("/auth?action=login", { userName, password });
      session = { token: res.token, user: res.user, mustChangePassword: res.mustChangePassword };
      saveSession(session);
      location.hash = "#/dashboard";
      if (res.mustChangePassword) setTimeout(() => openChangePassword(true), 300);
    } catch (err) {
      errEl.textContent = err.message; errEl.style.display = "block";
      btn.disabled = false; btn.textContent = "登 录";
    }
  };
}

function openChangePassword(forced = false) {
  openModal({
    title: forced ? "首次登录，请修改密码" : "修改密码",
    desc: forced ? "为了账号安全，请先修改初始密码后再使用系统" : "",
    bodyHtml: `
      <div class="field"><label>旧密码</label><input class="input" id="pwdOld" type="password" placeholder="请输入旧密码"></div>
      <div class="field"><label>新密码</label><input class="input" id="pwdNew" type="password" placeholder="至少6位"></div>
      <div class="field"><label>确认新密码</label><input class="input" id="pwdConfirm" type="password" placeholder="请再次输入新密码"></div>
      <div class="err-text" id="pwdErr" style="display:none"></div>`,
    confirmText: "确认修改",
    onConfirm: async (overlay) => {
      const oldPassword = $("#pwdOld", overlay).value;
      const newPassword = $("#pwdNew", overlay).value;
      const confirm = $("#pwdConfirm", overlay).value;
      const errEl = $("#pwdErr", overlay);
      const fail = (m) => { errEl.textContent = m; errEl.style.display = "block"; return false; };
      if (!oldPassword) return fail("请输入旧密码");
      if (!newPassword) return fail("请输入新密码");
      if (newPassword.length < 6) return fail("新密码至少6位");
      if (confirm !== newPassword) return fail("两次密码输入不一致");
      try {
        await api.post("/auth?action=change-password", { id: currentUser().id, oldPassword, newPassword });
        toast("密码修改成功");
        if (session) { session.mustChangePassword = false; saveSession(session); }
      } catch (err) { return fail(err.message); }
    },
  });
}

/* ---------- 看板 ---------- */
/**
 * 看板页：4 张指标卡 + 4 张图表。
 * 指标卡中「总数 / 未闭环 / 逾期」可点击，跳转到台账页并自动带入对应筛选
 * （见 gotoLedger）。完成率卡为进度条样式，颜色按完成率分四档（rateLevel）。
 */
async function renderDashboard() {
  $("#app").innerHTML = layout("dashboard", `<div class="loading"><div class="spinner"></div>加载中...</div>`);
  bindLayout();

  let stats;
  try { stats = await api.get("/stats"); }
  catch (err) {
    $("#content").innerHTML = `<div class="card card-pad"><div class="empty"><div class="e-title">加载失败</div><div class="e-sub">${esc(err.message)}</div></div></div>`;
    return;
  }

  const levelData = stats.byLevel.map((d) => ({ label: LEVEL_LABELS[d.level], value: d.count, color: LEVEL_COLORS[d.level] }));
  const catData = stats.byCategory.map((d) => ({ label: CATEGORY_LABELS[d.category], value: d.count }));
  const rateLv = rateLevel(stats.completionRate);
  const ratePct = Math.max(0, Math.min(100, Number(stats.completionRate) || 0));

  const seedBanner = stats.total === 0 ? `
    <div class="card card-pad" style="display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap">
      <div>
        <div style="font-weight:600">暂无隐患数据</div>
        <div style="font-size:13px;color:#6b7280;margin-top:4px">可一键灌入一批示例隐患数据，用于快速体验台账、看板与复查闭环流程</div>
      </div>
      <button class="btn btn-primary" id="btnSeed">灌入示例数据</button>
    </div>` : "";

  $("#content").innerHTML = `<div class="page">
    <div class="page-head"><div><div class="page-title">统计看板</div><div class="page-sub">隐患全流程数据概览</div></div></div>
    ${seedBanner}
    <div class="stat-grid">
      <div class="stat-card bg-blue clickable" data-goto="" role="button" tabindex="0" title="点击查看全部台账">
        <div><div class="s-title">隐患总数</div><div class="s-value">${stats.total}</div><div class="s-sub">累计登记</div></div>
        ${icon("trend", 30)}<span class="s-more">查看台账 ›</span>
      </div>
      <div class="stat-card bg-orange clickable" data-goto="unclosed" role="button" tabindex="0" title="点击查看未闭环台账">
        <div><div class="s-title">未闭环数</div><div class="s-value">${stats.unclosed}</div><div class="s-sub">待处理</div></div>
        ${icon("clock", 30)}<span class="s-more">查看台账 ›</span>
      </div>
      <div class="stat-card bg-red clickable" data-goto="overdue" role="button" tabindex="0" title="点击查看逾期台账">
        <div><div class="s-title">逾期数</div><div class="s-value">${stats.overdue}</div><div class="s-sub">需关注</div></div>
        ${icon("alert", 30)}<span class="s-more">查看台账 ›</span>
      </div>
      <div class="stat-card ${rateLv.cls} rate-card">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px">
          <div>
            <div class="s-title">整改完成率</div>
            <div class="s-value">${stats.completionRate}%</div>
            <div class="s-sub">闭环率 · ${rateLv.label}</div>
          </div>
          ${icon("check", 30)}
        </div>
        <div class="rate-bar" title="完成率 ${ratePct}%">
          <span style="width:${ratePct}%"></span>
        </div>
      </div>
    </div>
    <div class="grid-2">
      <div class="card"><div class="card-head">隐患等级分布</div><div class="card-pad">${donutChart(levelData, stats.total)}</div></div>
      <div class="card"><div class="card-head">隐患类别分布</div><div class="card-pad">${hBarChart(catData)}</div></div>
    </div>
    <div class="grid-2">
      <div class="card"><div class="card-head">闭环时长分布（按耗时天数）</div><div class="card-pad">${closureBarChart(stats.closureDist || [])}</div></div>
      <div class="card"><div class="card-head">月度趋势（近 12 个月）</div><div class="card-pad">${lineChart(stats.monthlyTrend)}</div></div>
    </div>
  </div>`;

  // 统计卡点击 → 跳转台账并带入筛选条件
  document.querySelectorAll("#content .stat-card[data-goto]").forEach((el) => {
    const go = () => gotoLedger(el.dataset.goto);
    el.onclick = go;
    el.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } };
  });

  const seedBtn = $("#btnSeed");
  if (seedBtn) {
    seedBtn.onclick = async () => {
      seedBtn.disabled = true; seedBtn.textContent = "灌入中...";
      try {
        const r = await api.post("/seed", {});
        toast(r.seeded ? "示例数据已灌入" : "已存在数据", r.seeded ? `共 ${r.count} 条` : "");
        renderDashboard();
      } catch (err) {
        toast("灌入失败", err.message, "err");
        seedBtn.disabled = false; seedBtn.textContent = "灌入示例数据";
      }
    };
  }
}

/* ---------- 台账列表 ---------- */
const listState = { page: 1, pageSize: 10, level: "", category: "", status: "", dateFrom: "", dateTo: "", keyword: "" };

// 从看板等入口跳转台账，并带入指定筛选
function gotoLedger(statusFilter) {
  Object.assign(listState, {
    page: 1, level: "", category: "", status: statusFilter || "",
    dateFrom: "", dateTo: "", keyword: "",
  });
  if (location.hash === "#/hazards") router();  // 已在台账页 → 强制重新渲染
  else location.hash = "#/hazards";
}

/**
 * 台账列表页。
 * 筛选条件保存在模块级 listState（不是 DOM），因此"看板点指标卡跳转"能直接
 * 预设条件再进入本页；renderHazardList 会把 listState 回填到筛控件上。
 * 表格整体可点击进详情；行内「删除」按钮做了事件隔离（见 loadList）。
 */
async function renderHazardList() {
  $("#app").innerHTML = layout("hazards", `
    <div class="page">
      <div class="page-head">
        <div><div class="page-title">隐患台账</div><div class="page-sub">排查发现 — 登记上报 — 整改实施 — 复查验收 — 闭环销号</div></div>
        <div style="display:flex;gap:10px">
          <button class="btn btn-outline" id="btnPrint">${icon("printer")}打印</button>
          <button class="btn btn-outline" id="btnExport">${icon("download")}导出 Excel</button>
          <a class="btn btn-primary" href="#/hazards/new">${icon("plus")}新增隐患</a>
        </div>
      </div>
      <div class="card card-pad">
        <div class="filter-grid">
          <div class="field"><label>隐患等级</label><select class="select" id="fLevel"><option value="">全部</option>${Object.entries(LEVEL_LABELS).map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></div>
          <div class="field"><label>隐患类别</label><select class="select" id="fCategory"><option value="">全部</option>${Object.entries(CATEGORY_LABELS).map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></div>
          <div class="field"><label>状态</label><select class="select" id="fStatus"><option value="">全部</option>${Object.entries(STATUS_FILTER_LABELS).map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></div>
          <div class="field"><label>关键词</label><input class="input" id="fKeyword" placeholder="搜索编号/描述/部位"></div>
          <div class="field"><label>开始日期</label><input class="input" type="date" id="fFrom"></div>
          <div class="field"><label>结束日期</label><input class="input" type="date" id="fTo"></div>
          <div class="field filter-actions">
            <button class="btn btn-outline" id="btnReset">重置</button>
            <button class="btn btn-primary" id="btnQuery">${icon("search")}查询</button>
          </div>
        </div>
      </div>
      <div class="card card-pad" id="listCard"><div class="loading"><div class="spinner"></div>加载中...</div></div>
    </div>`);
  bindLayout();

  // 回填筛选条件
  $("#fLevel").value = listState.level; $("#fCategory").value = listState.category;
  $("#fStatus").value = listState.status; $("#fKeyword").value = listState.keyword;
  $("#fFrom").value = listState.dateFrom; $("#fTo").value = listState.dateTo;

  $("#btnPrint").onclick = async () => {
    const btn = $("#btnPrint");
    btn.disabled = true;
    const old = btn.innerHTML;
    btn.textContent = "准备中...";
    try {
      await printLedger();
    } catch (err) {
      toast("打印失败", err.message, "err");
    } finally {
      btn.disabled = false; btn.innerHTML = old;
    }
  };

  $("#btnExport").onclick = async () => {
    const btn = $("#btnExport");
    btn.disabled = true;
    const old = btn.innerHTML;
    btn.textContent = "导出中...";
    try {
      const qs = new URLSearchParams({ format: "xlsx" });
      ["level", "category", "status", "dateFrom", "dateTo", "keyword"].forEach((k) => {
        if (listState[k]) qs.set(k, listState[k]);
      });
      const res = await fetch(`/api/export?${qs.toString()}`, {
        headers: {
          Authorization: `Bearer ${session.token}`,
          "X-Operator-Id": session?.user?.id || "",
          "X-Operator": encodeURIComponent(session?.user?.userName || ""),
          "X-Operator-Role": session?.user?.role || "",
        },
      });
      if (!res.ok) throw new Error("导出失败");
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `隐患台账_${todayStr()}.xlsx`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      toast("导出成功", "已按当前筛选条件导出");
    } catch (err) {
      toast("导出失败", err.message, "err");
    } finally {
      btn.disabled = false; btn.innerHTML = old;
    }
  };

  $("#btnQuery").onclick = () => {
    listState.level = $("#fLevel").value; listState.category = $("#fCategory").value;
    listState.status = $("#fStatus").value; listState.keyword = $("#fKeyword").value.trim();
    listState.dateFrom = $("#fFrom").value; listState.dateTo = $("#fTo").value;
    listState.page = 1; loadList();
  };
  $("#btnReset").onclick = () => {
    Object.assign(listState, { page: 1, level: "", category: "", status: "", dateFrom: "", dateTo: "", keyword: "" });
    ["fLevel", "fCategory", "fStatus", "fKeyword", "fFrom", "fTo"].forEach((id) => { $("#" + id).value = ""; });
    loadList();
  };
  loadList();
}

async function loadList() {
  const card = $("#listCard");
  if (!card) return;
  card.innerHTML = `<div class="loading"><div class="spinner"></div>加载中...</div>`;
  const qs = new URLSearchParams({ page: listState.page, pageSize: listState.pageSize });
  ["level", "category", "status", "dateFrom", "dateTo", "keyword"].forEach((k) => { if (listState[k]) qs.set(k, listState[k]); });

  let data;
  try { data = await api.get(`/hazards?${qs.toString()}`); }
  catch (err) { card.innerHTML = `<div class="empty"><div class="e-title">加载失败</div><div class="e-sub">${esc(err.message)}</div></div>`; return; }

  const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const rows = data.items.map((h) => `<tr class="${h.status === "overdue" ? "overdue" : ""}" data-view="${h.id}" title="点击查看详情">
      <td class="code">${esc(h.hazardCode)}</td>
      <td>${esc(h.inspectDate)}</td>
      <td>${esc(h.location)}</td>
      <td class="desc" title="${esc(h.description)}">${esc(h.description)}</td>
      <td>${esc(CATEGORY_LABELS[h.category] || h.category)}</td>
      <td><span class="badge lv-${h.level}">${esc(LEVEL_LABELS[h.level] || h.level)}</span></td>
      <td><span class="badge st-${h.status}">${esc(STATUS_LABELS[h.status] || h.status)}</span></td>
      <td>${esc(h.rectifyPerson)}</td>
      <td>${esc(h.planDeadline)}</td>
      <td style="white-space:nowrap"><span class="btn-link">查看</span>${isAdmin() || currentUser()?.role === "safety_admin" ? ` <button class="btn-link" style="color:#dc2626" data-del="${h.id}" data-code="${esc(h.hazardCode)}">删除</button>` : ""}</td>
    </tr>`).join("");

  card.innerHTML = data.items.length === 0
    ? `<div class="empty">${icon("search", 40)}<div class="e-title">暂无数据</div><div class="e-sub">没有找到符合条件的隐患记录</div></div>`
    : `<div class="scroll-hint">← 左右滑动查看完整表格 →</div>
      <div class="table-wrap"><table class="tbl">
        <thead><tr>
          <th>隐患编号</th><th>排查日期</th><th>所在部位</th><th>隐患描述</th><th>类别</th>
          <th>等级</th><th>状态</th><th>整改责任人</th><th>计划完成时限</th><th>操作</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <div class="pager">
        <div class="info">共 <b>${data.total}</b> 条记录</div>
        <div class="ctrl">
          <span class="info">每页</span>
          <select class="input" id="pageSizeSel">${[10, 20, 50].map((n) => `<option value="${n}" ${n === data.pageSize ? "selected" : ""}>${n}</option>`).join("")}</select>
          <button class="icon-btn" id="prevBtn" ${listState.page <= 1 ? "disabled" : ""}>${icon("chevronLeft", 15)}</button>
          <span style="font-size:13px">${listState.page} / ${totalPages}</span>
          <button class="icon-btn" id="nextBtn" ${listState.page >= totalPages ? "disabled" : ""}>${icon("chevronRight", 15)}</button>
        </div>
      </div>`;

  // 整行点击 → 进入详情（删除按钮除外）
  card.querySelectorAll("tr[data-view]").forEach((tr) => {
    tr.onclick = (e) => {
      if (e.target.closest("[data-del]")) return;
      location.hash = `#/hazards/${tr.dataset.view}`;
    };
  });
  card.querySelectorAll("[data-del]").forEach((b) => {
    b.onclick = () => openModal({
      title: "确认删除", desc: `确定要删除隐患「${b.dataset.code}」吗？此操作不可撤销。`,
      confirmText: "确认删除", danger: true,
      onConfirm: async () => {
        try { await api.del(`/hazards/${b.dataset.del}`); toast("删除成功"); loadList(); }
        catch (err) { toast("删除失败", err.message, "err"); return false; }
      },
    });
  });
  const ps = $("#pageSizeSel");
  if (ps) ps.onchange = () => { listState.pageSize = Number(ps.value); listState.page = 1; loadList(); };
  const prev = $("#prevBtn"), next = $("#nextBtn");
  if (prev) prev.onclick = () => { listState.page = Math.max(1, listState.page - 1); loadList(); };
  if (next) next.onclick = () => { listState.page = Math.min(totalPages, listState.page + 1); loadList(); };
}

/* ---------- 打印台账 ---------- */
// 取回当前筛选条件下的全部记录（分页循环）
async function fetchAllFiltered() {
  const pageSize = 100;
  let page = 1;
  let all = [];
  for (;;) {
    const qs = new URLSearchParams({ page, pageSize });
    ["level", "category", "status", "dateFrom", "dateTo", "keyword"].forEach((k) => {
      if (listState[k]) qs.set(k, listState[k]);
    });
    const data = await api.get(`/hazards?${qs.toString()}`);
    all = all.concat(data.items);
    if (all.length >= data.total || data.items.length === 0) break;
    page += 1;
    if (page > 100) break; // 安全上限
  }
  return all;
}

function filterSummaryText() {
  const parts = [];
  if (listState.level) parts.push(`等级：${LEVEL_LABELS[listState.level]}`);
  if (listState.category) parts.push(`类别：${CATEGORY_LABELS[listState.category]}`);
  if (listState.status) parts.push(`状态：${STATUS_LABELS[listState.status]}`);
  if (listState.dateFrom) parts.push(`排查日期 ≥ ${listState.dateFrom}`);
  if (listState.dateTo) parts.push(`排查日期 ≤ ${listState.dateTo}`);
  if (listState.keyword) parts.push(`关键词：${listState.keyword}`);
  return parts.length ? parts.join("；") : "全部";
}

/**
 * 打印台账清单。
 * 思路：新建一个隐藏 iframe → document.write 打印专用 HTML → contentWindow.print()。
 * 用 iframe 而不是 window.open，可以避免被浏览器"拦截弹窗"。
 * 打印稿含 A4 横向页面设置、标题、筛选条件与条数，并自动取回**全部**筛选结果
 * （fetchAllFiltered 会分页循环拉取，不受列表每页条数限制）。
 */
async function printLedger() {
  const items = await fetchAllFiltered();
  if (items.length === 0) {
    toast("无可打印数据", "当前筛选条件下没有隐患记录", "err");
    return;
  }
  showPrintHintOnce();

  const rows = items.map((h, i) => `<tr>
      <td>${i + 1}</td>
      <td>${esc(h.hazardCode)}</td>
      <td>${esc(h.inspectDate)}</td>
      <td>${esc(h.location)}</td>
      <td class="d">${esc(h.description)}</td>
      <td>${esc(CATEGORY_LABELS[h.category] || h.category)}</td>
      <td>${esc(LEVEL_LABELS[h.level] || h.level)}</td>
      <td class="d">${esc(h.rectifyMeasure)}</td>
      <td>${esc(h.rectifyPerson)}</td>
      <td>${esc(h.rectifyFund)}</td>
      <td>${esc(h.planDeadline)}</td>
      <td>${esc(STATUS_LABELS[h.status] || h.status)}</td>
    </tr>`).join("");

  const html = `<!DOCTYPE html><html lang="zh"><head><meta charset="UTF-8"><title>矿山安全隐患排查治理台账</title>
<style>
  @page { size: A4 landscape; margin: 10mm; }
  * { box-sizing: border-box; }
  body { font-family: "Microsoft YaHei", "PingFang SC", sans-serif; color: #111; margin: 0; }
  h1 { font-size: 17pt; text-align: center; margin: 0 0 6px; letter-spacing: 1px; }
  .meta { text-align: center; font-size: 9pt; color: #555; margin-bottom: 10px; }
  table { width: 100%; border-collapse: collapse; font-size: 8.5pt; }
  th, td { border: 1px solid #999; padding: 4px 5px; vertical-align: top; word-break: break-all; }
  th { background: #eee; font-weight: 600; }
  td.d { max-width: 150px; }
  tr { page-break-inside: avoid; }
  thead { display: table-header-group; }
</style></head><body>
<h1>矿山安全隐患排查治理台账</h1>
<div class="meta">筛选条件：${esc(filterSummaryText())}　｜　共 ${items.length} 条</div>
<table>
  <thead><tr>
    <th style="width:3%">序号</th><th style="width:9%">隐患编号</th><th style="width:7%">排查日期</th>
    <th style="width:9%">所在部位</th><th>隐患描述</th><th style="width:6%">类别</th>
    <th style="width:5%">等级</th><th>整改措施</th><th style="width:6%">整改责任人</th>
    <th style="width:7%">整改资金(元)</th><th style="width:7%">计划完成时限</th><th style="width:5%">状态</th>
  </tr></thead>
  <tbody>${rows}</tbody>
</table>
</body></html>`;

  const iframe = document.createElement("iframe");
  iframe.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
  document.body.appendChild(iframe);
  const doc = iframe.contentWindow.document;
  doc.open(); doc.write(html); doc.close();
  setTimeout(() => {
    try {
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
    } finally {
      setTimeout(() => iframe.remove(), 1500);
    }
  }, 350);
}

/* ---------- 打印单条隐患详情单 ---------- */
function printHazardDetail(h) {
  showPrintHintOnce();
  const v = (x) => (x === null || x === undefined || String(x).trim() === "" ? "—" : String(x));

  const section = (t) => `<tr class="sec"><td colspan="4">${esc(t)}</td></tr>`;
  const row2 = (l1, v1, l2, v2) => `<tr><th>${esc(l1)}</th><td>${esc(v(v1))}</td><th>${esc(l2)}</th><td>${esc(v(v2))}</td></tr>`;
  const rowFull = (l, val) => `<tr><th>${esc(l)}</th><td colspan="3" class="pre">${esc(v(val))}</td></tr>`;
  const photoRow = (label, urls) => {
    const list = Array.isArray(urls) ? urls : [];
    if (list.length === 0) return `<tr><th>${esc(label)}</th><td colspan="3">—</td></tr>`;
    const imgs = list.map((u) => `<img src="${esc(location.origin + u)}" alt="">`).join("");
    return `<tr><th>${esc(label)}</th><td colspan="3"><div class="ph">${imgs}</div></td></tr>`;
  };

  const html = `<!DOCTYPE html><html lang="zh"><head><meta charset="UTF-8"><title>隐患详情单 ${esc(h.hazardCode)}</title>
<style>
  @page { size: A4 portrait; margin: 14mm; }
  * { box-sizing: border-box; }
  body { font-family: "Microsoft YaHei", "PingFang SC", sans-serif; color: #111; margin: 0; }
  h1 { font-size: 17pt; text-align: center; margin: 0 0 4px; letter-spacing: 2px; }
  .code { text-align: center; font-size: 10pt; color: #444; margin-bottom: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 10pt; }
  th, td { border: 1px solid #888; padding: 7px 9px; vertical-align: top; word-break: break-all; }
  th { background: #f0f0f0; font-weight: 600; width: 15%; text-align: left; white-space: nowrap; }
  tr.sec td { background: #e2e8f0; font-weight: 700; letter-spacing: 1px; }
  td.pre { white-space: pre-wrap; line-height: 1.6; }
  .ph img { height: 88px; border: 1px solid #999; margin: 3px 5px 3px 0; vertical-align: middle; }
  .badge { display: inline-block; border: 1px solid #666; border-radius: 3px; padding: 0 6px; font-size: 9.5pt; }
  .sign { margin-top: 30px; display: flex; justify-content: space-between; font-size: 10.5pt; }
  .sign .line { display: inline-block; border-bottom: 1px solid #333; min-width: 110px; }
</style></head><body>
<h1>安全隐患排查治理台账 · 隐患详情单</h1>
<div class="code">隐患编号：<b>${esc(h.hazardCode)}</b>　｜　状态：<span class="badge">${esc(STATUS_LABELS[h.status] || h.status)}</span></div>
<table>
  ${section("一、基本信息")}
  ${row2("排查日期", h.inspectDate, "排查人员", h.inspector)}
  ${row2("所在部位", h.location, "登记时间", fmtDateTime(h.createdAt))}
  ${section("二、隐患信息")}
  ${row2("隐患类别", CATEGORY_LABELS[h.category] || h.category, "隐患等级", LEVEL_LABELS[h.level] || h.level)}
  ${rowFull("隐患描述", h.description)}
  ${photoRow("隐患照片", h.hazardPhotos)}
  ${section("三、整改信息")}
  ${rowFull("整改措施", h.rectifyMeasure)}
  ${row2("整改责任人", h.rectifyPerson, "整改资金（元）", h.rectifyFund)}
  ${row2("计划完成时限", h.planDeadline, "整改状态", STATUS_LABELS[h.status] || h.status)}
  ${rowFull("应急预案", h.emergencyPlan || "无")}
  ${photoRow("整改照片", h.rectifyPhotos)}
  ${section("四、复查闭环信息")}
  ${row2("实际完成日期", h.actualCompleteDate, "复查人员", h.reviewer)}
  ${row2("复查日期", h.reviewDate, "闭环时间", h.closedAt ? fmtDateTime(h.closedAt) : "")}
  ${rowFull("复查结果", h.reviewResult)}
</table>
<div class="sign">
  <div>排查人签字：<span class="line"></span></div>
  <div>整改责任人签字：<span class="line"></span></div>
  <div>复查人签字：<span class="line"></span></div>
</div>
</body></html>`;

  const iframe = document.createElement("iframe");
  iframe.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
  document.body.appendChild(iframe);
  const doc = iframe.contentWindow.document;
  doc.open(); doc.write(html); doc.close();
  setTimeout(() => {
    try {
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
    } finally {
      setTimeout(() => iframe.remove(), 1500);
    }
  }, 350);
}

/* ---------- 隐患登记 ---------- */
function renderHazardNew() {
  const sel = (id, labels, ph) => `<select class="select" id="${id}"><option value="">${ph}</option>${Object.entries(labels).map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select>`;
  $("#app").innerHTML = layout("new", `<div class="page">
    <div class="page-head">
      <div class="head-left"><button class="back-btn" id="backBtn">${icon("back")}</button><div class="page-title">隐患登记</div></div>
    </div>
    <div class="card card-pad">
      <form id="hazardForm">
        <div class="section-title">基本信息</div>
        <div class="form-grid">
          <div class="field"><label>排查日期 <span class="req">*</span></label><input class="input" type="date" id="inspectDate" value="${todayStr()}"></div>
          <div class="field"><label>排查人员 <span class="req">*</span></label><input class="input" id="inspector" placeholder="请输入排查人员姓名"></div>
          <div class="field span-2"><label>隐患所在部位 <span class="req">*</span></label><input class="input" id="location" placeholder="如：主井口提升机、井下变电室"></div>
        </div>
        <div class="section-title" style="margin-top:26px">隐患信息</div>
        <div class="form-grid">
          <div class="field span-2"><label>隐患描述 <span class="req">*</span></label><textarea class="textarea" id="description" placeholder="请详细描述隐患情况"></textarea></div>
          <div class="field"><label>隐患类别 <span class="req">*</span></label>${sel("category", CATEGORY_LABELS, "请选择隐患类别")}</div>
          <div class="field"><label>隐患等级 <span class="req">*</span></label>${sel("level", LEVEL_LABELS, "请选择隐患等级")}</div>
          ${photoUploaderHtml("hazardPhotos", "隐患照片", `最多 ${MAX_PHOTOS} 张，选择后自动上传；点击缩略图可放大`)}
        </div>
        <div class="section-title" style="margin-top:26px">整改信息</div>
        <div class="form-grid">
          <div class="field span-2"><label>整改措施 <span class="req">*</span></label><textarea class="textarea" id="rectifyMeasure" placeholder="请描述具体整改措施"></textarea></div>
          <div class="field"><label>整改责任人 <span class="req">*</span></label><input class="input" id="rectifyPerson" placeholder="请输入整改责任人姓名"></div>
          <div class="field"><label>整改资金（元） <span class="req">*</span></label><input class="input" type="number" min="0" id="rectifyFund" placeholder="请输入整改资金"></div>
          <div class="field"><label>计划完成时限 <span class="req">*</span></label><input class="input" type="date" id="planDeadline"></div>
          <div class="field span-2"><label>应急预案</label><textarea class="textarea" id="emergencyPlan" placeholder="请输入应急预案（选填）"></textarea></div>
          ${photoUploaderHtml("rectifyPhotos", "整改照片", `最多 ${MAX_PHOTOS} 张，可登记时上传，也可整改完成后补充`)}
        </div>
        <div class="err-text" id="formErr" style="display:none;margin-top:14px"></div>
        <div style="display:flex;justify-content:flex-end;gap:12px;margin-top:24px;padding-top:20px;border-top:1px solid #f1f5f9">
          <a class="btn btn-outline" href="#/hazards">取消</a>
          <button class="btn btn-primary" type="submit" id="submitBtn">提交登记</button>
        </div>
      </form>
    </div>
  </div>`);
  bindLayout();
  $("#backBtn").onclick = () => history.back();
  const hazardPhotos = initPhotoUploader("hazardPhotos");
  const rectifyPhotos = initPhotoUploader("rectifyPhotos");

  $("#hazardForm").onsubmit = async (e) => {
    e.preventDefault();
    const errEl = $("#formErr"); errEl.style.display = "none";
    const get = (id) => $("#" + id).value;
    const payload = {
      inspectDate: get("inspectDate"), inspector: get("inspector").trim(),
      location: get("location").trim(), description: get("description").trim(),
      category: get("category"), level: get("level"),
      rectifyMeasure: get("rectifyMeasure").trim(), rectifyPerson: get("rectifyPerson").trim(),
      rectifyFund: get("rectifyFund"), planDeadline: get("planDeadline"),
      emergencyPlan: get("emergencyPlan").trim() || undefined,
      hazardPhotos: hazardPhotos.urls,
      rectifyPhotos: rectifyPhotos.urls,
    };
    for (const [k, label] of [["inspectDate", "排查日期"], ["inspector", "排查人员"], ["location", "隐患所在部位"], ["description", "隐患描述"], ["category", "隐患类别"], ["level", "隐患等级"], ["rectifyMeasure", "整改措施"], ["rectifyPerson", "整改责任人"], ["rectifyFund", "整改资金"], ["planDeadline", "计划完成时限"]]) {
      if (!payload[k]) { errEl.textContent = `请填写${label}`; errEl.style.display = "block"; return; }
    }
    if (Number(payload.rectifyFund) < 0) { errEl.textContent = "整改资金不能为负数"; errEl.style.display = "block"; return; }
    const btn = $("#submitBtn"); btn.disabled = true; btn.textContent = "提交中...";
    try {
      await api.post("/hazards", payload);
      toast("登记成功", "隐患已成功登记，即将返回台账列表");
      location.hash = "#/hazards";
    } catch (err) {
      errEl.textContent = err.message; errEl.style.display = "block";
      btn.disabled = false; btn.textContent = "提交登记";
    }
  };
}

/* ---------- 隐患详情 / 复查 ---------- */
/**
 * 隐患详情页（含状态流转操作）。
 * 页面按状态自适应：
 *   待整改 → 显示「开始整改」按钮（有整改权限时）
 *   整改中 → 显示复查表单（有复查权限时）
 *   已闭环 → 显示闭环信息
 * 右上角「打印」可输出 A4 纵向的《隐患详情单》。
 */
async function renderHazardDetail(id) {
  $("#app").innerHTML = layout("hazards", `<div class="loading"><div class="spinner"></div>加载中...</div>`);
  bindLayout();

  let h;
  try { h = await api.get(`/hazards/${id}`); }
  catch (err) {
    $("#content").innerHTML = `<div class="card card-pad"><div class="empty"><div class="e-title">加载失败</div><div class="e-sub">${esc(err.message)}</div></div></div>`;
    return;
  }

  const infoRow = (label, value) => `<div class="info-item"><div class="i-label">${esc(label)}</div><div class="i-value">${esc(value) || "—"}</div></div>`;
  const isClosed = h.status === "closed";
  const canReview = ["reviewer", "safety_admin", "admin"].includes(currentUser()?.role);
  const canRectify = ["entry", "safety_admin", "admin"].includes(currentUser()?.role);

  const reviewForm = `
    <form id="reviewForm">
      <div class="form-grid">
        <div class="field"><label>实际完成日期 <span class="req">*</span></label><input class="input" type="date" id="actualCompleteDate"></div>
        <div class="field"><label>复查日期 <span class="req">*</span></label><input class="input" type="date" id="reviewDate" value="${todayStr()}"></div>
      </div>
      <div class="form-grid" style="margin-top:16px">
        <div class="field span-2"><label>复查人员 <span class="req">*</span></label><input class="input" id="reviewer" placeholder="请输入复查人员姓名"></div>
        <div class="field span-2"><label>复查结果 <span class="req">*</span></label><textarea class="textarea" id="reviewResult" placeholder="请输入复查结果描述"></textarea></div>
      </div>
      <div class="err-text" id="reviewErr" style="display:none;margin-top:12px"></div>
      <div style="display:flex;justify-content:flex-end;margin-top:18px">
        <button class="btn btn-primary" type="submit" id="reviewBtn">确认复查闭环</button>
      </div>
    </form>`;

  $("#content").innerHTML = `<div class="page">
    <div class="page-head">
      <div class="head-left">
        <button class="back-btn" id="backBtn">${icon("back")}</button>
        <div class="page-title">${esc(h.hazardCode)}</div>
      </div>
      <div style="display:flex;align-items:center;gap:12px">
        <span class="badge st-${h.status}" style="padding:5px 12px">${esc(STATUS_LABELS[h.status])}</span>
        <button class="btn btn-outline" id="btnPrintDetail">${icon("printer")}打印</button>
      </div>
    </div>
    ${h.status === "overdue" ? `<div class="alert-overdue">${icon("alert", 18)}该隐患已逾期，请尽快完成整改并复查闭环</div>` : ""}
    <div class="card card-pad">
      <div class="card-head" style="padding:0 0 14px;border:none;font-size:16px">基本信息</div>
      <div class="info-grid">
        ${infoRow("排查日期", h.inspectDate)}${infoRow("排查人员", h.inspector)}${infoRow("所在部位", h.location)}
        ${infoRow("隐患类别", CATEGORY_LABELS[h.category] || h.category)}
        <div class="info-item"><div class="i-label">隐患等级</div><div class="i-value"><span class="badge lv-${h.level}">${esc(LEVEL_LABELS[h.level])}</span></div></div>
        ${infoRow("登记时间", fmtDateTime(h.createdAt))}
        <div class="info-item full"><div class="i-label">隐患描述</div><div class="i-value pre">${esc(h.description)}</div></div>
        ${photoViewer("隐患照片", h.hazardPhotos)}
      </div>
    </div>
    <div class="card card-pad">
      <div class="card-head" style="padding:0 0 14px;border:none;font-size:16px">整改信息</div>
      <div class="info-item full" style="margin-bottom:16px"><div class="i-label">整改措施</div><div class="i-value pre">${esc(h.rectifyMeasure)}</div></div>
      <div class="info-grid">
        ${infoRow("整改责任人", h.rectifyPerson)}${infoRow("整改资金（元）", h.rectifyFund)}${infoRow("计划完成时限", h.planDeadline)}
        <div class="info-item full"><div class="i-label">应急预案</div><div class="i-value pre">${esc(h.emergencyPlan || "无")}</div></div>
        ${photoViewer("整改照片", h.rectifyPhotos)}
      </div>
    </div>
    <div class="card card-pad">
      <div class="card-head" style="padding:0 0 14px;border:none;font-size:16px">复查信息</div>
      ${isClosed ? `
        <div class="info-grid">
          ${infoRow("实际完成日期", h.actualCompleteDate)}${infoRow("复查人员", h.reviewer)}${infoRow("复查日期", h.reviewDate)}
          ${infoRow("闭环时间", fmtDateTime(h.closedAt))}
          <div class="info-item full"><div class="i-label">复查结果</div><div class="i-value pre">${esc(h.reviewResult)}</div></div>
        </div>
        <div class="closed-note">${icon("check", 18)}已闭环</div>`
      : h.status === "rectifying" ? `
        <div class="rectify-banner">${icon("clock", 18)}该隐患正在整改中，整改责任人：${esc(h.rectifyPerson)}</div>
        ${canReview ? reviewForm : `<div class="empty"><div class="e-title">整改中</div><div class="e-sub">等待复查人员复查闭环</div></div>`}`
      : `
        ${canRectify ? `<div class="rectify-banner pending">
          <div>
            <div style="font-weight:600">该隐患待整改</div>
            <div style="font-size:13px;color:#6b7280;margin-top:2px">整改责任人：${esc(h.rectifyPerson)}，点击右侧按钮进入整改流程</div>
          </div>
          <button class="btn btn-primary" id="btnStartRectify">${icon("play", 16)}开始整改</button>
        </div>` : `<div class="empty"><div class="e-title">待整改</div><div class="e-sub">当前角色无权开始整改</div></div>`}
        ${canReview ? `<div style="font-size:12.5px;color:#9ca3af;margin-top:12px">提示：需先由录入人员/安全管理员「开始整改」后，方可进行复查闭环。</div>` : ""}`}
    </div>
  </div>`;

  $("#backBtn").onclick = () => history.back();
  const bpd = $("#btnPrintDetail");
  if (bpd) {
    bpd.onclick = () => {
      const old = bpd.innerHTML;
      bpd.disabled = true;
      bpd.textContent = "准备中...";
      try {
        printHazardDetail(h);
      } finally {
        setTimeout(() => { bpd.disabled = false; bpd.innerHTML = old; }, 800);
      }
    };
  }
  const btnSR = $("#btnStartRectify");
  if (btnSR) {
    btnSR.onclick = async () => {
      btnSR.disabled = true; btnSR.textContent = "处理中...";
      try {
        await api.patch(`/hazards/${id}`, { action: "start-rectify" });
        toast("已开始整改", "状态：待整改 → 整改中");
        renderHazardDetail(id);
      } catch (err) {
        toast("操作失败", err.message, "err");
        btnSR.disabled = false; btnSR.innerHTML = `${icon("play", 16)}开始整改`;
      }
    };
  }
  const rf = $("#reviewForm");
  if (rf) {
    rf.onsubmit = async (e) => {
      e.preventDefault();
      const errEl = $("#reviewErr"); errEl.style.display = "none";
      const payload = {
        action: "review",
        actualCompleteDate: $("#actualCompleteDate").value,
        reviewer: $("#reviewer").value.trim(),
        reviewDate: $("#reviewDate").value,
        reviewResult: $("#reviewResult").value.trim(),
      };
      for (const [k, label] of [["actualCompleteDate", "实际完成日期"], ["reviewer", "复查人员"], ["reviewDate", "复查日期"], ["reviewResult", "复查结果"]]) {
        if (!payload[k]) { errEl.textContent = `请填写${label}`; errEl.style.display = "block"; return; }
      }
      const btn = $("#reviewBtn"); btn.disabled = true; btn.textContent = "提交中...";
      try {
        await api.patch(`/hazards/${id}`, payload);
        toast("复查闭环成功");
        renderHazardDetail(id);
      } catch (err) {
        errEl.textContent = err.message; errEl.style.display = "block";
        btn.disabled = false; btn.textContent = "确认复查闭环";
      }
    };
  }
}

/* ---------- 用户管理 ---------- */
async function renderUsers() {
  $("#app").innerHTML = layout("users", `<div class="page">
    <div class="page-head">
      <div><div class="page-title">用户管理</div><div class="page-sub">管理系统用户及角色权限</div></div>
      ${isAdmin() ? `<button class="btn btn-primary" id="btnAddUser">${icon("userPlus")}添加用户</button>` : ""}
    </div>
    <div class="card card-pad" id="userCard"><div class="loading"><div class="spinner"></div>加载中...</div></div>
    ${isAdmin() ? `<div class="card card-pad" id="maintCard">
      <div style="font-size:16px;font-weight:600;margin-bottom:14px">系统维护</div>
      <div id="maintBox"><div class="loading"><div class="spinner"></div>加载中...</div></div>
    </div>` : ""}
  </div>`);
  bindLayout();
  if (isAdmin()) $("#btnAddUser").onclick = openAddUser;
  loadUsers();
  if (isAdmin()) loadMaintenance();
}

/* ---------- 系统维护：无引用图片清理 ---------- */
const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

async function loadMaintenance() {
  const box = $("#maintBox");
  if (!box) return;
  let d;
  try { d = await api.get("/photos"); }
  catch (err) {
    box.innerHTML = `<div class="empty"><div class="e-title">加载失败</div><div class="e-sub">${esc(err.message)}</div></div>`;
    return;
  }
  box.innerHTML = `
    <div class="info-grid cols-4">
      <div class="info-item"><div class="i-label">图片文件总数</div><div class="i-value">${d.total} 张</div></div>
      <div class="info-item"><div class="i-label">占用空间</div><div class="i-value">${fmtSize(d.totalSize)}</div></div>
      <div class="info-item"><div class="i-label">被记录引用</div><div class="i-value">${d.referenced} 张</div></div>
      <div class="info-item"><div class="i-label">无引用（可清理）</div>
        <div class="i-value" style="color:${d.orphanCount ? "#dc2626" : "#16a34a"}">${d.orphanCount} 张</div></div>
    </div>
    <div style="display:flex;align-items:center;gap:12px;margin-top:18px;flex-wrap:wrap">
      <button class="btn btn-outline" id="btnCleanup" ${d.orphanCount ? "" : "disabled"}>${icon("trash", 16)}清理无引用图片</button>
      <span style="font-size:12.5px;color:#6b7280">
        ${d.orphanCount
          ? `将释放约 ${fmtSize(d.orphanSize)}；被隐患记录引用的图片不会删除`
          : "当前没有需要清理的图片"}
      </span>
    </div>`;

  const btn = $("#btnCleanup");
  if (btn && d.orphanCount) {
    btn.onclick = () => openModal({
      title: "确认清理",
      desc: `将删除 ${d.orphanCount} 张未被任何隐患记录引用的图片（约 ${fmtSize(d.orphanSize)}）。此操作不可撤销。`,
      confirmText: "确认清理", danger: true,
      onConfirm: async () => {
        try {
          const r = await api.post("/photos", {});
          toast("清理完成", `已删除 ${r.deleted} 张，释放 ${(r.freed / 1024).toFixed(0)} KB`);
          loadMaintenance();
        } catch (err) { toast("清理失败", err.message, "err"); return false; }
      },
    });
  }
}

async function loadUsers() {
  const card = $("#userCard");
  let users;
  try { users = await api.get("/users"); }
  catch (err) { card.innerHTML = `<div class="empty"><div class="e-title">加载失败</div><div class="e-sub">${esc(err.message)}</div></div>`; return; }

  card.innerHTML = users.length === 0
    ? `<div class="empty">${icon("users", 40)}<div class="e-title">暂无用户数据</div></div>`
    : `<div class="table-wrap"><table class="tbl" style="min-width:720px">
        <thead><tr><th>用户姓名</th><th>角色</th><th>创建时间</th><th style="text-align:right">操作</th></tr></thead>
        <tbody>${users.map((u) => `<tr>
          <td style="font-weight:500">${esc(u.userName)}</td>
          <td><span class="badge role-${u.role}">${esc(ROLE_LABELS[u.role] || u.role)}</span></td>
          <td style="color:#6b7280">${fmtDateTime(u.createdAt)}</td>
          <td style="text-align:right">
            ${isAdmin() ? `<button class="btn-link" data-edit="${u.id}">编辑角色</button>
            <button class="btn-link" style="margin-left:10px" data-reset="${u.id}" data-name="${esc(u.userName)}">重置密码</button>
            <button class="btn-link" style="margin-left:10px;color:#dc2626" data-del="${u.id}" data-name="${esc(u.userName)}">删除</button>`
            : `<span style="color:#9ca3af;font-size:12.5px">仅系统管理员可操作</span>`}
          </td>
        </tr>`).join("")}</tbody>
      </table></div>`;

  card.querySelectorAll("[data-edit]").forEach((b) => {
    const u = users.find((x) => x.id === b.dataset.edit);
    b.onclick = () => openModal({
      title: "编辑角色", desc: `用户：${u.userName}`,
      bodyHtml: `<div class="field"><label>角色</label><select class="select" id="editRole">${Object.entries(ROLE_LABELS).map(([v, l]) => `<option value="${v}" ${v === u.role ? "selected" : ""}>${l}</option>`).join("")}</select></div>`,
      onConfirm: async (overlay) => {
        try { await api.patch(`/users/${u.id}`, { role: $("#editRole", overlay).value }); toast("角色更新成功"); loadUsers(); }
        catch (err) { toast("更新失败", err.message, "err"); return false; }
      },
    });
  });
  card.querySelectorAll("[data-reset]").forEach((b) => {
    b.onclick = () => openModal({
      title: "确认重置密码",
      desc: `确定要重置用户「${b.dataset.name}」的密码吗？重置后为初始密码 123456，该用户下次登录需强制修改。`,
      confirmText: "确认重置",
      onConfirm: async () => {
        try { await api.patch(`/users/${b.dataset.reset}`, { action: "reset-password" }); toast("密码已重置为 123456，下次登录需修改"); }
        catch (err) { toast("重置失败", err.message, "err"); return false; }
      },
    });
  });
  card.querySelectorAll("[data-del]").forEach((b) => {
    b.onclick = () => openModal({
      title: "确认删除", desc: `确定要删除用户「${b.dataset.name}」吗？此操作不可撤销。`,
      confirmText: "确认删除", danger: true,
      onConfirm: async () => {
        try { await api.del(`/users/${b.dataset.del}`); toast("删除成功"); loadUsers(); }
        catch (err) { toast("删除失败", err.message, "err"); return false; }
      },
    });
  });
}

function openAddUser() {
  openModal({
    title: "添加用户", desc: "填写用户信息并分配角色，初始密码为 123456",
    bodyHtml: `
      <div class="field"><label>用户姓名</label><input class="input" id="newUserName" placeholder="请输入用户姓名"></div>
      <div class="field"><label>角色</label><select class="select" id="newUserRole">${Object.entries(ROLE_LABELS).map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></div>
      <div class="err-text" id="newUserErr" style="display:none"></div>`,
    confirmText: "确认",
    onConfirm: async (overlay) => {
      const userName = $("#newUserName", overlay).value.trim();
      const errEl = $("#newUserErr", overlay);
      if (!userName) { errEl.textContent = "请输入用户姓名"; errEl.style.display = "block"; return false; }
      try {
        await api.post("/users", { userName, role: $("#newUserRole", overlay).value });
        toast("添加用户成功", "初始密码 123456");
        loadUsers();
      } catch (err) { errEl.textContent = err.message; errEl.style.display = "block"; return false; }
    },
  });
}

/* ---------- 操作日志 ---------- */
const logState = { page: 1, pageSize: 20, action: "", keyword: "" };

async function renderLogs() {
  $("#app").innerHTML = layout("logs", `
    <div class="page">
      <div class="page-head"><div><div class="page-title">操作日志</div><div class="page-sub">记录谁在何时登记、整改、复查、删除了什么</div></div></div>
      <div class="card card-pad">
        <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:flex-end">
          <div class="field" style="min-width:180px"><label>操作类型</label>
            <select class="select" id="logAction"><option value="">全部</option>${Object.entries(ACTION_LABELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select>
          </div>
          <div class="field" style="min-width:240px"><label>关键词</label><input class="input" id="logKeyword" placeholder="操作人 / 隐患编号 / 详情"></div>
          <button class="btn btn-primary" id="logQuery">${icon("search")}查询</button>
          <button class="btn btn-outline" id="logReset">重置</button>
        </div>
      </div>
      <div class="card card-pad" id="logCard"><div class="loading"><div class="spinner"></div>加载中...</div></div>
    </div>`);
  bindLayout();
  $("#logAction").value = logState.action;
  $("#logKeyword").value = logState.keyword;
  $("#logQuery").onclick = () => {
    logState.action = $("#logAction").value;
    logState.keyword = $("#logKeyword").value.trim();
    logState.page = 1; loadLogs();
  };
  $("#logReset").onclick = () => {
    logState.action = ""; logState.keyword = ""; logState.page = 1;
    $("#logAction").value = ""; $("#logKeyword").value = "";
    loadLogs();
  };
  loadLogs();
}

async function loadLogs() {
  const card = $("#logCard");
  if (!card) return;
  card.innerHTML = `<div class="loading"><div class="spinner"></div>加载中...</div>`;
  const qs = new URLSearchParams({ page: logState.page, pageSize: logState.pageSize });
  if (logState.action) qs.set("action", logState.action);
  if (logState.keyword) qs.set("keyword", logState.keyword);

  let data;
  try { data = await api.get(`/logs?${qs.toString()}`); }
  catch (err) { card.innerHTML = `<div class="empty"><div class="e-title">加载失败</div><div class="e-sub">${esc(err.message)}</div></div>`; return; }

  const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const rows = data.items.map((l) => `<tr>
      <td style="white-space:nowrap;color:#6b7280">${fmtDateTime(l.createdAt)}</td>
      <td style="font-weight:500">${esc(l.userName || "—")}</td>
      <td><span class="badge st-pending">${esc(l.actionLabel)}</span></td>
      <td class="code">${esc(l.targetCode || "—")}</td>
      <td style="color:#4b5563">${esc(l.detail || "")}</td>
    </tr>`).join("");

  card.innerHTML = data.items.length === 0
    ? `<div class="empty">${icon("fileText", 40)}<div class="e-title">暂无日志</div><div class="e-sub">没有符合条件的操作记录</div></div>`
    : `<div class="table-wrap"><table class="tbl" style="min-width:820px">
        <thead><tr><th style="width:180px">时间</th><th style="width:120px">操作人</th><th style="width:140px">操作</th><th style="width:180px">对象</th><th>详情</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <div class="pager">
        <div class="info">共 <b>${data.total}</b> 条日志</div>
        <div class="ctrl">
          <button class="icon-btn" id="logPrev" ${logState.page <= 1 ? "disabled" : ""}>${icon("chevronLeft", 15)}</button>
          <span style="font-size:13px">${logState.page} / ${totalPages}</span>
          <button class="icon-btn" id="logNext" ${logState.page >= totalPages ? "disabled" : ""}>${icon("chevronRight", 15)}</button>
        </div>
      </div>`;

  const p = $("#logPrev"), n = $("#logNext");
  if (p) p.onclick = () => { logState.page = Math.max(1, logState.page - 1); loadLogs(); };
  if (n) n.onclick = () => { logState.page = Math.min(totalPages, logState.page + 1); loadLogs(); };
}

/* ---------- 个人中心：我的提醒 ---------- */
let reminderSummary = { rectify: 0, review: 0, closure: 0 };
const reminderTotal = () => (reminderSummary.rectify || 0) + (reminderSummary.review || 0) + (reminderSummary.closure || 0);

function updateNavBadge() {
  const el = document.getElementById("navBadgeProfile");
  if (!el) return;
  const n = reminderTotal();
  el.textContent = n > 99 ? "99+" : String(n);
  el.style.display = n > 0 ? "inline-block" : "none";
}

async function refreshReminderBadge() {
  try {
    const d = await api.get("/reminders");
    reminderSummary = d.summary || reminderSummary;
  } catch { /* 静默失败，不影响主流程 */ }
  updateNavBadge();
}

async function renderProfile() {
  const u = currentUser();
  $("#app").innerHTML = layout("profile", `<div class="page">
    <div class="page-head"><div><div class="page-title">个人中心</div><div class="page-sub">我的信息与待办提醒</div></div></div>
    <div class="card card-pad" style="display:flex;align-items:center;gap:18px;flex-wrap:wrap">
      <div class="avatar" style="width:56px;height:56px;font-size:22px">${esc((u?.userName || "?").charAt(0))}</div>
      <div style="flex:1;min-width:200px">
        <div style="font-size:19px;font-weight:700">${esc(u?.userName || "")}</div>
        <div style="font-size:13px;color:#6b7280;margin-top:6px">
          角色：<span class="badge role-${u?.role}">${esc(ROLE_LABELS[u?.role] || u?.role || "")}</span>
          <span style="margin-left:14px">加入时间：${fmtDateTime(u?.createdAt)}</span>
        </div>
      </div>
      <button class="btn btn-outline" id="btnPwd">${icon("lock", 16)}修改密码</button>
    </div>
    <div id="reminderBox" style="display:flex;flex-direction:column;gap:20px"><div class="card card-pad"><div class="loading"><div class="spinner"></div>加载提醒...</div></div></div>
  </div>`);
  bindLayout();
  const bp = $("#btnPwd");
  if (bp) bp.onclick = () => openChangePassword();
  loadReminders();
}

async function loadReminders() {
  const box = $("#reminderBox");
  if (!box) return;
  let d;
  try { d = await api.get("/reminders"); }
  catch (err) {
    box.innerHTML = `<div class="card card-pad"><div class="empty"><div class="e-title">提醒加载失败</div><div class="e-sub">${esc(err.message)}</div></div></div>`;
    return;
  }
  reminderSummary = d.summary || reminderSummary;
  updateNavBadge();

  const block = (title, iconName, items, emptyText, tip) => `
    <div class="card">
      <div class="card-head" style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
        <span style="display:flex;align-items:center;gap:8px">${icon(iconName, 17)}${title}
          <span class="badge ${items.length ? "count-alert" : "count-ok"}">${items.length}</span>
        </span>
        <span style="font-size:12px;font-weight:400;color:#9ca3af">${esc(tip)}</span>
      </div>
      <div class="card-pad" style="padding-top:10px">
        ${items.length ? `<div class="table-wrap"><table class="tbl" style="min-width:660px">
          <thead><tr><th>隐患编号</th><th>所在部位</th><th>等级</th><th>整改责任人</th><th>计划完成时限</th><th>状态</th></tr></thead>
          <tbody>${items.map((h) => `<tr data-view="${h.id}" title="点击查看详情" class="${h.overdue ? "overdue" : ""}">
            <td class="code">${esc(h.hazardCode)}</td>
            <td>${esc(h.location)}</td>
            <td><span class="badge lv-${h.level}">${esc(LEVEL_LABELS[h.level] || h.level)}</span></td>
            <td>${esc(h.rectifyPerson)}</td>
            <td>${esc(h.planDeadline)}${h.overdue ? ' <span class="badge st-overdue">已逾期</span>' : ""}</td>
            <td><span class="badge st-${h.status}">${esc(STATUS_LABELS[h.status] || h.status)}</span></td>
          </tr>`).join("")}</tbody>
        </table></div>` : `<div class="empty" style="padding:30px 12px">${icon(iconName, 34)}<div class="e-title">${esc(emptyText)}</div></div>`}
      </div>
    </div>`;

  const canReview = ["reviewer", "safety_admin", "admin"].includes(currentUser()?.role);
  const canRectify = ["entry", "safety_admin", "admin"].includes(currentUser()?.role);

  box.innerHTML = `
    ${block("整改提醒", "alert", d.rectify, "没有需要您整改的隐患",
      canRectify ? "我是整改责任人 · 未闭环" : "我是整改责任人 · 未闭环（当前角色无整改权限）")}
    ${block("复查提醒", "fileText", d.review, "没有等待复查的隐患",
      canReview ? "状态为「整改中」· 待复查闭环" : "状态为「整改中」· 需由复查人员处理")}
    ${block("闭环提醒", "clock", d.closure, "没有临近或逾期未闭环的隐患", "已逾期或 3 天内到期 · 未闭环")}`;

  box.querySelectorAll("tr[data-view]").forEach((tr) => {
    tr.onclick = () => { location.hash = `#/hazards/${tr.dataset.view}`; };
  });
}

/* ================= 路由 =================
 * 极简 hash 路由：监听 hashchange，用 location.hash 决定渲染哪个页面。
 * 未登录时除 #/login 外一律重定向到登录页；越权页面（用户管理/操作日志）
 * 也会被重定向回看板——这只是体验优化，真正的拦截在服务端。
 */
function requireAuth() {
  if (!currentUser()) { location.hash = "#/login"; return false; }
  return true;
}

/**
 * 路由分发：根据 location.hash 渲染对应页面。
 * 未登录 → 强制 #/login；越权页面（users/logs）→ 提示后回看板。
 */
function router() {
  const hash = location.hash.replace(/^#/, "") || "/dashboard";
  const app = $("#app");

  if (hash === "/login") { renderLogin(); return; }
  if (!requireAuth()) return;

  const parts = hash.split("/").filter(Boolean); // e.g. ["hazards","new"]
  if (parts[0] === "dashboard") return renderDashboard();
  if (parts[0] === "profile") return renderProfile();
  if (parts[0] === "hazards" && parts[1] === "new") return renderHazardNew();
  if (parts[0] === "hazards" && parts[1]) return renderHazardDetail(parts[1]);
  if (parts[0] === "hazards") return renderHazardList();
  if (parts[0] === "users") {
    if (!canManageUsers()) { toast("无权限访问", "仅管理员可访问用户管理", "err"); location.hash = "#/dashboard"; return; }
    return renderUsers();
  }
  if (parts[0] === "logs") {
    if (!canManageUsers()) { toast("无权限访问", "仅管理员可查看操作日志", "err"); location.hash = "#/dashboard"; return; }
    return renderLogs();
  }
  location.hash = "#/dashboard";
}

  window.addEventListener("hashchange", router);
  window.addEventListener("DOMContentLoaded", async () => {
    // 点击任意缩略图 → 新窗口放大查看
    document.addEventListener("click", (e) => {
      const im = e.target.closest("[data-preview]");
      if (im) { e.preventDefault(); window.open(im.getAttribute("data-preview"), "_blank"); }
    });
    // 先取公司名等信息，再渲染，避免侧边栏/登录页出现"先空后跳"
    await loadAppInfo();
    if (!location.hash) location.hash = currentUser() ? "#/dashboard" : "#/login";
    router();
  });
