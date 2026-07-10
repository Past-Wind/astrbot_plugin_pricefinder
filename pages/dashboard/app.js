/* ================================================================
   PriceFinder Dashboard — app.js
   三页一合：商品比价 / 查询历史 / 收藏夹
   双状态架构 + switchPage() 页面切换
   ================================================================ */

// ========== 列定义 ==========
const DASHBOARD_COLUMNS = [
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

const FAVORITES_COLUMNS = [
  { key: "brand",        label: "品牌方",   sortable: true },
  { key: "product_name", label: "商品名",   sortable: true },
  { key: "model",        label: "详细型号", sortable: true },
  { key: "price",        label: "售价",     sortable: true,  type: "price" },
  { key: "price_source", label: "价格来源", sortable: true },
  { key: "query_source", label: "查价来源", sortable: true },
  { key: "user_id",      label: "查询用户", sortable: true },
  { key: "url",          label: "链接",     sortable: false, type: "link" },
  { key: "created_at",   label: "收藏时间", sortable: true,  type: "time" },
];

function getColumns(page) {
  if (page === "favorites") return FAVORITES_COLUMNS;
  return DASHBOARD_COLUMNS;
}

// ========== ApiClient ==========
class ApiClient {

  constructor(bridge) {
    this.bridge = bridge;
  }

  async ready() {
    return await this.bridge.ready();
  }

  buildEndpoint(path) {
    const clean = String(path).replace(/^\/+/, "");
    return clean.startsWith("page/") ? clean : "page/" + clean;
  }

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

  async post(endpoint, body = {}) {
    const base = this.buildEndpoint(endpoint);
    return await this.bridge.apiPost(base, body);
  }
}

// ========== 工具函数 ==========

function esc(s) {
  const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(s).replace(/[&<>"']/g, c => map[c]);
}

function parsePrice(priceStr) {
  return parseFloat(String(priceStr).replace(/[^0-9.]/g, "")) || 0;
}

function formatTime(ts) {
  if (!ts) return "--";
  const d = new Date(ts * 1000);
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ========== Toast ==========
let toastTimer;

function showToast(msg, isError = false) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.remove("visible", "error");
  if (isError) el.classList.add("error");
  void el.offsetWidth;
  el.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("visible"), 2500);
}

// ========== 主题 ==========

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  const btn = document.getElementById("themeBtn");
  if (btn) {
    btn.textContent = theme === "dark" ? "☀️ 亮色模式" : "🌙 暗色模式";
  }
  try { localStorage.setItem("pf_theme", theme); } catch (_) {}
}

function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme") || "light";
  applyTheme(current === "light" ? "dark" : "light");
}

// ========== 调试 ==========
let debugEnabled = false;

async function loadDebugConfig() {
  try {
    const cfg = await api.get("debug-config");
    debugEnabled = !!(cfg && cfg.debug_enabled);
    const cb = document.getElementById("debugToggle");
    if (cb) cb.checked = debugEnabled;
  } catch (_) {}
}

async function toggleDebug() {
  try {
    await api.post("debug-config", { debug_enabled: !debugEnabled });
    debugEnabled = !debugEnabled;
    document.getElementById("debugToggle").checked = debugEnabled;
    showToast(debugEnabled ? "调试模式已开启" : "调试模式已关闭");
  } catch (e) {
    showToast("切换调试模式失败", true);
  }
}

// ========== DOM 引用工具 ==========

function getPageDom(prefix) {
  const el = (id) => document.getElementById(prefix + id);
  return {
    stats:       el("Stats"),
    searchInput: el("SearchInput"),
    btnReset:    el("BtnReset"),
    btnSearch:   el("BtnSearch"),
    sidebar:     el("Sidebar"),
    tableInfo:   el("TableInfo"),
    tableHead:   el("TableHead"),
    tableBody:   el("TableBody"),
    pagination:  el("Pagination"),
  };
}

// ========== 全局状态 ==========
let currentPage = "dashboard";
let api = null;
let bridge = null;

function createPageState(defaults = {}) {
  return {
    data: [],
    filtered: [],
    filters: {
      keyword: "",
      brands: new Set(),
      priceSources: new Set(),
      querySources: new Set(),
      users: new Set(),
      priceMin: "",
      priceMax: "",
      dateFrom: "",
      dateTo: "",
    },
    sort: { key: defaults.sortKey || "timestamp", order: "desc" },
    page: 1,
    pageSize: 20,
    _brands: [],
    _priceSources: [],
    _querySources: [],
    _users: [],
    _loaded: false,
    _loading: false,
    activeFilterCount: 0,
  };
}

const dashboardState = createPageState({ sortKey: "timestamp" });
const favState       = createPageState({ sortKey: "created_at" });

function pageState(page) {
  if (page === "favorites") return favState;
  return dashboardState;
}

function currentState() {
  return pageState(currentPage);
}

// ========== 页面切换 ==========

function switchPage(name) {
  if (currentPage === name) return;
  currentPage = name;

  document.querySelectorAll(".header-tab").forEach(b =>
    b.classList.toggle("active", b.dataset.page === name));
  document.querySelectorAll(".page").forEach(p =>
    p.classList.toggle("active", p.id === "page-" + name));

  const state = pageState(name);
  const dom = getPageDom(name === "favorites" ? "fav" : name);

  if (!state._loaded) {
    initPage(state, dom, name);
  }
}

// ========== 按页数据加载 ==========

async function loadStats(state, dom, page) {
  try {
    if (page === "dashboard") {
      const stats = await api.get("stats");
      dom.stats.innerHTML = `
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
    } else {
      const favs = await api.get("favorites");
      const arr = Array.isArray(favs) ? favs : [];
      dom.stats.innerHTML = `
        <div class="stat-card">
          <div class="stat-icon primary">⭐</div>
          <div class="stat-label">总收藏数</div>
          <div class="stat-value">${arr.length}</div>
        </div>
        <div class="stat-card">
          <div class="stat-icon success">👤</div>
          <div class="stat-label">收藏用户数</div>
          <div class="stat-value">${new Set(arr.map(f => f.user_id)).size}</div>
        </div>
        <div class="stat-card">
          <div class="stat-icon info">📦</div>
          <div class="stat-label">收藏商品数</div>
          <div class="stat-value">${new Set(arr.map(f => f.url)).size}</div>
        </div>
        <div class="stat-card">
          <div class="stat-icon warning">📅</div>
          <div class="stat-label">今日收藏</div>
          <div class="stat-value">${arr.filter(f => {
            const d = new Date(f.created_at * 1000);
            const today = new Date();
            return d.toDateString() === today.toDateString();
          }).length}</div>
        </div>`;
    }
  } catch (e) {
    showToast("加载统计信息失败", true);
  }
}

async function loadFilterOptions(state, dom, page) {
  try {
    let endpoint = page === "favorites" ? "favorites-filters" : "filters";

    const options = await api.get(endpoint);
    state._brands = options.brands || [];
    state._priceSources = options.price_sources || [];
    state._querySources = options.query_sources || [];
    state._users = options.users || [];
    renderSidebar(state, dom, page);
  } catch (e) {
    showToast("加载筛选选项失败", true);
  }
}

async function doSearch(state, dom, page) {
  if (state._loading) return;
  state._loading = true;
  showLoading(state, dom, page);

  const keyword = (dom.searchInput?.value || "").trim();
  const params = {};
  if (keyword) params.keyword = keyword;

  try {
    let endpoint = page === "favorites" ? "favorites" : "search";

    state.data = await api.get(endpoint, params);
    state.page = 1;
    sortData(state, page);
    applyFilters(state, page);
    showToast(state.filtered.length > 0
      ? `找到 ${state.filtered.length} 条结果`
      : "没有匹配的结果");
  } catch (e) {
    showToast("搜索失败", true);
    state.data = [];
    applyFilters(state, page);
  } finally {
    state._loading = false;
  }
}

// ========== 筛选 ==========

function applyFilters(state, page) {
  let count = 0;
  let data = [...state.data];

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

  if (state.filters.brands.size > 0)       { count++; data = data.filter(r => state.filters.brands.has(r.brand)); }
  if (state.filters.priceSources.size > 0) { count++; data = data.filter(r => state.filters.priceSources.has(r.price_source)); }
  if (state.filters.querySources.size > 0) { count++; data = data.filter(r => state.filters.querySources.has(r.query_source)); }
  if (state.filters.users.size > 0)        { count++; data = data.filter(r => state.filters.users.has(r.user_id)); }

  if (state.filters.priceMin !== "") { count++; const min = parseFloat(state.filters.priceMin); data = data.filter(r => parsePrice(r.price) >= min); }
  if (state.filters.priceMax !== "") { count++; const max = parseFloat(state.filters.priceMax); data = data.filter(r => parsePrice(r.price) <= max); }

  const timeField = page === "favorites" ? "created_at" : "timestamp";
  if (state.filters.dateFrom) { count++; const from = new Date(state.filters.dateFrom).getTime() / 1000; data = data.filter(r => r[timeField] >= from); }
  if (state.filters.dateTo)   { count++; const to   = new Date(state.filters.dateTo).getTime() / 1000 + 86400; data = data.filter(r => r[timeField] <= to); }

  state.activeFilterCount = count;
  state.filtered = data;
  state.page = 1;

  const dom = getPageDom(page === "favorites" ? "fav" : page);
  renderAll(state, dom, page);
}

function sortData(state, page) {
  const { key, order } = state.sort;
  const cols = getColumns(page);
  const col = cols.find(c => c.key === key);
  state.filtered.sort((a, b) => {
    let va = a[key], vb = b[key];
    if (col && col.type === "price") { va = parsePrice(va); vb = parsePrice(vb); }
    if (col && col.type === "time")  { va = va || 0; vb = vb || 0; }
    if (typeof va === "string") { va = va.toLowerCase(); vb = (vb || "").toLowerCase(); }
    if (va < vb) return order === "asc" ? -1 : 1;
    if (va > vb) return order === "asc" ? 1 : -1;
    return 0;
  });
}

function toggleSort(state, key, dom, page) {
  const cols = getColumns(page);
  const col = cols.find(c => c.key === key);
  if (!col || !col.sortable) return;
  if (state.sort.key === key) {
    state.sort.order = state.sort.order === "asc" ? "desc" : "asc";
  } else {
    state.sort.key = key;
    state.sort.order = "asc";
  }
  sortData(state, page);
  state.page = 1;
  renderAll(state, dom, page);
}

// ========== 筛选器交互 ==========

function onFilterChange(state, dom, page) {
  const allChecks = dom.sidebar.querySelectorAll(".checkbox-list input[type=checkbox]");
  state.filters.brands = new Set();
  state.filters.priceSources = new Set();
  state.filters.querySources = new Set();
  state.filters.users = new Set();

  allChecks.forEach(cb => {
    if (!cb.checked) return;
    const group = cb.closest(".filter-group").querySelector("label").textContent;
    if (group.includes("品牌")) state.filters.brands.add(cb.value);
    else if (group.includes("价格来源")) state.filters.priceSources.add(cb.value);
    else if (group.includes("查价来源")) state.filters.querySources.add(cb.value);
    else if (group.includes("用户")) state.filters.users.add(cb.value);
  });

  applyFilters(state, page);
}

function onRangeChange(state, field, value, page) {
  state.filters[field] = value;
  applyFilters(state, page);
}

function clearFilters(state, dom, page) {
  state.filters = {
    keyword: "",
    brands: new Set(),
    priceSources: new Set(),
    querySources: new Set(),
    users: new Set(),
    priceMin: "", priceMax: "",
    dateFrom: "", dateTo: "",
  };
  state.sort = { key: page === "favorites" ? "created_at" : "timestamp", order: "desc" };
  state.page = 1;
  sortData(state, page);
  renderAll(state, dom, page);
}

function resetAll(state, dom, page) {
  dom.searchInput.value = "";
  dom.btnReset.classList.remove("visible");
  clearFilters(state, dom, page);
}

// ========== 分页 ==========

function getPageData(state) {
  const start = (state.page - 1) * state.pageSize;
  return state.filtered.slice(start, start + state.pageSize);
}

function totalPages(state) {
  const ps = state.pageSize >= 99999 ? state.filtered.length : state.pageSize;
  return Math.max(1, Math.ceil(state.filtered.length / ps));
}

function goPage(state, n, dom) {
  if (n < 1 || n > totalPages(state)) return;
  state.page = n;
  renderTableBody(state, dom, currentPage);
  renderPagination(state, dom);
  const scrollEl = dom.tableBody.closest(".table-scroll");
  if (scrollEl) scrollEl.scrollTop = 0;
}

function changePageSize(state, dom) {
  const select = dom.pagination.querySelector(".page-size-select");
  if (!select) return;
  const val = select.value;
  state.pageSize = val === "all" ? 99999 : parseInt(val);
  state.page = 1;
  renderTableBody(state, dom, currentPage);
  renderPagination(state, dom);
}

// ========== 渲染 ==========

function showLoading(state, dom, page) {
  const cols = getColumns(page);
  const colCount = page === "dashboard" ? cols.length + 1 : cols.length;
  dom.tableBody.innerHTML = `<tr><td colspan="${colCount}">
    <div class="loading-overlay"><span class="spinner-lg"></span>加载中...</div>
  </td></tr>`;
}

function renderSidebar(state, dom, page) {
  const brands = state._brands || [];
  const priceSources = state._priceSources || [];
  const querySources = page === "dashboard" ? (state._querySources || []) : [];
  const users = state._users || [];
  const badgeHtml = state.activeFilterCount > 0
    ? `<span class="filter-badge">${state.activeFilterCount}</span>` : "";

  let filtersHtml = "";
  filtersHtml += `
    <div class="filter-group">
      <label>品牌方</label>
      <div class="checkbox-list">
        ${brands.map(b => `<label><input type="checkbox" value="${esc(b)}" ${state.filters.brands.has(b) ? "checked" : ""} /> ${esc(b)}</label>`).join("")}
      </div>
    </div>`;

  filtersHtml += `
    <div class="filter-group">
      <label>价格来源</label>
      <div class="checkbox-list">
        ${priceSources.map(s => `<label><input type="checkbox" value="${esc(s)}" ${state.filters.priceSources.has(s) ? "checked" : ""} /> ${esc(s)}</label>`).join("")}
      </div>
    </div>`;

  if (page === "dashboard" && querySources.length > 0) {
    filtersHtml += `
    <div class="filter-group">
      <label>查价来源</label>
      <div class="checkbox-list">
        ${querySources.map(s => `<label><input type="checkbox" value="${esc(s)}" ${state.filters.querySources.has(s) ? "checked" : ""} /> ${esc(s)}</label>`).join("")}
      </div>
    </div>`;
  }

  filtersHtml += `
    <div class="filter-group">
      <label>查询用户</label>
      <div class="checkbox-list">
        ${users.map(u => `<label><input type="checkbox" value="${esc(u)}" ${state.filters.users.has(u) ? "checked" : ""} /> ${esc(u)}</label>`).join("")}
      </div>
    </div>
    <div class="filter-group">
      <label>价格范围</label>
      <div class="range-inputs">
        <input type="number" placeholder="最低(¥)" value="${state.filters.priceMin}" id="${dom.sidebar.id}-priceMin" />
        <span>-</span>
        <input type="number" placeholder="最高(¥)" value="${state.filters.priceMax}" id="${dom.sidebar.id}-priceMax" />
      </div>
    </div>
    <div class="filter-group">
      <label>时间范围</label>
      <div class="range-inputs date-range">
        <input type="date" value="${state.filters.dateFrom}" id="${dom.sidebar.id}-dateFrom" min="2015-01-01" max="2050-12-31" />
        <span>-</span>
        <input type="date" value="${state.filters.dateTo}" id="${dom.sidebar.id}-dateTo" min="2015-01-01" max="2050-12-31" />
      </div>
    </div>`;

  dom.sidebar.innerHTML = `
    <h3>筛选条件 ${badgeHtml} <a class="reset-link" id="${dom.sidebar.id}-clearLink">清除全部</a></h3>
    ${filtersHtml}`;

  dom.sidebar.querySelectorAll(".checkbox-list input[type=checkbox]").forEach(cb => {
    cb.addEventListener("change", () => onFilterChange(state, dom, page));
  });
  const priceMin = document.getElementById(dom.sidebar.id + "-priceMin");
  const priceMax = document.getElementById(dom.sidebar.id + "-priceMax");
  const dateFrom = document.getElementById(dom.sidebar.id + "-dateFrom");
  const dateTo   = document.getElementById(dom.sidebar.id + "-dateTo");
  if (priceMin) priceMin.addEventListener("change", (e) => onRangeChange(state, "priceMin", e.target.value, page));
  if (priceMax) priceMax.addEventListener("change", (e) => onRangeChange(state, "priceMax", e.target.value, page));
  if (dateFrom) dateFrom.addEventListener("change", (e) => onRangeChange(state, "dateFrom", e.target.value, page));
  if (dateTo)   dateTo.addEventListener("change",   (e) => onRangeChange(state, "dateTo",   e.target.value, page));
  const clearLink = document.getElementById(dom.sidebar.id + "-clearLink");
  if (clearLink) clearLink.addEventListener("click", () => clearFilters(state, dom, page));

  if (page === "dashboard") {
    applyDateDensity({ state, dom });
  }
}

function applyDateDensity({ state, dom }) {
  function computeDateDensity(input) {
    const val = input.value;
    if (!val || state.data.length === 0) return 0;
    const target = new Date(val).getTime() / 1000;
    const window = 86400 * 3;
    const count = state.data.filter(r => Math.abs(r.timestamp - target) <= window).length;
    const ratio = count / state.data.length;
    if (ratio > 0.3) return 3;
    if (ratio > 0.1) return 2;
    return 1;
  }

  function applyDensity(input) {
    input.classList.remove("date-density-0", "date-density-1", "date-density-2", "date-density-3");
    const density = computeDateDensity(input);
    input.classList.add(`date-density-${density}`);
  }

  [document.getElementById(dom.sidebar.id + "-dateFrom"),
   document.getElementById(dom.sidebar.id + "-dateTo")].forEach(inp => {
    if (!inp) return;
    applyDensity(inp);
    inp.addEventListener("change", () => applyDensity(inp));
  });
}

function renderTableHead(state, dom, page) {
  const cols = getColumns(page);
  const actionTH = page === "dashboard" ? `<th class="action-col-head"></th>` : "";
  dom.tableHead.innerHTML =
    `<tr>${cols.map(c => {
      const sorted = state.sort.key === c.key ? " sorted" : "";
      const arrow = c.sortable
        ? `<span class="sort-arrow">${sorted ? (state.sort.order === "asc" ? "▲" : "▼") : "⇅"}</span>`
        : "";
      return `<th class="${sorted}"${c.sortable ? ` data-sort="${c.key}"` : ""}>${c.label}${arrow}</th>`;
    }).join("")}${actionTH}</tr>`;

  dom.tableHead.querySelectorAll("th[data-sort]").forEach(th => {
    th.addEventListener("click", () => toggleSort(state, th.dataset.sort, dom, page));
  });
}

function renderTableBody(state, dom, page) {
  const cols = getColumns(page);
  const pageData = getPageData(state);
  const colCount = page === "dashboard" ? cols.length + 1 : cols.length;
  if (pageData.length === 0) {
    dom.tableBody.innerHTML =
      `<tr><td colspan="${colCount}"><div class="empty-state"><div class="empty-icon">📭</div><p>没有匹配的记录</p><p style="font-size:12px;color:var(--text-muted)">尝试调整筛选条件或搜索关键词</p></div></td></tr>`;
    return;
  }
  dom.tableBody.innerHTML = pageData.map(r => {
    const timeField = page === "favorites" ? "created_at" : "timestamp";
    const t = (v) => v ? ` title="${esc(v)}"` : "";
    const delCol = page === "dashboard"
      ? `<td class="action-cell"><button class="btn-del" data-cache-key="${esc(r.query || "")}" title="删除此缓存条目">🗑️</button></td>`
      : "";
    return `<tr>
      <td${t(r.brand)}><span class="tag tag-brand"${t(r.brand)}>${esc(r.brand || "--")}</span></td>
      <td${t(r.product_name || r.title)}>${esc(r.product_name || r.title || "--")}</td>
      <td${t(r.model)}>${esc(r.model || "--")}</td>
      <td class="price-cell"${t(r.price)}>${esc(r.price || "--")}</td>
      <td${t(r.price_source)}><span class="tag tag-store"${t(r.price_source)}>${esc(r.price_source || "--")}</span></td>
      <td${t(r.query_source)}><span class="tag tag-source"${t(r.query_source)}>${esc(r.query_source || "--")}</span></td>
      <td${t(r.user_id)}>${esc(r.user_id || "--")}</td>
      ${page !== "favorites" ? `<td${t(r.query)}>${esc(r.query || "--")}</td>` : ""}
      <td class="link-cell">${r.url ? `<a href="${r.url.replace(/"/g, '&quot;')}" target="_blank" rel="noopener">查看</a>` : "--"}</td>
      <td>${formatTime(r[timeField])}</td>
      ${delCol}
    </tr>`;
  }).join("");

  dom.tableBody.querySelectorAll(".btn-del").forEach(btn => {
    btn.addEventListener("click", () => {
      const cacheKey = btn.dataset.cacheKey;
      if (cacheKey && confirm(`确定要删除缓存条目「${cacheKey}」吗？`)) {
        deleteCacheEntry(state, dom, page, cacheKey);
      }
    });
  });
}

async function deleteCacheEntry(state, dom, page, cacheKey) {
  try {
    const resp = await api.post("cache-delete", { cache_key: cacheKey });
    if (resp && resp.ok) {
      state.data = state.data.filter(r => r.query !== cacheKey);
      sortData(state, page);
      applyFilters(state, page);
      showToast(`已删除缓存条目「${cacheKey}」`);
    } else {
      showToast("删除失败", true);
    }
  } catch (e) {
    showToast("删除失败", true);
  }
}

function renderPagination(state, dom) {
  const total = totalPages(state);
  const page = state.page;
  let btns = "";
  for (let i = 1; i <= total; i++) {
    if (total > 7 && i > 3 && i < total - 1 && i !== page && i !== page - 1 && i !== page + 1) {
      if (i === 4) btns += `<button disabled>…</button>`;
      continue;
    }
    btns += `<button class="${i === page ? "active" : ""}" data-pg="${i}">${i}</button>`;
  }
  const ps = state.pageSize >= 99999 ? "all" : String(state.pageSize);
  dom.pagination.innerHTML = `
    <span>第 ${page}/${total} 页 ·
      <select class="page-size-select" id="${dom.pagination.id}-psSelect">
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
  dom.tableInfo.innerHTML = `共 <strong>${state.filtered.length}</strong> 条记录`;

  const psSelect = document.getElementById(dom.pagination.id + "-psSelect");
  if (psSelect) psSelect.addEventListener("change", () => changePageSize(state, dom));
  dom.pagination.querySelectorAll("button[data-pg]").forEach(btn => {
    btn.addEventListener("click", () => goPage(state, parseInt(btn.dataset.pg), dom));
  });
}

function renderAll(state, dom, page) {
  renderTableHead(state, dom, page);
  renderTableBody(state, dom, page);
  renderPagination(state, dom);
}

// ========== 按页初始化 ==========

function bindPageEvents(state, dom, page) {
  dom.btnSearch.addEventListener("click", () => {
    state.filters.keyword = dom.searchInput.value.trim();
    doSearch(state, dom, page);
  });

  dom.btnReset.addEventListener("click", () => resetAll(state, dom, page));

  dom.searchInput.addEventListener("input", () => {
    dom.btnReset.classList.toggle("visible", dom.searchInput.value.length > 0);
  });

  dom.searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      state.filters.keyword = dom.searchInput.value.trim();
      doSearch(state, dom, page);
    }
  });
}

async function initPage(state, dom, page) {
  if (state._loaded) return;
  state._loaded = true;

  bindPageEvents(state, dom, page);

  currentPage = page;
  await Promise.all([loadFilterOptions(state, dom, page), doSearch(state, dom, page), loadStats(state, dom, page)]);
  dom.searchInput.focus();
}

// ========== 主初始化 ==========

async function init() {
  bridge = window.AstrBotPluginPage;
  api = new ApiClient(bridge);

  await api.ready();

  const savedTheme = (() => {
    try { return localStorage.getItem("pf_theme"); } catch (_) { return null; }
  })();

  if (bridge && typeof bridge.onContext === "function") {
    bridge.onContext((ctx) => {
      if (ctx && typeof ctx.isDark === "boolean") {
        applyTheme(ctx.isDark ? "dark" : "light");
      }
    });
  }

  applyTheme(savedTheme || "light");

  document.getElementById("themeBtn").addEventListener("click", toggleTheme);
  document.getElementById("debugToggle").addEventListener("change", toggleDebug);

  document.querySelectorAll(".header-tab[data-page]").forEach(btn => {
    btn.addEventListener("click", () => switchPage(btn.dataset.page));
  });

  await loadDebugConfig();

  const dom = getPageDom("dashboard");
  await initPage(dashboardState, dom, "dashboard");
}

init();
