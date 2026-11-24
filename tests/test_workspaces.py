"""Workspace regressions; all application data lives in temporary directories."""
from __future__ import annotations

import importlib.util
import json
import sqlite3
import sys
import tempfile
import types
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import Mock, patch

from fastapi.testclient import TestClient


SERVER = Path(__file__).resolve().parents[1] / "server"


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class WorkspaceCase(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="workspace-test-")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.cfg = types.ModuleType("config")
        self.cfg.DATA_DIR = self.root
        self.cfg.HOST = "127.0.0.1"
        self.cfg.WEB_DIST = self.root / "missing-web"
        modules = patch.dict(sys.modules, {"config": self.cfg})
        modules.start()
        self.addCleanup(modules.stop)
        self.s = load_module("storage", SERVER / "storage.py")
        sys.modules["storage"] = self.s
        self.p = load_module("prompts", SERVER / "prompts.py")
        sys.modules["prompts"] = self.p
        connect = self.s._conn

        @contextmanager
        def closing_connection():
            conn = connect()
            try:
                with conn:
                    yield conn
            finally:
                conn.close()

        self.s._conn = closing_connection

    def scalar(self, sql, params=()):
        with self.s._conn() as conn:
            return conn.execute(sql, params).fetchone()[0]

    def add_card(self, card_id, name, text, active=False):
        state = self.p.load()
        cards = [card for card in state["cards"] if card["id"] != card_id]
        cards.append({
            "id": card_id,
            "name": name,
            "description": "",
            "text": text,
        })
        return self.p.save({
            "active": card_id if active else state["active"],
            "cards": cards,
        })

    def session(self, session_id, title="Session", text="hello workspace"):
        return {
            "id": session_id,
            "title": title,
            "createdAt": 1,
            "updatedAt": 2,
            "messages": [{"id": "m1", "role": "user", "content": text}],
        }


class LegacyMigrationTests(WorkspaceCase):
    def test_old_database_migrates_idempotently_and_old_sessions_are_ungrouped(self):
        db = self.root / "chat.db"
        conn = sqlite3.connect(db)
        try:
            with conn:
                conn.execute(
                    "CREATE TABLE sessions ("
                    "id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', "
                    "created_at INTEGER NOT NULL DEFAULT 0, "
                    "updated_at INTEGER NOT NULL DEFAULT 0, "
                    "archived INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL)"
                )
                conn.execute(
                    "INSERT INTO sessions(id, title, data) VALUES(?, ?, ?)",
                    ("legacy", "Legacy", json.dumps({
                        "id": "legacy", "title": "Legacy", "workspaceId": "forged",
                        "messages": [],
                    })),
                )
        finally:
            conn.close()
        self.s.init()
        self.s.init()
        with self.s._conn() as conn:
            columns = {row["name"] for row in conn.execute(
                "PRAGMA table_info(sessions)"
            ).fetchall()}
            workspace_columns = {row["name"] for row in conn.execute(
                "PRAGMA table_info(workspaces)"
            ).fetchall()}
            indexes = {row["name"] for row in conn.execute(
                "PRAGMA index_list(sessions)"
            ).fetchall()}
        self.assertIn("workspace_id", columns)
        self.assertEqual(workspace_columns, {
            "id", "name", "card_id", "sort_order", "created_at", "updated_at",
        })
        self.assertIn("idx_sessions_workspace_id", indexes)
        self.assertIsNone(self.scalar("SELECT workspace_id FROM sessions WHERE id='legacy'"))
        loaded = self.s.load_session("legacy")
        self.assertIsNone(loaded["workspaceId"])
        stored = json.loads(self.scalar("SELECT data FROM sessions WHERE id='legacy'"))
        self.assertIsNone(stored["workspaceId"])
        self.assertEqual(self.s.list_sessions()[0]["workspaceId"], None)


class WorkspaceStorageTests(WorkspaceCase):
    def setUp(self):
        super().setUp()
        self.s.init()

    def test_crud_returns_camel_case_and_binding_follows_card_id(self):
        self.add_card("card", "Old name", "old text", active=True)
        created = self.s.create_workspace("  Project   One  ", "card")
        self.assertEqual(set(created), {
            "id", "name", "cardId", "sortOrder", "createdAt", "updatedAt",
        })
        self.assertEqual(created["name"], "Project One")
        self.assertEqual(created["cardId"], "card")
        self.assertEqual(created["sortOrder"], 0)
        self.assertIsInstance(created["createdAt"], int)
        self.assertIsInstance(created["updatedAt"], int)
        renamed = self.s.update_workspace(
            created["id"], name="Renamed", card_id=None, sort_order=7
        )
        self.assertEqual(renamed["name"], "Renamed")
        self.assertIsNone(renamed["cardId"])
        self.assertEqual(renamed["sortOrder"], 7)
        self.assertGreater(renamed["updatedAt"], created["updatedAt"])
        self.s.update_workspace(created["id"], card_id="card")
        self.add_card("card", "New name", "new text")
        self.assertEqual(self.s.get_workspace(created["id"])["cardId"], "card")
        self.assertEqual(self.p.card_text("card"), "new text")
        self.assertEqual(self.s.delete_workspace(created["id"]), {"ok": True, "moved": 0})
        self.assertEqual(self.s.list_workspaces(), [])

    def test_names_are_unique_case_insensitively_and_limits_are_enforced(self):
        self.s.create_workspace("Alpha")
        with self.assertRaisesRegex(ValueError, "同名"):
            self.s.create_workspace("  aLPHa ")
        self.s.create_workspace("Straße")
        with self.assertRaisesRegex(ValueError, "同名"):
            self.s.create_workspace("STRASSE")
        for invalid in ("", "   ", "x" * 41, None, 42):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                self.s.create_workspace(invalid)
        for index in range(28):
            self.s.create_workspace(f"Workspace {index}")
        self.assertEqual(len(self.s.list_workspaces()), 30)
        with self.assertRaisesRegex(ValueError, "最多 30"):
            self.s.create_workspace("Overflow")

    def test_invalid_card_and_workspace_ids_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "角色卡不存在"):
            self.s.create_workspace("Invalid", "missing")
        workspace = self.s.create_workspace("Valid")
        with self.assertRaisesRegex(ValueError, "角色卡不存在"):
            self.s.update_workspace(workspace["id"], card_id="missing")
        with self.assertRaisesRegex(ValueError, "sortOrder"):
            self.s.update_workspace(workspace["id"], sort_order=True)
        session = self.session("s1")
        with self.assertRaisesRegex(ValueError, "工作区不存在"):
            self.s.save_session({**session, "workspaceId": "missing"})
        self.s.save_session(session)
        with self.assertRaisesRegex(ValueError, "工作区不存在"):
            self.s.move_session("s1", "missing")
        with self.assertRaisesRegex(ValueError, "工作区 ID"):
            self.s.move_session("s1", "../bad")

    def test_delete_workspace_only_detaches_its_sessions(self):
        first = self.s.create_workspace("First")
        second = self.s.create_workspace("Second")
        for session_id in ("a", "b"):
            self.s.save_session({**self.session(session_id), "workspaceId": first["id"]})
        self.s.save_session({**self.session("c"), "workspaceId": second["id"]})
        self.s.save_session(self.session("d"))
        result = self.s.delete_workspace(first["id"])
        self.assertEqual(result, {"ok": True, "moved": 2})
        summaries = {item["id"]: item for item in self.s.list_sessions()}
        self.assertIsNone(summaries["a"]["workspaceId"])
        self.assertIsNone(summaries["b"]["workspaceId"])
        self.assertEqual(summaries["c"]["workspaceId"], second["id"])
        self.assertIsNone(summaries["d"]["workspaceId"])
        for session_id in ("a", "b"):
            self.assertIsNone(self.s.load_session(session_id)["workspaceId"])
            raw = json.loads(self.scalar("SELECT data FROM sessions WHERE id=?", (session_id,)))
            self.assertIsNone(raw["workspaceId"])
        self.assertIsNotNone(self.s.load_session("c"))

    def test_session_summaries_and_database_workspace_are_authoritative(self):
        first = self.s.create_workspace("First")
        second = self.s.create_workspace("Second")
        snapshot = {**self.session("s1", title="Needle"), "workspaceId": first["id"]}
        self.s.save_session(snapshot)
        self.assertEqual(self.s.list_sessions()[0]["workspaceId"], first["id"])
        self.assertEqual(self.s.search_sessions("needle")[0]["workspaceId"], first["id"])
        self.s.move_session("s1", second["id"])
        self.assertEqual(self.s.load_session("s1")["workspaceId"], second["id"])
        stale = {**snapshot, "title": "Stale title", "workspaceId": first["id"]}
        self.s.save_session(stale)
        self.assertEqual(stale["workspaceId"], second["id"])
        loaded = self.s.load_session("s1")
        self.assertEqual(loaded["title"], "Stale title")
        self.assertEqual(loaded["workspaceId"], second["id"])
        raw = json.loads(self.scalar("SELECT data FROM sessions WHERE id='s1'"))
        self.assertEqual(raw["workspaceId"], second["id"])
        with self.s._conn() as conn:
            conn.execute(
                "UPDATE sessions SET data=? WHERE id='s1'",
                (json.dumps({**loaded, "workspaceId": first["id"]}),),
            )
        self.assertEqual(self.s.load_session("s1")["workspaceId"], second["id"])
        raw = json.loads(self.scalar("SELECT data FROM sessions WHERE id='s1'"))
        self.assertEqual(raw["workspaceId"], second["id"])

    def test_new_and_existing_ungrouped_sessions_resolve_workspace_correctly(self):
        workspace = self.s.create_workspace("First")
        self.s.save_session({**self.session("new"), "workspaceId": workspace["id"]})
        self.assertEqual(self.s.load_session("new")["workspaceId"], workspace["id"])
        self.s.save_session(self.session("ungrouped"))
        self.assertIsNone(self.s.resolve_session_workspace_id("ungrouped", workspace["id"]))
        self.assertEqual(self.s.resolve_session_workspace_id("future", workspace["id"]), workspace["id"])
        self.assertIsNone(self.s.resolve_session_workspace_id("future", None))
        with self.assertRaisesRegex(ValueError, "工作区不存在"):
            self.s.resolve_session_workspace_id("future", "missing")
        self.assertEqual(
            self.s.resolve_session_workspace_id("new", "missing"), workspace["id"]
        )
        with self.assertRaises(self.s.SessionNotFound):
            self.s.move_session("missing", None)


class PromptWorkspaceTests(WorkspaceCase):
    def setUp(self):
        super().setUp()
        self.s.init()

    def test_bound_card_cannot_be_deleted_but_can_be_renamed_or_edited(self):
        self.add_card("card", "Teacher", "original", active=True)
        workspace = self.s.create_workspace("Class", "card")
        before = (self.root / "prompts.json").read_text(encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "请先解绑"):
            self.p.save({"active": "", "cards": []})
        self.assertEqual((self.root / "prompts.json").read_text(encoding="utf-8"), before)
        self.add_card("card", "Renamed teacher", "updated body")
        self.assertEqual(self.s.get_workspace(workspace["id"])["cardId"], "card")
        self.assertEqual(self.p.card_text("card"), "updated body")
        self.assertEqual(self.p.card_text("missing"), "")
        self.s.update_workspace(workspace["id"], card_id=None)
        self.p.save({"active": "", "cards": []})
        self.assertEqual(self.p.load()["cards"], [])


class WorkspaceAPITests(WorkspaceCase):
    def setUp(self):
        super().setUp()
        self.s.init()
        providers = types.ModuleType("providers")
        for name in ("asr", "extract", "llm", "ocr", "search", "tts"):
            setattr(providers, name, types.ModuleType(f"providers.{name}"))
        ai = types.ModuleType("ai")
        ai.UpstreamError = RuntimeError
        memory = types.ModuleType("memory")
        memory.init = Mock()
        usage = types.ModuleType("usage")
        usage.init = Mock()
        debug = types.ModuleType("debug")
        debug.install = Mock()
        modules = {
            "ai": ai,
            "debug": debug,
            "memory": memory,
            "providers": providers,
            "setup_store": types.ModuleType("setup_store"),
            "usage": usage,
        }
        isolated = patch.dict(sys.modules, modules)
        isolated.start()
        self.addCleanup(isolated.stop)
        self.main = load_module("main", SERVER / "main.py")
        self.client = TestClient(self.main.app)
        self.addCleanup(self.client.close)
        self.headers = {"x-chat-local": "1"}

    def test_guard_and_workspace_crud_contract(self):
        self.assertEqual(self.client.get("/api/chat/workspaces").status_code, 403)
        self.add_card("card", "Card", "body")
        response = self.client.post(
            "/api/chat/workspaces",
            json={"name": "Project", "cardId": "card"},
            headers=self.headers,
        )
        self.assertEqual(response.status_code, 200)
        workspace = response.json()
        self.assertEqual(set(workspace), {
            "id", "name", "cardId", "sortOrder", "createdAt", "updatedAt",
        })
        listed = self.client.get("/api/chat/workspaces", headers=self.headers).json()
        self.assertEqual(listed, {"workspaces": [workspace]})
        patched = self.client.patch(
            f"/api/chat/workspaces/{workspace['id']}",
            json={"name": "Renamed", "sortOrder": 4},
            headers=self.headers,
        )
        self.assertEqual(patched.status_code, 200)
        self.assertEqual(patched.json()["name"], "Renamed")
        self.assertEqual(patched.json()["cardId"], "card")
        unchanged = self.client.patch(
            f"/api/chat/workspaces/{workspace['id']}", json={}, headers=self.headers
        )
        self.assertEqual(unchanged.json(), patched.json())
        for invalid in ({"name": None}, {"sortOrder": None}):
            self.assertEqual(self.client.patch(
                f"/api/chat/workspaces/{workspace['id']}", json=invalid,
                headers=self.headers,
            ).status_code, 400)
        unbound = self.client.patch(
            f"/api/chat/workspaces/{workspace['id']}",
            json={"cardId": None},
            headers=self.headers,
        )
        self.assertEqual(unbound.status_code, 200)
        self.assertIsNone(unbound.json()["cardId"])
        deleted = self.client.delete(
            f"/api/chat/workspaces/{workspace['id']}", headers=self.headers
        )
        self.assertEqual(deleted.json(), {"ok": True, "moved": 0})

    def test_api_validation_and_move_then_delete_detaches_session(self):
        self.assertEqual(self.client.post(
            "/api/chat/workspaces", json={"name": "No guard"}
        ).status_code, 403)
        created = self.client.post(
            "/api/chat/workspaces", json={"name": "Same"}, headers=self.headers
        ).json()
        duplicate = self.client.post(
            "/api/chat/workspaces", json={"name": "same"}, headers=self.headers
        )
        self.assertEqual(duplicate.status_code, 400)
        invalid_card = self.client.post(
            "/api/chat/workspaces", json={"name": "Bad", "cardId": "missing"},
            headers=self.headers,
        )
        self.assertEqual(invalid_card.status_code, 400)
        missing = self.client.patch(
            "/api/chat/workspaces/missing", json={"name": "X"}, headers=self.headers
        )
        self.assertEqual(missing.status_code, 404)
        self.client.put(
            "/api/chat/sessions/s1", json=self.session("s1"), headers=self.headers
        )
        moved = self.client.patch(
            "/api/chat/sessions/s1/workspace",
            json={"workspaceId": created["id"]},
            headers=self.headers,
        )
        self.assertEqual(moved.json(), {"ok": True, "workspaceId": created["id"]})
        loaded = self.client.get("/api/chat/sessions/s1", headers=self.headers).json()
        self.assertEqual(loaded["workspaceId"], created["id"])
        detached = self.client.delete(
            f"/api/chat/workspaces/{created['id']}", headers=self.headers
        )
        self.assertEqual(detached.json(), {"ok": True, "moved": 1})
        loaded = self.client.get("/api/chat/sessions/s1", headers=self.headers).json()
        self.assertIsNone(loaded["workspaceId"])
        self.assertEqual(self.client.patch(
            "/api/chat/sessions/s1/workspace", json={}, headers=self.headers
        ).status_code, 400)
        self.assertEqual(self.client.patch(
            "/api/chat/sessions/s1/workspace", json={"workspaceId": "missing"},
            headers=self.headers,
        ).status_code, 404)
        self.assertEqual(self.client.patch(
            "/api/chat/sessions/missing/workspace", json={"workspaceId": None},
            headers=self.headers,
        ).status_code, 404)


if __name__ == "__main__":
    unittest.main()
