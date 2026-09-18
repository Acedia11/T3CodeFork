import * as NodeEvents from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const State = vi.hoisted(() => ({ Apps: [], Server: null, FailStartup: false, FailSpawn: false }));
class Child extends NodeEvents.EventEmitter {
  exitCode = null;
  signalCode = null;
  constructor(Pid) {
    super();
    this.pid = Pid;
  }
  Exit(Code, Signal = null) {
    this.exitCode = Code;
    this.signalCode = Signal;
    this.emit("exit", Code, Signal);
  }
  kill(Signal) {
    this.Exit(null, Signal);
    return true;
  }
}

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  spawnSync: vi.fn(),
  spawn: () => {
    const App = new Child(50000 + State.Apps.length);
    State.Apps.push(App);
    return App;
  },
  fork: () => {
    const Server = new Child(51000);
    State.Server = Server;
    if (State.FailSpawn) Server.pid = undefined;
    queueMicrotask(() => {
      if (State.FailSpawn) Server.emit("error", new Error("spawn failed"));
      else if (State.FailStartup) Server.Exit(1);
      else Server.emit("message", "ready");
    });
    return Server;
  },
}));
vi.mock("node:os", async (ImportOriginal) => ({
  ...(await ImportOriginal()),
  platform: () => "darwin",
}));
vi.mock("./electron-launcher.mjs", () => ({
  desktopDir: "/unused/desktop",
  resolveDevProtocolClient: () => null,
  resolveElectronLaunchCommand: () => ({ electronPath: "/unused/electron", args: [] }),
}));
vi.mock("./wait-for-resources.mjs", () => ({ waitForResources: async () => {} }));

let Kill;
let Exit;
let Listeners;
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubEnv("VITE_DEV_SERVER_URL", "http://127.0.0.1:6230");
  vi.stubEnv("VITE_T3CODE_ACE_PREVIEW", "1");
  vi.stubEnv("T3CODE_COMPILED_PREVIEW", "1");
  State.Apps = [];
  State.Server = null;
  State.FailStartup = false;
  State.FailSpawn = false;
  Kill = vi.spyOn(process, "kill").mockReturnValue(true);
  Exit = vi.spyOn(process, "exit").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  Listeners = new Map(
    ["SIGINT", "SIGTERM", "SIGHUP"].map((Signal) => [Signal, process.listeners(Signal)]),
  );
});
afterEach(() => {
  for (const [Signal, Original] of Listeners) {
    for (const Listener of process.listeners(Signal)) {
      if (!Original.includes(Listener)) process.removeListener(Signal, Listener);
    }
  }
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("waits for forced cleanup of a surviving preview group before normal quit completes", async () => {
  await import("./dev-electron.mjs");
  State.Apps[0].Exit(0);
  await vi.advanceTimersByTimeAsync(1200);
  expect(State.Server.signalCode).toBe("SIGTERM");
  expect(Exit).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(300);
  expect(Kill).toHaveBeenCalledWith(-50000, "SIGKILL");
  expect(Exit).toHaveBeenCalledWith(0);
  expect(Kill.mock.invocationCallOrder.at(-1)).toBeLessThan(Exit.mock.invocationCallOrder[0]);
});

it("keeps the renderer server alive during an explicit Electron relaunch", async () => {
  await import("./dev-electron.mjs");
  State.Apps[0].Exit(75);
  await vi.advanceTimersByTimeAsync(1500);
  expect(State.Apps).toHaveLength(2);
  expect(State.Server.exitCode).toBeNull();
  expect(State.Server.signalCode).toBeNull();
  expect(Exit).not.toHaveBeenCalled();
});

it("stops Electron when the renderer server fails after startup", async () => {
  await import("./dev-electron.mjs");
  State.Server.Exit(1);
  await vi.advanceTimersByTimeAsync(1500);
  expect(Kill).toHaveBeenCalledWith(-50000, "SIGTERM");
  expect(Kill).toHaveBeenCalledWith(-50000, "SIGKILL");
  expect(Exit).toHaveBeenCalledWith(1);
});

it("does not launch Electron when the renderer cannot bind its port", async () => {
  State.FailStartup = true;
  await import("./dev-electron.mjs");
  expect(State.Apps).toHaveLength(0);
  expect(Exit).toHaveBeenCalledWith(1);
});

it("exits without waiting for a renderer process that failed to spawn", async () => {
  State.FailSpawn = true;
  await import("./dev-electron.mjs");
  expect(State.Apps).toHaveLength(0);
  expect(Exit).toHaveBeenCalledWith(1);
});
