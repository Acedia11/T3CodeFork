import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  desktopDir,
  resolveDevProtocolClient,
  resolveElectronLaunchCommand,
} from "./electron-launcher.mjs";
import { waitForResources } from "./wait-for-resources.mjs";

const devServerUrl = process.env.VITE_DEV_SERVER_URL?.trim();
if (!devServerUrl) {
  throw new Error("VITE_DEV_SERVER_URL is required for desktop development.");
}

const devServer = new URL(devServerUrl);
const port = Number.parseInt(devServer.port, 10);
if (!Number.isInteger(port) || port <= 0) {
  throw new Error(`VITE_DEV_SERVER_URL must include an explicit port: ${devServerUrl}`);
}

const requiredFiles = [
  "dist-electron/main.cjs",
  "dist-electron/electron/WindowsForegroundFocusWorker.cjs",
  "dist-electron/preload.cjs",
  "dist-electron/snapShot/GlobalShiftShortcutWorker.cjs",
  "dist-electron/snapShot/RegionSnapShotWorker.cjs",
  "dist-electron/snapShot/SnapShotAccessibilityWorker.cjs",
  "../server/dist/bin.mjs",
];
const watchedDirectories = [
  { directory: "dist-electron", files: new Set(["main.cjs", "preload.cjs"]) },
  {
    directory: "dist-electron/electron",
    files: new Set(["WindowsForegroundFocusWorker.cjs"]),
  },
  {
    directory: "dist-electron/snapShot",
    files: new Set([
      "GlobalShiftShortcutWorker.cjs",
      "RegionSnapShotWorker.cjs",
      "SnapShotAccessibilityWorker.cjs",
    ]),
  },
  { directory: "../server/dist", files: new Set(["bin.mjs"]) },
];
const forcedShutdownTimeoutMs = 1_500;
const restartDebounceMs = 120;
const childTreeGracePeriodMs = 1_200;
const remoteDebuggingPort = process.env.T3CODE_DESKTOP_REMOTE_DEBUGGING_PORT?.trim();
// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone dev script has no Effect runtime.
const hostPlatform = NodeOS.platform();
const OwnPreviewGroup = hostPlatform !== "win32" && process.env.VITE_T3CODE_ACE_PREVIEW === "1";
const CompiledPreview = process.env.T3CODE_COMPILED_PREVIEW === "1";

NodeChildProcess.execFileSync(
  process.execPath,
  [NodePath.join(desktopDir, "scripts/build-browser-secret.mjs")],
  { stdio: "inherit" },
);

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;
const devProtocolClient = resolveDevProtocolClient();
if (devProtocolClient) {
  childEnv.T3CODE_DESKTOP_APP_USER_MODEL_ID = devProtocolClient.appBundleId;
  childEnv.T3CODE_DESKTOP_PROTOCOL_REGISTRATION_MANAGED = "1";
}

let shuttingDown = false;
let restartTimer = null;
let currentApp = null;
let restartQueue = Promise.resolve();
const expectedExits = new WeakSet();
const watchers = [];
const PreviewGroupCleanup = new Set();
let RendererServer = null;

async function StartCompiledRenderer() {
  RendererServer = NodeChildProcess.fork(
    NodePath.join(import.meta.dirname, "preview-renderer.mjs"),
    {
      cwd: NodePath.resolve(desktopDir, "../web"),
      env: childEnv,
      stdio: ["inherit", "inherit", "inherit", "ipc"],
    },
  );
  const Server = RendererServer;
  await new Promise((Resolve, Reject) => {
    Server.once("message", Resolve);
    Server.once("error", Reject);
    Server.once("exit", (Code) =>
      Reject(new Error(`Renderer server exited before startup: ${Code}`)),
    );
    Server.on("exit", () => {
      if (!shuttingDown) void shutdown(1);
    });
  });
}

function killChildTreeByPid(pid, signal) {
  if (hostPlatform === "win32" || typeof pid !== "number") {
    return;
  }

  NodeChildProcess.spawnSync("pkill", [`-${signal}`, "-P", String(pid)], { stdio: "ignore" });
}

function SignalApp(App, Signal) {
  if (OwnPreviewGroup && typeof App.pid === "number") {
    try {
      process.kill(-App.pid, Signal);
    } catch (Cause) {
      if (Cause.code !== "ESRCH") throw Cause;
    }
  } else {
    killChildTreeByPid(App.pid, Signal.replace("SIG", ""));
    App.kill(Signal);
  }
}

function startApp() {
  if (shuttingDown || currentApp !== null) {
    return;
  }

  const electronArgs = remoteDebuggingPort
    ? [`--remote-debugging-port=${remoteDebuggingPort}`]
    : [];
  const launchArgs = devProtocolClient
    ? electronArgs
    : [...electronArgs, `--t3code-dev-root=${desktopDir}`, "dist-electron/main.cjs"];
  const electronCommand = resolveElectronLaunchCommand(launchArgs);
  const app = NodeChildProcess.spawn(electronCommand.electronPath, electronCommand.args, {
    cwd: desktopDir,
    env: childEnv,
    stdio: "inherit",
    detached: OwnPreviewGroup,
  });

  currentApp = app;
  if (OwnPreviewGroup) console.log(`[dev-electron] Preview process group: ${app.pid}`);

  app.once("error", () => {
    if (currentApp === app) {
      currentApp = null;
    }

    if (!shuttingDown) {
      scheduleRestart();
    }
  });

  app.once("exit", (code, signal) => {
    if (OwnPreviewGroup) {
      SignalApp(app, "SIGTERM");
      const Cleanup = new Promise((Resolve) => {
        setTimeout(() => {
          SignalApp(app, "SIGKILL");
          Resolve();
        }, forcedShutdownTimeoutMs);
      });
      PreviewGroupCleanup.add(Cleanup);
      void Cleanup.then(() => PreviewGroupCleanup.delete(Cleanup));
    }
    if (currentApp === app) {
      currentApp = null;
    }

    const exitedAbnormally = signal !== null || code !== 0;
    if (CompiledPreview && !shuttingDown && !expectedExits.has(app) && !exitedAbnormally) {
      void shutdown(0);
      return;
    }
    if (!shuttingDown && !expectedExits.has(app) && exitedAbnormally) {
      scheduleRestart();
    }
  });
}

async function stopApp() {
  const app = currentApp;
  if (!app) {
    return;
  }

  currentApp = null;
  expectedExits.add(app);

  await new Promise((resolve) => {
    let settled = false;

    const finish = () => {
      if (settled) {
        return;
      }

      settled = true;
      resolve();
    };

    app.once("exit", finish);
    SignalApp(app, "SIGTERM");

    setTimeout(() => {
      if (settled) {
        return;
      }

      SignalApp(app, "SIGKILL");
      finish();
    }, forcedShutdownTimeoutMs).unref();
  });
}

function scheduleRestart() {
  if (shuttingDown) {
    return;
  }

  if (restartTimer) {
    clearTimeout(restartTimer);
  }

  restartTimer = setTimeout(() => {
    restartTimer = null;
    restartQueue = restartQueue
      .catch(() => undefined)
      .then(async () => {
        await stopApp();
        if (!shuttingDown) {
          startApp();
        }
      });
  }, restartDebounceMs);
}

function startWatchers() {
  for (const { directory, files } of watchedDirectories) {
    const watcher = NodeFS.watch(
      NodePath.join(desktopDir, directory),
      { persistent: true },
      (_eventType, filename) => {
        if (typeof filename !== "string" || !files.has(filename)) {
          return;
        }

        scheduleRestart();
      },
    );

    watchers.push(watcher);
  }
}

function killChildTree(signal) {
  if (hostPlatform === "win32") {
    return;
  }

  // Kill direct children as a final fallback in case normal shutdown leaves stragglers.
  NodeChildProcess.spawnSync("pkill", [`-${signal}`, "-P", String(process.pid)], {
    stdio: "ignore",
  });
}

async function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;

  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  for (const watcher of watchers) {
    watcher.close();
  }

  await stopApp();
  if (
    RendererServer?.pid &&
    RendererServer.exitCode === null &&
    RendererServer.signalCode === null
  ) {
    const Server = RendererServer;
    await new Promise((Resolve) => {
      const Timeout = setTimeout(() => Server.kill("SIGKILL"), forcedShutdownTimeoutMs);
      Server.once("exit", () => {
        clearTimeout(Timeout);
        Resolve();
      });
      Server.kill("SIGTERM");
    });
  }
  await Promise.all(PreviewGroupCleanup);
  if (!OwnPreviewGroup) {
    killChildTree("TERM");
    await new Promise((resolve) => {
      setTimeout(resolve, childTreeGracePeriodMs);
    });
    killChildTree("KILL");
  }

  process.exit(exitCode);
}

process.once("SIGINT", () => {
  void shutdown(130);
});
process.once("SIGTERM", () => {
  void shutdown(143);
});
process.once("SIGHUP", () => {
  void shutdown(129);
});

try {
  if (CompiledPreview) await StartCompiledRenderer();
  await waitForResources({
    baseDir: desktopDir,
    files: requiredFiles,
    tcpHost: devServer.hostname,
    tcpPort: port,
  });
  if (!CompiledPreview) startWatchers();
  startApp();
} catch (Cause) {
  console.error(Cause);
  await shutdown(1);
}
