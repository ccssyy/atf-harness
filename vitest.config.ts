import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// 批⑱-M2：atf-tools/atf-ui 消费 vendor/dsh 构建产物（symlink 解析在 vitest 的 ESM
// resolver 下不稳——alias 显式映射为仓相对的稳定路径；生产运行面不受影响）。
const vendor = fileURLToPath(new URL("./vendor/dsh/deepseek-harness", import.meta.url));

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    // 测试提速 T2（指令 edaebcb148f7 §三.3）：transform 持久缓存——全量实测 Transform
    // 每次重做占 28%（308s），fsModuleCache 跨 run/跨进程复用转译产物；缓存落
    // node_modules/.vitest-cache（依赖重装自然失效）。收口批全量复测对比数字。
    fsModuleCache: true,
    // 批㊶-ISO D2①：tmux 测试 socket 全局 fixture（逐测试文件建 atf-test-<runid> socket
    // ＋命名域前缀 env，用毕 kill-server——含 tmux 操作的测试对默认 socket 零触碰）
    setupFiles: ["tests/fixtures/testIsolationGuard.ts", "tests/fixtures/tmuxTestSocket.ts"],
  },
  resolve: {
    alias: [
      { find: "@deepseek-ai/dsh-tools", replacement: `${vendor}/packages/core/tools/lib/index.js` },
      { find: "@deepseek-ai/schemastery", replacement: `${vendor}/vendor/schemastery/lib/index.mjs` },
      { find: "@deepseek-ai/cordis", replacement: `${vendor}/vendor/cordis/lib/index.js` },
      { find: "@deepseek-ai/cosmokit", replacement: `${vendor}/vendor/cosmokit/lib/index.js` },
      { find: "@deepseek-ai/dsh-scope", replacement: `${vendor}/packages/core/scope/lib/index.js` },
      { find: "@deepseek-ai/dsh-util-values", replacement: `${vendor}/packages/util/values/lib/index.js` },
      { find: "@deepseek-ai/dsh-brand", replacement: `${vendor}/packages/util/brand/lib/index.js` },
      { find: "@deepseek-ai/dsh-llm", replacement: `${vendor}/packages/llm/llm/lib/index.js` },
      { find: "@deepseek-ai/dsh-typert-protocol", replacement: `${vendor}/packages/typert/protocol/lib/index.js` },
      { find: "@deepseek-ai/dsh-sandbox", replacement: `${vendor}/packages/sandbox/sandbox/lib/index.js` },
      { find: "@deepseek-ai/dsh-user-approval", replacement: `${vendor}/packages/interaction/user-approval/lib/index.js` },
      { find: "@deepseek-ai/dsh-fs", replacement: `${vendor}/packages/fs/fs/lib/index.js` },
      { find: "@deepseek-ai/dsh-session", replacement: `${vendor}/packages/core/session/lib/index.js` },
    ],
  },
});
