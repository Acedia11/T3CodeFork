import * as NodePath from "node:path";
import { preview } from "vite-plus";

const Root = NodePath.resolve(import.meta.dirname, "../../web");
const Server = await preview({ root: Root, mode: "ace-preview" });
process.once("disconnect", () => {
  void Server.close().finally(() => process.exit(0));
});
process.send?.("ready");
