import { defineConfig } from "vitest/config";

// G2：atf-core 包自带的测试收集配置。
//
// 为什么需要它：仓根 vitest.config.ts 的 include 是 `tests/**/*.test.ts`（只收仓根
// tests/ 树下），所以 `npx vitest run packages/extensions/atf-core` 会被报
// 「No test files found」。根配置不在本批改动范围（G2 边界只允许 atf-core/**），
// 故在本包内声明自己的 include，让 `--root packages/extensions/atf-core` 稳定成立：
//
//   npx vitest run --root packages/extensions/atf-core
//
// 测试放在本包 tests/ 下（任务书许可的两处之一）；src/ 下的 *.test.ts 一并收，
// 便于后续把开发测试贴近实现放。
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
  },
});
