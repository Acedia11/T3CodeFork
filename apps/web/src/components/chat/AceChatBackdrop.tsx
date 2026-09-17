import { useSyncExternalStore } from "react";
import { AceDefaultWallpaper, ReadAceWallpaper, SubscribeAceWallpaper } from "../../AceWallpaper";

export function AceChatBackdrop({ Empty }: { Empty: boolean }) {
  const Wallpaper = useSyncExternalStore(SubscribeAceWallpaper, ReadAceWallpaper, ReadAceWallpaper);

  return (
    <div
      className="AceBackdrop"
      data-empty={Empty}
      data-custom={Boolean(Wallpaper)}
      aria-hidden="true"
    >
      <div
        className="AceBackdropImage"
        data-empty={Empty}
        data-custom={Boolean(Wallpaper)}
        style={{ backgroundImage: `url(${Wallpaper ?? AceDefaultWallpaper})` }}
      />
    </div>
  );
}
