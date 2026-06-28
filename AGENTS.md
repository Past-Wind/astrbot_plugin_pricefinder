# AGENTS.md

## Project

AstrBot plugin — single-file Python plugin (`main.py`) loaded by the AstrBot host at runtime.
Not a standalone app; no `pyproject.toml`, no tests, no build step, no CI.

## Key files

- `main.py` — entire plugin implementation (~575 lines)
- `metadata.yaml` — plugin identity (name, version, author, repo URL); parsed by AstrBot's plugin loader
- `_conf_schema.json` — AstrBot config schema; defines all plugin settings with types, defaults, and hints
- `requirements.txt` — Python deps: httpx, beautifulsoup4, lxml
- `dev_docs/` — AstrBot plugin development reference docs (not plugin-specific)

## Plugin API

Imports come from `astrbot.api` — only available inside a running AstrBot host.

- `@register(name, author, desc, version)` — class decorator that registers the plugin
- `@filter.command_group("name")` / `@group.command("sub")` — registers async command handlers
- `@filter.llm_tool(name="...")` — registers an LLM tool that AI can call autonomously
- Handlers are `async def` methods that `yield event.plain_result(...)` (generator, not `return`)
- `event.message_str` — raw text; `event.get_sender_name()` — sender display name
- `Context` (injected via `__init__`) provides `get_provider_by_id()`, `get_using_provider()`, `get_all_embedding_providers()`
- `initialize()` / `terminate()` — async lifecycle hooks (httpx client setup/teardown lives here)

## Architecture

The plugin scrapes ManManBuy (慢慢买), a Chinese price-comparison site:
- URL: `https://s.manmanbuy.com/pc/search/result?c=discount&keyword={keyword}`
- CSS selectors: `.DiscountItemPC_box__m9G3M`, `.DiscountItemPC_itemTitle__hlI5m a`, `.DiscountItemPC_itemSubTitle__rWgWK a`, `.DiscountItemPC_itemMall__R8PlE`

Key subsystems in `main.py`:
- `CacheManager` — JSON file cache with TTL expiry + vector similarity search (cosine similarity over embeddings)
- `_ai_filter_results()` — LLM-based dedup/ranking; uses `provider.text_chat()` with a structured prompt
- `_get_embedding()` — vector embeddings for semantic cache lookup; falls back gracefully if no provider

Data flows: `command → _do_search() → cache check → HTTP fetch → parse → AI filter → format output`

## Conventions

- Plugin `name` in `metadata.yaml` must start with `astrbot_plugin_` per AstrBot convention (the `name` field omits the prefix; the repo name carries it)
- No lint/test/typecheck commands exist in this repo
- All command handlers use `yield event.plain_result(...)` — never `return` with a string
- Config values are read via `self.config.get("key", default)` — keys match `_conf_schema.json`
- HTTP requests use `httpx.AsyncClient` with configurable timeout, retry, and User-Agent
- Cache files are stored at `{astrbot_data_path}/plugin_data/pricefinder/`
- Language is Chinese throughout (UI strings, prompts, comments) — maintain consistency
