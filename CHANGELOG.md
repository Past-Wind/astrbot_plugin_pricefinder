# 更新日志

所有重要的更改都会记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
并且遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.0.0] - 2026-06-27

### 新增
- 商品比价搜索：从慢慢买抓取商品价格信息
- 智能缓存：支持 TTL 过期自动清理
- 向量语义搜索：支持缓存语义相似匹配
- AI 结果过滤：LLM 去重、排序、过滤搜索结果
- LLM Tool：AI 可自主调用 search_prices 工具

### 变更
- AI 过滤器提供商选择器从文本输入改为下拉选择（select_provider）
- README 英文标题翻译为中文
- LLMTool 输出改为将过滤后的内容传递给主 LLM 处理

### 移除
- 移除搜索设置中"启用慢慢买搜索"开关，搜索始终执行

[1.0.0]: https://github.com/Past-Wind/astrbot_plugin_pricefinder/releases/tag/v1.0.0
