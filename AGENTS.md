# AGENTS.md

## Project

AstrBot plugin — single-file Python plugin (`main.py`) loaded by the AstrBot host at runtime.
Not a standalone app; no `pyproject.toml`, no tests, no build step, no CI, no lint/typecheck commands.

## Key files

- `main.py` — entire plugin implementation (~1734 lines)
- `metadata.yaml` — parsed by AstrBot's plugin loader; `name` field includes the `astrbot_plugin_` prefix
- `_conf_schema.json` — all plugin settings with types, defaults, hints
- `requirements.txt` — deps: httpx, beautifulsoup4, lxml
- `doc/` — AstrBot plugin development reference docs (not plugin-specific)
- `pages/dashboard/` — WebUI: single-page app with two tabs (index.html + style.css + app.js)
- `test/` — dashboard preview HTML files (not automated tests)
- `.gitignore` — has `!AGENTS.md` at end; do not remove that line; opencode config patterns also ignored
- `CHANGELOG.md` — follow Keep a Changelog format with `[version]` link refs at bottom

## Plugin API

Imports from `astrbot.api` (register, filter, AstrMessageEvent, Context, Star, AstrBotConfig, logger),
except `initialize()` which also imports `get_astrbot_data_path` from `astrbot.core.utils.astrbot_path`.

- `@register(name, author, desc, version)` — class decorator
- `@filter.command_group("name")` / `@group.command("sub")` — command handlers: `async def` generators that `yield event.plain_result(...)`
- `@filter.command("name")` — top-level command handlers (not nested in command_group); used for standalone commands like `我的收藏`
- `@filter.llm_tool(name="...")` — LLM tool handlers: `async def` that `return` a string (not `yield`)
- `event.message_str` — raw text; `event.get_sender_id()` — user ID; `event.get_sender_name()` — display name
- `Context` provides `get_provider_by_id()`, `get_using_provider()`, `get_all_embedding_providers()`, `register_web_api()`
- `initialize()` / `terminate()` — async lifecycle hooks (httpx client setup/teardown + web API registration)
- Config read via `self.config.get("key", default)` matching `_conf_schema.json`
- Web API handlers use `from quart import jsonify, request`; routes registered via `context.register_web_api(path, handler, methods, desc)`

## Architecture

Scrapes [慢慢买 (ManManBuy)](https://s.manmanbuy.com/pc/search/result?c=discount&keyword={keyword}).
CSS selectors use `DiscountItemPC_*` class names (CSS modules hashes — brittle, break on site updates):
`.DiscountItemPC_box__m9G3M`, `.DiscountItemPC_itemTitle__hlI5m a`, `.DiscountItemPC_itemSubTitle__rWgWK a`, `.DiscountItemPC_itemMall__R8PlE`.

### Data model

- `PriceResult`: title, brand, product_name, model, price, price_source (商店), url, query_source (数据来源), history_low
- `FavoriteItem`: user_id, title, brand, product_name, model, price, price_source, url, query_source, history_low, created_at — stored in `favorites.json`
- `CacheEntry`: query, user_id, timestamp, manmanbuy_results, embedding
- `CacheEntry.from_dict()` handles backward compat: old `store`→`price_source`, `source`→`query_source`, missing fields default to `""`

### Key subsystems

- `CacheManager` — JSON file cache (TTL expiry, LRU eviction) + linear cosine similarity vector search + stats tracking (`total_queries`, `get_stats()`, `get_all_results()`, `get_filter_options()`)
- `FavoritesManager` — `favorites.json` persistent storage (add/remove/list per user, get_all with keyword/user/time filters, get_filter_options)
- `HistoryHelper` — read-only query history from `CacheManager.entries` filtered by `user_id`
- `_ai_filter_and_structure()` — LLM dedup/ranking + brand/product/model extraction via `provider.text_chat()`; parses response by matching URLs back to original `PriceResult` objects
- `_filter_price_outliers()` — statistical price anomaly detection (IQR-based, configurable threshold ratios)
- `_is_combo_product()` / `_is_multi_product_listing()` — combo/multi-item filtering (板U套装, 整机, etc.)
- `_clean_result_fields()` — post-LLM field cleanup (SEO keyword stripping, brand redundancy repair)
- `_get_embedding()` — vector embeddings for semantic cache lookup; falls back gracefully if no embedding provider
- `_log(level)` — unified debug logging; `level="info"` always outputs, `level="debug"` only when `debug_settings.debug_enabled` is true; uses `logger.info` with prefix

### Data flow

Command: `command → _do_search() → cache check (exact + vector) → HTTP fetch → parse → AI filter+structure → cache → format output`
(LLM filter runs once before caching; subsequent hits return pre-filtered results.)
WebUI: `app.js → ApiClient.get("search") → /{PLUGIN_NAME}/page/search → CacheManager.get_all_results()`

### Commands

| Command | Handler |
|---------|---------|
| `/price` / `/price help` | Returns `HELP_TEXT` (module-level constant) |
| `/price search <keyword>` | `price_search` — saves results to `self._last_search[user_id]` for fav lookup |
| `/price history` | Reads history via `HistoryHelper.get_user_history(cache, user_id)` |
| `/price fav add <N>` | Indexes into `self._last_search[user_id]`, calls `self.favorites.add()` |
| `/price fav list` | `self.favorites.list_by_user(user_id)` |
| `/price fav remove <N>` | `self.favorites.remove(user_id, idx)` |
| `我的收藏` | Top-level `@filter.command("我的收藏")`, same as fav list |
| `取消收藏 <N>` | Top-level `@filter.command("取消收藏")`, same as fav remove |

## WebUI

`pages/dashboard/` follows AstrBot Pages spec — two tabs in one page via `<section class="page">` switching:
- **商品比价** (default): search via `/page/search`, stats via `/page/stats`, filters via `/page/filters`
- **收藏夹**: favorites via `/page/favorites`, filters via `/page/favorites-filters`

Shared features across all tabs:
- Bridge: `window.AstrBotPluginPage`, init via `await bridge.ready()`
- API endpoints relative (e.g. `"page/stats"`), Dashboard auto-prefixes plugin name
- Backend routes registered as `/{PLUGIN_NAME}/page/{endpoint}` where `PLUGIN_NAME = "astrbot_plugin_pricefinder"`
- Theme support via CSS `:root` / `[data-theme="dark"]` variables
- Layout per tab: stats → search bar → sidebar filters → results table
- Debug toggle calls GET/POST `/page/debug-config`
- Global scrollbar dark-mode immersion via `::-webkit-scrollbar` and `scrollbar-color`

## Conventions

- Language is Chinese throughout (UI strings, prompts, comments, cache files)
- HTTP via `httpx.AsyncClient` with configurable timeout, retry, User-Agent
- Cache files stored at `{astrbot_data_path}/plugin_data/pricefinder/`
- License: AGPL-3.0
