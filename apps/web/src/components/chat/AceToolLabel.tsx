import { FileTextIcon, SearchIcon, SquarePenIcon, TerminalIcon } from "lucide-react";
import type { AceToolPresentation } from "./AceToolPresentation";
import { PierreEntryIcon } from "./PierreEntryIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function AceToolIcon({ Kind }: { Kind: AceToolPresentation["Kind"] }) {
  const Icon =
    Kind === "read"
      ? FileTextIcon
      : Kind === "edit"
        ? SquarePenIcon
        : Kind === "search"
          ? SearchIcon
          : TerminalIcon;
  return <Icon aria-hidden className="size-4 shrink-0 stroke-[1.5]" />;
}

export function AceToolLabel({
  Presentation,
  Theme,
}: {
  Presentation: AceToolPresentation;
  Theme: "light" | "dark";
}) {
  return (
    <span className="AceToolLabel">
      <span className="AceToolVerb">{Presentation.Label}</span>
      {Presentation.Paths.slice(0, 3).map((Path) => (
        <Tooltip key={Path}>
          <TooltipTrigger render={<span className="AceToolFileChip" />}>
            <span className="AceToolFileIcon">
              <PierreEntryIcon pathValue={Path} kind="file" theme={Theme} className="size-3.5" />
            </span>
            <span>{Path.split(/[/\\]/).at(-1) || Path}</span>
          </TooltipTrigger>
          <TooltipPopup>{Path}</TooltipPopup>
        </Tooltip>
      ))}
      {Presentation.Paths.length > 3 ? (
        <span className="AceToolDetail">+{Presentation.Paths.length - 3} more</span>
      ) : null}
      {Presentation.Detail ? <span className="AceToolDetail">{Presentation.Detail}</span> : null}
    </span>
  );
}
