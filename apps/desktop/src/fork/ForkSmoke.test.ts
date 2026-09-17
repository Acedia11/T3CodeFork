import * as NodeEvents from "node:events";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const App = vi.hoisted(() => ({ on: vi.fn(), quit: vi.fn(), exit: vi.fn() }));
vi.mock("electron", () => ({ app: App }));
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
});
