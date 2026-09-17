import json
import os
from pathlib import Path
import tempfile


def WritePrivateJson(Destination, Data):
    Destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    Descriptor, Temporary = tempfile.mkstemp(prefix=".AcePreview-", dir=Destination.parent)
    try:
        with os.fdopen(Descriptor, "w") as File:
            json.dump(Data, File, indent=2)
            File.write("\n")
        os.replace(Temporary, Destination)
    finally:
        Path(Temporary).unlink(missing_ok=True)


def ImportAccounts(Source, PreviewHome):
    Destination = PreviewHome / "userdata/settings.json"
    Marker = PreviewHome / "AccountsImported.json"
    if Destination.resolve() == Source.resolve():
        raise RuntimeError("Preview settings must be separate from the live settings.")
    if Marker.exists() or not Source.exists():
        return False

    Live = json.loads(Source.read_text())
    Preview = json.loads(Destination.read_text()) if Destination.exists() else {}
    Drivers = {"codex", "claudeAgent"}
    Imported = {
        "providers": {Key: Value for Key, Value in Live.get("providers", {}).items()
                      if Key in Drivers},
        # An environment override can select another login or reference a live secret store.
        "providerInstances": {Key: Value for Key, Value in Live.get("providerInstances", {}).items()
                              if Value.get("driver") in Drivers and not Value.get("environment")},
    }
    Merged = dict(Preview)
    for Group, Entries in Imported.items():
        if Entries:
            Merged[Group] = {**Entries, **Preview.get(Group, {})}

    PreviewHome.mkdir(parents=True, exist_ok=True, mode=0o700)
    PreviewHome.chmod(0o700)
    if Merged != Preview:
        WritePrivateJson(Destination, Merged)
    WritePrivateJson(Marker, {"Source": str(Source), "InstanceIds": list(Imported["providerInstances"])})
    return True
