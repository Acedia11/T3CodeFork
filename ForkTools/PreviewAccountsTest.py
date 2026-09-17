import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from PreviewAccounts import ImportAccounts


class PreviewAccountsTests(unittest.TestCase):
    def setUp(self):
        self.Temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.Temporary.cleanup)
        self.Root = Path(self.Temporary.name)
        self.Source = self.Root / "Live/userdata/settings.json"
        self.Source.parent.mkdir(parents=True)
        self.Preview = self.Root / "Preview"
        self.Destination = self.Preview / "userdata/settings.json"
        self.Live = {
            "projectSettingsOverrides": {"real-project": {"autoPull": True}},
            "providers": {"codex": {"homePath": "~/.codex"}},
            "providerInstances": {
                "codex_work": {"driver": "codex", "displayName": "Work", "enabled": True,
                               "config": {"shadowHomePath": "~/.codex-t3/work"}},
                "claude_work": {"driver": "claudeAgent", "displayName": "Work",
                                "config": {"homePath": "~/.claude-work"}},
            },
        }
        self.Source.write_text(json.dumps(self.Live))

    def WritePreview(self, Data):
        self.Destination.parent.mkdir(parents=True, exist_ok=True)
        self.Destination.write_text(json.dumps(Data))

    def test_ImportsSeparateAccountsWithoutLiveProjectSettings(self):
        Before = self.Source.read_bytes()
        self.assertTrue(ImportAccounts(self.Source, self.Preview))
        Copied = json.loads(self.Destination.read_text())
        self.assertEqual(Copied["providers"], self.Live["providers"])
        self.assertEqual(Copied["providerInstances"], self.Live["providerInstances"])
        self.assertNotIn("projectSettingsOverrides", Copied)
        self.assertEqual(self.Source.read_bytes(), Before)
        self.assertEqual(self.Preview.stat().st_mode & 0o777, 0o700)
        for File in [self.Destination, self.Preview / "AccountsImported.json"]:
            self.assertEqual(File.stat().st_mode & 0o777, 0o600)

    def test_PreservesPreviewOverridesChatsAndLaterAccountRemoval(self):
        Existing = {
            "responseStreamingMode": "buffered",
            "projectSettingsOverrides": {"sandbox": {"scripts": []}},
            "providers": {"codex": {"enabled": False}, "cursor": {"enabled": False}},
            "providerInstances": {
                "codex_work": {"driver": "codex", "enabled": False},
                "preview_only": {"driver": "claudeAgent", "displayName": "Test"},
            },
        }
        self.WritePreview(Existing)
        Database = self.Destination.parent / "state.sqlite"
        Database.write_bytes(b"preview history remains untouched")
        ImportAccounts(self.Source, self.Preview)
        Result = json.loads(self.Destination.read_text())
        for Key in ["responseStreamingMode", "projectSettingsOverrides", "providers"]:
            self.assertEqual(Result[Key], Existing[Key])
        for Key, Value in Existing["providerInstances"].items():
            self.assertEqual(Result["providerInstances"][Key], Value)
        self.assertIn("claude_work", Result["providerInstances"])
        self.assertEqual(Database.read_bytes(), b"preview history remains untouched")
        del Result["providerInstances"]["claude_work"]
        self.WritePreview(Result)
        Before = self.Destination.read_bytes()
        self.assertFalse(ImportAccounts(self.Source, self.Preview))
        self.assertEqual(self.Destination.read_bytes(), Before)

    def test_DoesNotImportOtherDriversOrEnvironmentDependentAccounts(self):
        self.Live["providers"]["antigravity"] = {"apiKey": "private-test-key"}
        self.Live["providerInstances"]["api_account"] = {
            "driver": "codex", "environment": [{"name": "OPENAI_API_KEY", "value": "private-test-key"}],
        }
        self.Live["providerInstances"]["remote"] = {
            "driver": "opencode", "config": {"serverPassword": "private-test-key"},
        }
        self.Source.write_text(json.dumps(self.Live))
        ImportAccounts(self.Source, self.Preview)
        Result = json.loads(self.Destination.read_text())
        self.assertEqual(set(Result["providerInstances"]), {"codex_work", "claude_work"})
        self.assertEqual(set(Result["providers"]), {"codex"})
        self.assertNotIn("private-test-key", self.Destination.read_text())

    def test_RefusesLiveDestination(self):
        Before = self.Source.read_bytes()
        with self.assertRaisesRegex(RuntimeError, "separate"):
            ImportAccounts(self.Source, self.Source.parent.parent)
        self.assertEqual(self.Source.read_bytes(), Before)

    def test_FailedAtomicWritePreservesSettingsAndCanRetry(self):
        self.WritePreview({"responseStreamingMode": "buffered"})
        Before = self.Destination.read_bytes()
        with patch("PreviewAccounts.os.replace", side_effect=OSError("test failure")):
            with self.assertRaises(OSError):
                ImportAccounts(self.Source, self.Preview)
        self.assertEqual(self.Destination.read_bytes(), Before)
        self.assertFalse((self.Preview / "AccountsImported.json").exists())
        self.assertEqual(list(self.Destination.parent.glob(".AcePreview-*")), [])
        self.assertTrue(ImportAccounts(self.Source, self.Preview))

    def test_MissingSourceDoesNotConsumeTheImport(self):
        Source = self.Source.with_name("Missing.json")
        self.assertFalse(ImportAccounts(Source, self.Preview))
        self.assertFalse(self.Preview.exists())
        Source.write_text(json.dumps(self.Live))
        self.assertTrue(ImportAccounts(Source, self.Preview))


if __name__ == "__main__":
    unittest.main()
