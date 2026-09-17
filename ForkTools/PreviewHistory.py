import datetime
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
import uuid


def IsolateHistory(Database, PreviewHome):
    Now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    Database.row_factory = sqlite3.Row

    def Append(Kind, Id, Type, Payload, Timestamp=Now):
        Version = Database.execute(
            "SELECT COALESCE(MAX(stream_version) + 1, 0) FROM orchestration_events WHERE aggregate_kind=? AND stream_id=?",
            (Kind, Id),
        ).fetchone()[0]
        Database.execute(
            "INSERT INTO orchestration_events (event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json) VALUES (?,?,?,?,?,?,?,?,?)",
            (str(uuid.uuid4()), Kind, Id, Version, Type, Timestamp, "server", json.dumps(Payload), "{}"),
        )

    for Project in Database.execute("SELECT * FROM projection_projects").fetchall():
        Id = Project["project_id"]
        Workspace = PreviewHome / "Projects" / hashlib.sha256(Id.encode()).hexdigest()[:16]
        Workspace.mkdir(parents=True, exist_ok=True)
        Database.execute("UPDATE projection_projects SET workspace_root=?,scripts_json='[]',auto_pull=0,default_thread_env_mode='local' WHERE project_id=?", (str(Workspace), Id))
        Append("project", Id, "project.meta-updated", {
            "projectId": Id, "workspaceRoot": str(Workspace), "repositoryIdentity": None,
            "scripts": [], "autoPull": False, "defaultThreadEnvMode": "local",
            "updatedAt": Project["updated_at"],
        }, Project["updated_at"])

    for Link in Database.execute("SELECT * FROM projection_thread_pull_requests").fetchall():
        Append("thread", Link["thread_id"], "thread.pull-request-unlinked", {
            "threadId": Link["thread_id"], "host": Link["host"],
            "repository": Link["repository"], "number": Link["number"], "updatedAt": Now,
        })

    for Message in Database.execute("SELECT * FROM projection_thread_messages WHERE is_streaming=1").fetchall():
        Append("thread", Message["thread_id"], "thread.message-sent", {
            "threadId": Message["thread_id"], "messageId": Message["message_id"],
            "role": Message["role"], "turnId": Message["turn_id"], "text": "",
            "streaming": False, "createdAt": Message["created_at"], "updatedAt": Message["updated_at"],
        }, Message["updated_at"])

    Requests = {}
    Activities = Database.execute("SELECT thread_id,turn_id,kind,payload_json FROM projection_thread_activities WHERE kind IN ('approval.requested','approval.resolved','user-input.requested','user-input.resolved') ORDER BY created_at,activity_id")
    for Request in Activities:
        Payload = json.loads(Request["payload_json"])
        RequestId = Payload.get("requestId") if isinstance(Payload, dict) else None
        if not RequestId:
            continue
        Key = (Request["thread_id"], Request["kind"].split(".")[0], RequestId)
        if Request["kind"].endswith(".resolved"):
            Requests.pop(Key, None)
        else:
            Requests[Key] = Request
    for (_, _, RequestId), Request in Requests.items():
        Kind = Request["kind"].replace(".requested", ".resolved")
        Append("thread", Request["thread_id"], "thread.activity-appended", {
            "threadId": Request["thread_id"], "activity": {
                "id": str(uuid.uuid4()), "kind": Kind, "tone": "info",
                "summary": "Request closed in preview snapshot", "turnId": Request["turn_id"],
                "createdAt": Now, "payload": {"requestId": RequestId, "decision": "cancel"},
            },
        })

    # These final events preserve thread ordering after message/request cleanup replays.
    for Thread in Database.execute("SELECT * FROM projection_threads").fetchall():
        Id = Thread["thread_id"]
        Timestamp = Thread["updated_at"]
        Append("thread", Id, "thread.meta-updated", {
            "threadId": Id, "branch": None, "worktreePath": None,
            "linkedPullRequest": None, "branchPullRequest": None,
            "titleRegeneration": None, "titleState": None, "updatedAt": Timestamp,
        }, Timestamp)
        Append("thread", Id, "thread.session-set", {"threadId": Id, "session": {
            "threadId": Id, "status": "stopped", "providerName": None,
            "runtimeMode": Thread["runtime_mode"], "activeTurnId": None,
            "lastError": None, "updatedAt": Timestamp,
        }}, Timestamp)

    for Table in ("provider_session_runtime", "auth_sessions", "auth_pairing_links", "projection_thread_pull_requests"):
        Database.execute(f"DELETE FROM {Table}")
    Database.execute("UPDATE projection_thread_sessions SET status='stopped',active_turn_id=NULL,last_error=NULL,provider_name=NULL,provider_instance_id=NULL,provider_session_id=NULL,provider_thread_id=NULL")
    Database.execute("UPDATE projection_threads SET branch=NULL,worktree_path=NULL,linked_pull_request_json=NULL,branch_pull_request_json=NULL,title_regeneration_request_id=NULL,title_regeneration_started_at=NULL,title_state_json=NULL")
    Database.execute("UPDATE projection_thread_messages SET is_streaming=0")
    Database.commit()


def CopyHistory(Source, PreviewHome):
    Destination = PreviewHome / "userdata/state.sqlite"
    if Destination.exists():
        raise RuntimeError("Preview history already exists; refusing to replace test chats.")
    PreviewHome.mkdir(parents=True, exist_ok=True, mode=0o700)
    PreviewHome.chmod(0o700)
    Destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    Temporary = Destination.with_name("Preparing.sqlite")
    if Temporary.exists():
        raise RuntimeError(f"An unfinished snapshot exists at {Temporary}; inspect it before retrying.")
    with sqlite3.connect(Source.as_uri() + "?mode=ro", uri=True) as Live:
        Live.execute("VACUUM INTO ?", (str(Temporary),))
    Temporary.chmod(0o600)
    with sqlite3.connect(Temporary) as Copy:
        IsolateHistory(Copy, PreviewHome)
        if Copy.execute("PRAGMA quick_check").fetchone()[0] != "ok":
            raise RuntimeError("Preview database failed its integrity check.")
        Counts = {"Threads": Copy.execute("SELECT COUNT(*) FROM projection_threads").fetchone()[0],
                  "Messages": Copy.execute("SELECT COUNT(*) FROM projection_thread_messages").fetchone()[0]}
    Attachments = Source.parent / "attachments"
    if Attachments.exists():
        shutil.copytree(Attachments, Destination.parent / "attachments", dirs_exist_ok=True,
                        ignore=lambda Root, Names: [Name for Name in Names if (Path(Root) / Name).is_symlink()])
    Temporary.rename(Destination)
    (PreviewHome / "HistorySnapshot.json").write_text(json.dumps(Counts, indent=2) + "\n")
    return Counts


if __name__ == "__main__":
    print(CopyHistory(Path.home() / ".t3/userdata/state.sqlite",
                      Path.home() / "Library/Application Support/T3CodeFork/Preview"))
