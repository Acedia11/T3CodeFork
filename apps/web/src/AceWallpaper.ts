export const AceDefaultWallpaper = "/AceSkyWallpaper.webp";

const WallpaperKey = "AcePreview.Wallpaper";
const WallpaperChanged = "AcePreview.WallpaperChanged";

export function ReadAceWallpaper() {
  try {
    return localStorage.getItem(WallpaperKey);
  } catch {
    return null;
  }
}

export function SubscribeAceWallpaper(OnChange: () => void) {
  function HandleStorage(Event: StorageEvent) {
    if (Event.key === WallpaperKey || Event.key === null) OnChange();
  }

  window.addEventListener(WallpaperChanged, OnChange);
  window.addEventListener("storage", HandleStorage);
  return () => {
    window.removeEventListener(WallpaperChanged, OnChange);
    window.removeEventListener("storage", HandleStorage);
  };
}

export async function SaveAceWallpaper(File: File) {
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
    window.dispatchEvent(new Event(WallpaperChanged));
  } finally {
    Picture.close();
  }
}

export function ResetAceWallpaper() {
  localStorage.removeItem(WallpaperKey);
  window.dispatchEvent(new Event(WallpaperChanged));
}
