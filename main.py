"""
PriceFinder - 慢慢买商品比价插件

AstrBot 插件，从慢慢买 (ManManBuy) 网站抓取商品比价信息。
支持智能缓存、向量语义搜索、AI 结果过滤等功能。

架构:
- CacheManager: JSON 文件缓存 + 向量相似度搜索
- ManManBuy Scraper: httpx 抓取 + BeautifulSoup 解析
- AI Filter: LLM 去重、排序、过滤搜索结果
"""

# ========== 标准库导入 ==========
import json
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path
from urllib.parse import quote

# ========== 第三方库导入 ==========
import httpx                          # 异步 HTTP 客户端（爬虫用）
from bs4 import BeautifulSoup         # HTML 解析器
from quart import jsonify, request    # pyright: ignore[reportMissingImports] # Web API 框架（AstrBot 内建）

# ========== AstrBot SDK 导入 ==========
from astrbot.api.event import filter, AstrMessageEvent # pyright: ignore[reportMissingImports]
from astrbot.api.star import Context, Star, register # pyright: ignore[reportMissingImports]
from astrbot.api import logger, AstrBotConfig # pyright: ignore[reportMissingImports]

# 插件完整名称：AstrBot 通过目录名识别，Web API 路由前缀需要此常量
PLUGIN_NAME = "astrbot_plugin_pricefinder"

# 默认 User-Agent，模拟浏览器访问以规避反爬检测
DEFAULT_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)


@dataclass
class PriceResult:
    """商品价格搜索结果数据类

    Attributes:
        title: 商品原始标题（爬虫直接获取）
        brand: 品牌方（如 "Apple"、"小米"）
        product_name: 商品名（如 "iPhone 16 Pro"）
        model: 商品详细型号（如 "256GB 沙漠金"）
        price: 商品价格（如 "¥99.00"）
        price_source: 售价来源（如 "京东"、"淘宝"）
        url: 商品详情页链接
        query_source: 查价来源（如 "ManManBuy"）
        history_low: 历史最低价（可选，爬虫未提供时为空）
    """
    title: str
    brand: str = ""
    product_name: str = ""
    model: str = ""
    price: str = ""
    price_source: str = ""
    url: str = ""
    query_source: str = ""
    history_low: str = ""


@dataclass
class CacheEntry:
    """缓存条目数据类，存储一次搜索的完整结果

    Attributes:
        query: 搜索关键词
        user_id: 查价用户 ID
        timestamp: 缓存时间戳（epoch 秒）
        manmanbuy_results: 搜索结果列表
        embedding: 查询的向量嵌入（用于语义相似搜索）
    """
    query: str
    timestamp: float
    user_id: str = ""
    manmanbuy_results: list = field(default_factory=list)
    embedding: list = field(default_factory=list)

    def to_dict(self):
        """序列化为字典，用于 JSON 持久化"""
        return {
            "query": self.query,
            "user_id": self.user_id,
            "timestamp": self.timestamp,
            "manmanbuy_results": [asdict(r) for r in self.manmanbuy_results],
            "embedding": self.embedding,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "CacheEntry":
        """从字典反序列化，用于从 JSON 加载

        兼容旧版缓存格式：自动将 store→price_source、source→query_source
        """
        results_raw = d.get("manmanbuy_results", [])
        migrated = []
        for r in results_raw:
            r_migrated = dict(r)
            if "store" in r_migrated and "price_source" not in r_migrated:
                r_migrated["price_source"] = r_migrated.pop("store")
            if "source" in r_migrated and "query_source" not in r_migrated:
                r_migrated["query_source"] = r_migrated.pop("source")
            r_migrated.setdefault("brand", "")
            r_migrated.setdefault("product_name", "")
            r_migrated.setdefault("model", "")
            migrated.append(PriceResult(**r_migrated))
        return cls(
            query=d["query"],
            timestamp=d["timestamp"],
            user_id=d.get("user_id", ""),
            manmanbuy_results=migrated,
            embedding=d.get("embedding", []),
        )


@dataclass
class EmbeddingIndex:
    """向量索引条目，用于快速语义相似搜索

    Attributes:
        query: 原始搜索关键词
        vector: 向量嵌入
        cache_key: 对应的缓存键
    """
    query: str
    vector: list
    cache_key: str


class CacheManager:
    """缓存管理器，负责搜索结果的持久化和检索

    使用两个 JSON 文件持久化:
    - cache.json: 搜索结果缓存
    - embeddings.json: 向量索引（用于语义相似搜索）

    支持功能:
    - LRU 淘汰策略（按时间戳排序，移除最旧条目）
    - TTL 过期清理
    - 向量相似度搜索（余弦相似度）
    """

    def __init__(self, cache_file: Path, embedding_file: Path):
        """初始化缓存管理器，从磁盘加载现有缓存

        Args:
            cache_file: 缓存文件路径
            embedding_file: 向量索引文件路径
        """
        self.cache_file = cache_file
        self.embedding_file = embedding_file
        self.entries: dict[str, CacheEntry] = {}  # key -> CacheEntry 映射
        self.index: list[EmbeddingIndex] = []  # 向量索引列表
        self.total_queries: int = 0  # 总查询次数计数器
        self._load_stats()  # 加载统计计数器
        self._load()

    def _load(self):
        """从磁盘加载缓存和向量索引

        如果文件不存在或加载失败，静默重置为空状态。
        """
        try:
            if self.cache_file.exists():
                with open(self.cache_file, "r", encoding="utf-8") as f:
                    data = json.load(f)
                for key, val in data.items():
                    self.entries[key] = CacheEntry.from_dict(val)
        except Exception as e:
            logger.warning(f"Failed to load cache: {e}")
            self.entries = {}

        try:
            if self.embedding_file.exists():
                with open(self.embedding_file, "r", encoding="utf-8") as f:
                    data = json.load(f)
                self.index = [EmbeddingIndex(**item) for item in data]
        except Exception as e:
            logger.warning(f"Failed to load embedding index: {e}")
            self.index = []

    def _save(self):
        """将缓存和向量索引持久化到磁盘

        写入两个 JSON 文件：cache.json（搜索结果）和 embeddings.json（向量索引）。
        使用 ensure_ascii=False 支持中文，indent=2 便于人工调试。
        失败时仅警告，不抛出异常——缓存写入失败不应打断搜索主流程。
        """
        try:
            self.cache_file.parent.mkdir(parents=True, exist_ok=True)
            with open(self.cache_file, "w", encoding="utf-8") as f:
                json.dump({k: v.to_dict() for k, v in self.entries.items()}, f, ensure_ascii=False, indent=2)
        except Exception as e:
            logger.warning(f"Failed to save cache: {e}")

        try:
            self.embedding_file.parent.mkdir(parents=True, exist_ok=True)
            with open(self.embedding_file, "w", encoding="utf-8") as f:
                json.dump([asdict(item) for item in self.index], f, ensure_ascii=False, indent=2)
        except Exception as e:
            logger.warning(f"Failed to save embedding index: {e}")

    def _stats_file(self) -> Path:
        """统计计数器文件路径"""
        return self.cache_file.parent / "stats.json"

    def _load_stats(self):
        """从磁盘加载统计计数器"""
        try:
            sf = self._stats_file()
            if sf.exists():
                with open(sf, "r", encoding="utf-8") as f:
                    data = json.load(f)
                self.total_queries = data.get("total_queries", 0)
        except Exception:
            self.total_queries = 0

    def _save_stats(self):
        """持久化统计计数器到磁盘"""
        try:
            sf = self._stats_file()
            sf.parent.mkdir(parents=True, exist_ok=True)
            with open(sf, "w", encoding="utf-8") as f:
                json.dump({"total_queries": self.total_queries}, f)
        except Exception as e:
            logger.warning(f"Failed to save stats: {e}")

    def increment_query(self):
        """递增总查询次数计数器"""
        self.total_queries += 1
        self._save_stats()

    def get_stats(self) -> dict:
        """返回仪表盘统计信息

        Returns:
            包含 total_entries, total_queries, today_queries, active_users 等指标的字典
        """
        now = time.time()
        today_start = now - (now % 86400)
        today_queries = 0
        users = set()
        for entry in self.entries.values():
            if entry.timestamp >= today_start:
                today_queries += 1
            if entry.user_id:
                users.add(entry.user_id)
        return {
            "total_entries": len(self.entries),
            "total_queries": self.total_queries,
            "today_queries": today_queries,
            "active_users": len(users),
        }

    def get_all_results(self, filters: dict | None = None) -> list:
        """获取所有缓存条目中的搜索结果（展平为单条记录）

        Args:
            filters: 可选筛选条件，支持 brand, price_source, query_source, keyword, user_id

        Returns:
            展平后的结果列表，每项包含 PriceResult 所有字段 + query + user_id + timestamp
        """
        results = []
        filters = filters or {}
        for key, entry in self.entries.items():
            for r in entry.manmanbuy_results:
                record = {
                    "query": entry.query,
                    "user_id": entry.user_id,
                    "timestamp": entry.timestamp,
                    "title": r.title,
                    "brand": r.brand,
                    "product_name": r.product_name,
                    "model": r.model,
                    "price": r.price,
                    "price_source": r.price_source,
                    "url": r.url,
                    "query_source": r.query_source,
                    "history_low": r.history_low,
                }
                if self._match_filters(record, filters):
                    results.append(record)
        results.sort(key=lambda x: x["timestamp"], reverse=True)
        return results

    def _match_filters(self, record: dict, filters: dict) -> bool:
        """检查记录是否匹配所有筛选条件"""
        keyword = (filters.get("keyword") or "").lower()
        if keyword:
            match = False
            for field in ("brand", "product_name", "model", "query", "price_source", "title"):
                if keyword in (record.get(field) or "").lower():
                    match = True
                    break
            if not match:
                return False
        for key in ("brand", "price_source", "query_source", "user_id"):
            fv = filters.get(key)
            if fv and record.get(key) != fv:
                return False
        return True

    def get_filter_options(self) -> dict:
        """返回筛选器可选项（品牌、售价来源、查价来源、用户的去重列表）"""
        brands = set()
        price_sources = set()
        query_sources = set()
        users = set()
        for entry in self.entries.values():
            for r in entry.manmanbuy_results:
                if r.brand:
                    brands.add(r.brand)
                if r.price_source:
                    price_sources.add(r.price_source)
                if r.query_source:
                    query_sources.add(r.query_source)
            if entry.user_id:
                users.add(entry.user_id)
        return {
            "brands": sorted(brands),
            "price_sources": sorted(price_sources),
            "query_sources": sorted(query_sources),
            "users": sorted(users),
        }

    def get(self, key: str) -> CacheEntry | None:
        """按精确键获取缓存条目"""
        return self.entries.get(key)

    def get_by_key(self, key: str) -> CacheEntry | None:
        """按精确键获取缓存条目（与 get 方法相同，保留用于向量搜索回调）"""
        return self.entries.get(key)

    async def put(self, key: str, entry: CacheEntry, embedding: list | None = None, max_entries: int = -1):
        """存储缓存条目

        Args:
            key: 缓存键（搜索关键词）
            entry: 缓存条目
            embedding: 向量嵌入（可选，用于语义搜索）
            max_entries: 最大缓存条目数（-1 表示不限制）
        """
        # 如果提供了向量，更新向量索引
        if embedding:
            entry.embedding = embedding
            # 移除旧的索引条目，添加新的
            self.index = [idx for idx in self.index if idx.cache_key != key]
            self.index.append(EmbeddingIndex(query=key, vector=embedding, cache_key=key))

        self.entries[key] = entry

        # LRU 淘汰：超过容量时移除最旧的条目
        if max_entries > 0 and len(self.entries) > max_entries:
            sorted_keys = sorted(self.entries.keys(), key=lambda k: self.entries[k].timestamp)
            while len(self.entries) > max_entries:
                old_key = sorted_keys.pop(0)
                self.entries.pop(old_key, None)
                # 同时移除对应的向量索引
                self.index = [idx for idx in self.index if idx.cache_key != old_key]

        self._save()

    async def search_similar(self, query: str, query_vec: list, threshold: float) -> CacheEntry | None:
        """通过向量相似度搜索缓存

        使用暴力线性扫描计算余弦相似度，返回超过阈值的最佳匹配。

        Args:
            query: 原始查询（用于返回结果）
            query_vec: 查询的向量嵌入
            threshold: 相似度阈值（0-1），超过此值视为匹配

        Returns:
            最匹配的缓存条目，无匹配返回 None
        """
        if not self.index or not query_vec:
            return None

        best_score = 0.0
        best_key = None
        for entry in self.index:
            if not entry.vector:
                continue
            score = _cosine_similarity(query_vec, entry.vector)
            if score > best_score:
                best_score = score
                best_key = entry.cache_key

        if best_score >= threshold and best_key:
            return self.get_by_key(best_key)
        return None

    def cleanup_expired(self, ttl_days: int):
        """清理过期的缓存条目

        Args:
            ttl_days: 过期天数（0 表示永不过期）
        """
        if ttl_days <= 0:
            return
        ttl_seconds = ttl_days * 86400  # 86400 = 24 * 60 * 60（秒/天）
        now = time.time()
        expired_keys = [k for k, v in self.entries.items() if (now - v.timestamp) > ttl_seconds]
        for key in expired_keys:
            self.entries.pop(key, None)
            self.index = [idx for idx in self.index if idx.cache_key != key]
        if expired_keys:
            self._save()
            logger.info(f"Cleaned up {len(expired_keys)} expired cache entries")


def _cosine_similarity(a: list, b: list) -> float:
    """计算两个向量的余弦相似度

    纯 Python 实现（无 numpy 依赖），适合插件运行时环境。
    公式：cos(θ) = (A·B) / (||A|| × ||B||)

    Args:
        a: 向量 A（浮点数列表）
        b: 向量 B（长度需与 A 相同）

    Returns:
        余弦相似度（-1 到 1，越接近 1 越相似）
        任一向量为零向量时返回 0.0（视为无相似性）
    """
    # 点积：A·B = Σ(a[i] × b[i])
    dot = sum(x * y for x, y in zip(a, b))
    # L2 范数：||A|| = √(Σ a[i]²)
    norm_a = sum(x * x for x in a) ** 0.5
    norm_b = sum(x * x for x in b) ** 0.5
    # 零向量保护
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


# 多商品列表页检测用品牌白名单（文案中出现3家以上品牌即判定为列表页）
_KNOWN_BRANDS = frozenset({
    "七彩虹", "华硕", "影驰", "微星", "技嘉", "耕升",
    "索泰", "铭瑄", "盈通", "蓝宝石", "撼讯", "讯景",
    "华为", "小米", "OPPO", "vivo", "三星", "Sony",
    "Apple", "苹果", "联想", "戴尔", "惠普", "宏碁",
})

# 套装/组合商品检测关键词
_COMBO_KEYWORDS = [
    "套装", "板U", "CPU套装", "主板套装", "CPU+主板",
    "准系统", "barebone",
    "整机", "组装电脑", "主机", "台式机",
    "套餐", "组合", "搭配", "整套",
    "显卡+电源", "显卡电源套",
]


@register("pricefinder", "past_windXF", "搜索慢慢买商品比价信息", "1.0.0")
class PriceFinderPlugin(Star):
    """PriceFinder 插件主类

    提供商品比价搜索功能，支持:
    - 命令行搜索: /price search <关键词>
    - LLM Tool: AI 可自主调用 search_prices 工具
    """

    def __init__(self, context: Context, config: AstrBotConfig):
        """初始化插件

        Args:
            context: AstrBot 上下文，用于访问 LLM 提供商
            config: 插件配置
        """
        super().__init__(context)
        self.config = config
        self.client: httpx.AsyncClient | None = None  # HTTP 客户端
        self.cache: CacheManager | None = None  # 缓存管理器

    async def initialize(self):
        """初始化插件资源

        创建缓存目录，初始化缓存管理器和 HTTP 客户端。
        缓存目录位于 AstrBot 数据目录下的 plugin_data/pricefinder/
        """
        from astrbot.core.utils.astrbot_path import get_astrbot_data_path # pyright: ignore[reportMissingImports]
        cache_dir = Path(get_astrbot_data_path()) / "plugin_data" / self.name
        self.cache = CacheManager(
            cache_file=cache_dir / "cache.json",
            embedding_file=cache_dir / "embeddings.json",
        )
        self.client = httpx.AsyncClient(
            timeout=httpx.Timeout(self.config.get("network_settings", {}).get("timeout", 15)),
            follow_redirects=True,
        )
        self._register_web_api()
        logger.info("PriceFinder plugin initialized")

    async def terminate(self):
        """清理插件资源，关闭 HTTP 客户端"""
        if self.client:
            await self.client.aclose()
        logger.info("PriceFinder plugin terminated")

    async def _fetch(self, url: str) -> str | None:
        """发起 HTTP GET 请求

        支持重试机制，构造浏览器请求头以避免反爬。

        Args:
            url: 目标 URL

        Returns:
            响应 HTML 文本，失败返回 None
        """
        net = self.config.get("network_settings", {})
        headers = {
            "User-Agent": net.get("user_agent", DEFAULT_UA),
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            "Referer": url.split("/")[0] + "//" + url.split("/")[2] + "/",  # 构造 Referer 头
        }
        retry_count = net.get("retry_count", 2)
        for attempt in range(retry_count + 1):
            try:
                resp = await self.client.get(url, headers=headers)
                if resp.status_code == 200:
                    return resp.text
                logger.warning(f"HTTP {resp.status_code} for {url}")
            except Exception as e:
                logger.warning(f"Request failed (attempt {attempt + 1}/{retry_count + 1}): {e}")
        return None

    async def _get_embedding(self, text: str) -> list | None:
        """获取文本的向量嵌入

        提供商解析优先级:
        1. 配置中指定的 embedding_provider ID
        2. 第一个可用的嵌入提供商
        3. 无可用提供商则返回 None

        Args:
            text: 要嵌入的文本

        Returns:
            向量列表，失败返回 None
        """
        provider_id = self.config.get("cache_settings", {}).get("embedding_provider", "")
        try:
            if provider_id:
                provider = self.context.get_provider_by_id(provider_id)
            else:
                providers = self.context.get_all_embedding_providers()
                provider = providers[0] if providers else None

            if provider is None:
                return None

            embedding = await provider.get_embedding(text)
            return embedding
        except Exception as e:
            logger.warning(f"Embedding failed: {e}")
            return None

    def _get_llm_provider(self):
        """获取 LLM 提供商

        提供商解析优先级:
        1. 配置中指定的 ai_filter_provider ID
        2. AstrBot 当前使用的提供商
        3. 无可用提供商则返回 None

        Returns:
            LLM 提供商实例，无可用返回 None
        """
        provider_id = self.config.get("ai_filter_settings", {}).get("ai_filter_provider", "")
        try:
            if provider_id:
                return self.context.get_provider_by_id(provider_id)
            return self.context.get_using_provider()
        except Exception:
            return None

    def _is_expired(self, entry: CacheEntry) -> bool:
        """检查缓存条目是否过期

        Args:
            entry: 缓存条目

        Returns:
            True 表示已过期或永不过期（ttl_days <= 0）
        """
        ttl_days = self.config.get("cache_settings", {}).get("cache_ttl_days", 1)
        if ttl_days <= 0:
            return False  # ttl_days <= 0 表示永不过期
        ttl_seconds = ttl_days * 86400  # 86400 = 24 * 60 * 60（秒/天）
        return (time.time() - entry.timestamp) > ttl_seconds

    async def has_query(self, keyword: str) -> tuple:
        """检查缓存中是否存在有效的搜索结果

        两级查找策略:
        1. 精确匹配: 直接按关键词查找
        2. 向量相似搜索: 通过嵌入向量查找语义相似的缓存

        Args:
            keyword: 搜索关键词

        Returns:
            (是否存在有效缓存, 缓存条目或 None)
        """
        exact = self.cache.get(keyword)
        if exact and not self._is_expired(exact):
            return True, exact

        cache_cfg = self.config.get("cache_settings", {})
        if cache_cfg.get("vector_search_enabled", True):
            query_vec = await self._get_embedding(keyword)
            if query_vec:
                threshold = cache_cfg.get("vector_similarity_threshold", 0.85)  # 0.85 = 默认相似度阈值
                similar = await self.cache.search_similar(keyword, query_vec, threshold)
                if similar and not self._is_expired(similar):
                    return True, similar

        return False, None

    async def _search_manmanbuy(self, keyword: str) -> list:
        """从慢慢买网站抓取商品比价信息

        使用 CSS 选择器解析 HTML，提取商品标题、价格、商城、链接。
        ⚠️ CSS 选择器依赖 React CSS Modules 生成的哈希类名
        （如 .DiscountItemPC_itemTitle__hlI5m），网站重构后可能失效。

        Args:
            keyword: 搜索关键词

        Returns:
            PriceResult 列表
        """
        # 构造搜索 URL：c=discount 表示按折扣排序
        url = f"https://s.manmanbuy.com/pc/search/result?c=discount&keyword={quote(keyword)}"
        html = await self._fetch(url)
        if not html:
            return []

        soup = BeautifulSoup(html, "lxml")
        results = []
        max_results = self.config.get("search_settings", {}).get("max_results", 5)

        # 遍历搜索结果卡片（每个 .DiscountItemPC_box__m9G3M 是一个商品条目）
        for item in soup.select(".DiscountItemPC_box__m9G3M")[:max_results]:
            try:
                title_el = item.select_one(".DiscountItemPC_itemTitle__hlI5m a")
                if not title_el:
                    continue
                title = title_el.get_text(strip=True)
                href = title_el.get("href", "")
                # 处理相对链接，补全为完整 URL
                if not href.startswith("http"):
                    href = "https://cu.manmanbuy.com" + href

                price_el = item.select_one(".DiscountItemPC_itemSubTitle__rWgWK a")
                price = price_el.get_text(strip=True) if price_el else ""

                price_source_el = item.select_one(".DiscountItemPC_itemMall__R8PlE")
                price_source_text = price_source_el.get_text(strip=True) if price_source_el else ""

                results.append(PriceResult(
                    title=title,
                    price=price,
                    price_source=price_source_text,
                    url=href,
                    query_source="ManManBuy",
                ))
            except Exception as e:
                logger.warning(f"Failed to parse ManManBuy item: {e}")
                continue

        return results

    @staticmethod
    def _is_multi_product_listing(result) -> bool:
        """检测单条链接是否为多品牌/多型号商品列表页

        规则:
        1. 标题中出现 3 家以上已知品牌 → 列表页
        2. 标题中斜杠分隔的纯型号变体 >= 4 个 → 列表页

        满足任一即返回 True，该条目不送入 LLM 处理。
        """
        title = result.title

        brand_count = sum(1 for b in _KNOWN_BRANDS if b in title)
        if brand_count >= 3:
            return True

        import re
        parts = re.split(r"[/／]", title)
        model_count = sum(
            1 for p in parts
            if re.match(r"^[A-Za-z0-9+\-]+\s*$", p.strip())
        )
        return model_count >= 4

    @staticmethod
    def _is_combo_product(result) -> bool:
        """检测单品链接是否为套装/准系统/整机类组合商品"""
        return any(kw in result.title for kw in _COMBO_KEYWORDS)

    @staticmethod
    def _is_combo_search(keyword: str) -> bool:
        """检测用户搜索意图是否为有意搜寻组合商品"""
        if not keyword:
            return False
        combo_intent_keywords = ["套装", "准系统", "板U", "整机", "套餐", "组合"]
        return any(kw in keyword for kw in combo_intent_keywords)

    def _filter_price_outliers(self, results: list) -> list:
        """基于中位数统计法剔除价格异常的离群结果

        从价格文本中提取纯数字，计算中位数后按上下界过滤。
        无有效价格的结果直接保留。

        Returns:
            过滤后的 PriceResult 列表
        """
        import re

        # 提取有效价格
        prices = []
        for r in results:
            m = re.search(r"(\d+(?:\.\d+)?)", r.price.replace(",", ""))
            if m:
                prices.append((float(m.group(1)), r))

        if len(prices) < 2:
            return results

        values = sorted(v for v, _ in prices)
        n = len(values)
        if n % 2 == 0:
            median = (values[n // 2 - 1] + values[n // 2]) / 2
        else:
            median = values[n // 2]

        ai_cfg = self.config.get("ai_filter_settings", {})
        lower_ratio = ai_cfg.get("price_outlier_lower_ratio", 0.3)
        upper_ratio = ai_cfg.get("price_outlier_upper_ratio", 3.0)
        lo = median * lower_ratio
        hi = median * upper_ratio

        removed = 0
        keep = []
        for r in results:
            m = re.search(r"(\d+(?:\.\d+)?)", r.price.replace(",", ""))
            if m:
                val = float(m.group(1))
                if val < lo or val > hi:
                    removed += 1
                    continue
            keep.append(r)

        if removed:
            logger.info(
                f"Price outlier filter: removed {removed} items "
                f"(median={median:.2f}, range=[{lo:.2f}, {hi:.2f}])"
            )
        return keep

    async def _ai_filter_and_structure(self, results: list, keyword: str) -> list:
        """使用 LLM 对搜索结果进行智能过滤和结构化提取

        功能:
        - 预先剔除多商品列表页（一条链接涵盖多种品牌/型号）
        - 移除与关键词语义无关的商品（如搜"iPhone"剔除安卓配件）
        - 去除重复商品
        - 按价格从低到高排序
        - 从标题中提取 品牌方/商品名/详细型号 结构化字段

        输入会被截断到 ai_filter_max_input 字符以控制成本。

        Args:
            results: 原始搜索结果列表
            keyword: 搜索关键词

        Returns:
            过滤并结构化后的结果列表，失败返回原始结果
        """
        ai_cfg = self.config.get("ai_filter_settings", {})
        if not ai_cfg.get("ai_filter_enabled", True):
            return results
        if not results:
            return results

        provider = self._get_llm_provider()
        if provider is None:
            logger.info("AI filter skipped: no LLM provider available")
            return results

        # 阶段0: 预过滤（多商品列表页 + 套装 + 价格异常）
        pre_count = len(results)

        # 0a: 多商品列表页
        pre_filtered = [r for r in results if not self._is_multi_product_listing(r)]
        list_removed = pre_count - len(pre_filtered)

        # 0b: 套装/组合商品（用户搜索词本身含套装关键词时跳过此步）
        if pre_filtered and ai_cfg.get("filter_combo_products", True) and not self._is_combo_search(keyword):
            combo_before = len(pre_filtered)
            pre_filtered = [r for r in pre_filtered if not self._is_combo_product(r)]
            combo_removed = combo_before - len(pre_filtered)
            if combo_removed:
                logger.info(f"Combo filter: removed {combo_removed} bundle/integrated products")

        # 0c: 价格异常过滤
        if pre_filtered and ai_cfg.get("price_outlier_filter_enabled", True):
            price_before = len(pre_filtered)
            pre_filtered = self._filter_price_outliers(pre_filtered)
            price_removed = price_before - len(pre_filtered)
            if price_removed:
                logger.info(f"Price outlier filter: removed {price_removed} items")

        total_removed = pre_count - len(pre_filtered)
        if total_removed:
            logger.info(f"Pre-filter: {pre_count} -> {len(pre_filtered)} ({total_removed} removed)")
        if not pre_filtered:
            return results

        max_input = ai_cfg.get("ai_filter_max_input", 3000)
        input_text = self._results_to_text(pre_filtered, keyword)[:max_input]

        prompt = f"""你是一个商品价格分析助手。请对以下搜索结果进行分析、过滤和结构化提取。

搜索关键词: {keyword}

原始搜索结果:
{input_text}

请完成以下任务:
1. 剔除与搜索关键词语义完全不相关的结果（如搜索"iPhone"时剔除安卓充电器、手机壳等配件品类）
2. 去除完全重复的商品（品牌+型号+规格完全相同才视为同款）；不同型号（如 RTX 5070 vs RTX 5070 Ti）属于不同商品，不得合并且必须全部保留
3. 按价格从低到高排序
4. 从每个结果的标题中提取: 品牌方、商品名、详细型号

字段提取规则（必须严格遵守）:
- 品牌方:
  仅提取厂商简称，只取品牌名本身。
  正确: Apple、华为、小米、三星、Sony、AMD、Intel、七彩虹、微星、华硕、影驰
  错误: 不要包含产品系列/型号变体（如"AMD锐龙 9600X/9700X"）、
        不要包含存储/颜色后缀（如"Apple 256GB"）
  技巧: 只看标题最前面1-2个词，提取其中是品牌的部分

- 商品名:
  提取核心产品线名，能唯一标识这个商品型号。
  正确: iPhone 16 Pro Max、RTX 5070、锐龙 7500F、B650M 主板
  斜杠变体列表（如"5070/5070Ti"）仅用于帮助判断各字段该填什么值，
  不影响去重——不同型号（RTX 5070 vs RTX 5070 Ti）是不同的商品，严禁合并或互相替代
  套装/组合: 如果标题是"CPU+主板套装"，商品名应反映实际在卖的主要商品，
        如标题"AMD锐龙 9600X 微星B850主板CPU套装"，商品名取"B850M 主板CPU套装"

- 型号:
  仅提取标题中明确写明的纯规格参数，不包含任何营销推广词汇。
  应包含: 显存(12G/16G)、内存、存储(256GB)、颜色(沙漠金)、芯片组(B650M)、频率、核心数
  必须删除: 推广标签（"黑神话悟空""赛博""新品""热门"）、
          场景描述（"台式电脑游戏""竞技主播""视频直播""光追""AI 4K"）、
          无关形容词（"水神""火神"仅在产品代号"火神"时保留）
  严禁推测: 如果标题中未明确写明具体的规格值，该列留空。
    错误示例: 标题"七彩虹 RTX 5070 Ti 显卡" → 型号"12G"（标题根本没提显存，凭空推测）
    正确做法: 标题"七彩虹 RTX 5070 Ti 显卡" → 型号留空
  如果标题中无法分离纯规格，该列留空

5. 如果标题无法提取某个字段，该列留空
6. 过滤后的结果不超过 12 条

输出格式（每行一个结果）:
品牌方 | 商品名 | 型号 | 原始标题 | 价格 | 平台 | 链接

示例:
Apple | iPhone 16 Pro Max | 256GB 沙漠色 | Apple/苹果 iPhone 16 Pro Max 5G全网通 256GB | ¥9999 | 京东 | https://cu.manmanbuy.com/xxx
七彩虹 | RTX 5070 | 12G | 七彩虹RTX 5070 12G 火神水神AD 台式电脑游戏竞技主播酷睿 | ¥5897.81元 | 京东商城 | https://cu.manmanbuy.com/xxx
AMD | 锐龙 7500F | | AMD 7500F/9600X/9700X R5 7500F 盒装处理器 | ¥719元 | 拼多多 | https://cu.manmanbuy.com/xxx
微星 | B650M 主板CPU套装 | B650M | AMD锐龙 9600X 微星B850/X870主板CPU套装 其他/other | ¥1747.81元 | 天猫旗舰店 | https://cu.manmanbuy.com/xxx
"""

        try:
            response = await provider.text_chat(
                prompt=prompt,
                system_prompt="你是一个精确的价格分析助手。严格按格式输出，每行7个字段用竖线分隔。只输出结果行，不要任何说明文字。",
            )
            structured = self._parse_ai_response_structured(response.completion_text, results)
            if structured:
                logger.info(f"AI filter+structure: {len(results)} -> {len(structured)} results")
                return structured
        except Exception as e:
            logger.warning(f"AI filter failed, using raw results: {e}")

        return results

    def _results_to_text(self, results: list, keyword: str) -> str:
        """将搜索结果序列化为文本格式供 LLM 处理

        格式: "序号. 标题 | 价格 | 商城 | 链接 | 历史低价:xxx"

        Args:
            results: 搜索结果列表
            keyword: 搜索关键词

        Returns:
            格式化的文本字符串
        """
        lines = []
        for i, r in enumerate(results, 1):
            line = f"{i}. {r.title} | {r.price} | {r.price_source} | {r.url}"
            if r.history_low:
                line += f" | 历史低价:{r.history_low}"
            lines.append(line)
        return "\n".join(lines)

    def _parse_ai_response_structured(self, ai_text: str, original: list) -> list | None:
        """解析 LLM 返回的过滤+结构化结果

        输出格式: 品牌方 | 商品名 | 型号 | 原始标题 | 价格 | 平台 | 链接
        URL 在最后一列，通过 URL 匹配回原始 PriceResult 并回写结构化字段。

        Args:
            ai_text: LLM 返回的文本
            original: 原始搜索结果列表

        Returns:
            过滤并结构化后的 PriceResult 列表，解析失败返回 None
        """
        url_map = {r.url: r for r in original}
        seen = set()
        filtered = []
        for line in ai_text.strip().split("\n"):
            line = line.strip()
            if not line or "|" not in line:
                continue
            parts = [p.strip() for p in line.split("|")]
            if len(parts) < 4:
                continue
            url = parts[-1]  # URL 始终在最后一列
            if url not in url_map or url in seen:
                continue
            seen.add(url)
            result = url_map[url]
            if len(parts) >= 7:
                result.brand = parts[0]
                result.product_name = parts[1]
                result.model = parts[2]
                # self._clean_result_fields(result)
            filtered.append(result)
        return filtered if filtered else None

    def _clean_result_fields(self, result):
         """后处理清洗 LLM 提取的 brand/product_name/model 字段
    
         作为 prompt 提取的 fallback 保护层，对明显不合理的字段值进行修正。
         目前仅处理 PC 硬件品类常见问题，后续可扩展。
    
         Args:
             result: 单个 PriceResult 对象（原地修改）
         """
         import re
    
         # === SEO/营销关键词黑名单（从 model 中删除） ===
         _seo_blacklist = [
             "台式电脑", "游戏竞技", "竞技主播", "视频直播", "光追",
             r"AI\s*4K", "4K", "黑神话悟空", "黑神话", "悟空",
             r"赛博\s*新品", "赛博", "新品上市", "新品", "热门",
             "主播", "电竞", "吃鸡", "LOL", "英雄联盟",
             "台式机", "组装电脑", "独显", "高性能",
         ]
         _seo_pattern = re.compile("|".join(_seo_blacklist))
    
         # === 品牌冗余清理 ===
         # 常见错误: "AMD锐龙 9600X/9700X" 应修正为 "AMD"
         # 策略: 若 brand 含数字或斜杠变体列表，截取纯品牌部分
         brand = result.brand
         if brand and re.search(r"\d", brand):
             match = re.match(r"^([A-Za-z\u4e00-\u9fff]+(?:锐龙|酷睿)?)\b", brand)
             if match:
                 result.brand = match.group(1).strip()
    
         # === model SEO 清洗 ===
         model = result.model
         if model:
             cleaned = _seo_pattern.sub("", model)
             cleaned = re.sub(r"\s{2,}", " ", cleaned).strip()
             if cleaned and not re.search(r"\w", cleaned):
                 cleaned = ""
             result.model = cleaned

    def _format_output(self, results: CacheEntry, keyword: str) -> str:
        """格式化命令搜索的输出

        根据缓存新鲜度显示不同提示:
        - 新鲜缓存: 显示缓存时间
        - 过期缓存: 显示过期天数并提示正在重新搜索

        Args:
            results: 缓存条目（包含搜索结果和时间戳）
            keyword: 搜索关键词

        Returns:
            格式化的输出文本
        """
        cache_age_days = (time.time() - results.timestamp) / 86400  # 86400 = 秒/天
        ttl_days = self.config.get("cache_settings", {}).get("cache_ttl_days", 1)
        is_fresh = ttl_days <= 0 or cache_age_days <= ttl_days

        from datetime import datetime
        cache_time = datetime.fromtimestamp(results.timestamp).strftime("%Y-%m-%d %H:%M")

        if is_fresh:
            header = f'🔍 搜索 "{keyword}" 的价格结果\n📅 缓存时间: {cache_time} (有效期内)\n'
        else:
            header = f'🔍 搜索 "{keyword}" 的价格结果\n⚠️ 缓存已过期({cache_age_days:.0f}天前)，正在重新搜索...\n'

        lines = [header]

        if results.manmanbuy_results:
            for i, r in enumerate(results.manmanbuy_results, 1):
                lines.append(f"{i}. {r.title}")
                price_line = f"   💰 {r.price}"
                if r.price_source:
                    price_line += f" | 🏪 {r.price_source}"
                lines.append(price_line)
                if r.history_low:
                    lines.append(f"   📉 历史低价: {r.history_low}")
                lines.append(f"   🔗 {r.url}")
            lines.append("")
        else:
            return f'🔍 搜索 "{keyword}" 未找到相关商品'

        return "\n".join(lines)

    async def _do_search(self, keyword: str, user_id: str = "") -> CacheEntry:
        """执行搜索的主流程

        流程:
        1. 检查缓存（精确匹配 + 向量语义匹配）
        2. 命中 → 直接返回已过滤的缓存
        3. 未命中 → 爬取慢慢买 → AI 过滤+结构化 → 写入缓存 → 返回
        LLM 过滤只在首次爬取时执行一次，后续命中缓存零 LLM 消耗。

        Args:
            keyword: 搜索关键词
            user_id: 查价用户 ID

        Returns:
            搜索结果缓存条目（已过滤+结构化）
        """
        # 全局查询计数器 +1
        self.cache.increment_query()

        # 步骤 1&2：尝试从缓存获取
        has_cache, cached = await self.has_query(keyword)
        if has_cache and cached:
            cache_age_days = (time.time() - cached.timestamp) / 86400
            logger.info(f"Cache hit for '{keyword}' (age: {cache_age_days:.1f} days)")
            return cached

        # 步骤 3a：缓存未命中 → 爬取慢慢买原始数据
        manmanbuy_results = await self._search_manmanbuy(keyword)

        # 步骤 3b：LLM 过滤无关结果 + 提取品牌/商品名/型号
        filtered_results = await self._ai_filter_and_structure(manmanbuy_results, keyword)

        # 步骤 3c：构造缓存条目（用户 ID 关联此次查询）
        results = CacheEntry(
            query=keyword,
            user_id=user_id,
            timestamp=time.time(),
            manmanbuy_results=filtered_results,
        )

        # 步骤 3d：持久化到缓存 JSON + 向量索引
        cache_cfg = self.config.get("cache_settings", {})
        if cache_cfg.get("cache_enabled", True):
            embedding = await self._get_embedding(keyword)
            max_entries = cache_cfg.get("cache_max_entries", -1)
            await self.cache.put(keyword, results, embedding, max_entries)

        return results

    def _register_web_api(self):
        """注册 WebUI 页面所需的 API 路由

        前端通过 bridge.apiGet("page/stats") 调用，
        Dashboard 转发到 /api/plug/{PLUGIN_NAME}/page/stats

        三个端点：
        - /page/stats   → 仪表盘指标（总条目、查询次数、活跃用户）
        - /page/search  → 按条件搜索缓存结果（支持 keyword/price_source/time_range）
        - /page/filters → 返回筛选器可选项（品牌、来源等去重列表）
        """
        self.context.register_web_api(
            f"/{PLUGIN_NAME}/page/stats",
            self._page_stats,
            ["GET"],
            "PriceFinder Page stats",
        )
        self.context.register_web_api(
            f"/{PLUGIN_NAME}/page/search",
            self._page_search,
            ["GET"],
            "PriceFinder Page search",
        )
        self.context.register_web_api(
            f"/{PLUGIN_NAME}/page/filters",
            self._page_filters,
            ["GET"],
            "PriceFinder Page filter options",
        )

    async def _page_stats(self):
        """仪表盘统计信息"""
        if self.cache is None:
            return jsonify({"total_entries": 0, "total_queries": 0, "today_queries": 0, "active_users": 0})
        return jsonify(self.cache.get_stats())

    async def _page_search(self):
        """按条件搜索缓存结果

        Query 参数：
        - keyword:      搜索关键词（模糊匹配品牌/商品名/型号等）
        - price_source: 按价格来源精确筛选（如 "京东"）
        - time_range:   时间范围（today / 7d / 30d / all）
        """
        if self.cache is None:
            return jsonify([])

        # 读取 request query 参数
        filters = {}
        keyword = (request.args.get("keyword") or "").strip()
        price_source = (request.args.get("price_source") or "").strip()
        time_range = (request.args.get("time_range") or "").strip()

        # 关键词和价格来源传给 CacheManager 的文本匹配
        if keyword:
            filters["keyword"] = keyword
        if price_source:
            filters["price_source"] = price_source

        results = self.cache.get_all_results(filters)

        # 时间范围：CacheManager 未内置此筛选，在后端手动过滤
        # 86400 = 每天秒数，604800 = 7天，2592000 = 30天
        if time_range and time_range != "all":
            now = time.time()
            ranges = {"today": 86400, "7d": 604800, "30d": 2592000}
            cutoff = now - ranges.get(time_range, 0)
            results = [r for r in results if r["timestamp"] >= cutoff]

        return jsonify(results)

    async def _page_filters(self):
        """返回筛选器可选项"""
        if self.cache is None:
            return jsonify({"brands": [], "price_sources": [], "query_sources": []})
        return jsonify(self.cache.get_filter_options())

    @filter.command_group("price")
    def price(self):
        """价格搜索命令组入口"""
        pass

    @price.command("search")
    async def price_search(self, event: AstrMessageEvent, keyword: str = ""):
        """搜索慢慢买商品比价信息

        使用方式: /price search <关键词>

        Args:
            keyword: 搜索关键词
        """
        if not keyword:
            yield event.plain_result("用法: /price search <关键词>\n示例: /price search iPhone 16")
            return

        user_id = event.get_sender_id()
        results = await self._do_search(keyword, user_id)
        all_results = results.manmanbuy_results

        if all_results:
            output = self._format_output(results, keyword)
        else:
            output = f'🔍 搜索 "{keyword}" 未找到相关商品'

        yield event.plain_result(output)

    def _format_tool_output(self, results: list, keyword: str) -> str:
        """格式化 LLM Tool 的输出

        输出原始数据格式，由主 LLM 进行自然语言总结。

        Args:
            results: 过滤后的搜索结果列表
            keyword: 搜索关键词

        Returns:
            格式化的输出文本
        """
        lines = []
        for i, r in enumerate(results, 1):
            line = f"{i}. {r.title}"
            if r.price:
                line += f" | {r.price}"
            if r.price_source:
                line += f" | {r.price_source}"
            if r.history_low:
                line += f" | 历史低价: {r.history_low}"
            if r.url:
                line += f" | {r.url}"
            lines.append(line)
        return "\n".join(lines)

    @filter.llm_tool(name="search_prices")
    async def search_prices_tool(self, event: AstrMessageEvent, keyword: str):
        """搜索商品价格信息

        AI 自主调用的工具，从慢慢买抓取比价数据，
        经过 AI 过滤后返回精简的结果列表供主 LLM 分析和总结。

        Args:
            keyword(string): 商品关键词，如 "iPhone 16"、"机械键盘"、"显卡"
        """
        user_id = event.get_sender_id()
        results = await self._do_search(keyword, user_id)
        all_results = results.manmanbuy_results

        if not all_results:
            return f"搜索 \"{keyword}\" 未找到相关商品，请尝试其他关键词。"

        output = self._format_tool_output(all_results, keyword)
        return output
