import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { useMediaQuery } from "~/hooks/useMediaQuery";

export const AceToolFoldDuration = 160;
const AceToolFoldStyle = {
  "--AceToolFoldDuration": `${AceToolFoldDuration}ms`,
} as CSSProperties;

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

  useEffect(() => {
    if (Open || !Mounted || ReducedMotion) return;
    // Canceled or zero-height transitions may never emit transitionend.
    const Timeout = setTimeout(() => SetMounted(false), AceToolFoldDuration + 50);
    return () => clearTimeout(Timeout);
  }, [Open, Mounted, ReducedMotion]);

  return (
    <div
      id={Id}
      className="AceToolFold"
      style={AceToolFoldStyle}
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
