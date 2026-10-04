"""
Quick test of the ScentRev MCP server.

Setup:
    pip3 install mcp
    export SCENTREV_KEY=frag_live_...

Run:
    python3 test_scentrev.py            -> prints every tool and its input schema
    python3 test_scentrev.py call       -> also runs the test calls in CALLS below
"""
import asyncio
import json
import os
import sys

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

URL = "https://api.scentrev.com/mcp/"
KEY = os.environ["SCENTREV_KEY"]

# Edit these after step 1 shows you the real argument names for each tool.
# The argument names below are guesses; the printed schemas are the truth.
CALLS = [
    ("search_fragrances", {"query": "Creed Aventus"}),
    # ("get_fragrance_profile", {"slug": "..."}),
    # ("search_fragrances_filtered", {...}),
]


async def main() -> None:
    headers = {"Authorization": f"Bearer {KEY}"}
    async with httpx.AsyncClient(headers=headers, timeout=30) as http:
        async with streamable_http_client(URL, http_client=http) as streams:
            read, write = streams[0], streams[1]
            async with ClientSession(read, write) as session:
                await session.initialize()

                tools = (await session.list_tools()).tools
                print(f"{len(tools)} tools\n")
                for t in tools:
                    print(f"== {t.name}: {t.description}")
                    print(json.dumps(t.input_schema, indent=2), "\n")

                if len(sys.argv) > 1 and sys.argv[1] == "call":
                    for name, args in CALLS:
                        print(f"\n>>> {name}({args})")
                        result = await session.call_tool(name, args)
                        for block in result.content:
                            print(getattr(block, "text", block))


asyncio.run(main())