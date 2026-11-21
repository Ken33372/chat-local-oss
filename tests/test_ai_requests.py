import asyncio
import importlib.util
import json
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch


ROOT = Path(__file__).resolve().parents[1]


def usage(input_tokens=0, output_tokens=0):
    return {
        "input_tokens": input_tokens,
        "cache_creation_input_tokens": 0,
        "cache_read_input_tokens": 0,
        "output_tokens": output_tokens,
    }


def response(input_tokens, output_tokens, tool=None):
    events = [{"type": "message_start", "message": {"usage": usage(input_tokens)}}]
    if tool:
        events.extend([
            {"type": "content_block_start", "index": 0, "content_block": {
                "type": "tool_use", "id": "call", "name": tool, "input": {},
            }},
            {"type": "content_block_delta", "index": 0, "delta": {
                "type": "input_json_delta", "partial_json": '{"url":"https://example.com"}',
            }},
            {"type": "content_block_stop", "index": 0},
        ])
    events.extend([
        {"type": "message_delta", "delta": {"stop_reason": "tool_use" if tool else "end_turn"},
         "usage": {"output_tokens": output_tokens}},
        {"type": "message_stop"},
    ])
    return events


class RequestTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        config = types.ModuleType("config")
        config.LLM_BASE_URL = "http://model.invalid"
        config.LLM_MODEL = "test-model"
        config.LLM_MAX_OUTPUT_TOKENS = 512
        config.MAX_TOOL_ROUNDS = 1
        config.MEMORY_ENABLED = False
        config.MEMORY_TOOLS = False
        config.IMAGE_PARSER = "vision"
        config.capabilities = lambda: {"search": True}
        memory = types.ModuleType("memory")
        memory.MAX_TEXT = 800
        memory.MAX_DESCRIPTION = 30
        memory.injection = lambda text: ("", set())
        memory.TOOL_NAMES = {"search_memory", "remember", "edit_memory"}
        prompts = types.ModuleType("prompts")
        prompts.active_text = lambda: ""
        providers = types.ModuleType("providers")
        providers.extract = types.ModuleType("providers.extract")
        providers.ocr = types.ModuleType("providers.ocr")
        providers.llm = types.ModuleType("providers.llm")
        providers.llm.LLMError = RuntimeError
        providers.search = types.ModuleType("providers.search")
        providers.search.is_searxng = lambda: False
        ledger = types.ModuleType("usage")
        ledger._count = lambda value: max(0, int(value or 0))
        ledger.record = Mock(return_value={"recorded": True})
        modules = {"config": config, "memory": memory, "prompts": prompts,
                   "providers": providers, "storage": types.ModuleType("storage"), "usage": ledger}
        with patch.dict(sys.modules, modules):
            spec = importlib.util.spec_from_file_location("audit_ai", ROOT / "server" / "ai.py")
            self.ai = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(self.ai)
        self.ai._prepare_messages = AsyncMock(return_value=([{"role": "user", "content": "hello"}], ""))
        self.ai._system_prompt = lambda *args, **kwargs: "test"
        self.ai._execute_tool = AsyncMock(return_value=(
            {"type": "web_fetch_tool_result", "content": {}, "kind": "read_link"}, "page"
        ))
        self.ai._execute_memory_tool = Mock()
        self.request = types.SimpleNamespace(is_disconnected=AsyncMock(return_value=False))
        self.payloads = []
        self.closed_streams = 0
        self.ledger = ledger

    def upstream(self, scripts):
        pending = iter(scripts)

        async def stream(payload, session=""):
            self.payloads.append(payload)
            try:
                for event in next(pending):
                    if isinstance(event, BaseException):
                        raise event
                    yield event
            finally:
                self.closed_streams += 1

        self.ai.llm.stream = stream

    async def consume(self, **options):
        generator = await self.ai.stream_chat({"messages": [], "session_id": "session", **options}, self.request)
        return [event async for event in generator]

    async def test_all_rounds_recorded_but_context_remains_last_round(self):
        self.upstream([response(10, 3, "read_url"), response(20, 4)])
        events = await self.consume()
        record = self.ledger.record.call_args.args[0]
        self.assertEqual(record["usage"], usage(30, 7))
        self.assertEqual(record["model"], "test-model")
        self.assertEqual(record["session_id"], "session")
        self.assertEqual(record["mode"], "local")
        self.ledger.record.assert_called_once()
        final = next(json.loads(event.split("data: ", 1)[1]) for event in events if "event: message_delta" in event)
        self.assertEqual(final["usage"], usage(20, 4))
        self.assertNotIn("tools", self.payloads[1])

    async def test_tool_limit_does_not_execute_extra_round(self):
        self.upstream([response(10, 3, "read_url"), response(20, 4, "read_url")])
        events = await self.consume(max_tool_rounds=1)
        self.ai._execute_tool.assert_awaited_once()
        self.assertTrue(any("工具调用次数已达上限" in event for event in events))
        self.assertEqual(self.ledger.record.call_args.args[0]["usage"], usage(30, 7))

    async def test_search_toggle_keeps_read_url_available(self):
        self.upstream([response(10, 3, "read_url"), response(20, 4)])
        events = await self.consume(search=False)
        self.ai._execute_tool.assert_awaited_once()
        self.assertFalse(any("event: error" in event for event in events))
        self.assertEqual(self.ledger.record.call_args.args[0]["usage"], usage(30, 7))

    async def test_disabled_search_tool_is_skipped_without_failing(self):
        self.upstream([response(10, 3, "web_search"), response(20, 4)])
        events = await self.consume(search=False)
        self.ai._execute_tool.assert_not_awaited()
        self.assertFalse(any("event: error" in event for event in events))
        result = self.payloads[1]["messages"][-1]["content"][0]["content"]
        self.assertIn("未启用", result)
        self.assertEqual(self.ledger.record.call_args.args[0]["usage"], usage(30, 7))

    async def test_disabled_memory_tool_is_skipped_without_failing(self):
        self.upstream([response(10, 3, "remember"), response(20, 4)])
        events = await self.consume()
        self.ai._execute_memory_tool.assert_not_called()
        self.ai._execute_tool.assert_not_awaited()
        self.assertFalse(any("event: error" in event for event in events))
        self.assertEqual(self.ledger.record.call_args.args[0]["usage"], usage(30, 7))

    async def test_failed_later_round_preserves_known_usage(self):
        self.upstream([
            response(10, 3, "read_url"),
            [{"type": "message_start", "message": {"usage": usage(20)}}, RuntimeError("offline")],
        ])
        events = await self.consume()
        self.assertTrue(any("event: error" in event for event in events))
        self.assertEqual(self.ledger.record.call_args.args[0]["usage"], usage(30, 3))

    async def test_cancelled_request_records_known_usage(self):
        self.upstream([[{"type": "message_start", "message": {"usage": usage(10)}}, asyncio.CancelledError()]])
        with self.assertRaises(asyncio.CancelledError):
            await self.consume()
        self.assertEqual(self.ledger.record.call_args.args[0]["usage"], usage(10))

    async def test_closed_generator_records_known_usage(self):
        self.upstream([
            [{"type": "message_start", "message": {"usage": usage(10)}},
             {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}]
        ])
        generator = await self.ai.stream_chat({"messages": []}, self.request)
        await anext(generator)
        await anext(generator)
        await generator.aclose()
        self.assertEqual(self.ledger.record.call_args.args[0]["usage"], usage(10))
        self.assertEqual(self.closed_streams, 1)

    async def test_partial_usage_merges_cache_and_output(self):
        self.upstream([[
            {"type": "message_start", "message": {"usage": {
                **usage(12), "cache_read_input_tokens": 50, "cache_creation_input_tokens": 8,
            }}},
            {"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 9}},
            {"type": "message_stop"},
        ]])
        await self.consume()
        self.assertEqual(self.ledger.record.call_args.args[0]["usage"], {
            **usage(12, 9), "cache_read_input_tokens": 50, "cache_creation_input_tokens": 8,
        })


if __name__ == "__main__":
    unittest.main()
