import { ImagePlusIcon, RotateCcwIcon } from "lucide-react";
import { useId, useRef, useState, useSyncExternalStore } from "react";
import {
  AceDefaultWallpaper,
  ReadAceWallpaper,
  ResetAceWallpaper,
  SaveAceWallpaper,
  SubscribeAceWallpaper,
} from "../../AceWallpaper";
import { SettingsSection } from "./settingsLayout";
import "./AceWallpaper.css";

export function AceWallpaperSettings() {
  const Wallpaper = useSyncExternalStore(SubscribeAceWallpaper, ReadAceWallpaper, ReadAceWallpaper);
  const [Failure, SetFailure] = useState<string | null>(null);
  const [Loading, SetLoading] = useState(false);
  const Input = useRef<HTMLInputElement>(null);
  const InputId = useId();

  async function ChooseWallpaper(File: File) {
    SetFailure(null);
    SetLoading(true);
    try {
      await SaveAceWallpaper(File);
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

  function ResetWallpaper() {
    try {
      ResetAceWallpaper();
      SetFailure(null);
    } catch {
      SetFailure("The saved image could not be removed.");
    }
  }

  return (
    <SettingsSection id="appearance-wallpaper" title="Wallpaper">
      <div className="AceWallpaperSettings" aria-busy={Loading}>
        <div className="AceWallpaperPreview">
          <img src={Wallpaper ?? AceDefaultWallpaper} alt="Current Ace wallpaper" />
          <div className="AceWallpaperPreviewComposer" aria-hidden="true" />
        </div>
        <div className="AceWallpaperDetails">
          <p className="AceWallpaperName" aria-live="polite">
            {Wallpaper ? "Custom image" : "Sky"}
          </p>
          <p className="AceWallpaperDescription">
            Your sidebar, send button, and new-chat background. The chat background fades when you
            send a message.
          </p>
          <div className="AceWallpaperActions">
            <button
              type="button"
              className="AceWallpaperAction"
              aria-controls={InputId}
              disabled={Loading}
              onClick={() => Input.current?.click()}
            >
              <ImagePlusIcon size={15} aria-hidden="true" />
              {Loading ? "Saving image…" : "Choose image"}
            </button>
            <button
              type="button"
              className="AceWallpaperAction"
              data-secondary
              disabled={Loading || !Wallpaper}
              onClick={ResetWallpaper}
            >
              <RotateCcwIcon size={14} aria-hidden="true" />
              Reset default
            </button>
          </div>
          <p className="AceWallpaperHint">PNG, JPEG, WebP or AVIF · Up to 25 MB</p>
          {Failure && (
            <p role="alert" className="AceWallpaperFailure">
              {Failure}
            </p>
          )}
        </div>
        <input
          id={InputId}
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
    </SettingsSection>
  );
}
