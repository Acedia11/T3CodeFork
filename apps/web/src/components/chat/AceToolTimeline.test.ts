import { MessageId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import type { TimelineEntry, WorkLogEntry } from "../../session-logic";
import {
  deriveMessagesTimelineRows,
  deriveMessagesTimelineRowsWithState,
  type MessagesTimelineRow,
} from "./MessagesTimeline.logic";
import { ResolveAceToolPresentation, SummarizeAceToolGroup } from "./AceToolPresentation";
import { ProjectAceToolTimeline, ResolveAceToolGroupOpen } from "./AceToolTimeline.logic";

const Turn = TurnId.make("ace-tool-turn");
const CreatedAt = "2026-09-17T10:00:00.000Z";

function Tool(Fields: Partial<WorkLogEntry> = {}): WorkLogEntry {
  return {
    id: "read-file",
    createdAt: CreatedAt,
    turnId: Turn,
    toolCallId: "call-read-file",
    label: "Read file",
    tone: "tool",
    toolLifecycleStatus: "completed",
    sourceActivityKind: "tool.completed",
    ...Fields,
  };
}

function Derive(Entries: WorkLogEntry[], Response = false, ExpandedGroups?: Set<string>) {
  const Timeline: TimelineEntry[] = Entries.map((Entry) => ({
    kind: "work",
    id: Entry.id,
    createdAt: Entry.createdAt,
    entry: Entry,
  }));
  if (Response)
    Timeline.push({
      kind: "message",
      id: "answer",
      createdAt: CreatedAt,
      message: {
        id: MessageId.make("answer"),
        role: "assistant",
        turnId: Turn,
        text: "Here is how it works.",
        createdAt: CreatedAt,
        updatedAt: CreatedAt,
        streaming: true,
      },
    });
  return deriveMessagesTimelineRows({
    timelineEntries: Timeline,
    latestTurn: { turnId: Turn, state: "running", startedAt: CreatedAt, completedAt: null },
    runningTurnId: Turn,
    isWorking: true,
    activeTurnStartedAt: CreatedAt,
    turnDiffSummaries: [],
    supportsConversationRollback: false,
    ...(ExpandedGroups ? { expandedWorkGroupIds: ExpandedGroups } : {}),
  });
}

function Project(Entries: WorkLogEntry[], Response = false) {
  return ProjectAceToolTimeline(Derive(Entries, Response));
}

describe("Ace tool presentation", () => {
  it("recovers a native file path from a truncated provider preview", () => {
    const Entry = Tool({
      detail: 'Read: {"file_path":"/repo/src/Composer.tsx","offset":20,"content":"truncated...',
    });
    expect(ResolveAceToolPresentation(Entry)).toMatchObject({
      Kind: "read",
      Label: "Read",
      Paths: ["/repo/src/Composer.tsx"],
    });
  });

  it("presents quoted shell reads as file chips without changing the raw command", () => {
    const Command = "cd /repo && sed -n '1,200p' 'src/Chat View.tsx' && cat package.json";
    const Entry = Tool({ command: Command, itemType: "command_execution" });
    expect(ResolveAceToolPresentation(Entry)).toMatchObject({
      Kind: "read",
      Paths: ["src/Chat View.tsx", "package.json"],
      Counts: { read: 2 },
    });
    expect(Entry.command).toBe(Command);
    expect(SummarizeAceToolGroup([Entry])).toBe("Read 2 files");
  });

  it("separates search options from the query and directory", () => {
    const Entry = Tool({ command: "rg -n -g '*.tsx' -C 3 'TextDelta|ToolCall' src | head -80" });
    expect(ResolveAceToolPresentation(Entry)).toMatchObject({
      Kind: "search",
      Label: "Search",
      Detail: "TextDelta|ToolCall in src",
      Counts: { search: 1 },
    });
  });

  it("summarizes mixed shell exploration using its underlying actions", () => {
    const Entry = Tool({ command: "cat src/Chat.tsx && rg -n 'streaming' src" });
    expect(ResolveAceToolPresentation(Entry).Label).toBe("Explore");
    expect(SummarizeAceToolGroup([Entry])).toBe("Read 1 file · searched 1 time");
  });

  it("keeps edits, script bodies and redirections out of inferred file reads", () => {
    for (const Command of [
      "sed -i 's/old/new/g' src/App.tsx",
      "node -e 'console.log(\"cat src/App.tsx\")'",
      "cat src/App.tsx > backup.txt",
      "cat $(find src -name '*.tsx')",
    ]) {
      expect(ResolveAceToolPresentation(Tool({ command: Command })).Kind).toBe("command");
    }
  });

  it("counts file edits and retains failures in the compact summary", () => {
    expect(
      SummarizeAceToolGroup([
        Tool({
          label: "Changed files",
          itemType: "file_change",
          changedFiles: ["a.ts", "b.ts", "a.ts"],
        }),
        Tool({ command: "vp test", toolLifecycleStatus: "failed" }),
      ]),
    ).toBe("Ran 1 command · edited 2 files · 1 failed");
  });
});

describe("Ace streamed tool groups", () => {
  it("retains the same disclosure and raw entry as live activity becomes a single completed call", () => {
    const Entry = Tool({ detail: "src/Composer.tsx" });
    const Live = Project([Entry]).find((Row) => Row.kind === "activity-group");
    const Answer = Project([Entry], true).find((Row) => Row.kind === "activity-group");
    expect(Live?.active).toBe(true);
    expect(Answer?.active).toBe(false);
    expect(Answer?.id).toBe(Live?.id);
    expect(Answer?.entries[0]).toMatchObject({ entry: Entry });
    expect(ResolveAceToolGroupOpen(Live!.active, undefined)).toBe(true);
    expect(ResolveAceToolGroupOpen(Answer!.active, undefined)).toBe(false);
    expect(ResolveAceToolGroupOpen(Live!.active, false)).toBe(false);
    expect(ResolveAceToolGroupOpen(Answer!.active, true)).toBe(true);
  });

  it("carries every completed call into its folded group", () => {
    const Entries = [
      Tool({ detail: "a.ts" }),
      Tool({ id: "second", toolCallId: "call-second", detail: "b.ts" }),
    ];
    const Live = Project(Entries).find((Row) => Row.kind === "activity-group");
    const Answer = Project(Entries, true).find((Row) => Row.kind === "activity-group");
    expect(Answer?.id).toBe(Live?.id);
    expect(Answer?.entries.map((Entry) => (Entry.kind === "work" ? Entry.entry : null))).toEqual(
      Entries,
    );
  });

  it("leaves approval and subagent rows under the existing timeline behavior", () => {
    const Approval = Tool({ sourceActivityKind: "approval.requested", requestKind: "command" });
    const Spawn = Tool({ agentSpawn: { workflowId: null, agentTaskIds: ["agent-1"] } });
    for (const Entry of [Approval, Spawn]) {
      expect(Project([Entry], true).some((Row) => Row.kind === "activity-group")).toBe(false);
    }
  });

  it.each([
    ["failed calls", { toolLifecycleStatus: "failed" }],
    ["declined calls", { toolLifecycleStatus: "declined" }],
    ["missing-file output", { detail: "cat: missing.ts: No such file or directory" }],
    ["nonzero exit output", { detail: "Process exited with exit code 2" }],
  ] satisfies [string, Partial<WorkLogEntry>][])(
    "preserves the existing failure row for %s before and after the answer starts",
    (_, Fields) => {
      for (const Response of [false, true]) {
        const Rows = Derive([Tool(Fields)], Response);
        if (Response) expect(Rows.some((Row) => Row.kind === "work")).toBe(true);
        const Adapted = ProjectAceToolTimeline(Rows);
        expect(Adapted).toEqual(Rows);
        expect(Adapted.every((Row, Index) => Row === Rows[Index])).toBe(true);
      }
    },
  );

  it("does not classify error text inside a successful search command as failure", () => {
    const Rows = Project(
      [Tool({ command: 'rg "file not found" src', detail: "Found 3 matches" })],
      true,
    );
    expect(Rows.some((Row) => Row.kind === "activity-group")).toBe(true);
  });

  it.each([false, true])("preserves detail suppression on cached rows (failure: %s)", (Failed) => {
    const Entries = [
      Tool({ toolLifecycleStatus: Failed ? "failed" : "completed", detail: "a.ts" }),
      Tool({ id: "second", toolCallId: "call-second", detail: "b.ts" }),
    ];
    const Group = Derive(Entries, true).find((Row) => Row.kind === "work-toggle")!;
    expect(Group).toBeDefined();
    const Rows = Derive(Entries, true, new Set([Group.groupId]));
    const Details = Rows.find((Row) => Row.id === `${Group.groupId}:details`)!;
    expect(Details).toBeDefined();
    for (let Pass = 0; Pass < 2; Pass++) {
      const Adapted = ProjectAceToolTimeline(Rows);
      expect(Adapted.includes(Details)).toBe(Failed);
      expect(Adapted.some((Row) => Row.kind === "activity-group")).toBe(!Failed);
    }
  });

  it("reuses settled adaptations and entry arrays across assistant text updates", () => {
    const Entries = [Tool(), Tool({ id: "second", toolCallId: "call-second" })];
    const Native: MessagesTimelineRow = {
      kind: "activity-group",
      id: "native-activity",
      groupId: "native-group",
      createdAt: CreatedAt,
      turnId: Turn,
      entries: [{ kind: "work", id: Entries[0]!.id, createdAt: CreatedAt, entry: Entries[0]! }],
      expanded: false,
      active: false,
    };
    const Rows = [...Derive(Entries, true), Native];
    const First = ProjectAceToolTimeline(Rows);
    const UpdatedRows = Rows.map((Row) =>
      Row.kind === "message"
        ? { ...Row, message: { ...Row.message, text: `${Row.message.text} More text.` } }
        : Row,
    );
    const Updated = ProjectAceToolTimeline(UpdatedRows);
    const Groups = First.filter((Row) => Row.kind === "activity-group");
    const UpdatedGroups = Updated.filter((Row) => Row.kind === "activity-group");
    expect(Groups).toHaveLength(2);
    for (const Group of Groups) {
      const Retained = UpdatedGroups.find((Row) => Row.id === Group.id);
      expect(Retained).toBe(Group);
      expect(Retained?.entries).toBe(Group.entries);
    }
    expect(Updated.find((Row) => Row.kind === "message")?.message.text).toContain("More text.");
  });

  it("reclassifies an immutable row replacement when its tool completes with failure", () => {
    const Entry = Tool({ toolLifecycleStatus: "inProgress" });
    const Row = Derive([Entry]).find((Item) => Item.kind === "work-live")!;
    expect(Row).toBeDefined();
    expect(ProjectAceToolTimeline([Row])[0]?.kind).toBe("activity-group");
    const Failed = { ...Entry, toolLifecycleStatus: "failed" as const };
    const Replacement = { ...Row, entry: Failed, groupedEntries: [Failed], active: false };
    expect(ProjectAceToolTimeline([Replacement])[0]).toBe(Replacement);
  });
});

describe("Ace completed turns", () => {
  function Fixture(): Parameters<typeof deriveMessagesTimelineRows>[0] {
    const Timeline: TimelineEntry[] = [TurnId.make("previous-turn"), Turn].flatMap((TurnId) => {
      const Message = (Suffix: string): Extract<TimelineEntry, { kind: "message" }> => {
        const Id = `${TurnId}:${Suffix}`;
        return {
          kind: "message",
          id: Id,
          createdAt: CreatedAt,
          message: {
            id: MessageId.make(Id),
            turnId: TurnId,
            role: "assistant",
            text: Suffix,
            createdAt: CreatedAt,
            updatedAt: CreatedAt,
            streaming: false,
          },
        };
      };
      const Entry = Tool({ id: `${TurnId}:read`, toolCallId: `${TurnId}:call`, turnId: TurnId });
      return [
        Message("commentary"),
        { kind: "work", id: Entry.id, createdAt: CreatedAt, entry: Entry },
        Message("answer"),
      ];
    });
    return {
      timelineEntries: Timeline,
      latestTurn: {
        turnId: Turn,
        state: "completed",
        startedAt: CreatedAt,
        completedAt: "2026-09-17T10:00:18.000Z",
      },
      runningTurnId: null,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    };
  }

  it("keeps commentary and collapsed activity summaries in completed history", () => {
    const Input = Fixture();
    const Default = deriveMessagesTimelineRowsWithState(Input);
    expect(Default.rows.filter((Row) => Row.kind === "turn-fold")).toHaveLength(2);
    const Preview = deriveMessagesTimelineRowsWithState(
      { ...Input, FoldSettledTurns: false },
      Default,
    );
    const Rows = ProjectAceToolTimeline(Preview.rows);
    expect(Rows.map((Row) => Row.kind)).toEqual([
      "message",
      "activity-group",
      "message",
      "message",
      "activity-group",
      "message",
    ]);
    expect(Rows.filter((Row) => Row.kind === "message").map((Row) => Row.message.text)).toEqual([
      "commentary",
      "answer",
      "commentary",
      "answer",
    ]);
    const Groups = Rows.filter((Row) => Row.kind === "activity-group");
    expect(Groups).toHaveLength(2);
    for (const Group of Groups) {
      expect(ResolveAceToolGroupOpen(Group.active, undefined)).toBe(false);
      expect(ResolveAceToolGroupOpen(Group.active, true)).toBe(true);
      expect(Group.entries[0]?.kind).toBe("work");
    }
  });

  it("retains the tool disclosure and commentary when a running turn completes", () => {
    const Input = { ...Fixture(), FoldSettledTurns: false };
    const Live = ProjectAceToolTimeline(
      deriveMessagesTimelineRows({
        ...Input,
        timelineEntries: Input.timelineEntries.slice(0, -1),
        latestTurn: { turnId: Turn, state: "running", startedAt: CreatedAt, completedAt: null },
        runningTurnId: Turn,
        isWorking: true,
      }),
    );
    const Completed = ProjectAceToolTimeline(deriveMessagesTimelineRows(Input));
    const LiveGroup = Live.findLast((Row) => Row.kind === "activity-group")!;
    const CompletedGroup = Completed.findLast((Row) => Row.kind === "activity-group")!;
    expect(LiveGroup.active).toBe(true);
    expect(CompletedGroup.active).toBe(false);
    expect(CompletedGroup.id).toBe(LiveGroup.id);
    expect(CompletedGroup.entries[0]).toBe(LiveGroup.entries[0]);
    expect(Completed.some((Row) => Row.id === `${Turn}:commentary`)).toBe(true);
    expect(Completed.some((Row) => Row.kind === "turn-fold")).toBe(false);
  });

  it("reuses settled rows and compact groups while the current answer streams", () => {
    const Input = Fixture();
    const Timeline = Input.timelineEntries.map((Entry) =>
      Entry.kind === "message" && Entry.id === `${Turn}:answer`
        ? { ...Entry, message: { ...Entry.message, streaming: true } }
        : Entry,
    );
    const First = deriveMessagesTimelineRowsWithState({
      ...Input,
      timelineEntries: Timeline,
      FoldSettledTurns: false,
      latestTurn: { turnId: Turn, state: "running", startedAt: CreatedAt, completedAt: null },
      runningTurnId: Turn,
      isWorking: true,
    });
    const FirstRows = ProjectAceToolTimeline(First.rows);
    const Updated = deriveMessagesTimelineRowsWithState(
      {
        ...First.input,
        timelineEntries: Timeline.map((Entry) =>
          Entry.kind === "message" && Entry.message.streaming
            ? { ...Entry, message: { ...Entry.message, text: `${Entry.message.text} continues` } }
            : Entry,
        ),
      },
      First,
    );
    const UpdatedRows = ProjectAceToolTimeline(Updated.rows);
    for (const Row of FirstRows) {
      if (Row.kind === "activity-group" || Row.id.endsWith(":commentary")) {
        expect(UpdatedRows.find((Next) => Next.id === Row.id)).toBe(Row);
      }
    }
  });
});
