import json
import os
import plistlib
import shutil
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import Updater


class UpdaterTests(unittest.TestCase):
    def setUp(self):
        self.Temporary = tempfile.TemporaryDirectory()
        self.Root = Path(self.Temporary.name)
        self.Upstream = self.Root / "Upstream"
        self.Upstream.mkdir()
        self.Git(self.Upstream, "init", "-b", "main")
        self.ConfigureGit(self.Upstream)
        (self.Upstream / "File.txt").write_text("original\n")
        self.Commit(self.Upstream, "initial")
        self.Repo = self.Root / "Fork"
        self.Git(self.Root, "clone", "--origin", "upstream", str(self.Upstream), str(self.Repo))
        self.ConfigureGit(self.Repo)
        self.Origin = self.Root / "Origin.git"
        self.Git(self.Root, "init", "--bare", str(self.Origin))
        self.Git(self.Repo, "remote", "add", "origin", str(self.Origin))
        self.Git(self.Repo, "push", "origin", "main")
        self.Config = {"SourceRoot": str(self.Repo), "CacheRoot": str(self.Root / "Cache"),
                       "AppPath": str(self.Root / "T3 Code (Ace).app"), "BuildPath": "/usr/bin:/bin"}
        self.Updater = Updater.ForkUpdater(self.Config)
        self.UpstreamPatch = patch.object(Updater, "Upstream", str(self.Upstream))
        self.UpstreamPatch.start()
        self.ConfigPatch = patch.object(Updater, "ConfigPath", self.Root / "Config.json")
        self.ConfigPatch.start()
        self.Tag = "v0.0.43-nightly.20260917.9999"

    def tearDown(self):
        self.UpstreamPatch.stop()
        self.ConfigPatch.stop()
        self.Temporary.cleanup()

    def Git(self, Directory, *Arguments):
        Result = subprocess.run(["git", "-c", "core.hooksPath=/dev/null", *Arguments], cwd=Directory,
                                text=True, capture_output=True, check=True)
        return Result.stdout.strip()

    def ConfigureGit(self, Directory):
        self.Git(Directory, "config", "user.name", "Fork Test")
        self.Git(Directory, "config", "user.email", "fork@example.invalid")
        self.Git(Directory, "config", "commit.gpgsign", "false")
        self.Git(Directory, "config", "core.hooksPath", "/dev/null")

    def Commit(self, Directory, Message):
        self.Git(Directory, "add", ".")
        self.Git(Directory, "commit", "-m", Message)
        return self.Git(Directory, "rev-parse", "HEAD")

    def Release(self, Conflict=False):
        (self.Upstream / ("File.txt" if Conflict else "New.txt")).write_text("upstream change\n")
        self.Commit(self.Upstream, "upstream change")
        self.Git(self.Upstream, "tag", self.Tag)
        return {"tag_name": self.Tag}

    def FakeManifest(self, Commit):
        App = self.Updater.Cache / "Candidates" / Commit / "App.app"
        App.mkdir(parents=True)
        (App / "Payload").write_text("validated")
        (App / "Contents/MacOS").mkdir(parents=True)
        (App / "Contents/MacOS/TestApp").write_text("test executable")
        with (App / "Contents/Info.plist").open("wb") as File:
            plistlib.dump({"CFBundleExecutable": "TestApp"}, File)
        return {"Commit": Commit, "App": str(App), "Digest": Updater.AppDigest(App),
                "Status": "ready", "Version": self.Tag[1:]}

    def test_CleanMergeDoesNotChangeCheckout(self):
        (self.Repo / "Custom.txt").write_text("my design")
        Before = self.Commit(self.Repo, "custom")
        Candidate = self.Updater.Check(self.Release())
        self.assertEqual(Candidate["Status"], "available")
        self.assertEqual(self.Git(self.Repo, "rev-parse", "HEAD"), Before)
        self.assertEqual(self.Git(self.Repo, "status", "--porcelain"), "")
        self.assertFalse((self.Repo / "New.txt").exists())

    def test_ConflictLeavesSourceAndHeadUnchanged(self):
        (self.Repo / "File.txt").write_text("my redesign\n")
        Before = self.Commit(self.Repo, "custom")
        with self.assertRaisesRegex(Updater.UpdateError, "conflicts with your fork"):
            self.Updater.Check(self.Release(Conflict=True))
        self.assertEqual(self.Git(self.Repo, "rev-parse", "HEAD"), Before)
        self.assertEqual((self.Repo / "File.txt").read_text(), "my redesign\n")
        self.assertEqual(self.Git(self.Repo, "status", "--porcelain"), "")
        self.assertIn("File.txt", (self.Updater.Cache / "Conflicts.txt").read_text())

    def test_UncommittedEditsPauseUpdates(self):
        Release = self.Release()
        (self.Repo / "File.txt").write_text("unfinished design")
        with self.assertRaisesRegex(Updater.UpdateError, "uncommitted edits"):
            self.Updater.Check(Release)
        self.assertEqual((self.Repo / "File.txt").read_text(), "unfinished design")

    def test_ChangesDuringBuildPreventPromotion(self):
        Candidate = self.Updater.Check(self.Release())
        Commit = self.Updater.CandidateCommit(Candidate)
        (self.Repo / "Custom.txt").write_text("new work")
        NewHead = self.Commit(self.Repo, "new work")
        with self.assertRaisesRegex(Updater.UpdateError, "source changed"):
            self.Updater.Promote(Candidate, self.FakeManifest(Commit))
        self.assertEqual(self.Git(self.Repo, "rev-parse", "HEAD"), NewHead)
        self.assertFalse((self.Updater.Cache / "Pending.json").exists())

    def test_ValidatedMergePromotesAndPushesMain(self):
        Candidate = self.Updater.Check(self.Release())
        Commit = self.Updater.CandidateCommit(Candidate)
        Manifest = self.FakeManifest(Commit)
        self.Updater.Promote(Candidate, Manifest)
        self.assertEqual(self.Git(self.Repo, "rev-parse", "HEAD"), Commit)
        self.assertEqual(self.Git(self.Origin, "rev-parse", "main"), Commit)
        self.assertEqual(self.Updater.Prepared()["Commit"], Commit)

    def test_FailedBuildLeavesMainUntouched(self):
        Before = self.Git(self.Repo, "rev-parse", "HEAD")
        Release = self.Release()
        with patch.object(self.Updater, "LatestNightly", return_value=Release), \
             patch.object(self.Updater, "Build", side_effect=Updater.UpdateError("build failed")):
            with self.assertRaisesRegex(Updater.UpdateError, "build failed"):
                self.Updater.Prepare("old")
        self.assertEqual(self.Git(self.Repo, "rev-parse", "HEAD"), Before)
        self.assertFalse((self.Updater.Cache / "Pending.json").exists())

    def test_PushFailureCanRetryWithoutRebuilding(self):
        Candidate = self.Updater.Check(self.Release())
        Commit = self.Updater.CandidateCommit(Candidate)
        Manifest = self.FakeManifest(Commit)
        OriginalGit = self.Updater.Git
        def FailPush(*Arguments, **Keywords):
            if Arguments[0] == "push":
                raise Updater.UpdateError("offline")
            return OriginalGit(*Arguments, **Keywords)
        with patch.object(self.Updater, "Git", side_effect=FailPush):
            with self.assertRaisesRegex(Updater.UpdateError, "offline"):
                self.Updater.Promote(Candidate, Manifest)
        with self.assertRaisesRegex(Updater.UpdateError, "not been pushed"):
            self.Updater.Prepared()
        with patch.object(self.Updater, "Build") as Build:
            Result = self.Updater.Prepare("old")
            self.assertTrue(Result["Published"])
            Build.assert_not_called()

    def test_FailedCandidateIsNotRebuiltByRepeatedChecks(self):
        Release = self.Release()
        with patch.object(self.Updater, "LatestNightly", return_value=Release), \
             patch.object(self.Updater, "Build", side_effect=Updater.UpdateError("startup failed")) as Build:
            with self.assertRaisesRegex(Updater.UpdateError, "startup failed"):
                self.Updater.Prepare("old")
            with self.assertRaisesRegex(Updater.UpdateError, "prepare --retry"):
                self.Updater.Prepare("old")
            self.assertEqual(Build.call_count, 1)
            with self.assertRaisesRegex(Updater.UpdateError, "startup failed"):
                self.Updater.Prepare("old", Retry=True)
            self.assertEqual(Build.call_count, 2)

    def test_ChangedBuildInputsAllowAnotherAttempt(self):
        Release = self.Release()
        with patch.object(self.Updater, "LatestNightly", return_value=Release), \
             patch.object(self.Updater, "Build", side_effect=Updater.UpdateError("startup failed")) as Build:
            def Attempt():
                with self.assertRaisesRegex(Updater.UpdateError, "^startup failed$"):
                    self.Updater.Prepare("old")
            Attempt()
            (self.Repo / "Fix.txt").write_text("fix")
            self.Commit(self.Repo, "fix startup")
            Attempt()
            self.Config["PublicBuildEnvironment"] = {"T3CODE_RELAY_URL": "https://example.invalid"}
            Attempt()
            self.Tag = "v0.0.43-nightly.20260918.1"
            (self.Upstream / "UpstreamFix.txt").write_text("upstream fix")
            self.Commit(self.Upstream, "fix")
            self.Git(self.Upstream, "tag", self.Tag)
            Release["tag_name"] = self.Tag
            Attempt()
            self.assertEqual(Build.call_count, 4)

    def test_CancelledBuildCanRetryAutomatically(self):
        Release = self.Release()
        with patch.object(self.Updater, "LatestNightly", return_value=Release), \
             patch.object(self.Updater, "Build", side_effect=Updater.UpdateCancelled("cancelled")) as Build:
            for _ in range(2):
                with self.assertRaises(Updater.UpdateCancelled):
                    self.Updater.Prepare("old")
            self.assertEqual(Build.call_count, 2)
        self.assertFalse((self.Updater.Cache / "FailedBuild.json").exists())

    def test_SmokeUsesAnIsolatedProfileAndMockKeychain(self):
        App = Path(self.FakeManifest("smoke")["App"])
        def Launch(Arguments, Directory, Environment, Log, Timeout):
            self.assertEqual(Arguments[1:], ["--use-mock-keychain"])
            self.assertEqual(Timeout, 120)
            Home = Path(Environment["T3CODE_HOME"])
            self.assertTrue(Home.is_relative_to(self.Updater.Cache))
            self.assertEqual(Environment["T3CODE_FORK_SMOKE"], "1")
            self.assertEqual(Environment["T3CODE_DISABLE_AUTO_UPDATE"], "true")
            self.assertNotIn("T3CODE_PORT", Environment)
            self.assertNotIn("VITE_DEV_SERVER_URL", Environment)
            (Home / "ForkSmokePassed.json").write_text("{}")
        with patch.object(self.Updater, "BuildCommand", side_effect=Launch):
            self.Updater.SmokeTest(App, self.Root / "Build.log")

    def test_MissingSmokeReceiptFailsEvenOnCleanExit(self):
        App = Path(self.FakeManifest("smoke")["App"])
        with patch.object(self.Updater, "BuildCommand"):
            with self.assertRaisesRegex(Updater.UpdateError, "did not finish"):
                self.Updater.SmokeTest(App, self.Root / "Build.log")

    def test_CommandTimeoutAndFailureStopOwnedChildren(self):
        for ExitCode in [0, 1, None]:
            with self.subTest(ExitCode=ExitCode):
                Receipt = self.Root / "Stopped.txt"
                Receipt.unlink(missing_ok=True)
                Child = ("import os, signal, sys; from pathlib import Path; "
                         "signal.signal(signal.SIGTERM, lambda *_: (Path(sys.argv[1]).write_text('stopped'), sys.exit(0))); "
                         "print('ready', flush=True); signal.pause()")
                Parent = ("import subprocess, sys, signal; "
                          "Child=subprocess.Popen([sys.executable, '-c', sys.argv[1], sys.argv[2]], stdout=subprocess.PIPE); "
                          "Child.stdout.readline(); " + ("signal.pause()" if ExitCode is None else f"sys.exit({ExitCode})"))
                Arguments = [sys.executable, "-c", Parent, Child, str(Receipt)]
                if ExitCode == 0:
                    self.Updater.BuildCommand(Arguments, self.Root, os.environ, self.Root / "Build.log", Timeout=1)
                else:
                    with self.assertRaisesRegex(Updater.UpdateError, "timed out" if ExitCode is None else "exit 1"):
                        self.Updater.BuildCommand(Arguments, self.Root, os.environ, self.Root / "Build.log", Timeout=1)
                self.assertEqual(Receipt.read_text(), "stopped")

    def test_ModifiedArtifactCannotInstall(self):
        Commit = self.Git(self.Repo, "rev-parse", "HEAD")
        Manifest = self.FakeManifest(Commit)
        Manifest["Published"] = True
        Updater.WriteJson(self.Updater.Cache / "Pending.json", Manifest)
        (Path(Manifest["App"]) / "Payload").write_text("changed after testing")
        with self.assertRaisesRegex(Updater.UpdateError, "changed after validation"):
            self.Updater.Prepared()

    def test_RemoteAdvanceDoesNotOverwriteMain(self):
        Candidate = self.Updater.Check(self.Release())
        Commit = self.Updater.CandidateCommit(Candidate)
        Other = self.Root / "Other"
        self.Git(self.Root, "clone", "-b", "main", str(self.Origin), str(Other))
        self.ConfigureGit(Other)
        (Other / "Other.txt").write_text("another session")
        self.Commit(Other, "other session")
        self.Git(Other, "push", "origin", "main")
        with self.assertRaisesRegex(Updater.UpdateError, "GitHub main has new changes"):
            self.Updater.Promote(Candidate, self.FakeManifest(Commit))
        self.assertEqual(self.Git(self.Repo, "rev-parse", "HEAD"), Candidate["Base"])

    def test_AlreadyMergedSourceStillBuildsWhenInstalledAppIsOlder(self):
        Release = self.Release()
        Candidate = self.Updater.Check(Release)
        Commit = self.Updater.CandidateCommit(Candidate)
        self.Git(self.Repo, "merge", "--ff-only", Commit)
        Manifest = self.FakeManifest(Commit)
        with patch.object(self.Updater, "LatestNightly", return_value=Release), \
             patch.object(self.Updater, "Build", return_value=Manifest) as Build:
            self.assertEqual(self.Updater.Prepare("old")["Status"], "ready")
            Build.assert_called_once_with(Commit, self.Tag[1:])

    def test_InstallationKeepsOldAppUntilCopyIsVerified(self):
        Commit = self.Git(self.Repo, "rev-parse", "HEAD")
        Manifest = self.FakeManifest(Commit)
        Manifest["Published"] = True
        Updater.WriteJson(self.Updater.Cache / "Pending.json", Manifest)
        shutil.copytree(Manifest["App"], self.Updater.AppPath)
        (self.Updater.AppPath / "Payload").write_text("old app")
        OriginalRun = Updater.Run
        def FailCopy(Arguments, *Args, **Keywords):
            if Arguments[0] == "lsof":
                return subprocess.CompletedProcess(Arguments, 1, "", "")
            if Arguments[0] == "ditto":
                raise Updater.UpdateError("copy failed")
            return OriginalRun(Arguments, *Args, **Keywords)
        with patch.object(Updater, "Run", side_effect=FailCopy), patch.object(Updater, "BackupUserData"):
            with self.assertRaisesRegex(Updater.UpdateError, "copy failed"):
                Updater.Install(self.Updater)
        self.assertEqual((self.Updater.AppPath / "Payload").read_text(), "old app")
        self.assertTrue((self.Updater.Cache / "Pending.json").exists())

    def test_InstallerRefusesToReplaceARunningApp(self):
        Commit = self.Git(self.Repo, "rev-parse", "HEAD")
        Manifest = self.FakeManifest(Commit)
        Manifest["Published"] = True
        Updater.WriteJson(self.Updater.Cache / "Pending.json", Manifest)
        shutil.copytree(Manifest["App"], self.Updater.AppPath)
        OriginalRun = Updater.Run
        def RunningApp(Arguments, *Args, **Keywords):
            if Arguments[0] == "lsof":
                return subprocess.CompletedProcess(Arguments, 0, "12345\n", "")
            return OriginalRun(Arguments, *Args, **Keywords)
        with patch.object(Updater, "Run", side_effect=RunningApp), \
             patch.object(Updater, "BackupUserData") as Backup:
            with self.assertRaisesRegex(Updater.UpdateError, "Quit T3 Code"):
                Updater.Install(self.Updater)
            Backup.assert_not_called()

    def test_MissingCloudConfigStopsBeforeBuilding(self):
        with patch.object(self.Updater, "BuildCommand") as Build:
            with self.assertRaisesRegex(Updater.UpdateError, "Cloud login build configuration is missing"):
                self.Updater.Build(self.Git(self.Repo, "rev-parse", "HEAD"), self.Tag[1:])
            Build.assert_not_called()

    def test_PreparedPollDoesNotRehashTheApp(self):
        Commit = self.Git(self.Repo, "rev-parse", "HEAD")
        Manifest = self.FakeManifest(Commit)
        Manifest["Published"] = True
        Updater.WriteJson(self.Updater.Cache / "Pending.json", Manifest)
        with patch.object(Updater, "AppDigest", side_effect=AssertionError("unexpected full app read")):
            self.assertEqual(self.Updater.Prepare("old")["Commit"], Commit)

    def test_InstallKeepsPriorAppAndRecordsInstalledCommit(self):
        Commit = self.Git(self.Repo, "rev-parse", "HEAD")
        Manifest = self.FakeManifest(Commit)
        Manifest["Published"] = True
        Updater.WriteJson(self.Updater.Cache / "Pending.json", Manifest)
        shutil.copytree(Manifest["App"], self.Updater.AppPath)
        (self.Updater.AppPath / "Payload").write_text("old app")
        OriginalRun = Updater.Run
        def ClosedApp(Arguments, *Args, **Keywords):
            if Arguments[0] == "lsof":
                return subprocess.CompletedProcess(Arguments, 1, "", "")
            return OriginalRun(Arguments, *Args, **Keywords)
        with patch.object(Updater, "Run", side_effect=ClosedApp), \
             patch.object(Updater, "BackupUserData", side_effect=lambda Cache: (Cache / "Backups").mkdir()):
            self.assertEqual(Updater.Install(self.Updater)["Status"], "installed")
        self.assertEqual((self.Updater.AppPath / "Payload").read_text(), "validated")
        self.assertEqual((self.Updater.Cache / "PreviousBundle/Payload").read_text(), "old app")
        self.assertEqual(json.loads(Updater.ConfigPath.read_text())["InstalledCommit"], Commit)
        self.assertFalse((self.Updater.Cache / "Pending.json").exists())

    def test_FailedFinalRenameRestoresPriorApp(self):
        Commit = self.Git(self.Repo, "rev-parse", "HEAD")
        Manifest = self.FakeManifest(Commit)
        Manifest["Published"] = True
        Updater.WriteJson(self.Updater.Cache / "Pending.json", Manifest)
        shutil.copytree(Manifest["App"], self.Updater.AppPath)
        (self.Updater.AppPath / "Payload").write_text("old app")
        OriginalRename = Path.rename
        def FailIncoming(PathValue, Target):
            if PathValue.name.endswith(".incoming.app"):
                raise OSError("rename failed")
            return OriginalRename(PathValue, Target)
        with patch.object(Path, "rename", FailIncoming), patch.object(Updater, "BackupUserData"):
            with self.assertRaisesRegex(OSError, "rename failed"):
                Updater.Install(self.Updater)
        self.assertEqual((self.Updater.AppPath / "Payload").read_text(), "old app")
        self.assertTrue((self.Updater.Cache / "Pending.json").exists())


if __name__ == "__main__":
    unittest.main()
