# 更新日志

所有重要的更改都会记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
并且遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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

[0.2.0]: https://github.com/Past-Wind/astrbot_plugin_pricefinder/releases/tag/v0.2.0
[0.1.0]: https://github.com/Past-Wind/astrbot_plugin_pricefinder/releases/tag/v0.1.0
