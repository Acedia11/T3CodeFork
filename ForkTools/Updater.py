#!/usr/bin/env python3
"""Build checked nightly merges without changing the editable checkout until validation passes."""

import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.request


ConfigPath = Path.home() / "Library/Application Support/T3CodeFork/Config.json"
NightlyPattern = re.compile(r"^v(\d+)\.(\d+)\.(\d+)-nightly\.(\d{8})\.(\d+)$")
Upstream = "https://github.com/pingdotgg/t3code.git"
PublicBuildKeys = ("T3CODE_CLERK_PUBLISHABLE_KEY", "T3CODE_CLERK_JWT_TEMPLATE",
                   "T3CODE_CLERK_CLI_OAUTH_CLIENT_ID", "T3CODE_RELAY_URL")


class UpdateError(Exception):
    pass


def Emit(Event, **Values):
    print(json.dumps({"Event": Event, **Values}), flush=True)


def WriteJson(PathValue, Value):
    PathValue.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    Temporary = PathValue.with_suffix(".tmp")
    with Temporary.open("w") as File:
        os.chmod(Temporary, 0o600)
        json.dump(Value, File, indent=2)
        File.flush()
        os.fsync(File.fileno())
    Temporary.replace(PathValue)


def Run(Arguments, Directory=None, Environment=None, Input=None, Check=True):
    Result = subprocess.run(
        [str(Value) for Value in Arguments], cwd=Directory, env=Environment,
        input=Input, text=True, capture_output=True, timeout=180,
    )
    if Check and Result.returncode:
        raise UpdateError((Result.stderr or Result.stdout).strip()[-6000:])
    return Result


class ForkUpdater:
    def __init__(self, Configuration):
        self.Config = Configuration
        self.Repo = Path(Configuration["SourceRoot"]).resolve()
        self.Cache = Path(Configuration["CacheRoot"]).resolve()
        self.AppPath = Path(Configuration["AppPath"])
        self.Environment = dict(os.environ, GIT_TERMINAL_PROMPT="0", COREPACK_ENABLE_DOWNLOAD_PROMPT="0")
        self.Environment["PATH"] = Configuration["BuildPath"] + os.pathsep + os.environ.get("PATH", "")
        self.Cache.mkdir(parents=True, exist_ok=True, mode=0o700)

    def Git(self, *Arguments, Check=True, Input=None):
        return Run(["git", *Arguments], self.Repo, self.Environment, Input, Check)

    @contextlib.contextmanager
    def Lock(self):
        with (self.Cache / "Update.lock").open("a") as File:
            try:
                fcntl.flock(File, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise UpdateError("A fork update is already running. Try again when it finishes.")
            for Stale in self.Cache.glob("Build-*"):
                if Stale.is_dir():
                    shutil.rmtree(Stale)
            yield

    def RequireCleanMain(self, ExpectedHead=None):
        if self.Git("branch", "--show-current").stdout.strip() != "main":
            raise UpdateError("Fork updates require the primary checkout on main.")
        if self.Git("status", "--porcelain", "--untracked-files=normal").stdout.strip():
            raise UpdateError("Fork updates are paused while your source has uncommitted edits. Commit them to main, then retry.")
        Head = self.Git("rev-parse", "HEAD").stdout.strip()
        if ExpectedHead and Head != ExpectedHead:
            raise UpdateError("Your source changed while the candidate was building. Retry to include the new changes.")
        if self.Git("remote", "get-url", "upstream").stdout.strip().removesuffix(".git") != Upstream.removesuffix(".git"):
            raise UpdateError("The upstream remote must point to pingdotgg/t3code.")
        return Head

    def LatestNightly(self):
        Request = urllib.request.Request(
            "https://api.github.com/repos/pingdotgg/t3code/releases?per_page=100",
            headers={"Accept": "application/vnd.github+json", "User-Agent": "T3CodeFork"},
        )
        with urllib.request.urlopen(Request, timeout=30) as Response:
            Releases = json.load(Response)
        Candidates = [Release for Release in Releases
                      if not Release["draft"] and Release.get("published_at")
                      and NightlyPattern.fullmatch(Release["tag_name"])
                      and any(Asset["name"].endswith("-arm64.zip") for Asset in Release.get("assets", []))]
        if not Candidates:
            raise UpdateError("No published Nightly with a macOS arm64 app was found.")
        return max(Candidates, key=lambda Release: tuple(map(int, NightlyPattern.fullmatch(Release["tag_name"]).groups())))

    def Check(self, Release=None):
        Head = self.RequireCleanMain()
        Release = Release or self.LatestNightly()
        Tag = Release["tag_name"]
        if not NightlyPattern.fullmatch(Tag):
            raise UpdateError("The release is not a published Nightly tag.")
        self.Git("fetch", "--no-tags", "upstream", f"refs/tags/{Tag}:refs/tags/{Tag}")
        UpstreamCommit = self.Git("rev-parse", f"{Tag}^{{commit}}").stdout.strip()
        if self.Git("merge-base", "--is-ancestor", UpstreamCommit, Head, Check=False).returncode == 0:
            return {"Status": "current", "Version": Tag[1:], "Commit": Head, "Tag": Tag}
        Merge = self.Git("merge-tree", "--write-tree", Head, UpstreamCommit, Check=False)
        if Merge.returncode == 1:
            Detail = "\n".join(Merge.stdout.splitlines()[1:])
            (self.Cache / "Conflicts.txt").write_text(Detail)
            raise UpdateError(f"Nightly {Tag} conflicts with your fork. Your source and installed app are unchanged. Resolve the merge in {self.Repo}, then retry.\n{Detail[-4000:]}")
        if Merge.returncode:
            raise UpdateError(f"Could not check the merge: {Merge.stderr[-4000:]}")
        Tree = Merge.stdout.splitlines()[0]
        return {"Status": "available", "Version": Tag[1:], "Tag": Tag, "Base": Head,
                "UpstreamCommit": UpstreamCommit, "Tree": Tree}

    def CandidateCommit(self, Candidate):
        return self.Git("commit-tree", Candidate["Tree"], "-p", Candidate["Base"], "-p", Candidate["UpstreamCommit"],
                        Input=f"chore(fork): sync {Candidate['Tag']}\n").stdout.strip()

    def BuildCommand(self, Arguments, Directory, Environment, Log):
        with Log.open("a") as Output:
            Output.write("\n" + " ".join(map(str, Arguments)) + "\n")
            Output.flush()
            Process = subprocess.Popen([str(Value) for Value in Arguments], cwd=Directory,
                                       env=Environment, stdout=Output, stderr=subprocess.STDOUT,
                                       start_new_session=True)
            try:
                Code = Process.wait(timeout=3600)
            except BaseException as Error:
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(Process.pid, signal.SIGTERM)
                try:
                    Process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    pass
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(Process.pid, signal.SIGKILL)
                Process.wait()
                if isinstance(Error, subprocess.TimeoutExpired):
                    raise UpdateError(f"Build timed out. See {Log}") from Error
                raise
        if Code:
            raise UpdateError(f"Build validation failed (exit {Code}). Your installed app is unchanged. See {Log}")

    def Build(self, Commit, Version):
        PublicEnvironment = self.Config.get("PublicBuildEnvironment", {})
        Missing = [Key for Key in PublicBuildKeys
                   if not isinstance(PublicEnvironment.get(Key), str) or not PublicEnvironment[Key].strip()]
        if Missing:
            raise UpdateError(f"Cloud login build configuration is missing from {ConfigPath}: {', '.join(Missing)}")
        if not NightlyPattern.fullmatch("v" + Version):
            raise UpdateError("A valid Nightly version is required.")
        Destination = self.Cache / "Candidates" / Commit
        if Destination.exists():
            shutil.rmtree(Destination)
        Destination.mkdir(parents=True, mode=0o700)
        Log = Destination / "Build.log"
        with tempfile.TemporaryDirectory(prefix="Build-", dir=self.Cache) as Temporary:
            Stage = Path(Temporary)
            Archive = Stage / "Source.tar"
            with Archive.open("wb") as Output:
                subprocess.run(["git", "archive", Commit], cwd=self.Repo, env=self.Environment, stdout=Output, check=True)
            Source = Stage / "Source"
            Source.mkdir()
            Run(["tar", "-xf", Archive, "-C", Source])
            Archive.unlink()
            Environment = dict(self.Environment, **PublicEnvironment)
            Environment.update({"T3CODE_FORK_BUILD": "1", "T3CODE_COMMIT_HASH": Commit,
                                "T3CODE_DESKTOP_UPDATE_REPOSITORY": self.Config["Repository"],
                                "CI": "true"})
            Environment["PATH"] = str(Source / "node_modules/.bin") + os.pathsep + Environment["PATH"]
            Emit("Progress", Percent=5)
            self.BuildCommand(["corepack", "pnpm", "install", "--frozen-lockfile"], Source, Environment, Log)
            Emit("Progress", Percent=20)
            self.BuildCommand([sys.executable, "-m", "unittest", "discover", "-s", "ForkTools", "-p", "*Test.py"], Source, Environment, Log)
            self.BuildCommand(["vp", "test", "run", "src/fork/ForkAutoUpdater.test.ts", "src/updates/updateMachine.test.ts", "src/updates/DesktopUpdates.test.ts"],
                              Source / "apps/desktop", Environment, Log)
            self.BuildCommand(["vp", "run", "--filter", "@t3tools/desktop", "typecheck"], Source, Environment, Log)
            self.BuildCommand(["vp", "run", "--filter", "@t3tools/web", "typecheck"], Source, Environment, Log)
            Emit("Progress", Percent=35)
            self.BuildCommand(["node", "scripts/build-desktop-artifact.ts", "--platform", "mac", "--target", "zip", "--arch", "arm64",
                               "--build-version", Version, "--output-dir", str(Destination)], Source, Environment, Log)
            Emit("Progress", Percent=85)
            Archives = list(Destination.glob("*-arm64.zip"))
            if len(Archives) != 1:
                raise UpdateError(f"Expected one packaged app archive in {Destination}.")
            self.BuildCommand(["ditto", "-x", "-k", Archives[0], Destination], Source, Environment, Log)
            Apps = list(Destination.glob("*.app"))
            if len(Apps) != 1:
                raise UpdateError("The build did not produce exactly one app.")
            BuiltApp = Apps[0]
            NamedApp = Destination / self.AppPath.name
            if BuiltApp != NamedApp:
                BuiltApp.rename(NamedApp)
            self.BuildCommand(["codesign", "--verify", "--deep", "--strict", NamedApp], Source, Environment, Log)
            self.SmokeTest(NamedApp, Log)
            Manifest = {"Status": "ready", "Version": Version, "Commit": Commit, "App": str(NamedApp),
                        "Digest": AppDigest(NamedApp), "BuiltAt": time.time()}
            WriteJson(Destination / "Manifest.json", Manifest)
            Archives[0].unlink()
            Emit("Progress", Percent=100)
            return Manifest

    def SmokeTest(self, App, Log):
        with (App / "Contents/Info.plist").open("rb") as File:
            Info = plistlib.load(File)
        Executable = App / "Contents/MacOS" / Info["CFBundleExecutable"]
        with tempfile.TemporaryDirectory(prefix="Smoke-", dir=self.Cache) as Temporary:
            Environment = dict(self.Environment, T3CODE_HOME=Temporary, T3CODE_FORK_SMOKE="1",
                               T3CODE_DISABLE_AUTO_UPDATE="true")
            Environment.pop("T3CODE_PORT", None)
            self.BuildCommand([Executable], self.Repo, Environment, Log)
            if not (Path(Temporary) / "ForkSmokePassed.json").exists():
                raise UpdateError(f"The packaged app did not finish its startup validation. See {Log}")

    def Promote(self, Candidate, Manifest):
        self.RequireCleanMain(Candidate["Base"])
        self.Git("fetch", "--no-tags", "origin", "main")
        Remote = self.Git("rev-parse", "FETCH_HEAD").stdout.strip()
        if self.Git("merge-base", "--is-ancestor", Remote, Candidate["Base"], Check=False).returncode:
            raise UpdateError("Your GitHub main has new changes. Sync main before retrying the fork update.")
        self.Git("merge", "--ff-only", Manifest["Commit"])
        WriteJson(self.Cache / "Pending.json", Manifest)
        self.PublishPrepared(Manifest)

    def PublishPrepared(self, Manifest):
        self.RequireCleanMain(Manifest["Commit"])
        self.Git("push", "origin", "main")
        Manifest["Published"] = True
        WriteJson(self.Cache / "Pending.json", Manifest)

    def Prepared(self, RequirePublished=True, VerifyDigest=True):
        Pending = self.Cache / "Pending.json"
        if not Pending.exists():
            return None
        Manifest = json.loads(Pending.read_text())
        self.RequireCleanMain(Manifest["Commit"])
        App = Path(Manifest["App"])
        if not App.is_relative_to(self.Cache / "Candidates") or not App.is_dir():
            raise UpdateError("The prepared app is missing. Build the fork again.")
        if VerifyDigest and AppDigest(App) != Manifest["Digest"]:
            raise UpdateError("The prepared app changed after validation. Build the fork again.")
        if RequirePublished and not Manifest.get("Published"):
            raise UpdateError("The build is validated but its commit has not been pushed. Retry the update to publish main before installing.")
        return Manifest

    def Prepare(self, CurrentVersion):
        Head = self.RequireCleanMain()
        PendingPath = self.Cache / "Pending.json"
        if PendingPath.exists() and json.loads(PendingPath.read_text())["Commit"] != Head:
            PendingPath.unlink()
        Prepared = self.Prepared(RequirePublished=False, VerifyDigest=False)
        if Prepared:
            if Prepared["Version"] == CurrentVersion and self.Config.get("InstalledCommit") == Prepared["Commit"]:
                (self.Cache / "Pending.json").unlink()
            else:
                if not Prepared.get("Published"):
                    self.PublishPrepared(Prepared)
                return Prepared
        Candidate = self.Check()
        if Candidate["Status"] == "current":
            if self.Config.get("InstalledCommit") == Candidate["Commit"] and CurrentVersion == Candidate["Version"]:
                return Candidate
            Emit("Available", Version=Candidate["Version"])
            Manifest = self.Build(Candidate["Commit"], Candidate["Version"])
            self.RequireCleanMain(Candidate["Commit"])
            WriteJson(self.Cache / "Pending.json", Manifest)
            self.PublishPrepared(Manifest)
            return Manifest
        Emit("Available", Version=Candidate["Version"])
        Commit = self.CandidateCommit(Candidate)
        Manifest = self.Build(Commit, Candidate["Version"])
        self.Promote(Candidate, Manifest)
        return Manifest


def AppDigest(App):
    Digest = hashlib.sha256()
    for Entry in sorted(App.rglob("*")):
        Relative = str(Entry.relative_to(App)).encode()
        if Entry.is_symlink():
            Digest.update(b"L" + Relative + os.readlink(Entry).encode())
        elif Entry.is_file():
            Digest.update(b"F" + Relative + str(Entry.stat().st_mode).encode())
            with Entry.open("rb") as File:
                for Block in iter(lambda: File.read(1024 * 1024), b""):
                    Digest.update(Block)
    return Digest.hexdigest()


def BackupUserData(Cache):
    Backup = Cache / "Backups" / time.strftime("%Y%m%d-%H%M%S")
    Backup.mkdir(parents=True, mode=0o700)
    State = Path.home() / ".t3/userdata"
    Database = State / "state.sqlite"
    if Database.exists():
        with sqlite3.connect(Database.as_uri() + "?mode=ro", uri=True) as Source:
            with sqlite3.connect(Backup / "state.sqlite") as Destination:
                Source.backup(Destination)
    for Entry in State.glob("*.json"):
        shutil.copy2(Entry, Backup / Entry.name)
    if (State / "secrets").is_dir():
        shutil.copytree(State / "secrets", Backup / "secrets")
    for Entry in Backup.rglob("*"):
        if Entry.is_file():
            Entry.chmod(0o600)
    return Backup


def Install(Updater, ParentPid=0, Reopen=False):
    Deadline = time.monotonic() + 180
    while ParentPid:
        try:
            os.kill(ParentPid, 0)
        except ProcessLookupError:
            break
        if time.monotonic() > Deadline:
            raise UpdateError("T3 did not quit. The prepared update was left pending.")
        time.sleep(0.5)
    Manifest = Updater.Prepared()
    if not Manifest:
        raise UpdateError("No validated fork update is ready.")
    App = Updater.AppPath
    def RequireAppClosed():
        if not App.exists():
            return
        with (App / "Contents/Info.plist").open("rb") as File:
            Info = plistlib.load(File)
        Executable = App / "Contents/MacOS" / Info["CFBundleExecutable"]
        if Run(["lsof", "-t", "--", Executable], Check=False).stdout.strip():
            raise UpdateError("Quit T3 Code (Ace) before installing the prepared update.")
    RequireAppClosed()
    BackupUserData(Updater.Cache)
    Incoming = App.with_name(App.stem + ".incoming.app")
    Previous = Updater.Cache / "PreviousBundle"
    if Incoming.exists():
        shutil.rmtree(Incoming)
    Run(["ditto", Manifest["App"], Incoming])
    if AppDigest(Incoming) != Manifest["Digest"]:
        raise UpdateError("The installed copy failed verification. The current app was kept.")
    RequireAppClosed()
    if Previous.exists():
        shutil.rmtree(Previous)
    if App.exists():
        App.rename(Previous)
    try:
        Incoming.rename(App)
    except OSError:
        if Previous.exists() and not App.exists():
            Previous.rename(App)
        raise
    Updater.Config["InstalledCommit"] = Manifest["Commit"]
    WriteJson(ConfigPath, Updater.Config)
    (Updater.Cache / "Pending.json").unlink()
    for Directory in (Updater.Cache / "Candidates").iterdir():
        if Directory.name != Manifest["Commit"] and Directory.is_dir():
            shutil.rmtree(Directory)
    for Directory in sorted((Updater.Cache / "Backups").iterdir(), reverse=True)[3:]:
        if Directory.is_dir():
            shutil.rmtree(Directory)
    if Reopen:
        Run(["open", str(App)])
    return {"Status": "installed", "Version": Manifest["Version"], "App": str(App)}


def Main():
    Parser = argparse.ArgumentParser()
    Parser.add_argument("Action", choices=["check", "prepare", "build", "validate", "install"])
    Parser.add_argument("--current-version", default="")
    Parser.add_argument("--parent-pid", type=int, default=0)
    Parser.add_argument("--reopen", action="store_true")
    Arguments = Parser.parse_args()
    def Cancel(Signum, Frame):
        raise UpdateError("Fork update cancelled because the app is closing. Retry when it reopens.")
    signal.signal(signal.SIGTERM, Cancel)
    try:
        Updater = ForkUpdater(json.loads(ConfigPath.read_text()))
        with Updater.Lock():
            if Arguments.Action == "check":
                Result = Updater.Check()
            elif Arguments.Action == "prepare":
                Result = Updater.Prepare(Arguments.current_version)
            elif Arguments.Action == "validate":
                Result = Updater.Prepared()
                if not Result:
                    raise UpdateError("No validated fork update is ready.")
            elif Arguments.Action == "build":
                Commit = Updater.RequireCleanMain()
                Version = Updater.Git("describe", "--tags", "--match", "v*-nightly.*", "--abbrev=0").stdout.strip()[1:]
                Result = Updater.Build(Commit, Version)
                Updater.RequireCleanMain(Commit)
                WriteJson(Updater.Cache / "Pending.json", Result)
                Updater.PublishPrepared(Result)
            else:
                Result = Install(Updater, Arguments.parent_pid, Arguments.reopen)
            Emit("Result", Result=Result)
    except Exception as Error:
        Emit("Error", Message=str(Error))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(Main())
