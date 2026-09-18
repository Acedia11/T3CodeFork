// @effect-diagnostics nodeBuiltinImport:off - Tests exercise the Node filesystem build boundary.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { ResolveAcePreview } from "./AcePreview";

const Homes: string[] = [];
function CreateHome() {
  const Home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "AcePreview-"));
  Homes.push(Home);
  return Home;
}
afterEach(() => {
  for (const Home of Homes.splice(0)) NodeFS.rmSync(Home, { recursive: true, force: true });
});

describe("Ace preview build isolation", () => {
  it("keeps ordinary builds and static previews disabled despite inherited preview flags", () => {
    const Environment = { VITE_T3CODE_ACE_PREVIEW: "1", T3CODE_HOME: "/missing/home" };
    expect(ResolveAcePreview("build", "production", false, Environment)).toEqual({
      Enabled: false,
      Compiled: false,
      OutDir: "dist",
    });
    expect(ResolveAcePreview("serve", "production", true, Environment).Enabled).toBe(false);
    expect(ResolveAcePreview("serve", "development", false, Environment).Enabled).toBe(true);
  });

  it("keeps built assets in their own child directory beside private data", () => {
    const Home = CreateHome();
    NodeFS.mkdirSync(NodePath.join(Home, "userdata"));
    const Result = ResolveAcePreview("build", "ace-preview", false, {
      VITE_T3CODE_ACE_PREVIEW: "1",
      T3CODE_HOME: Home,
    });
    expect(Result).toEqual({
      Enabled: true,
      Compiled: true,
      OutDir: NodePath.join(NodeFS.realpathSync(Home), "Renderer"),
    });
    expect(NodeFS.existsSync(NodePath.join(Home, "userdata"))).toBe(true);
  });

  it.each([undefined, "", "relative/home"])("rejects an implicit or relative home: %s", (Home) => {
    expect(() => ResolveAcePreview("build", "ace-preview", false, { T3CODE_HOME: Home })).toThrow(
      "explicit absolute",
    );
  });

  it("rejects an output symlink to private state", () => {
    const Home = CreateHome();
    NodeFS.mkdirSync(NodePath.join(Home, "userdata"));
    NodeFS.symlinkSync(NodePath.join(Home, "userdata"), NodePath.join(Home, "Renderer"));
    expect(() => ResolveAcePreview("build", "ace-preview", false, { T3CODE_HOME: Home })).toThrow(
      "symlink",
    );
  });
});
