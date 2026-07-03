# AGENTS.md

## Project

AstrBot plugin — single-file Python plugin (`main.py`) loaded by the AstrBot host at runtime.
Not a standalone app; no `pyproject.toml`, no tests, no build step, no CI, no lint/typecheck commands.

## Key files

- `main.py` — entire plugin implementation (~960 lines)
- `metadata.yaml` — parsed by AstrBot's plugin loader; `name` field includes the `astrbot_plugin_` prefix
- `_conf_schema.json` — all plugin settings with types, defaults, hints
- `requirements.txt` — deps: httpx, beautifulsoup4, lxml
- `doc/` — AstrBot plugin development reference docs (not plugin-specific)
- `pages/dashboard/` — WebUI (`index.html` + `style.css` + `app.js`)
- `test/` — empty
- `.gitignore` — has `!AGENTS.md` at end; do not remove that line

## Plugin API

Imports from `astrbot.api` (register, filter, AstrMessageEvent, Context, Star, AstrBotConfig, logger),
except `initialize()` which also imports `get_astrbot_data_path` from `astrbot.core.utils.astrbot_path`.

- `@register(name, author, desc, version)` — class decorator
- `@filter.command_group("name")` / `@group.command("sub")` — command handlers: `async def` generators that `yield event.plain_result(...)`
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
- `CacheEntry`: query, user_id, timestamp, manmanbuy_results, embedding
- `CacheEntry.from_dict()` handles backward compat: old `store`→`price_source`, `source`→`query_source`, missing fields default to `""`

### Key subsystems

- `CacheManager` — JSON file cache (TTL expiry, LRU eviction) + linear cosine similarity vector search + stats tracking (`total_queries`, `get_stats()`, `get_all_results()`, `get_filter_options()`)
- `_ai_filter_results()` — LLM dedup/ranking via `provider.text_chat()`; parses response by matching URLs back to original `PriceResult` objects
- `_get_embedding()` — vector embeddings for semantic cache lookup; falls back gracefully if no embedding provider

### Data flow

Command: `command → _do_search() → cache check (exact + vector) → HTTP fetch → parse → AI filter → format output`
WebUI: `app.js → bridge.apiGet("page/search") → /{PLUGIN_NAME}/page/search → CacheManager.get_all_results()`

## WebUI

`pages/dashboard/` follows AstrBot Pages spec:
- Bridge: `window.AstrBotPluginPage`, init via `await bridge.ready()`
- API endpoints relative (e.g. `"page/stats"`), Dashboard auto-prefixes plugin name
- Backend routes registered as `/{PLUGIN_NAME}/page/{endpoint}` where `PLUGIN_NAME = "astrbot_plugin_pricefinder"`
- Theme support via CSS `:root` / `[data-theme="dark"]` variables
- Layout: sidebar filters → metrics → search bar → results table

## Conventions

- Language is Chinese throughout (UI strings, prompts, comments, cache files)
- HTTP via `httpx.AsyncClient` with configurable timeout, retry, User-Agent
- Cache files stored at `{astrbot_data_path}/plugin_data/pricefinder/`
- License: AGPL-3.0
