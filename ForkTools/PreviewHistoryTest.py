import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

from PreviewHistory import CopyHistory


class PreviewHistoryTests(unittest.TestCase):
    def setUp(self):
        self.Temporary = tempfile.TemporaryDirectory()
        self.Root = Path(self.Temporary.name)
        self.Source = self.Root / "Live/state.sqlite"
        self.Source.parent.mkdir()
        self.Preview = self.Root / "Preview"
        self.Live = sqlite3.connect(self.Source)
        self.Live.executescript("""
            PRAGMA journal_mode=WAL;
            CREATE TABLE orchestration_events (sequence INTEGER PRIMARY KEY, event_id TEXT UNIQUE, aggregate_kind TEXT, stream_id TEXT, stream_version INTEGER, event_type TEXT, occurred_at TEXT, command_id TEXT, causation_event_id TEXT, correlation_id TEXT, actor_kind TEXT, payload_json TEXT, metadata_json TEXT);
            CREATE TABLE projection_projects (project_id TEXT, workspace_root TEXT, scripts_json TEXT, auto_pull INTEGER, default_thread_env_mode TEXT, updated_at TEXT);
            CREATE TABLE projection_threads (thread_id TEXT, runtime_mode TEXT, updated_at TEXT, branch TEXT, worktree_path TEXT, linked_pull_request_json TEXT, branch_pull_request_json TEXT, title_regeneration_request_id TEXT, title_regeneration_started_at TEXT, title_state_json TEXT);
            CREATE TABLE projection_thread_sessions (status TEXT, active_turn_id TEXT, last_error TEXT, provider_name TEXT, provider_instance_id TEXT, provider_session_id TEXT, provider_thread_id TEXT);
            CREATE TABLE projection_thread_messages (thread_id TEXT, message_id TEXT, role TEXT, turn_id TEXT, text TEXT, is_streaming INTEGER, created_at TEXT, updated_at TEXT);
            CREATE TABLE projection_thread_activities (thread_id TEXT, turn_id TEXT, kind TEXT, payload_json TEXT, created_at TEXT, activity_id TEXT);
            CREATE TABLE projection_thread_pull_requests (thread_id TEXT, host TEXT, repository TEXT, number INTEGER);
            CREATE TABLE projection_state (projector TEXT PRIMARY KEY, last_applied_sequence INTEGER NOT NULL, updated_at TEXT NOT NULL);
            INSERT INTO projection_state VALUES ('projection.threads',1,'2026-09-17T00:00:00.000Z');
            INSERT INTO projection_state VALUES ('projection.thread-messages',0,'2026-09-17T00:00:00.000Z');
            CREATE TABLE provider_session_runtime (resume_cursor_json TEXT);
            INSERT INTO provider_session_runtime VALUES ('original-provider-session');
            CREATE TABLE auth_sessions (credential TEXT);
            INSERT INTO auth_sessions VALUES ('original-auth');
            CREATE TABLE auth_pairing_links (credential TEXT);
            INSERT INTO auth_pairing_links VALUES ('original-pairing');
            INSERT INTO projection_projects VALUES ('project-one','/real/project','["run setup"]',1,'worktree','2026-09-17T00:00:00.000Z');
            INSERT INTO projection_threads VALUES ('thread-one','full-access','2026-09-17T00:02:00.000Z','main','/real/worktree','{}','{}','pending-title',NULL,'{}');
            INSERT INTO projection_thread_sessions VALUES ('running','live-turn',NULL,'codex','codex','live-session','live-provider-thread');
            INSERT INTO projection_thread_messages VALUES ('thread-one','message-one','assistant','live-turn','Text from the live WAL',1,'2026-09-17T00:00:00.000Z','2026-09-17T00:00:00.000Z');
            INSERT INTO projection_thread_pull_requests VALUES ('thread-one','github','owner/repo',1);
            INSERT INTO projection_thread_activities VALUES ('thread-one','live-turn','approval.requested','{"requestId":"open"}','2026-09-17T00:00:00.000Z','1');
            INSERT INTO projection_thread_activities VALUES ('thread-one','old-turn','approval.requested','{"requestId":"closed"}','2026-09-17T00:00:00.000Z','2');
            INSERT INTO projection_thread_activities VALUES ('thread-one','old-turn','approval.resolved','{"requestId":"closed","decision":"accept"}','2026-09-17T00:00:01.000Z','3');
        """)

    def tearDown(self):
        self.Live.close()
        self.Temporary.cleanup()

    def test_SnapshotKeepsWalHistoryAndDetachesLiveWork(self):
        Before = list(self.Live.iterdump())
        Counts = CopyHistory(self.Source, self.Preview)
        self.assertEqual(Counts, {"Threads": 1, "Messages": 1})
        with sqlite3.connect(self.Preview / "userdata/state.sqlite") as Copy:
            self.assertEqual(Copy.execute("SELECT text,is_streaming FROM projection_thread_messages").fetchone(), ("Text from the live WAL", 0))
            self.assertEqual(Copy.execute("SELECT status,active_turn_id,provider_thread_id FROM projection_thread_sessions").fetchone(), ("stopped", None, None))
            for Table in ("provider_session_runtime", "auth_sessions", "auth_pairing_links", "projection_thread_pull_requests"):
                self.assertEqual(Copy.execute(f"SELECT COUNT(*) FROM {Table}").fetchone()[0], 0)
            Workspace, Scripts, AutoPull = Copy.execute("SELECT workspace_root,scripts_json,auto_pull FROM projection_projects").fetchone()
            self.assertTrue(Path(Workspace).is_relative_to(self.Preview))
            self.assertTrue(Path(Workspace).is_dir())
            self.assertEqual((Scripts, AutoPull), ("[]", 0))
            self.assertEqual(Copy.execute("SELECT * FROM projection_state ORDER BY projector").fetchall(),
                             self.Live.execute("SELECT * FROM projection_state ORDER BY projector").fetchall())
            Events = [(Kind, json.loads(Payload)) for Kind, Payload in Copy.execute("SELECT event_type,payload_json FROM orchestration_events")]
            self.assertTrue(any(Kind == "thread.session-set" and Payload["session"]["status"] == "stopped" for Kind, Payload in Events))
            self.assertTrue(any(Kind == "project.meta-updated" and Payload["workspaceRoot"] == Workspace for Kind, Payload in Events))
            Requests = [Payload["activity"]["payload"]["requestId"] for Kind, Payload in Events if Kind == "thread.activity-appended"]
            self.assertEqual(Requests, ["open"])
            self.assertEqual(Copy.execute("SELECT MIN(stream_version) FROM orchestration_events GROUP BY stream_id").fetchall(), [(0,), (0,)])
            Last = Copy.execute("SELECT event_type,occurred_at FROM orchestration_events WHERE stream_id='thread-one' ORDER BY sequence DESC LIMIT 1").fetchone()
            self.assertEqual(Last, ("thread.session-set", "2026-09-17T00:02:00.000Z"))
        self.assertEqual(self.Preview.stat().st_mode & 0o777, 0o700)
        self.assertEqual((self.Preview / "userdata/state.sqlite").stat().st_mode & 0o777, 0o600)
        self.assertEqual(list(self.Live.iterdump()), Before)

    def test_ExistingPreviewIsNeverReplaced(self):
        CopyHistory(self.Source, self.Preview)
        with self.assertRaisesRegex(RuntimeError, "refusing to replace"):
            CopyHistory(self.Source, self.Preview)

    def test_AttachmentsAreCopiedWithoutFollowingSymlinks(self):
        Attachments = self.Source.parent / "attachments"
        Attachments.mkdir()
        (Attachments / "image.png").write_bytes(b"image-data")
        (Attachments / "outside").symlink_to(self.Root, target_is_directory=True)
        CopyHistory(self.Source, self.Preview)
        Copied = self.Preview / "userdata/attachments"
        self.assertEqual((Copied / "image.png").read_bytes(), b"image-data")
        self.assertFalse((Copied / "outside").exists())


if __name__ == "__main__":
    unittest.main()
