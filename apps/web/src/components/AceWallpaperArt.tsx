import { useSyncExternalStore } from "react";
import { AceDefaultWallpaper, ReadAceWallpaper, SubscribeAceWallpaper } from "../AceWallpaper";

export function AceWallpaperArt({ ClassName }: { ClassName: string }) {
  const Wallpaper = useSyncExternalStore(SubscribeAceWallpaper, ReadAceWallpaper, ReadAceWallpaper);
  return (
    <img
      className={ClassName}
      src={Wallpaper ?? AceDefaultWallpaper}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}
