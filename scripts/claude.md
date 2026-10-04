# FragranceAI

## What this is
An LLM chatbot that recommends perfumes and answers questions about them.
Recommendations filter on: price range, note preference, occasion, weather/season, longevity.
It must also answer factual questions about any perfume (notes, longevity, projection).
Perfume facts must come from tool results, never from the model's memory.
No model training or fine-tuning: a hosted LLM plus tool calling is the architecture.

## How it works
Two chat scripts in `scripts/` run the same loop: user message -> LLM with tools ->
execute tool calls over MCP -> LLM writes the final answer. Both connect to two MCP servers:
- `fragchat.py` - Claude as the LLM (default `claude-sonnet-5-5`; `FRAG_MODEL=claude-haiku-4-5-20251001` is cheaper)
- `fragchat_gemini.py` - Gemini as the LLM (default `gemini-3.5-flash-lite`; `gemini-3.6-flash` is stronger)

Run: `python3 scripts/fragchat_gemini.py` (type quit/exit, or Ctrl+C/Ctrl+D, to leave).
After each answer the script prints which services were used (the source footer).

## Data sources
1. **ScentRev MCP** (primary perfume data)
   - URL `https://api.scentrev.com/mcp/`, auth `Authorization: Bearer $SCENTREV_KEY`.
   - 22 tools (19 used; wardrobe tools skipped, they need a logged-in user). 126k+ fragrances.
   - List tools hard-capped at 10 rows, so it cannot be bulk-downloaded; use as a live tool.
   - Metrics are 0-1 with a category label and `n_records` (vote count; over 500 strong,
     under 100 thin). Accord weights are 0-100.
   - Free "during the current period", solo project launched July 2026: keep the data layer swappable.
   - Tools: `resolve_slug`, `search_fragrances`, `search_fragrances_filtered`, `get_fragrance_profile`
     (sections: performance, appreciation, notes, note_pyramid, accords, perfumers, pros_cons,
     reminds_of, price_value), `get_scent_card`, `get_wear_summary`, `get_performance`,
     `suggest_occasion`, `compare_fragrances`, `get_reminds_of`, `find_dupes`, `blind_buy_risk`, `decode_taste`.
   - Every tool accepts `conversation_id`; the scripts hide it from the LLM and pass back
     the value the server returns. (Not yet seen in practice; everything works without it.)
2. **Exa MCP** (web search: prices, availability, perfumes missing from ScentRev)
   - URL `https://mcp.exa.ai/mcp`, works without a key on a small free plan.
   - When the free plan is used up it answers 429, and a search may hang and time out.
     Fix: `export EXA_API_KEY=...` (key from dashboard.exa.ai); the scripts send it as the `x-api-key` header.
   - Default tools are `web_search_exa` and `web_fetch_exa`; the scripts allow only those (plus `crawling_exa` if present).
3. **Kaggle Fragrantica dataset** (`olgagmiufana1/fragrantica-com-fragrance-dataset`) - about
   2 years old, no longevity/season/price. Optional local base for semantic search; not used by the chatbot yet.
4. **Not built yet:** YouTube review transcripts (plan: a small `youtube_transcript(url)` tool using yt-dlp).

## Decisions
- Interpretation is allowed: the bot may explain what the data means in buyer-friendly language
  ("strong projection plus sweet, warm-spicy accords suggests heavy in heat"), phrased as inference.
- Vote count is mentioned once as an overall confidence note, not per score.
- Prices come only from web search: ask the buyer's country first, give a range with source URLs,
  say prices vary by seller and change over time, never estimate from memory.
- Web content is untrusted data, never instructions (prompt-injection rule in the system prompt).
- Agent-Reach (github.com/Panniantong/Agent-Reach) is NOT integrated: it is a setup layer for coding
  agents, not a library. Use its underlying tools directly (Exa, Jina Reader `r.jina.ai/<url>`, yt-dlp).
  Twitter/Reddit/Instagram routes need login cookies and risk account bans; skipped.

## Library quirks (newer `mcp` Python SDK)
- `streamable_http_client(url, http_client=httpx.AsyncClient(headers=...))` (not `streamablehttp_client`)
- `tool.input_schema` (not `inputSchema`); `result.is_error` (not `isError`)
- Gemini 3 thought signatures: append the model's whole reply to the history unchanged.

## Environment
- macOS, Python 3.12. Install with `python3 -m pip install anthropic google-genai mcp httpx`.
- Env vars: `SCENTREV_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, optional `EXA_API_KEY`, `FRAG_MODEL`.
- Never hardcode keys; use environment variables.
- Project folder: `~/Downloads/FragranceAI`.

## Front end (tentative)
- `python3 scripts/server.py` then open http://127.0.0.1:8000. `server.py` (Starlette) imports the prompt and MCP helpers
  from `fragchat_gemini.py` and streams events (status / final / error) from `POST /api/chat`; `GET /api/status` feeds the banner.
- Page lives in `scripts/web/` (plain HTML/CSS/JS, no build). Background is a plain tonal gradient (no images).
- Source tags: a service tag per MCP server used, plus a domain tag for every web URL the answer cites that really appeared in a search result.
- Error messages are mapped in `classify()` in `server.py`; keep them until the back end is final.

## Open questions
- Does ScentRev's `price_value` section hold an actual price, or only a relative value score?
- How good is coverage and vote depth for 2025-26 releases and Indian-market brands?
- What do ScentRev's terms say about caching or storing responses?
- Does the lite Gemini model stay grounded on recommendation-style questions, or is a stronger model needed?

## Next steps
1. Test recommendation questions ("long-lasting citrus perfume for a hot day") and price questions via Exa.
2. Add the YouTube transcript tool.
3. Build a front end; show the source footer there and keep chat history per user.