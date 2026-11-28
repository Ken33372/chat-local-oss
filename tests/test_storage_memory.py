"""Offline regressions; never import real config/providers or open application data."""
import importlib.util
import json
from contextlib import contextmanager
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch


SERVER = Path(__file__).resolve().parents[1] / "server"


def load_module(name):
    spec = importlib.util.spec_from_file_location(name, SERVER / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class IsolatedCase(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="storage-memory-test-")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.cfg = types.ModuleType("config")
        self.cfg.DATA_DIR = self.root
        self.cfg.EMBEDDING_BASE_URL = "https://first.invalid/v1"
        self.cfg.EMBEDDING_MODEL = "test-model"
        self.cfg.EMBEDDING_DIM = 2
        self.cfg.MEMORY_ENABLED = True
        self.cfg.MEMORY_WRITE = "confirm"
        self.cfg.MEMORY_SIM_THRESHOLD = 0.42
        self.cfg.MEMORY_SEARCH_MODE = "embedding"
        self.cfg.MEMORY_INJECT_MODE = "embedding"
        self.cfg.MEMORY_INJECT = "recent"
        self.cfg.MEMORY_INJECT_COUNT = 5
        self.cfg.capabilities = lambda: {"embedding": True}
        self.provider = types.ModuleType("providers")
        self.provider.embedding = types.SimpleNamespace(
            configured=lambda: True,
            embed=Mock(side_effect=lambda texts: [[1.0, 0.0] for _ in texts]),
            embed_batched=Mock(side_effect=lambda texts: [[1.0, 0.0] for _ in texts]),
        )
        self.provider.rerank = types.SimpleNamespace(
            configured=lambda: False,
            rerank=Mock(side_effect=AssertionError("unexpected rerank")),
        )
        modules = patch.dict(sys.modules, {"config": self.cfg, "providers": self.provider})
        modules.start()
        self.addCleanup(modules.stop)
        self.s = load_module("storage")
        sys.modules["storage"] = self.s
        # sqlite's own context manager commits/rolls back but does not close.
        # Close every test connection deterministically, including failure paths.
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
        self.s.init()
        self.m = load_module("memory")
        self.m.init()

    def scalar(self, sql, params=()):
        with self.s._conn() as conn:
            return conn.execute(sql, params).fetchone()[0]

    def session(self, session_id, file_id="attachment"):
        return {"id": session_id, "messages": [
            {"id": "msg", "role": "user", "files": [
                {"id": file_id, "serverId": file_id, "name": "a.txt", "size": 4}
            ]}
        ]}

    def stage(self):
        self.s.save_file("old", "old.txt", "text/plain", b"OLD!")
        self.s.save_session(self.session("old-session", "old"))
        self.s.set_file_text("old", "text", "old cached text")
        self.s.save_staging_file("new", "new.txt", "text/plain", b"NEW!")
        self.s.add_staging_session(self.session("new-session", "new"))

    def assert_rolled_back(self):
        self.assertEqual((self.s.FILES_DIR / "old").read_bytes(), b"OLD!")
        self.assertEqual((self.s.STAGING_DIR / "new").read_bytes(), b"NEW!")
        self.assertIsNotNone(self.s.load_session("old-session"))
        self.assertIsNone(self.s.load_session("new-session"))
        self.assertEqual(self.scalar("SELECT COUNT(*) FROM staging_sessions"), 1)
        self.assertEqual(self.scalar("SELECT COUNT(*) FROM staging_files"), 1)
        self.assertEqual(self.s.get_file_text("old"), "old cached text")
        self.assertFalse((self.root / "files_previous").exists())


class StorageTests(IsolatedCase):
    def test_same_size_write_changes_bytes_and_invalidates_text(self):
        self.s.save_file("a", "a", "text/plain", b"aaaa")
        self.s.set_file_text("a", "text", "cached")
        with patch.object(self.s.os, "replace", wraps=self.s.os.replace) as replace:
            self.s.save_file("a", "a", "text/plain", b"aaaa")
            replace.assert_not_called()
        self.assertEqual(self.s.get_file_text("a"), "cached")
        self.s.save_file("a", "a", "text/plain", b"bbbb")
        self.assertEqual(self.s.read_file("a")[0], b"bbbb")
        self.assertIsNone(self.s.get_file_text("a"))
        self.s.set_file_text("a", "text", "new cached")
        self.s.save_file("a", "a", "text/plain", b"longer")
        self.assertIsNone(self.s.get_file_text("a"))

    def test_staging_same_size_write_changes_bytes(self):
        self.s.save_staging_file("a", "a", "text/plain", b"aaaa")
        self.s.save_staging_file("a", "a", "text/plain", b"bbbb")
        self.assertEqual((self.s.STAGING_DIR / "a").read_bytes(), b"bbbb")

    def test_merge_conflicts_compare_bytes_and_reuse_identical(self):
        for mode in ("merge-skip", "merge-copy"):
            for content in (b"aaaa", b"bbbb"):
                with self.subTest(mode=mode, content=content):
                    file_id = f"a-{mode}-{content.decode()}"
                    session_id = f"s-{file_id}"
                    self.s.save_file(file_id, "a", "text/plain", b"aaaa")
                    self.s.set_file_text(file_id, "text", "original")
                    self.s.save_staging_file(file_id, "a", "text/plain", content)
                    self.s.add_staging_session(self.session(session_id, file_id))
                    self.s.commit_staging(mode)
                    item = self.s.load_session(session_id)["messages"][0]["files"][0]
                    self.assertEqual(item["id"], item["serverId"])
                    self.assertEqual(self.s.read_file(item["id"])[0], content)
                    self.assertEqual(item["id"] == file_id, content == b"aaaa")
                    self.assertEqual(self.s.get_file_text(file_id), "original")
                    if item["id"] != file_id:
                        self.assertIsNone(self.s.get_file_text(item["id"]))

    def test_merge_updates_batch_index_and_detects_new_conflict(self):
        self.s.save_staging_file("attachment", "a", "text/plain", b"aaaa")
        self.s.add_staging_session(self.session("first"))
        self.s.add_staging_session(self.session("second"))
        install = self.s._install_files
        prepare = self.s._prepare_added_files
        seen = []

        def inspect(session, conn, existing):
            seen.append(set(existing))
            return prepare(session, conn, existing)

        def change_staged_after_first(conn, file_map, meta, copied):
            install(conn, file_map, meta, copied)
            (self.s.STAGING_DIR / "attachment").write_bytes(b"bbbb")

        with patch.object(self.s, "_prepare_added_files", side_effect=inspect), \
                patch.object(self.s, "_install_files", side_effect=change_staged_after_first):
            self.s.commit_staging("merge-skip")
        self.assertNotIn("attachment", seen[0])
        self.assertIn("attachment", seen[1])
        first = self.s.load_session("first")["messages"][0]["files"][0]["id"]
        second = self.s.load_session("second")["messages"][0]["files"][0]["id"]
        self.assertNotEqual(first, second)
        self.assertEqual(self.s.read_file(first)[0], b"aaaa")
        self.assertEqual(self.s.read_file(second)[0], b"bbbb")

    def test_install_missing_blob_invalidates_cache(self):
        self.s.set_file_text("attachment", "text", "obsolete")
        self.s.save_staging_file("attachment", "a", "text/plain", b"aaaa")
        self.s.add_staging_session(self.session("first"))
        self.s.commit_staging("merge-skip")
        self.assertIsNone(self.s.get_file_text("attachment"))

    def test_replace_first_move_failure(self):
        self.stage()
        with patch.object(self.s.os, "replace", side_effect=OSError("first move")):
            with self.assertRaises(OSError):
                self.s.commit_staging()
        self.assert_rolled_back()

    def test_replace_second_move_failure_and_retry(self):
        self.stage()
        replace = self.s.os.replace

        def fail(source, target):
            if source == self.s.STAGING_DIR:
                raise OSError("staging move")
            return replace(source, target)

        with patch.object(self.s.os, "replace", side_effect=fail):
            with self.assertRaises(OSError):
                self.s.commit_staging()
        self.assert_rolled_back()
        self.s.commit_staging()
        self.assertEqual(self.s.read_file("new")[0], b"NEW!")
        self.assertIsNone(self.s.load_session("old-session"))
        self.assertEqual(self.scalar("SELECT COUNT(*) FROM staging_sessions"), 0)

    def test_replace_staging_mkdir_failure(self):
        self.stage()
        mkdir = Path.mkdir

        def fail(path, *args, **kwargs):
            if path == self.s.STAGING_DIR:
                raise OSError("mkdir")
            return mkdir(path, *args, **kwargs)

        with patch.object(Path, "mkdir", fail):
            with self.assertRaises(OSError):
                self.s.commit_staging()
        self.assert_rolled_back()

    def test_replace_database_failure_restores_both_directories(self):
        self.stage()
        with self.s._conn() as conn:
            conn.execute("CREATE TRIGGER fail_import BEFORE INSERT ON sessions "
                         "BEGIN SELECT RAISE(ABORT, 'injected db failure'); END")
        with self.assertRaisesRegex(Exception, "injected db failure"):
            self.s.commit_staging()
        self.assert_rolled_back()

    def test_failed_rollback_preserves_backup_on_next_attempt(self):
        self.stage()
        replace = self.s.os.replace
        backup = self.root / "files_previous"

        def fail(source, target):
            if source in (self.s.STAGING_DIR, backup):
                raise OSError("move and rollback fail")
            return replace(source, target)

        with patch.object(self.s.os, "replace", side_effect=fail):
            with self.assertRaises(OSError):
                self.s.commit_staging()
        with self.assertRaisesRegex(RuntimeError, "恢复备份"):
            self.s.commit_staging()
        self.assertEqual((backup / "old").read_bytes(), b"OLD!")
        self.assertEqual((self.s.STAGING_DIR / "new").read_bytes(), b"NEW!")
        self.assertIsNotNone(self.s.load_session("old-session"))

    def test_failed_return_to_staging_keeps_import_and_old_backup(self):
        self.stage()
        with self.s._conn() as conn:
            conn.execute("CREATE TRIGGER fail_import BEFORE INSERT ON sessions "
                         "BEGIN SELECT RAISE(ABORT, 'injected db failure'); END")
        replace = self.s.os.replace

        def fail(source, target):
            if source == self.s.FILES_DIR and target == self.s.STAGING_DIR:
                raise OSError("cannot return imported directory")
            return replace(source, target)

        with patch.object(self.s.os, "replace", side_effect=fail):
            with self.assertRaises(OSError):
                self.s.commit_staging()
        with self.assertRaises(RuntimeError):
            self.s.commit_staging()
        self.assertEqual((self.root / "files_previous" / "old").read_bytes(), b"OLD!")
        self.assertEqual((self.s.FILES_DIR / "new").read_bytes(), b"NEW!")
        self.assertIsNotNone(self.s.load_session("old-session"))
        self.assertEqual(self.scalar("SELECT COUNT(*) FROM staging_sessions"), 1)

    def test_preexisting_backup_is_never_removed(self):
        self.stage()
        backup = self.root / "files_previous"
        backup.mkdir()
        (backup / "recovery").write_bytes(b"keep")
        with self.assertRaises(RuntimeError):
            self.s.commit_staging()
        self.assertEqual((backup / "recovery").read_bytes(), b"keep")
        self.assertEqual(self.s.read_file("old")[0], b"OLD!")


class MemoryTests(IsolatedCase):
    def test_injection_uses_selected_mode_instead_of_legacy_recent_flag(self):
        self.m.clear_all()
        self.m.add_item("用户正在学习 Stata")
        self.provider.embedding.embed_batched.side_effect = lambda texts: [[1.0, 0.0] for _ in texts]
        self.provider.embedding.embed.side_effect = lambda texts: [[0.0, 1.0] for _ in texts]

        output, ids = self.m.injection("今天天气怎么样")

        self.assertEqual(ids, set())
        self.assertEqual(output, "")

    def test_vector_write_rechecks_text_description_and_deletion(self):
        for change in ("text", "description", "delete"):
            with self.subTest(change=change):
                self.m.clear_all()
                item = self.m.add_item("original", description="before")

                def during_embed(texts):
                    if change == "delete":
                        self.m.delete_item(item["id"])
                    else:
                        self.m.update_item(item["id"], **{change: "changed"})
                    return [[1.0, 0.0]]

                self.provider.embedding.embed_batched.side_effect = during_embed
                self.assertEqual(self.m._sync_vectors([item]), {})
                self.assertEqual(self.scalar("SELECT COUNT(*) FROM memory_vectors"), 0)

    def test_unchanged_vector_is_reused(self):
        item = self.m.add_item("original", description="before")
        self.assertEqual(self.m._sync_vectors([item]), {item["id"]: [1.0, 0.0]})
        self.m._sync_vectors([item])
        self.provider.embedding.embed_batched.assert_called_once_with(["before\noriginal"])

    def test_stale_snapshot_cannot_use_new_vector(self):
        old = self.m.add_item("original")
        new = self.m.update_item(old["id"], text="different")
        self.m._sync_vectors([new])
        self.assertEqual(self.m._sync_vectors([old]), {})

    def test_search_and_injection_do_not_fallback_to_stale_hits(self):
        for operation in ("search", "injection"):
            with self.subTest(operation=operation):
                self.m.clear_all()
                item = self.m.add_item("original")

                def during_embed(texts):
                    self.m.update_item(item["id"], text="different")
                    return [[1.0, 0.0]]

                self.provider.embedding.embed_batched.side_effect = during_embed
                output, ids = getattr(self.m, operation)("original")
                self.assertFalse(ids)
                self.assertNotIn("original", output)

    def test_query_network_edit_removes_cached_vector_hit(self):
        item = self.m.add_item("original")
        self.m._sync_vectors([item])

        def during_query(texts):
            self.m.update_item(item["id"], description="changed")
            return [[1.0, 0.0]]

        self.provider.embedding.embed.side_effect = during_query
        self.assertEqual(self.m._semantic_order("query", [item], 5), [])
        self.assertEqual(self.scalar("SELECT COUNT(*) FROM memory_vectors"), 0)

    def test_rerank_network_edit_does_not_return_old_hit(self):
        first = self.m.add_item("original")
        second = self.m.add_item("different")
        self.provider.rerank.configured = lambda: True

        def during_rerank(query, texts):
            self.m.update_item(first["id"], description="changed")
            return [0, 1]

        self.provider.rerank.rerank.side_effect = during_rerank
        self.assertEqual(self.m._semantic_order("query", [first, second], 1), [])

    def test_known_vector_edited_while_other_vector_computes_is_excluded(self):
        first = self.m.add_item("original")
        self.m._sync_vectors([first])
        second = self.m.add_item("different")

        def during_embed(texts):
            self.m.update_item(first["id"], text="correction")
            return [[1.0, 0.0]]

        self.provider.embedding.embed_batched.side_effect = during_embed
        self.assertEqual(self.m._sync_vectors([first, second]), {second["id"]: [1.0, 0.0]})
        self.assertEqual(self.scalar("SELECT COUNT(*) FROM memory_vectors WHERE memory_id=?", (first["id"],)), 0)

    def test_query_cache_and_persistent_vectors_use_full_identity(self):
        item = self.m.add_item("original")
        self.m._sync_vectors([item])
        self.m._query_vector("query")
        self.m._query_vector("query")
        self.assertEqual(self.provider.embedding.embed.call_count, 1)
        old_identity = self.scalar("SELECT model FROM memory_vectors")
        for name, value in (("EMBEDDING_BASE_URL", "https://second.invalid/v1"),
                            ("EMBEDDING_MODEL", "another-model"),
                            ("EMBEDDING_DIM", 3)):
            with self.subTest(setting=name):
                setattr(self.cfg, name, value)
                dim = self.cfg.EMBEDDING_DIM
                self.provider.embedding.embed.side_effect = lambda texts: [[1.0] * dim]
                self.provider.embedding.embed_batched.side_effect = lambda texts: [[1.0] * dim]
                calls = self.provider.embedding.embed.call_count
                self.m._query_vector("query")
                self.assertEqual(self.provider.embedding.embed.call_count, calls + 1)
                self.m._sync_vectors([item])
                identity = self.scalar("SELECT model FROM memory_vectors")
                self.assertNotEqual(identity, old_identity)
                old_identity = identity

    def test_legacy_model_only_vector_is_rebuilt(self):
        item = self.m.add_item("original")
        with self.s._conn() as conn:
            conn.execute("INSERT INTO memory_vectors(memory_id, model, dim, vec) VALUES(?,?,?,?)",
                         (item["id"], self.cfg.EMBEDDING_MODEL, 2, self.m._pack([0.0, 1.0])))
        self.assertEqual(self.m._sync_vectors([item])[item["id"]], [1.0, 0.0])
        self.provider.embedding.embed_batched.assert_called_once()

    def test_service_change_during_compute_is_not_cached(self):
        item = self.m.add_item("original")

        def change_service(texts):
            self.cfg.EMBEDDING_BASE_URL += "/changed"
            return [[1.0, 0.0]]

        self.provider.embedding.embed_batched.side_effect = change_service
        with self.assertRaisesRegex(RuntimeError, "配置已变化"):
            self.m._sync_vectors([item])
        self.assertEqual(self.scalar("SELECT COUNT(*) FROM memory_vectors"), 0)
        self.provider.embedding.embed.side_effect = change_service
        with self.assertRaisesRegex(RuntimeError, "配置已变化"):
            self.m._query_vector("query")
        self.assertFalse(self.m._QUERY_CACHE)

    def test_edit_proposal_rejects_changed_original_but_stays_pending(self):
        item = self.m.add_item("original")
        proposal = self.m.propose_edit("original", "proposed")
        payload = json.loads(self.scalar("SELECT payload FROM memory_proposals WHERE id=?", (proposal,)))
        self.assertEqual(payload["old_text"], "original")
        self.m.update_item(item["id"], text="manual correction")
        with self.assertRaisesRegex(ValueError, "原记忆已修改"):
            self.m.accept_proposal(proposal)
        self.assertEqual(self.m.list_items()[0]["text"], "manual correction")
        self.assertEqual(self.scalar("SELECT status FROM memory_proposals WHERE id=?", (proposal,)), "pending")

    def test_edit_proposal_requires_confirmation_and_preserves_unspecified_fields(self):
        item = self.m.add_item("original", description="before")
        self.m._sync_vectors([item])
        proposal = self.m.propose_edit("original", "proposed")
        self.assertEqual(self.m.list_items()[0]["text"], "original")
        self.m.update_item(item["id"], pinned=True, description="manual note")
        accepted = self.m.accept_proposal(proposal)
        self.assertEqual(accepted["text"], "proposed")
        self.assertTrue(accepted["pinned"])
        self.assertEqual(accepted["description"], "manual note")
        self.assertEqual(self.scalar("SELECT COUNT(*) FROM memory_vectors"), 0)
        with self.assertRaises(ValueError):
            self.m.accept_proposal(proposal)

    def test_edit_proposal_does_not_overwrite_manual_description(self):
        item = self.m.add_item("original", description="before")
        proposal = self.m.propose_edit("original", "proposed", description="suggested")
        self.m.update_item(item["id"], description="manual note")
        with self.assertRaisesRegex(ValueError, "原记忆已修改"):
            self.m.accept_proposal(proposal)
        self.assertEqual(self.m.list_items()[0]["description"], "manual note")

    def test_edit_proposal_does_not_overwrite_manual_pin(self):
        item = self.m.add_item("original")
        proposal = self.m.propose_edit("original", "proposed", pinned=False)
        self.m.update_item(item["id"], pinned=True)
        with self.assertRaisesRegex(ValueError, "原记忆已修改"):
            self.m.accept_proposal(proposal)
        self.assertTrue(self.m.list_items()[0]["pinned"])

    def test_stats_only_count_current_vector_service(self):
        self.cfg.MEMORY_INJECT_MODE = "embedding"
        self.cfg.MEMORY_TOOLS = True
        item = self.m.add_item("original")
        self.m._sync_vectors([item])
        current = self.m.stats()
        self.assertEqual(current["vectors"], 1)
        self.assertEqual(current["vector_model"], "test-model")
        self.cfg.EMBEDDING_BASE_URL = "https://changed.invalid"
        current = self.m.stats()
        self.assertEqual(current["vectors"], 0)
        self.assertEqual(current["vectors_missing"], 1)

    def test_new_proposal_accepts_last_available_slot(self):
        self.m.MAX_ITEMS = 1
        proposal = self.m.propose("proposed", description="note")
        self.assertEqual(self.m.list_items(), [])
        accepted = self.m.accept_proposal(proposal)
        self.assertEqual(accepted["text"], "proposed")
        self.assertEqual(accepted["description"], "note")
        self.assertEqual(accepted["source"], "tool")
        self.assertEqual(len(self.m.list_items()), 1)

    def test_edit_proposal_still_checks_duplicates_on_accept(self):
        item = self.m.add_item("original")
        proposal = self.m.propose_edit("original", "proposed")
        self.m.add_item("proposed")
        with self.assertRaisesRegex(ValueError, "相似记忆"):
            self.m.accept_proposal(proposal)
        self.assertEqual(next(row for row in self.m.list_items() if row["id"] == item["id"])["text"], "original")

    def test_new_proposal_limit_and_existing_deduplication(self):
        self.m.MAX_ITEMS = 1
        proposal = self.m.propose("proposed")
        self.m.add_item("original")
        with self.assertRaisesRegex(ValueError, "上限"):
            self.m.accept_proposal(proposal)
        self.assertEqual(self.scalar("SELECT status FROM memory_proposals WHERE id=?", (proposal,)), "pending")
        self.m.delete_item(self.m.list_items()[0]["id"])
        self.m.add_item("proposed")
        self.m.accept_proposal(proposal)  # already present: no extra slot required
        self.assertEqual(len(self.m.list_items()), 1)
        self.assertEqual(self.scalar("SELECT status FROM memory_proposals WHERE id=?", (proposal,)), "accepted")


if __name__ == "__main__":
    unittest.main()
