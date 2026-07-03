/* ================================================================
   PriceFinder Dashboard — app.js
   前端主逻辑：桥接 AstrBot API + 状态管理 + 表格渲染 + 搜索筛选
   ================================================================ */

// ========== 表格列定义 ==========
// 定义 WebUI 数据表格的所有列。key 对应对后端 API 返回的字段名。
// sortable: 是否支持点击排序；type: 特殊渲染类型（price/time/link）。
const COLUMNS = [
  { key: "brand",        label: "品牌方",   sortable: true },
  { key: "product_name", label: "商品名",   sortable: true },
  { key: "model",        label: "详细型号", sortable: true },
  { key: "price",        label: "售价",     sortable: true,  type: "price" },
  { key: "price_source", label: "价格来源", sortable: true },
  { key: "query_source", label: "查价来源", sortable: true },
  { key: "user_id",      label: "查询用户", sortable: true },
  { key: "query",        label: "搜索关键词", sortable: true },
  { key: "url",          label: "链接",     sortable: false, type: "link" },
  { key: "timestamp",    label: "查询时间", sortable: true,  type: "time" },
];

// ========== ApiClient：封装 AstrBot Bridge 通信 ==========
// 所有前端与后端的数据交互都通过此类，统一管理 endpoint、重试、错误处理。
class ApiClient {

  // bridge: AstrBot 注入的 window.AstrBotPluginPage 对象
  //        提供 apiGet/apiPost/ready/onContext 等方法
  constructor(bridge) {
    this.bridge = bridge;
  }

  // 等待 bridge 就绪，返回上下文（含插件名、语言、主题等）
  async ready() {
    return await this.bridge.ready();
  }

  // 自动补全 "page/" 前缀
  // 后端路由：/{PLUGIN_NAME}/page/stats
  // bridge 调用：bridge.apiGet("page/stats") → Dashboard 转发到完整路径
  buildEndpoint(path) {
    const clean = String(path).replace(/^\/+/, "");
    return clean.startsWith("page/") ? clean : "page/" + clean;
  }

  // 通用 GET 请求
  //   endpoint: 相对路径，如 "stats" 或 "search"
  //   params:   query 参数对象，如 { keyword: "iPhone" }
  // bridge.apiGet 需要分开传 base + params，Dashboard 自动拼接 query string
  async get(endpoint, params = {}) {
    const qs = Object.entries(params)
      .filter(([, v]) => v !== "" && v !== null && v !== undefined)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");
    const base = this.buildEndpoint(endpoint);
    const rp = {};
    if (qs) {
      new URLSearchParams(qs).forEach((v, k) => { rp[k] = v; });
    }
    return await this.bridge.apiGet(base, rp);
  }
}

// ========== 全局状态 ==========
// 集中管理所有页面状态，避免散落全局变量。
const state = {
  // 从后端 API 获取的原始全量数据（不做筛选）
  allData: [],
  // 经过侧边栏筛选条件过滤后的数据
  filteredData: [],
  // 侧边栏筛选条件
  filters: {
    brands: new Set(),        // 选中的品牌方集合
    priceSources: new Set(),  // 选中的价格来源集合
    querySources: new Set(),  // 选中的查价来源集合
    priceMin: "",             // 价格下限
    priceMax: "",             // 价格上限
    dateFrom: "",             // 起始日期
    dateTo: "",               // 结束日期
    keyword: "",              // 搜索关键词
  },
  // 当前排序状态
  sort: { key: "timestamp", order: "desc" },
  // 分页状态
  page: 1,
  pageSize: 20,
  // 当前生效的筛选器数量（用于侧边栏徽章）
  activeFilterCount: 0,
  // 是否正在加载中（防止重复请求）
  isLoading: false,
  // 动态加载的数据
  _brands: [],         // 品牌方列表（来自 /page/filters）
  _priceSources: [],   // 价格来源列表
  _querySources: [],   // 查价来源列表
  // bridge 和 ApiClient 引用（init 时赋值）
  api: null,
  bridge: null,
};

// ========== 工具函数 ==========

// HTML 转义：防止 XSS 攻击。
// 注意：URL 类型的值不要用此函数——会破坏 & = ? 等合法字符。
function esc(s) {
  const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(s).replace(/[&<>"']/g, c => map[c]);
}

// 从 "¥9,999" 格式的字符串中提取浮点数
function parsePrice(priceStr) {
  return parseFloat(String(priceStr).replace(/[^0-9.]/g, "")) || 0;
}

// 格式化 Unix 时间戳为可读字符串
function formatTime(ts) {
  if (!ts) return "--";
  const d = new Date(ts * 1000);
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ========== Toast 通知 ==========
let toastTimer;

// 在页面底部显示一条短暂的通知消息。
//   msg:     要显示的文本
//   isError: 是否为错误状态（红色边框）
function showToast(msg, isError = false) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.remove("visible", "error");
  if (isError) el.classList.add("error");
  void el.offsetWidth;                // 强制回流，确保 CSS transition 生效
  el.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("visible"), 2500);
}

// ========== 主题切换 ==========

// 设置 data-theme 属性（"light"/"dark"），CSS 变量自动切换。
// 同时更新 localStorage 和 header 按钮文字。
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  const btn = document.getElementById("themeBtn");
  if (btn) {
    btn.textContent = theme === "dark" ? "☀️ 亮色模式" : "🌙 暗色模式";
  }
  try { localStorage.setItem("pf_theme", theme); } catch (_) {}
}

// 切换到相反主题
function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme") || "light";
  applyTheme(current === "light" ? "dark" : "light");
}

// ========== API 数据加载 ==========

// 从后端获取仪表盘统计信息并渲染到顶部指标卡片
async function loadStats() {
  try {
    const stats = await state.api.get("stats");
    renderStats(stats);
  } catch (e) {
    showToast("加载统计信息失败", true);
  }
}

// 渲染顶部四格指标卡片
function renderStats(stats) {
  document.getElementById("statsRow").innerHTML = `
    <div class="stat-card">
      <div class="stat-icon primary">📦</div>
      <div class="stat-label">缓存总条目</div>
      <div class="stat-value">${stats.total_entries ?? stats.totalEntries ?? 0}</div>
    </div>
    <div class="stat-card">
      <div class="stat-icon info">🔍</div>
      <div class="stat-label">总查询次数</div>
      <div class="stat-value">${(stats.total_queries ?? stats.totalQueries ?? 0).toLocaleString()}</div>
    </div>
    <div class="stat-card">
      <div class="stat-icon success">👤</div>
      <div class="stat-label">活跃用户数</div>
      <div class="stat-value">${stats.active_users ?? stats.activeUsers ?? 0}</div>
    </div>
    <div class="stat-card">
      <div class="stat-icon warning">📅</div>
      <div class="stat-label">今日查询</div>
      <div class="stat-value">${stats.today_queries ?? stats.todayQueries ?? 0}</div>
    </div>`;
}

// 从后端获取筛选器可选项（品牌、来源列表）并渲染侧边栏
async function loadFilterOptions() {
  try {
    const options = await state.api.get("filters");
    state._brands = options.brands || [];
    state._priceSources = options.price_sources || [];
    state._querySources = options.query_sources || [];
    renderSidebar();
  } catch (e) {
    showToast("加载筛选选项失败", true);
  }
}

// ========== 搜索与数据获取 ==========

// 主搜索流程：
// 1. 从搜索框取关键词 → 2. 调后端 API → 3. 排序 → 4. 应用筛选 → 5. 重新渲染页面
async function doSearch() {
  if (state.isLoading) return;    // 防止重复点击
  state.isLoading = true;
  showLoading();

  const keyword = (document.getElementById("searchInput")?.value || "").trim();
  const params = {};
  if (keyword) params.keyword = keyword;

  try {
    state.allData = await state.api.get("search", params);
    state.page = 1;
    sortData();
    applyFilters();
    showToast(state.filteredData.length > 0
      ? `找到 ${state.filteredData.length} 条结果`
      : "没有匹配的结果");
  } catch (e) {
    showToast("搜索失败", true);
    state.allData = [];
    applyFilters();
  } finally {
    state.isLoading = false;
  }
}

// 将 state.filters 中的所有条件应用到 state.allData
// 每匹配一个筛选条件，activeFilterCount 自增（用于侧边栏徽章）
function applyFilters() {
  let count = 0;
  let data = [...state.allData];               // 浅拷贝，避免修改原数据

  // 1. 关键词模糊搜索：匹配品牌、商品名、型号、搜索词、标题
  const kw = state.filters.keyword.toLowerCase();
  if (kw) {
    count++;
    data = data.filter(r =>
      (r.brand || "").toLowerCase().includes(kw) ||
      (r.product_name || "").toLowerCase().includes(kw) ||
      (r.model || "").toLowerCase().includes(kw) ||
      (r.query || "").toLowerCase().includes(kw) ||
      (r.title || "").toLowerCase().includes(kw)
    );
  }

  // 2. 侧边栏 checkbox 筛选（多选，取交集）
  if (state.filters.brands.size > 0)       { count++; data = data.filter(r => state.filters.brands.has(r.brand)); }
  if (state.filters.priceSources.size > 0) { count++; data = data.filter(r => state.filters.priceSources.has(r.price_source)); }
  if (state.filters.querySources.size > 0) { count++; data = data.filter(r => state.filters.querySources.has(r.query_source)); }

  // 3. 价格范围筛选
  if (state.filters.priceMin !== "") { count++; const min = parseFloat(state.filters.priceMin); data = data.filter(r => parsePrice(r.price) >= min); }
  if (state.filters.priceMax !== "") { count++; const max = parseFloat(state.filters.priceMax); data = data.filter(r => parsePrice(r.price) <= max); }

  // 4. 日期范围筛选（Unix 时间戳比较）
  if (state.filters.dateFrom) { count++; const from = new Date(state.filters.dateFrom).getTime() / 1000; data = data.filter(r => r.timestamp >= from); }
  if (state.filters.dateTo)   { count++; const to   = new Date(state.filters.dateTo).getTime() / 1000 + 86400; data = data.filter(r => r.timestamp <= to); }

  state.activeFilterCount = count;
  state.filteredData = data;
  state.page = 1;
  renderAll();
}

// 按 state.sort 对 filteredData 进行排序
// 特殊处理：price 按数值排序，time 按时间戳排序，其余按字符串比较
function sortData() {
  const { key, order } = state.sort;
  const col = COLUMNS.find(c => c.key === key);
  state.filteredData.sort((a, b) => {
    let va = a[key], vb = b[key];
    if (col && col.type === "price") { va = parsePrice(va); vb = parsePrice(vb); }
    if (col && col.type === "time")  { va = va || 0; vb = vb || 0; }
    if (typeof va === "string") { va = va.toLowerCase(); vb = (vb || "").toLowerCase(); }
    if (va < vb) return order === "asc" ? -1 : 1;
    if (va > vb) return order === "asc" ? 1 : -1;
    return 0;
  });
}

// 点击表头切换排序；同一列点第二次反转顺序
function toggleSort(key) {
  if (state.sort.key === key) {
    state.sort.order = state.sort.order === "asc" ? "desc" : "asc";
  } else {
    state.sort.key = key;
    state.sort.order = "asc";
  }
  sortData();
  state.page = 1;
  renderAll();
}

// ========== 筛选器交互 ==========

// checkbox 变更时：读取当前选中的项，更新 state.filters，重新应用筛选
function onFilterChange() {
  const allChecks = document.querySelectorAll("#sidebar .checkbox-list input[type=checkbox]");
  state.filters.brands = new Set();
  state.filters.priceSources = new Set();
  state.filters.querySources = new Set();

  allChecks.forEach(cb => {
    if (!cb.checked) return;
    // 通过 checkbox 所在的 filter-group 的 label 文字判断属于哪个筛选类别
    const group = cb.closest(".filter-group").querySelector("label").textContent;
    if (group.includes("品牌")) state.filters.brands.add(cb.value);
    else if (group.includes("价格来源")) state.filters.priceSources.add(cb.value);
    else if (group.includes("查价来源")) state.filters.querySources.add(cb.value);
  });

  applyFilters();
}

// 范围输入变更（价格/日期）时，更新对应字段并重新筛选
function onRangeChange(field, value) {
  state.filters[field] = value;
  applyFilters();
}

// 清除所有筛选条件，重置为默认
function clearFilters() {
  state.filters = {
    brands: new Set(),
    priceSources: new Set(),
    querySources: new Set(),
    priceMin: "", priceMax: "",
    dateFrom: "", dateTo: "",
    keyword: "",
  };
  state.sort = { key: "timestamp", order: "desc" };
  state.page = 1;
  sortData();
  renderAll();
}

// 重置按钮：清空搜索框 + 隐藏清除按钮 + 清除筛选
function resetAll() {
  document.getElementById("searchInput").value = "";
  document.getElementById("btnReset").classList.remove("visible");
  clearFilters();
}

// ========== 分页 ==========

// 获取当前页的数据切片
function getPageData() {
  const start = (state.page - 1) * state.pageSize;
  return state.filteredData.slice(start, start + state.pageSize);
}

// 计算总页数（"全部"模式时 pageSize 是一个大数，总页数为 1）
function totalPages() {
  const ps = state.pageSize >= 99999 ? state.filteredData.length : state.pageSize;
  return Math.max(1, Math.ceil(state.filteredData.length / ps));
}

// 跳转到指定页
function goPage(n) {
  if (n < 1 || n > totalPages()) return;
  state.page = n;
  renderTableBody();
  renderPagination();
  document.querySelector(".table-scroll").scrollTop = 0;
}

// 每页条数变更：更新 state.pageSize，重置到第 1 页
function changePageSize() {
  const val = document.getElementById("pageSizeSelect").value;
  state.pageSize = val === "all" ? 99999 : parseInt(val);
  state.page = 1;
  renderTableBody();
  renderPagination();
}

// ========== 渲染函数 ==========

// 显示加载中状态
function showLoading() {
  document.getElementById("tableBody").innerHTML = `<tr><td colspan="${COLUMNS.length}">
    <div class="loading-overlay"><span class="spinner-lg"></span>加载中...</div>
  </td></tr>`;
}

// 渲染侧边栏：品牌/价格来源/查价来源 checkbox + 价格范围 + 日期范围
// 每次调用时重新生成 innerHTML，再绑定事件监听器
function renderSidebar() {
  const brands = state._brands || [];
  const priceSources = state._priceSources || [];
  const querySources = state._querySources || [];
  // 筛选器徽章：显示当前激活的筛选条件数
  const badgeHtml = state.activeFilterCount > 0
    ? `<span class="filter-badge">${state.activeFilterCount}</span>` : "";

  document.getElementById("sidebar").innerHTML = `
    <h3>筛选条件 ${badgeHtml} <a class="reset-link" id="clearFiltersLink">清除全部</a></h3>
    <div class="filter-group">
      <label>品牌方</label>
      <div class="checkbox-list" id="brandChecks">
        ${brands.map(b => `<label><input type="checkbox" value="${esc(b)}" ${state.filters.brands.has(b) ? "checked" : ""} /> ${esc(b)}</label>`).join("")}
      </div>
    </div>
    <div class="filter-group">
      <label>价格来源</label>
      <div class="checkbox-list">
        ${priceSources.map(s => `<label><input type="checkbox" value="${esc(s)}" ${state.filters.priceSources.has(s) ? "checked" : ""} /> ${esc(s)}</label>`).join("")}
      </div>
    </div>
    <div class="filter-group">
      <label>查价来源</label>
      <div class="checkbox-list">
        ${querySources.map(s => `<label><input type="checkbox" value="${esc(s)}" ${state.filters.querySources.has(s) ? "checked" : ""} /> ${esc(s)}</label>`).join("")}
      </div>
    </div>
    <div class="filter-group">
      <label>价格范围</label>
      <div class="range-inputs">
        <input type="number" placeholder="最低(¥)" value="${state.filters.priceMin}" id="filterPriceMin" />
        <span>-</span>
        <input type="number" placeholder="最高(¥)" value="${state.filters.priceMax}" id="filterPriceMax" />
      </div>
    </div>
    <div class="filter-group">
      <label>时间范围</label>
      <div class="range-inputs">
        <input type="date" value="${state.filters.dateFrom}" id="filterDateFrom" min="2015-01-01" max="2050-12-31" />
        <span>-</span>
        <input type="date" value="${state.filters.dateTo}" id="filterDateTo" min="2015-01-01" max="2050-12-31" />
      </div>
    </div>`;

  // 绑定 checkbox 变更事件
  document.querySelectorAll("#sidebar .checkbox-list input[type=checkbox]").forEach(cb => {
    cb.addEventListener("change", onFilterChange);
  });
  // 绑定价格/日期范围变更事件
  document.getElementById("filterPriceMin").addEventListener("change", (e) => onRangeChange("priceMin", e.target.value));
  document.getElementById("filterPriceMax").addEventListener("change", (e) => onRangeChange("priceMax", e.target.value));
  document.getElementById("filterDateFrom").addEventListener("change", (e) => onRangeChange("dateFrom", e.target.value));
  document.getElementById("filterDateTo").addEventListener("change", (e) => onRangeChange("dateTo", e.target.value));
  // 清除全部链接
  document.getElementById("clearFiltersLink").addEventListener("click", clearFilters);

  // ===== 日期密度计算（GitHub 风格热力色阶） =====
  // 根据日期附近 ±3 天内的记录数量，为日期输入框添加密度色阶 class
  function computeDateDensity(input) {
    const val = input.value;
    if (!val || state.allData.length === 0) return 0;
    const target = new Date(val).getTime() / 1000;
    const window = 86400 * 3;                        // ±3 天窗口
    const count = state.allData.filter(r => Math.abs(r.timestamp - target) <= window).length;
    const ratio = count / state.allData.length;
    if (ratio > 0.3) return 3;                       // 高密度 → 深绿
    if (ratio > 0.1) return 2;                       // 中密度 → 中绿
    return 1;                                         // 低密度 → 浅绿
  }

  function applyDateDensity(input) {
    input.classList.remove("date-density-0", "date-density-1", "date-density-2", "date-density-3");
    const density = computeDateDensity(input);
    input.classList.add(`date-density-${density}`);
  }

  [document.getElementById("filterDateFrom"), document.getElementById("filterDateTo")].forEach(inp => {
    applyDateDensity(inp);
    inp.addEventListener("change", () => applyDateDensity(inp));
  });
}

// 渲染表头，根据当前排序状态显示 ▲▼ 箭头
function renderTableHead() {
  document.getElementById("tableHead").innerHTML =
    `<tr>${COLUMNS.map(c => {
      const sorted = state.sort.key === c.key ? " sorted" : "";
      const arrow = c.sortable
        ? `<span class="sort-arrow">${sorted ? (state.sort.order === "asc" ? "▲" : "▼") : "⇅"}</span>`
        : "";
      return `<th class="${sorted}"${c.sortable ? ` data-sort="${c.key}"` : ""}>${c.label}${arrow}</th>`;
    }).join("")}</tr>`;

  // 绑定表头点击排序
  document.querySelectorAll("th[data-sort]").forEach(th => {
    th.addEventListener("click", () => toggleSort(th.dataset.sort));
  });
}

// 渲染表格数据行
function renderTableBody() {
  const pageData = getPageData();
  // 无数据时显示空状态
  if (pageData.length === 0) {
    document.getElementById("tableBody").innerHTML =
      `<tr><td colspan="${COLUMNS.length}"><div class="empty-state"><div class="empty-icon">📭</div><p>没有匹配的记录</p><p style="font-size:12px;color:var(--text-muted)">尝试调整筛选条件或搜索关键词</p></div></td></tr>`;
    return;
  }
  // 渲染数据行
  // 品牌/价格来源/查价来源使用彩色标签；价格列红色醒目；
  // 链接列保留原始 href（不经过 esc，否则 & 会被转义为 &amp;）
  document.getElementById("tableBody").innerHTML = pageData.map(r => `
    <tr>
      <td><span class="tag tag-brand">${esc(r.brand || "--")}</span></td>
      <td>${esc(r.product_name || r.title || "--")}</td>
      <td>${esc(r.model || "--")}</td>
      <td class="price-cell">${esc(r.price || "--")}</td>
      <td><span class="tag tag-store">${esc(r.price_source || "--")}</span></td>
      <td><span class="tag tag-source">${esc(r.query_source || "--")}</span></td>
      <td>${esc(r.user_id || "--")}</td>
      <td>${esc(r.query || "--")}</td>
      <td class="link-cell">${r.url ? `<a href="${r.url.replace(/"/g, '&quot;')}" target="_blank" rel="noopener">查看</a>` : "--"}</td>
      <td>${formatTime(r.timestamp)}</td>
    </tr>`).join("");
}

// 渲染分页栏：页码信息 + 每页条数选择器 + 翻页按钮组
function renderPagination() {
  const total = totalPages();
  const page = state.page;
  // 生成页码按钮，超过 7 页时使用省略号
  let btns = "";
  for (let i = 1; i <= total; i++) {
    if (total > 7 && i > 3 && i < total - 1 && i !== page && i !== page - 1 && i !== page + 1) {
      if (i === 4) btns += `<button disabled>…</button>`;
      continue;
    }
    btns += `<button class="${i === page ? "active" : ""}" data-pg="${i}">${i}</button>`;
  }
  const ps = state.pageSize >= 99999 ? "all" : String(state.pageSize);
  document.getElementById("pagination").innerHTML = `
    <span>第 ${page}/${total} 页 ·
      <select class="page-size-select" id="pageSizeSelect">
        <option value="50" ${ps === "50" ? "selected" : ""}>50 条/页</option>
        <option value="100" ${ps === "100" ? "selected" : ""}>100 条/页</option>
        <option value="200" ${ps === "200" ? "selected" : ""}>200 条/页</option>
        <option value="all" ${ps === "all" ? "selected" : ""}>全部</option>
      </select>
    </span>
    <div class="page-btns">
      <button data-pg="1" ${page === 1 ? "disabled" : ""}>&#171;</button>
      <button data-pg="${page - 1}" ${page === 1 ? "disabled" : ""}>&#8249;</button>
      ${btns}
      <button data-pg="${page + 1}" ${page === total ? "disabled" : ""}>&#8250;</button>
      <button data-pg="${total}" ${page === total ? "disabled" : ""}>&#187;</button>
    </div>`;
  // 更新表格工具栏的记录数
  document.getElementById("tableInfo").innerHTML = `共 <strong>${state.filteredData.length}</strong> 条记录`;

  // 绑定每页条数和页码按钮的事件
  document.getElementById("pageSizeSelect").addEventListener("change", changePageSize);
  document.querySelectorAll(".pagination button[data-pg]").forEach(btn => {
    btn.addEventListener("click", () => goPage(parseInt(btn.dataset.pg)));
  });
}

// 全量渲染：表头 + 表体 + 分页
// 当筛选条件变更导致 activeFilterCount 变化时，同步刷新侧边栏
function renderAll() {
  renderTableHead();
  renderTableBody();
  renderPagination();
  if (state.activeFilterCount !== (document.querySelectorAll("#sidebar .checkbox-list").length > 0
    ? state.activeFilterCount : 0)) {
    renderSidebar();
  }
}

// ========== 初始化 ==========

// 页面入口：连接 bridge → 加载主题 → 绑定事件 → 加载数据
async function init() {
  // 获取 AstrBot 注入的 bridge 对象
  const bridge = window.AstrBotPluginPage;
  state.api = new ApiClient(bridge);
  state.bridge = bridge;

  await state.api.ready();

  // 从 localStorage 读取上次保存的主题，没有则默认亮色
  const savedTheme = (() => {
    try { return localStorage.getItem("pf_theme"); } catch (_) { return null; }
  })();

  // 监听 AstrBot WebUI 的主题切换事件，自动同步
  if (bridge && typeof bridge.onContext === "function") {
    bridge.onContext((ctx) => {
      if (ctx && typeof ctx.isDark === "boolean") {
        applyTheme(ctx.isDark ? "dark" : "light");
      }
    });
  }

  applyTheme(savedTheme || "light");

  // ===== 绑定 UI 事件 =====

  // 主题切换按钮
  document.getElementById("themeBtn").addEventListener("click", toggleTheme);

  // 搜索按钮（搜索框内的 🔍 按钮）
  document.getElementById("btnSearch").addEventListener("click", () => {
    state.filters.keyword = document.getElementById("searchInput").value.trim();
    doSearch();
  });

  // 清除按钮（搜索框内的 ✕ 按钮）
  document.getElementById("btnReset").addEventListener("click", resetAll);

  const searchInput = document.getElementById("searchInput");
  const btnReset = document.getElementById("btnReset");

  // 输入框有内容时显示 ✕ 清除按钮，为空时隐藏
  searchInput.addEventListener("input", () => {
    btnReset.classList.toggle("visible", searchInput.value.length > 0);
  });

  // 回车键触发搜索
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      state.filters.keyword = searchInput.value.trim();
      doSearch();
    }
  });

  // 初始加载：统计信息 + 全量数据 + 筛选器选项
  await Promise.all([loadStats(), doSearch(), loadFilterOptions()]);
  searchInput.focus();
}

// 启动应用
init();
