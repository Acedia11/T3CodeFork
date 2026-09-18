// @effect-diagnostics nodeBuiltinImport:off - Vite validates its output directory before an Effect runtime exists.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export function ResolveAcePreview(
  Command: string,
  Mode: string,
  IsPreview: boolean | undefined,
  Environment: NodeJS.ProcessEnv,
) {
  const Compiled = Mode === "ace-preview";
  const Enabled =
    Environment.VITE_T3CODE_ACE_PREVIEW === "1" &&
    (Compiled || (Command === "serve" && !IsPreview));
  if (!Compiled) return { Enabled, Compiled, OutDir: "dist" };

  const Home = Environment.T3CODE_HOME?.trim();
  if (!Home || !NodePath.isAbsolute(Home)) {
    throw new Error("The compiled Ace preview requires an explicit absolute T3CODE_HOME.");
  }
  const ResolvedHome = NodeFS.realpathSync(Home);
  const LiveHome = NodePath.join(NodeOS.homedir(), ".t3");
  const ResolvedLiveHome = NodeFS.existsSync(LiveHome) ? NodeFS.realpathSync(LiveHome) : LiveHome;
  if (ResolvedHome === ResolvedLiveHome) {
    throw new Error("The compiled Ace preview requires a separate data directory.");
  }
  const OutDir = NodePath.join(ResolvedHome, "Renderer");
  if (NodeFS.lstatSync(OutDir, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error("The compiled Ace renderer directory must not be a symlink.");
  }
  return { Enabled, Compiled, OutDir };
}
