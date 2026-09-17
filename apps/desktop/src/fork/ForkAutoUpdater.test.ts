import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("electron", () => ({ app: {} }));

import { ForkAutoUpdater, ForkUpdateError, ReadForkFailure } from "./ForkAutoUpdater.ts";

const Version = "0.0.43-nightly.20260917.9999";

describe("fork updater", () => {
  it("does not install a stale candidate after the next prepare fails", async () => {
    const Install = vi.fn();
    const Run = vi
      .fn()
      .mockResolvedValueOnce({ Status: "ready", Version })
      .mockRejectedValueOnce(new ForkUpdateError("Source changed and the new merge conflicts"));
    const Updater = new ForkAutoUpdater({ Version, Run, Install, Quit: vi.fn() });
    await Updater.checkForUpdates();
    await expect(Updater.checkForUpdates()).rejects.toThrow("new merge conflicts");
    Updater.InstallOnQuit();
    expect(Install).not.toHaveBeenCalled();
    expect(() => Updater.quitAndInstall()).toThrow("No validated fork update");
  });

  it("reports validation failures even when Python returns non-JSON output", () => {
    expect(
      ReadForkFailure({
        stdout: Buffer.from("not JSON"),
        stderr: Buffer.from("Missing ForkUpdater.py"),
      }),
    ).toBe("Missing ForkUpdater.py");
    expect(
      ReadForkFailure({ stdout: Buffer.from('{"Event":"Error","Message":"Source changed"}') }),
    ).toBe("Source changed");
    expect(ReadForkFailure(new Error("spawn failed"))).toContain("could not be validated");
  });
  it("prepares a validated update through the existing progress events", async () => {
    const Events: string[] = [];
    const Updater = new ForkAutoUpdater({
      Version: "old",
      Run: async (OnEvent) => {
        OnEvent({ Event: "Available", Version });
        OnEvent({ Event: "Progress", Percent: 35 });
        return { Status: "ready", Version };
      },
      Install: vi.fn(),
      Quit: vi.fn(),
    });
    for (const Event of ["update-available", "download-progress", "update-downloaded"]) {
      Updater.on(Event, () => Events.push(Event));
    }
    await Updater.checkForUpdates();
    expect(Events).toEqual(["update-available", "download-progress", "update-downloaded"]);
  });

  it("does not offer or install a conflicting update", async () => {
    const Install = vi.fn();
    const Downloaded = vi.fn();
    const Updater = new ForkAutoUpdater({
      Version,
      Run: async () => {
        throw new ForkUpdateError("Conflict in Sidebar.tsx");
      },
      Install,
      Quit: vi.fn(),
    });
    Updater.on("update-downloaded", Downloaded);
    await expect(Updater.checkForUpdates()).rejects.toThrow("Conflict in Sidebar.tsx");
    Updater.InstallOnQuit();
    expect(Install).not.toHaveBeenCalled();
    expect(Downloaded).not.toHaveBeenCalled();
  });

  it("coalesces concurrent checks into one build", async () => {
    let Finish!: () => void;
    const Gate = new Promise<void>((Resolve) => {
      Finish = Resolve;
    });
    const Run = vi.fn(async () => {
      await Gate;
      return { Status: "current" as const, Version };
    });
    const Updater = new ForkAutoUpdater({ Version, Run, Install: vi.fn(), Quit: vi.fn() });
    const First = Updater.checkForUpdates();
    const Second = Updater.checkForUpdates();
    expect(First).toBe(Second);
    Finish();
    await First;
    expect(Run).toHaveBeenCalledTimes(1);
  });

  it("starts the installer once and only after a ready build", async () => {
    const Install = vi.fn();
    const Quit = vi.fn();
    const Updater = new ForkAutoUpdater({
      Version,
      Run: async () => ({ Status: "ready", Version }),
      Install,
      Quit,
    });
    expect(() => Updater.quitAndInstall()).toThrow("No validated fork update");
    await Updater.checkForUpdates();
    Updater.quitAndInstall(true, true);
    Updater.InstallOnQuit();
    expect(Install).toHaveBeenCalledExactlyOnceWith(true);
    expect(Quit).toHaveBeenCalledTimes(1);
  });

  it("keeps the app open when installation validation fails", async () => {
    const Quit = vi.fn();
    const Updater = new ForkAutoUpdater({
      Version,
      Run: async () => ({ Status: "ready", Version }),
      Install: () => {
        throw new ForkUpdateError("Source changed");
      },
      Quit,
    });
    await Updater.checkForUpdates();
    expect(() => Updater.quitAndInstall()).toThrow("Source changed");
    expect(Quit).not.toHaveBeenCalled();
  });

  it("never switches the fork to the official stable binary feed", async () => {
    const Run = vi.fn();
    const Updater = new ForkAutoUpdater({ Version, Run, Install: vi.fn(), Quit: vi.fn() });
    Updater.channel = "latest";
    await expect(Updater.checkForUpdates()).rejects.toThrow("follows Nightly");
    expect(Run).not.toHaveBeenCalled();
  });

  it("disarms a ready installer when a later check rejects the channel", async () => {
    const Install = vi.fn();
    const Updater = new ForkAutoUpdater({
      Version,
      Run: async () => ({ Status: "ready", Version }),
      Install,
      Quit: vi.fn(),
    });
    await Updater.checkForUpdates();
    Updater.channel = "latest";
    await expect(Updater.checkForUpdates()).rejects.toThrow("follows Nightly");
    Updater.InstallOnQuit();
    expect(Install).not.toHaveBeenCalled();
    expect(() => Updater.quitAndInstall()).toThrow("No validated fork update");
  });
});
