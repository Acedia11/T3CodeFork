import { workEntryDisplayIndicatesToolFailure } from "@t3tools/client-runtime/work-log/presentation";
import type { TimelineEntry, WorkLogEntry } from "../../session-logic";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

const AceWorkEntries = new WeakMap<WorkLogEntry, Extract<TimelineEntry, { kind: "work" }>>();
const AceToolRows = new WeakMap<MessagesTimelineRow, MessagesTimelineRow>();

function AceWorkEntry(Entry: WorkLogEntry): Extract<TimelineEntry, { kind: "work" }> {
  const Cached = AceWorkEntries.get(Entry);
  if (Cached) return Cached;
  const Result = { kind: "work" as const, id: Entry.id, createdAt: Entry.createdAt, entry: Entry };
  AceWorkEntries.set(Entry, Result);
  return Result;
}

export function AceToolEntryKey(Entry: WorkLogEntry) {
  return Entry.toolCallId ? `tool:${Entry.turnId ?? "no-turn"}:${Entry.toolCallId}` : Entry.id;
}

export function ResolveAceToolGroupOpen(Active: boolean, Pinned: boolean | undefined) {
  return Pinned ?? Active;
}

function AdaptAceToolRow(Row: MessagesTimelineRow): MessagesTimelineRow {
  if (Row.kind === "activity-group") {
    return Row.id === Row.groupId ? Row : { ...Row, id: Row.groupId };
  }
  if (Row.kind !== "work-live" && Row.kind !== "work-toggle" && Row.kind !== "work") return Row;
  const Entries = Row.groupedEntries;
  const First = Entries?.[0];
  if (
    !First?.turnId ||
    !Entries ||
    (Row.kind === "work" && Row.isExpandedToolGroup) ||
    Entries.some(
      (Entry) =>
        Entry.agentSpawn ||
        Entry.questionAnswer ||
        workEntryDisplayIndicatesToolFailure(Entry) ||
        Entry.sourceActivityKind?.includes("approval") ||
        Entry.sourceActivityKind?.startsWith("user-input."),
    )
  ) {
    return Row;
  }
  const GroupId = Row.kind === "work" ? `work-group:${AceToolEntryKey(First)}` : Row.groupId;
  return {
    kind: "activity-group",
    id: GroupId,
    groupId: GroupId,
    createdAt: Row.createdAt,
    turnId: First.turnId,
    entries: Entries.map(AceWorkEntry),
    expanded: Row.kind !== "work" && Row.expanded,
    active: Row.kind === "work-live" && Row.active,
  };
}

/** Keep a tool group's identity and disclosure mounted through the answer handoff. */
export function ProjectAceToolTimeline(Rows: MessagesTimelineRow[]): MessagesTimelineRow[] {
  const Result: MessagesTimelineRow[] = [];
  const FoldedDetailIds = new Set<string>();
  for (const Row of Rows) {
    if (FoldedDetailIds.has(Row.id)) continue;
    let Adapted = AceToolRows.get(Row);
    if (!Adapted) {
      Adapted = AdaptAceToolRow(Row);
      AceToolRows.set(Row, Adapted);
    }
    if (Row.kind !== "activity-group" && Adapted.kind === "activity-group") {
      FoldedDetailIds.add(`${Adapted.groupId}:details`);
    }
    Result.push(Adapted);
  }
  return Result;
}
