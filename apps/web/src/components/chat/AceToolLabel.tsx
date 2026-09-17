import { FileCode2Icon } from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function AceToolLabel({ Label }: { Label: string }) {
  const Match = /^(Read|Reading|Edit|Edited|Editing|Updated|Created|Opened|Viewing)\s+(.+)$/i.exec(
    Label,
  );
  if (!Match) return Label;
  const Path = Match[2]!.replace(/^[`"']|[`"']$/g, "");
  if (!/[/\\]|\.[a-z0-9]{1,8}$/i.test(Path) || Path.includes("\n")) return Label;
  const Filename = Path.split(/[/\\]/).at(-1) || Path;
  return (
    <span className="AceToolLabel">
      <span>{Match[1]}</span>
      <Tooltip>
        <TooltipTrigger render={<span className="AceFileChip" />}>
          <FileCode2Icon size={13} className="shrink-0 opacity-65" />
          <span>{Filename}</span>
        </TooltipTrigger>
        <TooltipPopup>{Path}</TooltipPopup>
      </Tooltip>
    </span>
  );
}
