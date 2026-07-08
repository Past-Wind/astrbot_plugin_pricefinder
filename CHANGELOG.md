# 更新日志

所有重要的更改都会记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
并且遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.1] - 2026-07-08

### Added
- 多商品列表页预过滤：`_is_multi_product_listing()` 检测单链接含 ≥3 个品牌或 ≥4 个斜杠型号变体的通用列表页，LLM 调用前剔除
- 套装/组合商品预过滤：`_is_combo_product()` 识别板U套装、准系统、整机等标题；`_is_combo_search()` 判断用户意图，搜索"套装"时自动跳过过滤
- 价格异常过滤：`_filter_price_outliers()` 提取纯数字价格后按中位数统计法剔除离群值，配置项 `price_outlier_lower_ratio`(默认 0.3) / `price_outlier_upper_ratio`(默认 3.0) 自定义上下界
- 模块常量 `_KNOWN_BRANDS`（24 个品牌白名单 frozenset）和 `_COMBO_KEYWORDS`（13 个套装关键词列表）
- `_clean_result_fields()` 后处理清洗函数（调用处已注释，预留 SEO 黑名单和品牌冗余修正逻辑）
- `_conf_schema.json` 新增 `filter_combo_products`、`price_outlier_filter_enabled`、`price_outlier_lower_ratio`、`price_outlier_upper_ratio` 配置项

### Changed
- `_ai_filter_and_structure` prompt 重写：新增 PC 硬件品类（显卡/CPU/主板套装）字段提取规则，附带 4 个正确 vs 错误对比示例
- 阶段0 预过滤块重构：从单步列表页检测扩展为三步链式（0a 列表页 → 0b 套装 → 0c 价格异常），各阶段独立日志

## [0.2.0] - 2026-07-04

### Added
- WebUI 仪表盘：支持按品牌/价格范围/日期筛选、排序、分页浏览缓存数据
- 后端 Web API：`/page/stats`、`/page/search`、`/page/filters` 三个端点
- 数据模型扩展：`PriceResult` 新增 `brand`、`product_name`、`model` 字段
- 用户追踪：`CacheEntry` 新增 `user_id` 字段，记录查价用户
- 缓存统计：`CacheManager` 新增全局查询计数器、`get_stats()`、`get_all_results()`
- LLM 结构化提取：AI 过滤时自动提取品牌方/商品名/详细型号
- LLM 无关结果过滤：搜索时剔除语义不相关的商品（如搜索 iPhone 剔除安卓配件）
- 亮/暗主题切换：CSS 变量驱动，跟随 AstrBot WebUI 自动同步
- Toast 通知：操作结果实时反馈
- 日期密度可视化：GitHub 风格色阶显示各日期查询热度
- 完整的代码中文注释

### Changed
- **破坏性**: `PriceResult.store` → `price_source`、`source` → `query_source`（旧缓存自动迁移）
- **破坏性**: LLM 过滤从搜索后执行改为搜索时执行（过滤结果写入缓存，后续命中零 LLM 消耗）
- `_ai_filter_results` 替换为 `_ai_filter_and_structure`，同时完成过滤和结构化
- `_parse_ai_response` 升级为 `_parse_ai_response_structured`，支持 7 列解析
- 命令和 LLM Tool 传递 `event.get_sender_id()` 到缓存
- `CacheEntry.from_dict()` 自动兼容旧版缓存字段命名

## [0.1.0] - 2026-06-27

### Added
- 商品比价搜索：从慢慢买抓取商品价格信息
- 智能缓存：支持 TTL 过期自动清理
- 向量语义搜索：支持缓存语义相似匹配
- AI 结果过滤：LLM 去重、排序、过滤搜索结果
- LLM Tool：AI 可自主调用 search_prices 工具

### Changed
- AI 过滤器提供商选择器从文本输入改为下拉选择（select_provider）
- README 英文标题翻译为中文
- LLMTool 输出改为将过滤后的内容传递给主 LLM 处理

### Removed
- 移除搜索设置中"启用慢慢买搜索"开关，搜索始终执行

[0.2.1]: https://github.com/Past-Wind/astrbot_plugin_pricefinder/releases/tag/v0.2.1
[0.2.0]: https://github.com/Past-Wind/astrbot_plugin_pricefinder/releases/tag/v0.2.0
[0.1.0]: https://github.com/Past-Wind/astrbot_plugin_pricefinder/releases/tag/v0.1.0
