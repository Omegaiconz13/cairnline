#!/usr/bin/env python3
"""
Deterministic OpenAI-compatible model, for offline verification only.

DEV ONLY. It is not a model. It exists so the Hermes gateway can be exercised end to end
(API server → agent loop → tool bridge → MCP server → answer) on a machine with no
provider key. It walks a fixed script: search the deferred tool catalogue, call the
first market tool it finds, then summarise what came back.

    TRISH_DEV_FAKE_MODEL=1 python3 tools/fake_model.py [port]     # default 8801

It refuses to start without that variable, because a runtime pointed at :8801 would
otherwise be silently answering with canned text. The app never imports this file and
never starts it; the engine card shows a red DEV warning whenever a model resolves to
this port. Verification only.
"""
from __future__ import annotations

import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8801
TOOLS_LOG = "/tmp/cairnline-fake-model-tools.json"
TRACE_LOG = "/tmp/cairnline-fake-model-trace.jsonl"


def _fn(tool: dict) -> dict:
    return tool.get("function") or tool


def _names(tools):
    return [_fn(t).get("name") for t in tools or []]


def _last_tool_content(messages):
    for m in reversed(messages):
        if m.get("role") == "tool":
            return str(m.get("content") or "")
    return ""


def _pick_market_tool(text: str) -> str | None:
    """Find a Cairnline market tool name in a tool_search / tool_describe payload."""
    for name in ("get_indicators", "get_quote", "get_signals"):
        for candidate in (f"mcp__cairnline__{name}", name):
            if candidate in text:
                return candidate
    return None


def _plan(messages, tools):
    """Return (kind, tool_name, args) — kind is 'tool' or 'text'."""
    tool_msgs = [m for m in messages if m.get("role") == "tool"]
    last = _last_tool_content(messages)
    if last:
        try:
            with open("/tmp/cairnline-fake-model-result.txt", "w") as fh:
                fh.write(last)
        except OSError:
            pass

    if not tool_msgs:
        if "tool_search" in _names(tools):
            return "tool", "tool_search", {"queries": ["cairnline indicators", "cairnline quote"]}
        return "text", "Stub model: no tools were offered.", None

    target = _pick_market_tool(last)
    if len(tool_msgs) == 1 and target:
        return "tool", "tool_describe", {"names": [target]}
    if len(tool_msgs) == 2 and target:
        return "tool", "tool_call", {"calls": [{"name": target,
                                                "arguments": {"symbol": "EURUSD", "interval": "1h"}}]}
    return "text", f"Stub model. Last tool payload: {last[:900]}", None


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        sys.stderr.write("[fake-model] " + (fmt % args) + "\n")

    def do_GET(self):  # noqa: N802
        if self.path.rstrip("/").endswith("/models"):
            return self._json(200, {"object": "list", "data": [
                {"id": "stub", "object": "model", "created": 0, "owned_by": "cairnline"}]})
        return self._json(404, {"error": {"message": "not found"}})

    def do_POST(self):  # noqa: N802
        if not self.path.rstrip("/").endswith("/chat/completions"):
            return self._json(404, {"error": {"message": "not found"}})
        length = int(self.headers.get("Content-Length") or 0)
        req = json.loads(self.rfile.read(length) or b"{}")
        messages = req.get("messages") or []
        tools = req.get("tools") or []

        with open(TOOLS_LOG, "w") as fh:
            json.dump(tools, fh, indent=1)
        with open(TRACE_LOG, "a") as fh:
            fh.write(json.dumps({"roles": [m.get("role") for m in messages],
                                 "tools": _names(tools)}) + "\n")

        kind, a, b = _plan(messages, tools)
        if kind == "tool":
            message = {"role": "assistant", "content": "", "tool_calls": [{
                "id": "call_1", "type": "function",
                "function": {"name": a, "arguments": json.dumps(b)}}]}
            finish = "tool_calls"
        else:
            message = {"role": "assistant", "content": a}
            finish = "stop"

        if req.get("stream"):
            return self._sse(message, finish)
        return self._json(200, {
            "id": "fake", "object": "chat.completion", "model": "stub",
            "choices": [{"index": 0, "finish_reason": finish, "message": message}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        })

    def _sse(self, message: dict, finish: str):
        delta = {"role": "assistant"}
        if message.get("content"):
            delta["content"] = message["content"]
        if message.get("tool_calls"):
            delta["tool_calls"] = message["tool_calls"]
        chunks = [
            {"id": "fake", "object": "chat.completion.chunk", "model": "stub",
             "choices": [{"index": 0, "delta": delta, "finish_reason": None}]},
            {"id": "fake", "object": "chat.completion.chunk", "model": "stub",
             "choices": [{"index": 0, "delta": {}, "finish_reason": finish}],
             "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}},
        ]
        # One Content-Length keeps the body a well-formed HTTP/1.1 response; the
        # client reads it as an SSE stream regardless of how it arrived.
        body = "".join(f"data: {json.dumps(c)}\n\n" for c in chunks) + "data: [DONE]\n\n"
        payload = body.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)
        self.wfile.flush()


if __name__ == "__main__":
    if os.environ.get("TRISH_DEV_FAKE_MODEL") != "1":
        print("refusing to start: this is a deterministic dev double, not a model.\n"
              "Set TRISH_DEV_FAKE_MODEL=1 to run it on purpose.", file=sys.stderr)
        raise SystemExit(2)
    print(f"DEV ONLY fake provider on http://127.0.0.1:{PORT}/v1 — not a model.", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
