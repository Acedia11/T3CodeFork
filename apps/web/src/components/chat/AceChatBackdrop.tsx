import { ImagePlusIcon, RotateCcwIcon } from "lucide-react";
import { useRef, useState } from "react";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

const WallpaperKey = "AcePreview.Wallpaper";

function ReadWallpaper() {
  try {
    return localStorage.getItem(WallpaperKey);
  } catch {
    return null;
  }
}

export function AceChatBackdrop({ Empty }: { Empty: boolean }) {
  const [Wallpaper, SetWallpaper] = useState(ReadWallpaper);
  const [Failure, SetFailure] = useState<string | null>(null);
  const [Loading, SetLoading] = useState(false);
  const Input = useRef<HTMLInputElement>(null);

  async function ChooseWallpaper(File: File) {
    SetFailure(null);
    SetLoading(true);
    try {
      if (!/^image\/(png|jpeg|webp|avif)$/.test(File.type) || File.size > 25 * 1024 * 1024) {
        throw new Error("Choose a PNG, JPEG, WebP, or AVIF image under 25 MB.");
      }
      const Picture = await createImageBitmap(File);
      try {
        const Scale = Math.min(1, 2048 / Math.max(Picture.width, Picture.height));
        const Canvas = document.createElement("canvas");
        Canvas.width = Math.max(1, Math.round(Picture.width * Scale));
        Canvas.height = Math.max(1, Math.round(Picture.height * Scale));
        const Context = Canvas.getContext("2d");
        if (!Context) throw new Error("This image could not be loaded.");
        Context.drawImage(Picture, 0, 0, Canvas.width, Canvas.height);
        const Data = Canvas.toDataURL("image/webp", 0.85);
        localStorage.setItem(WallpaperKey, Data);
        SetWallpaper(Data);
      } finally {
        Picture.close();
      }
    } catch (Cause) {
      SetFailure(
        Cause instanceof DOMException && Cause.name === "QuotaExceededError"
          ? "The image could not be saved. Try a smaller image."
          : Cause instanceof Error
            ? Cause.message
            : "This image could not be loaded.",
      );
    } finally {
      SetLoading(false);
    }
  }

  return (
    <>
      <div className="AceBackdrop" aria-hidden="true">
        <div
          className="AceBackdropImage"
          data-empty={Empty}
          style={Wallpaper ? { backgroundImage: `url(${Wallpaper})` } : undefined}
        />
      </div>
      <div className="AceBackdropControls" hidden={!Empty}>
        <Popover>
          <PopoverTrigger className="AceAppearanceButton" aria-label="Chat appearance">
            <ImagePlusIcon size={15} />
            <span>Appearance</span>
          </PopoverTrigger>
          <PopoverPopup align="end" side="top" className="w-64">
            <div className="space-y-3">
              <div>
                <p className="font-medium text-sm">Your new-chat canvas</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  The image fades away when you send a message.
                </p>
              </div>
              <button
                className="AceWallpaperButton"
                disabled={Loading}
                onClick={() => Input.current?.click()}
              >
                <ImagePlusIcon size={16} />
                {Loading ? "Loading image…" : "Choose image"}
              </button>
              {Wallpaper && (
                <button
                  className="AceWallpaperButton"
                  onClick={() => {
                    try {
                      localStorage.removeItem(WallpaperKey);
                      SetWallpaper(null);
                      SetFailure(null);
                    } catch {
                      SetFailure("The saved image could not be removed.");
                    }
                  }}
                >
                  <RotateCcwIcon size={14} />
                  Reset background
                </button>
              )}
              {Failure && (
                <p role="alert" className="text-xs text-destructive">
                  {Failure}
                </p>
              )}
            </div>
          </PopoverPopup>
        </Popover>
        <input
          ref={Input}
          hidden
          type="file"
          accept="image/png,image/jpeg,image/webp,image/avif"
          onChange={(Event) => {
            const File = Event.currentTarget.files?.[0];
            Event.currentTarget.value = "";
            if (File) void ChooseWallpaper(File);
          }}
        />
      </div>
    </>
  );
}
