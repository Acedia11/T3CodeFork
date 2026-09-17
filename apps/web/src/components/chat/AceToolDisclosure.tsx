import { useState, type ReactNode } from "react";
import { useMediaQuery } from "~/hooks/useMediaQuery";

export function AceToolDisclosure({
  Open,
  Id,
  Children,
}: {
  Open: boolean;
  Id: string;
  Children: ReactNode;
}) {
  const [Mounted, SetMounted] = useState(Open);
  const ReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  if (Open && !Mounted) SetMounted(true);
  if (!Open && Mounted && ReducedMotion) SetMounted(false);

  return (
    <div
      id={Id}
      className="AceToolFold"
      data-open={Open}
      aria-hidden={!Open}
      inert={!Open}
      onTransitionEnd={(Event) => {
        if (
          Event.target === Event.currentTarget &&
          Event.propertyName === "grid-template-rows" &&
          !Open
        )
          SetMounted(false);
      }}
    >
      <div className="AceToolFoldContent">{Open || Mounted ? Children : null}</div>
    </div>
  );
}
