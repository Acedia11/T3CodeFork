import { commandProgramName } from "@t3tools/client-runtime/work-log/command-label";
import {
  normalizeCompactToolLabel,
  resolveWorkEntryToolPresentation,
  toolGroupAction,
  workEntryDisplayIndicatesToolFailure,
} from "@t3tools/client-runtime/work-log/presentation";
import type { WorkLogEntry } from "../../session-logic";

export type AceToolKind = "read" | "edit" | "search" | "command" | "other";
export interface AceToolPresentation {
  Kind: AceToolKind;
  Label: string;
  Detail: string;
  Paths: readonly string[];
  Counts: Partial<Record<AceToolKind, number>>;
}

const AcePresentations = new WeakMap<WorkLogEntry, AceToolPresentation>();

function AcePresentation(
  Kind: AceToolKind,
  Label: string,
  Detail = "",
  Paths: readonly string[] = [],
): AceToolPresentation {
  const UniquePaths = [...new Set(Paths)];
  const CompactDetail = Detail.replace(/\s+/g, " ").trim();
  return {
    Kind,
    Label,
    Detail: CompactDetail.length > 180 ? `${CompactDetail.slice(0, 177)}…` : CompactDetail,
    Paths: UniquePaths,
    Counts: { [Kind]: Math.max(1, UniquePaths.length) },
  };
}

function AceRecord(Value: unknown): Record<string, unknown> | undefined {
  return Value !== null && typeof Value === "object" && !Array.isArray(Value)
    ? (Value as Record<string, unknown>)
    : undefined;
}

function AceInput(Entry: WorkLogEntry) {
  const Data = AceRecord(Entry.toolData);
  const Nested = Data?.arguments ?? Data?.input ?? Data?.rawInput;
  if (typeof Nested !== "string") return AceRecord(Nested) ?? Data;
  try {
    return AceRecord(JSON.parse(Nested));
  } catch {
    return undefined;
  }
}

function AceInputString(Entry: WorkLogEntry, Keys: readonly string[]) {
  const Input = AceInput(Entry);
  for (const Key of Keys) {
    const Value = Input?.[Key];
    if (typeof Value === "string" && Value.trim()) return Value.trim();
    // Provider previews can truncate JSON after an intact leading path/query.
    const Match = new RegExp(`"${Key}"\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`).exec(Entry.detail ?? "");
    if (Match) {
      try {
        return JSON.parse(Match[1]!) as string;
      } catch {
        continue;
      }
    }
  }
  return undefined;
}

function AcePath(Value: string | undefined) {
  const Path = Value?.replace(
    /^(?:read|reading|edit|edited|editing|write|created|updated|view)\s+/i,
    "",
  )
    .replace(/^[`"']|[`"']$/g, "")
    .trim();
  return Path && !/[\r\n{}]/.test(Path) && /[/\\]|\.[a-z0-9_-]{1,12}$/i.test(Path)
    ? Path
    : undefined;
}

function AceShellSegments(Command: string): string[][] | null {
  if (Command.length > 16_384 || /`|\$\(/.test(Command)) return null;
  const Segments: string[][] = [];
  let Tokens: string[] = [];
  let Token = "";
  let Quote = "";
  const FinishToken = () => {
    if (Token) Tokens.push(Token);
    Token = "";
  };
  for (let Index = 0; Index < Command.length; Index += 1) {
    const Character = Command[Index]!;
    if (Character === "\\" && Quote !== "'") {
      Token += Command[++Index] ?? "";
    } else if (Quote) {
      if (Character === Quote) Quote = "";
      else Token += Character;
    } else if (Character === '"' || Character === "'") {
      Quote = Character;
    } else if ("<>()".includes(Character)) {
      return null;
    } else if (";&|\n".includes(Character)) {
      FinishToken();
      if (Tokens.length) Segments.push(Tokens);
      Tokens = [];
      if (Segments.length > 64) return null;
    } else if (/\s/.test(Character)) {
      FinishToken();
    } else {
      Token += Character;
    }
  }
  if (Quote) return null;
  FinishToken();
  if (Tokens.length) Segments.push(Tokens);
  return Segments;
}

const AceSearchValueOptions = new Set([
  "-g",
  "--glob",
  "--iglob",
  "-t",
  "--type",
  "-T",
  "--type-not",
  "-A",
  "-B",
  "-C",
  "--after-context",
  "--before-context",
  "--context",
  "-m",
  "--max-count",
  "--max-columns",
  "--sort",
  "--sortr",
  "--encoding",
  "-j",
  "--threads",
  "--exclude",
  "--include",
]);

function AceShellPresentation(Tokens: readonly string[]): AceToolPresentation | null {
  const Program = Tokens[0]?.split(/[/\\]/).at(-1)?.toLowerCase();
  const Arguments = Tokens.slice(1);
  if (!Program) return null;
  if (["cat", "bat", "batcat", "head", "tail", "less", "more"].includes(Program)) {
    const Paths: string[] = [];
    for (let Index = 0; Index < Arguments.length; Index += 1) {
      const Argument = Arguments[Index]!;
      if (["-n", "-c", "--lines", "--bytes"].includes(Argument) && Program !== "cat") {
        Index += 1;
      } else if (!Argument.startsWith("-") && !/^\d+$/.test(Argument)) {
        Paths.push(Argument);
      }
    }
    return Paths.length ? AcePresentation("read", "Read", "", Paths) : null;
  }
  if (Program === "sed" && Arguments[0] === "-n") {
    return /^\d+(?:,(?:\d+|\$))?p$/.test(Arguments[1] ?? "") && Arguments.length > 2
      ? AcePresentation("read", "Read", "", Arguments.slice(2))
      : null;
  }
  if (["rg", "grep", "ag", "ack"].includes(Program)) {
    const Positional: string[] = [];
    let Pattern: string | undefined;
    let Glob: string | undefined;
    let OptionsEnded = false;
    for (let Index = 0; Index < Arguments.length; Index += 1) {
      const Argument = Arguments[Index]!;
      if (!OptionsEnded && Argument === "--") OptionsEnded = true;
      else if (!OptionsEnded && ["-e", "--regexp"].includes(Argument)) Pattern = Arguments[++Index];
      else if (!OptionsEnded && AceSearchValueOptions.has(Argument)) {
        const Value = Arguments[++Index];
        if (Argument === "-g" || Argument === "--glob") Glob = Value;
      } else if (OptionsEnded || !Argument.startsWith("-")) Positional.push(Argument);
    }
    const Files = Arguments.includes("--files");
    Pattern ??= Files ? (Glob ?? "files") : Positional.shift();
    const Location = Positional.join(", ");
    return AcePresentation(
      "search",
      Files ? "Find" : "Search",
      `${Pattern ?? "files"}${Location ? ` in ${Location}` : ""}`,
    );
  }
  if (Program === "find" || Program === "fd") {
    return AcePresentation("search", "Find", Arguments.join(" "));
  }
  return null;
}

function AceCommandPresentation(Command: string): AceToolPresentation {
  const Segments = AceShellSegments(Command);
  const Presentations: AceToolPresentation[] = [];
  let Recognized = Segments !== null;
  for (const Tokens of Segments ?? []) {
    if (Tokens[0] === "cd" && Tokens.length === 2) continue;
    const Presentation = AceShellPresentation(Tokens);
    if (!Presentation) {
      // A trailing output limiter has no file of its own to count.
      if (Presentations.length && /^(head|tail)$/.test(Tokens[0] ?? "")) continue;
      Recognized = false;
      break;
    }
    Presentations.push(Presentation);
  }
  if (Recognized && Presentations.length) {
    const First = Presentations[0]!;
    if (Presentations.every((Presentation) => Presentation.Kind === "read")) {
      return AcePresentation(
        "read",
        "Read",
        "",
        Presentations.flatMap((Presentation) => Presentation.Paths),
      );
    }
    if (Presentations.length === 1) return First;
    const Combined = AcePresentation(
      "search",
      "Explore",
      Presentations.map((Presentation) =>
        Presentation.Paths.length
          ? `${Presentation.Label} ${Presentation.Paths.map((Path) => Path.split(/[/\\]/).at(-1)).join(", ")}`
          : `${Presentation.Label} ${Presentation.Detail}`,
      ).join(" · "),
    );
    Combined.Counts = {};
    for (const Presentation of Presentations) {
      for (const [Kind, Count] of Object.entries(Presentation.Counts)) {
        const Key = Kind as AceToolKind;
        Combined.Counts[Key] = (Combined.Counts[Key] ?? 0) + Count;
      }
    }
    return Combined;
  }
  const FirstLine = Command.trim().split(/\r?\n/)[0] ?? "";
  const Program = commandProgramName(Command);
  const Detail = FirstLine.length <= 140 ? FirstLine : `${FirstLine.slice(0, 137)}…`;
  return AcePresentation("command", "Run", Detail || Program || "command");
}

function BuildAceToolPresentation(Entry: WorkLogEntry): AceToolPresentation {
  if (Entry.command?.trim()) return AceCommandPresentation(Entry.command.trim());
  const Title = normalizeCompactToolLabel(Entry.toolTitle ?? Entry.label);
  const Description = `${Title} ${Entry.label}`;
  const Action = toolGroupAction(Entry);
  const Native = resolveWorkEntryToolPresentation(Entry);
  if (Native) return AcePresentation("other", Native.displayName);
  if (Entry.questionAnswer || Entry.sourceActivityKind?.includes("approval")) {
    return AcePresentation("other", Title);
  }
  const Searching =
    /\b(?:grep|glob|search|searched|searching)\b/i.test(Description) ||
    Action === "search" ||
    Action === "code-search";
  if (Searching) {
    const Query = AceInputString(Entry, ["pattern", "query", "searchTerm", "glob"]);
    const Path = AceInputString(Entry, ["path", "directory"]);
    return AcePresentation(
      "search",
      /\bglob\b/i.test(Title) ? "Find" : "Search",
      Query ? `${Query}${Path ? ` in ${Path}` : ""}` : (Entry.detail ?? "files"),
    );
  }
  const Reading =
    /\b(?:read|reading|view|viewing|opened)\b/i.test(Description) || Action === "read";
  if (Reading || Action === "edit" || /\b(?:edit|write|patch)\b/i.test(Description)) {
    const Path =
      AceInputString(Entry, ["file_path", "filePath", "path", "filename"]) ??
      Entry.viewedImagePath ??
      AcePath(Entry.detail) ??
      AcePath(Title);
    const Paths = Reading
      ? Path
        ? [Path]
        : (Entry.changedFiles ?? [])
      : Entry.changedFiles?.length
        ? Entry.changedFiles
        : Path
          ? [Path]
          : [];
    return AcePresentation(
      Reading ? "read" : "edit",
      Reading ? "Read" : "Edit",
      Paths.length ? "" : "files",
      Paths,
    );
  }
  const Detail = Entry.toolSource?.name ?? Entry.detail?.split(/\r?\n/)[0] ?? "";
  return AcePresentation("other", Title, Detail === Title ? "" : Detail.slice(0, 140));
}

export function ResolveAceToolPresentation(Entry: WorkLogEntry): AceToolPresentation {
  const Cached = AcePresentations.get(Entry);
  if (Cached) return Cached;
  const Presentation = BuildAceToolPresentation(Entry);
  AcePresentations.set(Entry, Presentation);
  return Presentation;
}

export function SummarizeAceToolGroup(Entries: readonly WorkLogEntry[]) {
  const Counts: Partial<Record<AceToolKind, number>> = {};
  let Failed = 0;
  for (const Entry of Entries) {
    const Presentation = ResolveAceToolPresentation(Entry);
    for (const [Kind, Count] of Object.entries(Presentation.Counts)) {
      const Key = Kind as AceToolKind;
      Counts[Key] = (Counts[Key] ?? 0) + Count;
    }
    if (workEntryDisplayIndicatesToolFailure(Entry)) Failed += 1;
  }
  const Parts: string[] = [];
  if (Counts.command) Parts.push(`Ran ${Counts.command} command${Counts.command === 1 ? "" : "s"}`);
  if (Counts.read) Parts.push(`Read ${Counts.read} file${Counts.read === 1 ? "" : "s"}`);
  if (Counts.edit) Parts.push(`Edited ${Counts.edit} file${Counts.edit === 1 ? "" : "s"}`);
  if (Counts.search) Parts.push(`Searched ${Counts.search} time${Counts.search === 1 ? "" : "s"}`);
  if (Counts.other) Parts.push(`Used ${Counts.other} tool${Counts.other === 1 ? "" : "s"}`);
  if (Failed) Parts.push(`${Failed} failed`);
  return Parts.map((Part, Index) =>
    Index ? Part.charAt(0).toLowerCase() + Part.slice(1) : Part,
  ).join(" · ");
}
