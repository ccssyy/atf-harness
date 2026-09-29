/**
 * 批⑯ WebUI 启动 shim（指令验收口径：`node webui/server.mjs`）。
 * 单源＝src/webui/server.ts → dist/webui/server.js（npm run build 后生效）。
 * 路径按仓库根显式拼接（webui/ 与 src/ 同级，cwd 无关）。
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url))); // webui/ 的上一级＝仓库根
await import(join(repoRoot, "dist", "webui", "server.js"));
