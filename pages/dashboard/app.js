const PAGE_SIZE = 10;

let bridge = null;
let context = null;
let allData = [];
let filterOptions = { brands: [], price_sources: [], query_sources: [] };
let activeFilters = { brand: [], price_source: [], query_source: [] };
let currentPage = 1;
let sortField = "timestamp";
let sortDir = "desc";
let isLoading = false;

async function init() {
  bridge = window.AstrBotPluginPage;
  context = await bridge.ready();

  const themeHandler = () => {};
  bridge.onContext(themeHandler);

  document.getElementById("btnSearch").addEventListener("click", doSearch);
  document.getElementById("btnReset").addEventListener("click", resetSearch);
  document.getElementById("clearFilters").addEventListener("click", resetSearch);
  document.getElementById("searchInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") doSearch();
  });
  document.getElementById("filterTimeRange").addEventListener("change", doSearch);

  document.querySelectorAll("th.sortable").forEach((th) => {
    th.addEventListener("click", () => {
      const field = th.dataset.sort;
      if (sortField === field) sortDir = sortDir === "asc" ? "desc" : "asc";
      else { sortField = field; sortDir = "asc"; }
      renderTable();
    });
  });

  await loadStats();
  await loadFilterOptions();
  document.getElementById("searchInput").focus();
}

async function loadStats() {
  try {
    const stats = await bridge.apiGet("page/stats");
    document.getElementById("metricEntries").textContent = stats.total_entries ?? "-";
    document.getElementById("metricQueries").textContent = (stats.total_queries ?? "-").toLocaleString();
    document.getElementById("metricToday").textContent = stats.today_queries ?? "-";
    document.getElementById("metricUsers").textContent = stats.active_users ?? "-";
  } catch (e) {
    console.warn("Failed to load stats:", e);
  }
}

async function loadFilterOptions() {
  try {
    filterOptions = await bridge.apiGet("page/filters");
    const srcSelect = document.getElementById("searchSource");
    srcSelect.innerHTML = '<option value="">全部来源</option>';
    filterOptions.price_sources.forEach((s) => {
      srcSelect.innerHTML += `<option value="${s}">${s}</option>`;
    });
    renderSidebarFilters();
  } catch (e) {
    console.warn("Failed to load filter options:", e);
  }
}

function renderSidebarFilters() {
  const renderGroup = (containerId, items, filterKey) => {
    const container = document.getElementById(containerId);
    const allCounts = {};
    allData.forEach((d) => {
      const v = d[filterKey];
      if (v) allCounts[v] = (allCounts[v] || 0) + 1;
    });
    container.innerHTML = items.slice(0, 15).map((item) => {
      const active = activeFilters[filterKey].includes(item);
      const count = allCounts[item] || 0;
      return `<label class="filter-item${active ? " active" : ""}">
        <input type="checkbox" ${active ? "checked" : ""} value="${item}"
          data-filter-key="${filterKey}" data-filter-value="${item}">
        <span>${item}</span><span class="count">${count}</span>
      </label>`;
    }).join("");
    container.querySelectorAll("input[type=checkbox]").forEach((cb) => {
      cb.addEventListener("change", (e) => {
        toggleFilter(e.target.dataset.filterKey, e.target.dataset.filterValue, e.target.checked);
      });
    });
  };

  renderGroup("filter-brand", filterOptions.brands, "brand");
  renderGroup("filter-price-source", filterOptions.price_sources, "price_source");
  renderGroup("filter-query-source", filterOptions.query_sources, "query_source");
}

function toggleFilter(key, value, checked) {
  if (checked) activeFilters[key].push(value);
  else activeFilters[key] = activeFilters[key].filter((v) => v !== value);
  currentPage = 1;
  renderTable();
  renderSidebarFilters();
}

async function doSearch() {
  if (isLoading) return;
  isLoading = true;
  showLoading();

  const keyword = document.getElementById("searchInput").value.trim();
  const source = document.getElementById("searchSource").value;
  const timeRange = document.getElementById("filterTimeRange").value;

  const params = {};
  if (keyword) params.keyword = keyword;
  if (source) params.price_source = source;
  if (timeRange && timeRange !== "all") params.time_range = timeRange;

  try {
    allData = await bridge.apiGet("page/search", params);
    currentPage = 1;
  } catch (e) {
    console.warn("Search failed:", e);
    allData = [];
  } finally {
    isLoading = false;
    await loadStats();
    renderTable();
    renderSidebarFilters();
  }
}

function showLoading() {
  document.getElementById("tableBody").innerHTML = `<tr><td colspan="10">
    <div class="loading-overlay"><span class="spinner-lg"></span>加载中...</div>
  </td></tr>`;
  document.getElementById("resultCount").textContent = "...";
}

function getFilteredData() {
  const timeRange = document.getElementById("filterTimeRange").value;
  const now = Date.now() / 1000;
  const ranges = { today: 86400, "7d": 604800, "30d": 2592000 };

  let data = allData;
  if (timeRange && timeRange !== "all") {
    const cutoff = now - ranges[timeRange];
    data = data.filter((d) => d.timestamp >= cutoff);
  }

  data = data.filter((d) => {
    if (activeFilters.brand.length && !activeFilters.brand.includes(d.brand)) return false;
    if (activeFilters.price_source.length && !activeFilters.price_source.includes(d.price_source)) return false;
    if (activeFilters.query_source.length && !activeFilters.query_source.includes(d.query_source)) return false;
    return true;
  });

  data.sort((a, b) => {
    let va = a[sortField] ?? "";
    let vb = b[sortField] ?? "";
    if (typeof va === "number" && typeof vb === "number") {
      return sortDir === "asc" ? va - vb : vb - va;
    }
    va = String(va).toLowerCase();
    vb = String(vb).toLowerCase();
    if (va < vb) return sortDir === "asc" ? -1 : 1;
    if (va > vb) return sortDir === "asc" ? 1 : -1;
    return 0;
  });

  return data;
}

function renderTable() {
  const filtered = getFilteredData();
  document.getElementById("resultCount").textContent = filtered.length;

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE) || 1;
  if (currentPage > totalPages) currentPage = totalPages;

  const start = (currentPage - 1) * PAGE_SIZE;
  const pageData = filtered.slice(start, start + PAGE_SIZE);

  const tbody = document.getElementById("tableBody");
  if (pageData.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10">
      <div class="empty-state"><div class="empty-icon">&#128270;</div><p>没有匹配的结果</p></div>
    </td></tr>`;
  } else {
    tbody.innerHTML = pageData.map((d, i) => `
      <tr>
        <td style="color:var(--text-tertiary)">${start + i + 1}</td>
        <td class="brand">${escHtml(d.brand || "-")}</td>
        <td>${escHtml(d.product_name || d.title || "-")}</td>
        <td>${escHtml(d.model || "-")}</td>
        <td class="price" style="text-align:right">${escHtml(d.price || "-")}</td>
        <td class="price-source"><span class="badge">${escHtml(d.price_source || "-")}</span></td>
        <td>${escHtml(d.query_source || "-")}</td>
        <td class="user-id">${escHtml(d.user_id || "-")}</td>
        <td class="time">${formatTime(d.timestamp)}</td>
        <td>${d.url ? `<a href="${escHtml(d.url)}" class="link-icon" target="_blank" title="打开链接">&#8599;</a>` : "-"}</td>
      </tr>
    `).join("");
  }

  renderPagination(totalPages);
}

function renderPagination(totalPages) {
  const pg = document.getElementById("pagination");
  if (totalPages <= 1) { pg.innerHTML = ""; return; }
  let html = `<button ${currentPage === 1 ? "disabled" : ""} data-page="${currentPage - 1}">&#8249;</button>`;
  const maxBtns = 5;
  let s = Math.max(1, currentPage - Math.floor(maxBtns / 2));
  let e = Math.min(totalPages, s + maxBtns - 1);
  if (e - s < maxBtns - 1) s = Math.max(1, e - maxBtns + 1);
  for (let p = s; p <= e; p++) {
    html += `<button class="${p === currentPage ? "active" : ""}" data-page="${p}">${p}</button>`;
  }
  html += `<button ${currentPage === totalPages ? "disabled" : ""} data-page="${currentPage + 1}">&#8250;</button>`;
  pg.innerHTML = html;
  pg.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      const page = parseInt(btn.dataset.page);
      if (!isNaN(page) && page >= 1 && page <= totalPages) {
        currentPage = page;
        renderTable();
      }
    });
  });
}

function resetSearch() {
  document.getElementById("searchInput").value = "";
  document.getElementById("searchSource").value = "";
  document.getElementById("filterTimeRange").value = "all";
  activeFilters = { brand: [], price_source: [], query_source: [] };
  currentPage = 1;
  sortField = "timestamp";
  sortDir = "desc";
  doSearch();
}

function formatTime(ts) {
  if (!ts) return "-";
  const d = new Date(ts * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function escHtml(s) {
  if (!s) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

init();
