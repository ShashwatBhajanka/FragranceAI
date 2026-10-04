"""
Web front end for the Gemini perfume chatbot.

Reuses the prompt, server list and MCP helpers from fragchat_gemini.py and exposes
the same loop (user message -> LLM with tools -> MCP tool calls -> final answer) over HTTP.

Run (needs the same packages and env vars as fragchat_gemini.py, plus starlette/uvicorn,
which come with `mcp`):
    python3 scripts/server.py
    open http://127.0.0.1:8000

Endpoints:
    GET  /api/status   health of the data services (the page shows this as a banner)
    POST /api/chat     {session_id, message} -> newline-delimited JSON events:
                         {"type":"status","text":...}   progress while the model works
                         {"type":"final","text":...,"sources":{...}}
                         {"type":"error","code":...,"message":...,"detail":...}
    POST /api/reset    {session_id} -> forget that conversation
"""
import asyncio
import json
import os
import re
import sys
from contextlib import AsyncExitStack, asynccontextmanager
from pathlib import Path
from urllib.parse import urlparse

import httpx
import uvicorn
from starlette.applications import Starlette
from starlette.responses import JSONResponse, StreamingResponse
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))

LLM_TIMEOUT = 90
TOOL_TIMEOUT = 45
MAX_STEPS = 10
MAX_MESSAGE_CHARS = 4000

# Where each service's name links to, for the clickable source tags.
SERVICE_LINKS = {
    "scentrev": ("ScentRev", "https://scentrev.com"),
    "exa": ("Web search", "https://exa.ai"),
}

S = {"problem": None, "ready": False, "model": None, "services": {}}
SESSIONS: dict[str, dict] = {}


def friendly_status(name: str, args: dict) -> str:
    """One plain sentence for the loading line; never shows raw tool names or JSON."""
    q = args.get("query") or args.get("name") or args.get("q") or ""
    q = f" for “{str(q)[:50]}”" if q else ""
    if name in {"web_search_exa", "web_fetch_exa", "crawling_exa"}:
        return "Searching the web" + q
    if name in {"search_fragrances", "search_fragrances_filtered", "resolve_slug"}:
        return "Looking up perfumes" + q
    if name in {"get_performance", "get_wear_summary"}:
        return "Checking longevity and projection"
    if name in {"get_fragrance_profile", "get_scent_card"}:
        return "Reading notes and accords"
    if name in {"compare_fragrances"}:
        return "Comparing the fragrances"
    if name in {"find_dupes", "get_reminds_of"}:
        return "Finding similar scents"
    if name == "suggest_occasion":
        return "Matching to the occasion"
    return "Checking the fragrance data"


def classify(e: Exception) -> tuple[str, str]:
    """Map an exception to (code, message a buyer can act on)."""
    code = getattr(e, "code", None)
    text = str(e)
    if isinstance(e, asyncio.TimeoutError):
        return "timeout", "The answer is taking longer than expected. Please try again in a moment."
    if code == 429 or "RESOURCE_EXHAUSTED" in text:
        return "rate_limited", "The assistant is getting too many requests right now. Wait a minute and try again."
    if code in (401, 403) or "API key" in text:
        return "llm_auth", "The assistant could not sign in to its language model. The API key may be missing or invalid."
    if isinstance(code, int) and code >= 500:
        return "llm_unavailable", "The language model is temporarily unavailable. Please try again shortly."
    if isinstance(e, (httpx.ConnectError, httpx.ReadError, OSError)):
        return "network", "Could not reach the network. Check your connection and try again."
    return "unknown", "Something went wrong while preparing your answer. Please try again."


URL_RE = re.compile(r"https?://[^\s\"'<>\]\)]+")


def clean_url(u: str) -> str:
    return u.rstrip(".,;:!?")


def extract_urls(text: str) -> set[str]:
    return {clean_url(u) for u in URL_RE.findall(text or "")}


@asynccontextmanager
async def lifespan(app):
    missing = [k for k in ("SCENTREV_KEY", "GEMINI_API_KEY") if not os.environ.get(k)]
    if missing:
        S["problem"] = {
            "code": "config",
            "message": "Not configured yet. Missing environment variable: " + ", ".join(missing) + ".",
        }
        yield
        return

    async with AsyncExitStack() as stack:
        try:
            import fragchat_gemini as fg
            from google import genai
            from google.genai import types

            print("Connecting to data services...")
            owner, mcp_tools = await fg.connect_all(stack)
            connected = {srv for srv, _ in owner.values()}
            S["services"] = {s["name"]: s["name"] in connected for s in fg.SERVERS}

            if "scentrev" not in connected:
                S["problem"] = {
                    "code": "no_perfume_data",
                    "message": "The perfume database (ScentRev) could not be reached, so answers are unavailable. Check the key and try again.",
                }
            else:
                takes_cid, declarations = set(), []
                for t in mcp_tools:
                    schema = json.loads(json.dumps(t.input_schema))
                    props = schema.get("properties", {})
                    if "conversation_id" in props:
                        takes_cid.add(t.name)
                        props.pop("conversation_id")
                    declarations.append(
                        types.FunctionDeclaration(
                            name=t.name,
                            description=t.description or "",
                            parameters_json_schema=fg.strip_defaults(schema),
                        )
                    )
                S.update(
                    fg=fg,
                    types=types,
                    llm=genai.Client(api_key=os.environ["GEMINI_API_KEY"]),
                    owner=owner,
                    takes_cid=takes_cid,
                    model=fg.MODEL,
                    config=types.GenerateContentConfig(
                        system_instruction=fg.SYSTEM,
                        tools=[types.Tool(function_declarations=declarations)],
                        automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
                    ),
                    ready=True,
                )
                print(f"Ready: {len(declarations)} tools. Model: {fg.MODEL}")
        except Exception as e:  # keep the page up so it can show the reason
            _, msg = classify(e)
            S["problem"] = {"code": "startup", "message": f"Startup failed: {msg}", "detail": str(e)[:300]}
            print("Startup failed:", e)
        yield


def event(**kw) -> bytes:
    return (json.dumps(kw, ensure_ascii=False) + "\n").encode()


async def run_turn(session: dict, user_text: str):
    """Yield events for one user message. Rolls the history back if the turn fails."""
    fg, types, llm = S["fg"], S["types"], S["llm"]
    contents = session["contents"]
    mark = len(contents)
    contents.append(types.Content(role="user", parts=[types.Part(text=user_text)]))

    used_servers: set[str] = set()
    seen_urls: set[str] = set()
    try:
        yield event(type="status", text="Thinking it through")
        for _ in range(MAX_STEPS):
            resp = None
            for attempt in (1, 2):
                try:
                    resp = await asyncio.wait_for(
                        llm.aio.models.generate_content(model=S["model"], contents=contents, config=S["config"]),
                        LLM_TIMEOUT,
                    )
                    break
                except Exception as e:
                    code = getattr(e, "code", None)
                    if attempt == 1 and isinstance(code, int) and code >= 500:
                        await asyncio.sleep(1.5)
                        continue
                    raise
            if not resp.candidates or not resp.candidates[0].content:
                raise RuntimeError("The model returned no content")
            # Keep the reply unchanged (Gemini 3 thought signatures).
            contents.append(resp.candidates[0].content)

            calls = resp.function_calls
            if not calls:
                text = (resp.text or "").strip()
                if not text:
                    del contents[mark:]
                    yield event(
                        type="error",
                        code="empty_reply",
                        message="The assistant did not produce an answer. Please try asking again.",
                    )
                    return
                links = []
                for u in extract_urls(text):
                    if u in seen_urls:  # only cite links that really came from a search result
                        host = urlparse(u).netloc.removeprefix("www.")
                        links.append({"label": host, "url": u})
                services = [
                    {"label": SERVICE_LINKS[s][0], "url": SERVICE_LINKS[s][1]}
                    for s in ("scentrev", "exa")
                    if s in used_servers
                ]
                yield event(type="final", text=text, sources={"services": services, "links": links})
                return

            response_parts = []
            for fc in calls:
                args = dict(fc.args or {})
                yield event(type="status", text=friendly_status(fc.name, args))
                if fc.name not in S["owner"]:
                    out, is_error = f"Unknown tool: {fc.name}", True
                else:
                    server, mcp_session = S["owner"][fc.name]
                    if fc.name in S["takes_cid"] and session["cid"]:
                        args["conversation_id"] = session["cid"]
                    try:
                        result = await asyncio.wait_for(mcp_session.call_tool(fc.name, args), TOOL_TIMEOUT)
                        out = "\n".join(getattr(c, "text", str(c)) for c in result.content)
                        is_error = bool(getattr(result, "is_error", False))
                    except Exception as e:
                        out, is_error = f"Tool call failed: {e or type(e).__name__}", True
                    if not is_error:
                        used_servers.add(server)
                        if server == "exa":
                            seen_urls |= extract_urls(out)
                        if server == "scentrev":
                            cid = fg.find_conversation_id(out)
                            if cid:
                                session["cid"] = cid
                key = "error" if is_error else "output"
                response_parts.append(
                    types.Part.from_function_response(name=fc.name, response={key: out[: fg.MAX_RESULT_CHARS]})
                )
            contents.append(types.Content(role="user", parts=response_parts))

        del contents[mark:]
        yield event(
            type="error",
            code="too_many_steps",
            message="That question needed more lookups than allowed. Try asking about one perfume or one need at a time.",
        )
    except asyncio.CancelledError:
        del contents[mark:]
        raise
    except Exception as e:
        del contents[mark:]
        code, msg = classify(e)
        print("Turn failed:", repr(e))
        yield event(type="error", code=code, message=msg, detail=str(e)[:300])


async def status(request):
    return JSONResponse(
        {"ok": S["ready"], "problem": S["problem"], "model": S["model"], "services": S["services"]}
    )


async def chat(request):
    try:
        body = await request.json()
        sid = str(body["session_id"])[:64]
        text = str(body["message"]).strip()
    except Exception:
        return JSONResponse({"code": "bad_request", "message": "That message could not be read."}, status_code=400)
    if not text:
        return JSONResponse({"code": "empty", "message": "Type a question first."}, status_code=400)
    if len(text) > MAX_MESSAGE_CHARS:
        return JSONResponse(
            {"code": "too_long", "message": f"Please keep messages under {MAX_MESSAGE_CHARS} characters."},
            status_code=400,
        )
    if not S["ready"]:
        problem = S["problem"] or {"code": "starting", "message": "The assistant is still starting up."}
        return JSONResponse(problem, status_code=503)

    session = SESSIONS.setdefault(sid, {"contents": [], "cid": None, "lock": asyncio.Lock()})
    if session["lock"].locked():
        return JSONResponse(
            {"code": "busy", "message": "Still working on your previous question."}, status_code=409
        )

    async def stream():
        async with session["lock"]:
            async for ev in run_turn(session, text):
                yield ev

    return StreamingResponse(stream(), media_type="application/x-ndjson", headers={"Cache-Control": "no-store"})


async def reset(request):
    try:
        body = await request.json()
        SESSIONS.pop(str(body["session_id"])[:64], None)
    except Exception:
        pass
    return JSONResponse({"ok": True})


app = Starlette(
    routes=[
        Route("/api/status", status),
        Route("/api/chat", chat, methods=["POST"]),
        Route("/api/reset", reset, methods=["POST"]),
        Mount("/", StaticFiles(directory=HERE / "web", html=True)),
    ],
    lifespan=lifespan,
)

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("PORT", "8000")), log_level="warning")
