import argparse
import json
import os
from pathlib import Path

from PreviewAccounts import ImportAccounts


def Main():
    Parser = argparse.ArgumentParser(description="Open Ace with separate preview data.")
    Parser.add_argument("--dev", dest="Dev", action="store_true", help="Reload the UI as source files change")
    Arguments = Parser.parse_args()
    ConfigPath = Path.home() / "Library/Application Support/T3CodeFork/Config.json"
    Config = json.loads(ConfigPath.read_text())
    PreviewHome = ConfigPath.parent / "Preview"
    PreviewHome.mkdir(parents=True, exist_ok=True, mode=0o700)
    PreviewHome.chmod(0o700)
    ImportAccounts(Path.home() / ".t3/userdata/settings.json", PreviewHome)
    Environment = dict(os.environ)
    Environment["PATH"] = os.pathsep.join((str(Path(Config["SourceRoot"]) / "node_modules/.bin"),
                                           Config["BuildPath"], Environment.get("PATH", "")))
    for Key in ("VITE_HTTP_URL", "VITE_WS_URL", "T3CODE_PORT", "T3CODE_HOME",
                "T3CODE_PORT_OFFSET", "T3CODE_FORK_BUILD", "ELECTRON_RUN_AS_NODE"):
        Environment.pop(Key, None)
    Environment.update({"T3CODE_DEV_INSTANCE": "AcePreview",
                        "T3CODE_DISABLE_AUTO_UPDATE": "1",
                        "VITE_T3CODE_ACE_PREVIEW": "1"})
    Environment.setdefault("T3CODE_BUNDLED_DEV", "1")
    Mode = "dev:desktop" if Arguments.Dev else "preview:desktop"
    print(f"Starting Ace's {Mode} (PID {os.getpid()}). Separate data: {PreviewHome}", flush=True)
    os.chdir(Config["SourceRoot"])
    os.execvpe("node", ["node", "scripts/dev-runner.ts", Mode,
                       "--home-dir", str(PreviewHome)], Environment)


if __name__ == "__main__":
    Main()
