/**
 * core/ 边界守卫（L1 门 2 T01 交付判据，《ATF独立Harness_L1门2任务书_20260915.md》§3 T01）：
 *   ① core/ 对三个外壳零依赖——src/ui/ · src/acp/ · src/mcp/ 是 core 的消费者，core 永不
 *      反向 import（静态扫描 src/core 全部 TS 源的 import 语句）；
 *   ② R2a 修订低依赖纪律——dependencies 恰为 @earendil-works/pi-ai 锁 exact（owner 决议
 *      2026-09-23 方案乙；原"恒空"口径已修订），devDependencies 仅构建测试工具，
 *      npm-shrinkwrap.json 在位（AGENTS.md §3 硬约束 6 修订态）；
 *   ③ 投影面唯一性——core 对外投影只有已落盘的 SessionEvent（createProjectionHub 契约：
 *      订阅序 = 落盘序；退订后不再收到投影）。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createProjectionHub } from "../../src/core/index.js";
import type { SessionEvent } from "../../src/core/session/index.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const coreRoot = join(repoRoot, "src", "core");

/** 递归收集目录下全部 .ts 文件（相对 repoRoot 的 POSIX 风格路径）。 */
const listTsFiles = (dir: string): string[] => {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listTsFiles(full));
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
};

const SHELL_DIRS = ["ui", "acp", "mcp"] as const;

describe("core 边界守卫（T01）", () => {
  it("core/ 不 import 任何外壳目录（ui/acp/mcp）", () => {
    const violations: string[] = [];
    for (const file of listTsFiles(coreRoot)) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/from\s+"([^"]+)"/g)) {
        const spec = match[1] ?? "";
        // 相对引用按 POSIX 段解析；裸包名（非 node: 内置）一律违规（零依赖）。
        const rel = spec.startsWith(".") ? spec : null;
        if (rel === null) {
          if (!spec.startsWith("node:")) violations.push(`${file}: 非相对非内置引用 "${spec}"`);
          continue;
        }
        const target = rel.replace(/\.js$/, ".ts");
        for (const shell of SHELL_DIRS) {
          if (target === `../${shell}` || target.startsWith(`../${shell}/`) || target === `../../${shell}` || target.startsWith(`../../${shell}/`) || target.startsWith(`../../../${shell}/`)) {
            violations.push(`${file}: import 外壳目录 src/${shell}/（"${spec}"）`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("package.json：dependencies 恰为 pi-ai 锁 exact（R2a 修订），devDependencies 仅构建测试工具；shrinkwrap 在位", () => {
    // R2a 修订（owner 决议 2026-09-23，方案乙：零 npm 运行时依赖 → 低依赖＋锁版本＋审计；
    // 授权链：《决议_框架化方向方案乙》26055c6b ＋《指令_门2启动_pi-ai换库批》6aa4303a）：
    // 运行时依赖面 = 恰 @earendil-works/pi-ai 一个、save-exact（禁止 ^/~ 漂移）；
    // npm-shrinkwrap.json 必须在位（传递闭包锁面 ＋ audit 纪律的静态前提）。
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      engines?: { node?: string };
    };
    expect(pkg.dependencies ?? {}).toEqual({ "@earendil-works/pi-ai": "0.87.1" });
    for (const range of Object.values(pkg.dependencies ?? {})) {
      expect(/^[0-9]/.test(range), `运行时依赖须锁 exact（禁 ^/~ 漂移）: ${range}`).toBe(true);
    }
    const allowed = new Set(["typescript", "vitest", "@types/node"]);
    for (const name of Object.keys(pkg.devDependencies ?? {})) {
      expect(allowed.has(name), `devDependencies 出现未登记项: ${name}`).toBe(true);
    }
    // pi-ai engines.node >= 22.19.0（门 1 前置核验项；A800 已实测 v24.16.0）
    const nodeRange = pkg.engines?.node ?? "";
    expect(nodeRange).toBe(">=22.19.0");
    // 传递闭包锁面：shrinkwrap 文件在位（npm shrinkwrap 产物；删除即审计失锚）
    expect(() => statSync(join(repoRoot, "npm-shrinkwrap.json"))).not.toThrow();
  });
});

describe("core 投影面契约（T01）", () => {
  const makeEvent = (id: number): SessionEvent =>
    ({ id, type: "turn/start", ts: "2026-09-15T00:00:00.000Z", payload: {} }) as unknown as SessionEvent;

  it("订阅序 = 投影序；退订后不再收到", () => {
    const hub = createProjectionHub();
    const seen: string[] = [];
    const unsubscribe = hub.subscribe((event) => {
      seen.push(`${event.id}`);
    });
    hub.emit(makeEvent(1), "live");
    hub.emit(makeEvent(2), "history");
    unsubscribe();
    hub.emit(makeEvent(3), "live");
    expect(seen).toEqual(["1", "2"]);
  });

  it("多订阅者并存；单订阅者异常被 hub 隔离，不反压、不饿死其他订阅者", () => {
    const hub = createProjectionHub();
    const seen: string[] = [];
    hub.subscribe(() => {
      throw new Error("订阅方自身故障不反压 core");
    });
    hub.subscribe((event) => {
      seen.push(`ok:${String(event.id)}`);
    });
    expect(() => hub.emit(makeEvent(7), "live")).not.toThrow();
    expect(seen).toEqual(["ok:7"]);
  });
});
