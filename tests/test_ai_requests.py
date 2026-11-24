import asyncio
import importlib.util
import json
import sys
import tempfile
import types
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch


ROOT = Path(__file__).resolve().parents[1]
SERVER = ROOT / "server"


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


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
        temp = tempfile.TemporaryDirectory(prefix="ai-request-test-")
        self.addCleanup(temp.cleanup)
        config = types.ModuleType("config")
        config.DATA_DIR = Path(temp.name)
        config.DEFAULT_SYSTEM = "fixed system"
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
        modules = {"config": config, "memory": memory, "providers": providers, "usage": ledger}
        isolated = patch.dict(sys.modules, modules)
        isolated.start()
        self.addCleanup(isolated.stop)
        self.storage = load_module("storage", SERVER / "storage.py")
        sys.modules["storage"] = self.storage
        self.prompts = load_module("prompts", SERVER / "prompts.py")
        sys.modules["prompts"] = self.prompts
        connect = self.storage._conn

        @contextmanager
        def closing_connection():
            conn = connect()
            try:
                with conn:
                    yield conn
            finally:
                conn.close()

        self.storage._conn = closing_connection
        self.storage.init()
        spec = importlib.util.spec_from_file_location("audit_ai", SERVER / "ai.py")
        self.ai = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.ai)
        self.ai._prepare_messages = AsyncMock(return_value=([{"role": "user", "content": "hello"}], ""))
        self.ai._system_prompt = Mock(wraps=self.ai._system_prompt)
        self.ai._execute_tool = AsyncMock(return_value=(
            {"type": "web_fetch_tool_result", "content": {}, "kind": "read_link"}, "page"
        ))
        self.ai._execute_memory_tool = Mock()
        self.request = types.SimpleNamespace(is_disconnected=AsyncMock(return_value=False))
        self.payloads = []
        self.closed_streams = 0
        self.ledger = ledger

    def add_card(self, card_id, text, active=False):
        state = self.prompts.load()
        cards = [card for card in state["cards"] if card["id"] != card_id]
        cards.append({
            "id": card_id,
            "name": card_id,
            "description": "",
            "text": text,
        })
        self.prompts.save({
            "active": card_id if active else state["active"],
            "cards": cards,
        })

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

    async def test_new_session_first_request_uses_workspace_card_and_ignores_frontend_system(self):
        self.add_card("global", "GLOBAL CARD TEXT", active=True)
        self.add_card("workspace", "WORKSPACE CARD TEXT")
        workspace = self.storage.create_workspace("Project", "workspace")
        self.upstream([response(10, 3)])
        await self.consume(
            session_id="new", workspace_id=workspace["id"], system="FORGED SYSTEM TEXT"
        )
        system = self.payloads[0]["system"]
        self.assertIn("WORKSPACE CARD TEXT", system)
        self.assertNotIn("GLOBAL CARD TEXT", system)
        self.assertNotIn("FORGED SYSTEM TEXT", system)
        self.assertEqual(
            self.ai._system_prompt.call_args.kwargs["prompt_block"], "WORKSPACE CARD TEXT"
        )

    async def test_unbound_workspace_falls_back_to_global_active_card(self):
        self.add_card("global", "GLOBAL CARD TEXT", active=True)
        self.add_card("workspace", "WORKSPACE CARD TEXT")
        workspace = self.storage.create_workspace("Project")
        self.upstream([response(10, 3)])
        await self.consume(session_id="new", workspace_id=workspace["id"])
        self.assertIn("GLOBAL CARD TEXT", self.payloads[0]["system"])
        self.assertNotIn("WORKSPACE CARD TEXT", self.payloads[0]["system"])

    async def test_missing_workspace_card_falls_back_to_global_active_card(self):
        self.add_card("global", "GLOBAL CARD TEXT", active=True)
        workspace = self.storage.create_workspace("Project", "global")
        with self.storage._conn() as conn:
            conn.execute(
                "UPDATE workspaces SET card_id='missing' WHERE id=?", (workspace["id"],)
            )
        self.upstream([response(10, 3)])
        await self.consume(session_id="new", workspace_id=workspace["id"])
        self.assertIn("GLOBAL CARD TEXT", self.payloads[0]["system"])

    async def test_database_workspace_overrides_forged_request_workspace(self):
        self.add_card("global", "GLOBAL CARD TEXT", active=True)
        self.add_card("first", "FIRST CARD TEXT")
        self.add_card("second", "SECOND CARD TEXT")
        first = self.storage.create_workspace("First", "first")
        second = self.storage.create_workspace("Second", "second")
        self.storage.save_session({
            "id": "session", "title": "", "createdAt": 1, "updatedAt": 1,
            "workspaceId": first["id"], "messages": [],
        })
        self.upstream([response(10, 3)])
        await self.consume(workspace_id=second["id"], system="FORGED SYSTEM TEXT")
        system = self.payloads[0]["system"]
        self.assertIn("FIRST CARD TEXT", system)
        self.assertNotIn("SECOND CARD TEXT", system)
        self.assertNotIn("GLOBAL CARD TEXT", system)
        self.assertNotIn("FORGED SYSTEM TEXT", system)
        self.assertEqual(
            self.storage.resolve_session_workspace_id("session", second["id"]), first["id"]
        )

    async def test_existing_ungrouped_session_ignores_requested_workspace(self):
        self.add_card("global", "GLOBAL CARD TEXT", active=True)
        self.add_card("workspace", "WORKSPACE CARD TEXT")
        workspace = self.storage.create_workspace("Project", "workspace")
        self.storage.save_session({
            "id": "session", "title": "", "createdAt": 1, "updatedAt": 1, "messages": [],
        })
        self.upstream([response(10, 3)])
        await self.consume(workspace_id=workspace["id"])
        self.assertIn("GLOBAL CARD TEXT", self.payloads[0]["system"])
        self.assertNotIn("WORKSPACE CARD TEXT", self.payloads[0]["system"])

    async def test_new_session_rejects_nonexistent_requested_workspace(self):
        self.upstream([response(10, 3)])
        with self.assertRaisesRegex(ValueError, "工作区不存在"):
            await self.ai.stream_chat({
                "messages": [], "session_id": "new", "workspace_id": "missing",
            }, self.request)
        self.assertEqual(self.payloads, [])


if __name__ == "__main__":
    unittest.main()
