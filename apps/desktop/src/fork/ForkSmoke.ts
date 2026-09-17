// @effect-diagnostics nodeBuiltinImport:off - Packaged-app startup validation uses an isolated profile.
// @effect-diagnostics globalTimers:off - The smoke watchdog starts before the Effect runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeTimers from "node:timers";
import { app } from "electron";

export function InitializeForkSmoke(): void {
  if (process.env.T3CODE_FORK_SMOKE !== "1") return;
  const Home = process.env.T3CODE_HOME;
  if (!Home || !NodePath.isAbsolute(Home))
    throw new Error("Fork smoke tests require an isolated T3CODE_HOME.");
  const Timeout = NodeTimers.setTimeout(() => app.exit(1), 90_000);
  app.on("browser-window-created", (_Event, Window) => {
    Window.on("show", () => Window.hide());
    Window.webContents.on("did-finish-load", () => {
      if (!Window.webContents.getURL().startsWith("t3code://app")) return;
      void Window.webContents
        .executeJavaScript(`new Promise((Resolve, Reject) => {
        const Timeout = setTimeout(() => { Observer.disconnect(); Reject(new Error("The app did not render")); }, 20000);
        const Check = () => {
          if (!document.querySelector('[data-slot="sidebar-wrapper"] [data-sidebar="sidebar"]')) return;
          clearTimeout(Timeout); Observer.disconnect(); Resolve(true);
        };
        const Observer = new MutationObserver(Check);
        Observer.observe(document.documentElement, { childList: true, subtree: true });
        Check();
      })`)
        .then(() => {
          if (!app.getPath("userData").startsWith(Home + NodePath.sep))
            throw new Error("Smoke profile isolation failed");
          NodeFS.writeFileSync(
            NodePath.join(Home, "ForkSmokePassed.json"),
            JSON.stringify({ Version: app.getVersion() }),
          );
          NodeTimers.clearTimeout(Timeout);
          app.quit();
        })
        .catch((Error: unknown) => {
          process.stderr.write(String(Error) + "\n");
          app.exit(1);
        });
    });
  });
}
