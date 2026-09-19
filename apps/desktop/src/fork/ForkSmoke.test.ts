// @effect-diagnostics nodeBuiltinImport:off - Tests mock the packaged-app receipt without filesystem writes.
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

const App = vi.hoisted(() => ({
  on: vi.fn(),
  quit: vi.fn(),
  exit: vi.fn(),
  getPath: vi.fn(),
  getVersion: vi.fn(),
}));
vi.mock("electron", () => ({ app: App }));
vi.mock("node:fs", () => ({ writeFileSync: vi.fn() }));
vi.mock("node:timers", () => ({ setTimeout: vi.fn(), clearTimeout: vi.fn() }));

import { InitializeForkSmoke } from "./ForkSmoke.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("fork startup validation", () => {
  it("does not install test hooks in the normal app", () => {
    vi.stubEnv("T3CODE_FORK_SMOKE", undefined);
    InitializeForkSmoke();
    expect(App.on).not.toHaveBeenCalled();
  });

  it("refuses to run without an isolated home", () => {
    vi.stubEnv("T3CODE_FORK_SMOKE", "1");
    vi.stubEnv("T3CODE_HOME", undefined);
    expect(InitializeForkSmoke).toThrow("isolated T3CODE_HOME");
  });

  it("lets the app clean up its backend when rendering fails", async () => {
    vi.stubEnv("T3CODE_FORK_SMOKE", "1");
    vi.stubEnv("T3CODE_HOME", "/tmp/ForkSmoke");
    const ErrorOutput = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const Quit = new Promise<void>((Resolve) => App.quit.mockImplementationOnce(Resolve));
      InitializeForkSmoke();
      const Window = new NodeEvents.EventEmitter();
      const WebContents = Object.assign(new NodeEvents.EventEmitter(), {
        getURL: () => "t3code://app/",
        executeJavaScript: () => Promise.reject(new Error("render failed")),
      });
      const OnWindow = App.on.mock.calls.find(([Name]) => Name === "browser-window-created")![1];
      OnWindow({}, Object.assign(Window, { webContents: WebContents }));
      WebContents.emit("did-finish-load");
      await Quit;
      expect(App.quit).toHaveBeenCalledOnce();
      expect(App.exit).not.toHaveBeenCalled();
      expect(ErrorOutput).toHaveBeenCalledWith("Error: render failed\n");
    } finally {
      ErrorOutput.mockRestore();
    }
  });

  it.each([false, true])("accepts only the rendered Ace appearance: %s", async (AceAppearance) => {
    vi.stubEnv("T3CODE_FORK_SMOKE", "1");
    vi.stubEnv("T3CODE_HOME", "/tmp/ForkSmoke");
    App.getPath.mockReturnValue("/tmp/ForkSmoke/t3code");
    App.getVersion.mockReturnValue("test-version");
    const ErrorOutput = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const Quit = new Promise<void>((Resolve) => App.quit.mockImplementationOnce(Resolve));
      InitializeForkSmoke();
      const WebContents = Object.assign(new NodeEvents.EventEmitter(), {
        getURL: () => "t3code://app/",
        getZoomFactor: () => 1,
        executeJavaScript: () => Promise.resolve(AceAppearance),
      });
      const Window = Object.assign(new NodeEvents.EventEmitter(), {
        webContents: WebContents,
        getWindowButtonPosition: () => ({ x: 16, y: 13 }),
      });
      const OnWindow = App.on.mock.calls.find(([Name]) => Name === "browser-window-created")![1];
      OnWindow({}, Window);
      WebContents.emit("did-finish-load");
      await Quit;
      if (AceAppearance) {
        expect(NodeFS.writeFileSync).toHaveBeenCalledWith(
          "/tmp/ForkSmoke/ForkSmokePassed.json",
          JSON.stringify({ Version: "test-version", AceAppearance: true }),
        );
        expect(ErrorOutput).not.toHaveBeenCalled();
      } else {
        expect(NodeFS.writeFileSync).not.toHaveBeenCalled();
        expect(ErrorOutput).toHaveBeenCalledWith("Error: The packaged Ace appearance is missing\n");
      }
    } finally {
      ErrorOutput.mockRestore();
    }
  });

  it.skipIf(HostProcessPlatform.defaultValue() !== "darwin")(
    "rejects production controls with the old header height",
    async () => {
      vi.stubEnv("T3CODE_FORK_SMOKE", "1");
      vi.stubEnv("T3CODE_HOME", "/tmp/ForkSmoke");
      App.getPath.mockReturnValue("/tmp/ForkSmoke/t3code");
      const ErrorOutput = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      try {
        const Quit = new Promise<void>((Resolve) => App.quit.mockImplementationOnce(Resolve));
        InitializeForkSmoke();
        const WebContents = Object.assign(new NodeEvents.EventEmitter(), {
          getURL: () => "t3code://app/",
          getZoomFactor: () => 1,
          executeJavaScript: () => Promise.resolve(true),
        });
        const Window = Object.assign(new NodeEvents.EventEmitter(), {
          webContents: WebContents,
          getWindowButtonPosition: () => ({ x: 16, y: 19 }),
        });
        const OnWindow = App.on.mock.calls.find(([Name]) => Name === "browser-window-created")![1];
        OnWindow({}, Window);
        WebContents.emit("did-finish-load");
        await Quit;
        expect(NodeFS.writeFileSync).not.toHaveBeenCalled();
        expect(ErrorOutput).toHaveBeenCalledWith(
          "Error: The packaged Ace window controls are misaligned\n",
        );
      } finally {
        ErrorOutput.mockRestore();
      }
    },
  );
});
