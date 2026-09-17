// @effect-diagnostics nodeBuiltinImport:off - This adapter owns the local build process and installer.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { app } from "electron";

declare const __T3CODE_FORK_BUILD__: boolean | undefined;
export const IsForkBuild = typeof __T3CODE_FORK_BUILD__ !== "undefined" && __T3CODE_FORK_BUILD__;

interface ForkResult {
  Status: "ready" | "current";
  Version: string;
}

interface ForkEvent {
  Event: string;
  Percent?: number;
  Version?: string;
  Message?: string;
  Result?: ForkResult;
}

interface ForkRuntime {
  Version: string;
  Run: (OnEvent: (Event: ForkEvent) => void) => Promise<ForkResult>;
  Install: (Reopen: boolean) => void;
  Quit: () => void;
}

export class ForkUpdateError extends Error {}

export function ReadForkFailure(Error: unknown): string {
  const Failure = Error as { stdout?: Buffer; stderr?: Buffer } | undefined;
  const Output = Failure?.stdout?.toString().trim().split("\n").at(-1);
  if (Output) {
    try {
      const Event = JSON.parse(Output) as ForkEvent;
      if (Event.Event === "Error" && typeof Event.Message === "string") return Event.Message;
    } catch {}
  }
  return (
    Failure?.stderr?.toString().trim().slice(-2000) ||
    "The prepared fork update could not be validated. Check the fork configuration and build log."
  );
}

export class ForkAutoUpdater extends NodeEvents.EventEmitter {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  channel: string | null = "nightly";
  allowPrerelease = true;
  allowDowngrade = false;
  fullChangelog = true;
  disableDifferentialDownload = true;
  private Running: Promise<void> | undefined;
  private Ready = false;
  private Installing = false;
  private readonly Runtime: ForkRuntime;

  constructor(Runtime: ForkRuntime) {
    super();
    this.Runtime = Runtime;
  }

  setFeedURL(_Options: unknown): void {}

  checkForUpdates(): Promise<void> {
    if (this.Running) return this.Running;
    this.Ready = false;
    if (this.channel !== "nightly") {
      return Promise.reject(
        new ForkUpdateError("This fork follows Nightly. Select Nightly in Settings → Updates."),
      );
    }
    this.Running = this.Prepare().finally(() => {
      this.Running = undefined;
    });
    return this.Running;
  }

  private async Prepare(): Promise<void> {
    this.emit("checking-for-update");
    const Result = await this.Runtime.Run((Event) => {
      if (Event.Event === "Available") {
        this.Ready = false;
        this.emit("update-available", { version: Event.Version });
      } else if (Event.Event === "Progress") {
        this.emit("download-progress", { percent: Event.Percent });
      }
    });
    this.Ready = Result.Status === "ready";
    this.emit(this.Ready ? "update-downloaded" : "update-not-available", {
      version: Result.Version,
    });
  }

  downloadUpdate(): Promise<void> {
    return this.checkForUpdates();
  }

  InstallOnQuit(): void {
    if (!this.Ready || this.Installing) return;
    try {
      this.Runtime.Install(false);
      this.Installing = true;
    } catch (Error) {
      process.stderr.write(`[fork-updater] Update remains pending: ${String(Error)}\n`);
    }
  }

  quitAndInstall(_Silent = true, Reopen = true): void {
    if (!this.Ready) throw new ForkUpdateError("No validated fork update is ready.");
    if (this.Installing) return;
    this.Runtime.Install(Reopen);
    this.Installing = true;
    this.Runtime.Quit();
  }
}

export function CreateForkAutoUpdater(): ForkAutoUpdater {
  const ConfigPath = NodePath.join(
    NodeOS.homedir(),
    "Library/Application Support/T3CodeFork/Config.json",
  );
  const Script = NodePath.join(process.resourcesPath, "ForkUpdater.py");
  const ReadConfig = () => {
    try {
      const Config = JSON.parse(NodeFS.readFileSync(ConfigPath, "utf8")) as {
        PythonPath: string;
        CacheRoot: string;
      };
      if (!NodePath.isAbsolute(Config.PythonPath) || !NodePath.isAbsolute(Config.CacheRoot)) {
        throw new Error("Expected absolute PythonPath and CacheRoot");
      }
      return Config;
    } catch {
      throw new ForkUpdateError(
        `Cannot read the fork configuration. Check PythonPath and CacheRoot in ${ConfigPath}`,
      );
    }
  };
  const Updater = new ForkAutoUpdater({
    Version: app.getVersion(),
    Run: (OnEvent) =>
      new Promise((Resolve, Reject) => {
        const Config = ReadConfig();
        const Child = NodeChildProcess.spawn(
          Config.PythonPath,
          [Script, "prepare", "--current-version", app.getVersion()],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        const Cancel = () => Child.kill("SIGTERM");
        app.once("before-quit", Cancel);
        let Buffer = "";
        let Failure = "";
        let Result: ForkResult | undefined;
        Child.stdout.setEncoding("utf8");
        Child.stderr.setEncoding("utf8");
        Child.stdout.on("data", (Chunk: string) => {
          Buffer += Chunk;
          const Lines = Buffer.split("\n");
          Buffer = Lines.pop() ?? "";
          for (const Line of Lines) {
            try {
              const Event = JSON.parse(Line) as ForkEvent;
              if (Event.Event === "Error") Failure = Event.Message ?? "Fork update failed.";
              if (Event.Event === "Result") Result = Event.Result;
              OnEvent(Event);
            } catch {
              Failure = "The fork updater returned an invalid response.";
            }
          }
        });
        Child.stderr.on("data", (Chunk: string) => {
          Failure = (Failure + Chunk).slice(-6000);
        });
        Child.once("error", (Error) => Reject(new ForkUpdateError(Error.message)));
        Child.once("close", (Code) => {
          app.removeListener("before-quit", Cancel);
          if (Code === 0 && Result && !Failure) Resolve(Result);
          else Reject(new ForkUpdateError(Failure || `Fork update failed (exit ${Code}).`));
        });
      }),
    Install: (Reopen) => {
      const Config = ReadConfig();
      try {
        NodeChildProcess.execFileSync(Config.PythonPath, [Script, "validate"], {
          timeout: 120_000,
          stdio: "pipe",
        });
      } catch (Error) {
        throw new ForkUpdateError(ReadForkFailure(Error));
      }
      const Log = NodeFS.openSync(NodePath.join(Config.CacheRoot, "Install.log"), "a", 0o600);
      try {
        const Child = NodeChildProcess.spawn(
          Config.PythonPath,
          [Script, "install", "--parent-pid", String(process.pid), ...(Reopen ? ["--reopen"] : [])],
          {
            detached: true,
            stdio: ["ignore", Log, Log],
          },
        );
        Child.on("error", (Error) =>
          process.stderr.write(`[fork-updater] Installer failed: ${String(Error)}\n`),
        );
        if (!Child.pid) throw new ForkUpdateError("The fork installer could not start.");
        Child.unref();
      } finally {
        NodeFS.closeSync(Log);
      }
    },
    Quit: () => app.quit(),
  });
  app.on("will-quit", () => Updater.InstallOnQuit());
  return Updater;
}
