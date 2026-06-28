# 更新日志

所有重要的更改都会记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
并且遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.0.0] - 2026-06-28

### 新增
- 商品比价搜索：从慢慢买 (ManManBuy) 抓取商品价格信息，包含标题、价格、商城、链接
- 智能缓存：JSON 文件缓存 + TTL 过期自动清理 + LRU 淘汰策略
- 向量语义搜索：余弦相似度匹配，即使关键词不完全匹配也能找到相似缓存
- AI 结果过滤：LLM 对搜索结果去重、排序、过滤，提升结果质量
- LLM Tool：AI 可自主调用 `search_prices` 工具查询商品价格
- 命令支持：`/price search <关键词>` 搜索商品比价信息

[1.0.0]: https://github.com/Past-Wind/astrbot_plugin_pricefinder/releases/tag/v1.0.0
