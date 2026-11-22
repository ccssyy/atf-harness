/**
 * G7／D9——内核目录解析单源测试锚（原「批㊶-ISO-2 S1 实例 pin 根单源」测试，pin 退役后重写）。
 *
 * 被测契约只有一条：内核目录怎么定。
 *   ATF_DSH_KERNEL_DIR ＞ ATF_CLI_PATH ＞ ATF_KERNEL_SOURCE ＞ 兄弟目录缺省 ＞ 空串（fail-closed）
 *
 * 退役面反锚（演练拦截用）：pin env、`.atf-pinned` 回退、pin tag↔版本串一致性门三者
 * 若被重新注入，必须不再影响解析结果——本组用例即该断言的机检落点。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  KERNEL_DIR_ENV,
  KERNEL_SIBLING_DIRNAME,
  KERNEL_SOURCE_ENV,
  CLI_PATH_ENV,
  resolveInstanceKernelDir,
  resolveInstancePinRoot,
  resolveKernelDir,
} from "../../../src/core/workspace/instancePin.js";

const tempRoot = (): string => mkdtempSync(join(tmpdir(), "g7-kernel-dir-"));

describe("G7／D9——内核目录解析单源", () => {
  it("env 链优先级：ATF_DSH_KERNEL_DIR ＞ ATF_CLI_PATH ＞ ATF_KERNEL_SOURCE", () => {
    expect(resolveKernelDir({ ATF_DSH_KERNEL_DIR: "/k1", ATF_CLI_PATH: "/k2", ATF_KERNEL_SOURCE: "/k3" }, "/repo")).toBe("/k1");
    expect(resolveKernelDir({ ATF_CLI_PATH: "/k2", ATF_KERNEL_SOURCE: "/k3" }, "/repo")).toBe("/k2");
    expect(resolveKernelDir({ ATF_KERNEL_SOURCE: "/k3" }, "/repo")).toBe("/k3");
  });

  it("env 名常量即解析链顺序（防改名漂移）", () => {
    expect(KERNEL_DIR_ENV).toBe("ATF_DSH_KERNEL_DIR");
    expect(CLI_PATH_ENV).toBe("ATF_CLI_PATH");
    expect(KERNEL_SOURCE_ENV).toBe("ATF_KERNEL_SOURCE");
  });

  it("空串/纯空白视同未设（不吞后续优先级的合法值）", () => {
    expect(resolveKernelDir({ ATF_DSH_KERNEL_DIR: "   ", ATF_CLI_PATH: "/k2" }, "/repo")).toBe("/k2");
    expect(resolveKernelDir({ ATF_DSH_KERNEL_DIR: "", ATF_KERNEL_SOURCE: "/k3" }, "/repo")).toBe("/k3");
  });

  it("相对路径升绝对（cwd=kernelDir 语义下杜绝子进程二次解析）", () => {
    expect(resolveKernelDir({ ATF_DSH_KERNEL_DIR: "/a/../b" }, "/repo")).toBe("/b");
  });

  it("全 env 缺席 → 兄弟目录缺省（双仓同父布局；在场即用）", () => {
    const parent = tempRoot();
    const repoRoot = join(parent, "ATF-Harness");
    const sibling = join(parent, KERNEL_SIBLING_DIRNAME);
    mkdirSync(repoRoot, { recursive: true });
    mkdirSync(sibling, { recursive: true });
    try {
      expect(resolveKernelDir({}, repoRoot)).toBe(sibling);
      expect(resolveInstanceKernelDir({}, repoRoot)).toBe(sibling);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("兄弟目录也不在场 → 空串（fail-closed：不猜路径，交调用方 L2 报错）", () => {
    const parent = tempRoot();
    const repoRoot = join(parent, "ATF-Harness");
    mkdirSync(repoRoot, { recursive: true });
    try {
      expect(resolveKernelDir({}, repoRoot)).toBe("");
      // 空串是「未解析」而非「不可解析错误」——语义与 boot preflight 的 hasKernelDir 判假对齐
      expect(resolveKernelDir({}, repoRoot)).not.toContain(KERNEL_SIBLING_DIRNAME);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe("G7／D9——pin 机制彻底解耦（演练拦截）", () => {
  it("pin env 被重新注入也不被消费（ATF_INSTANCE_PIN_ROOT 已非解析输入）", () => {
    const parent = tempRoot();
    const repoRoot = join(parent, "ATF-Harness");
    mkdirSync(repoRoot, { recursive: true });
    // 人为违规注入：pin 根指向一个真实存在的诱饵目录
    const bait = join(parent, "pinned-bait");
    mkdirSync(bait, { recursive: true });
    try {
      const withBait = { ATF_INSTANCE_PIN_ROOT: bait, ATF_KERNEL_SOURCE: "/real-kernel" };
      // 解析结果只取 KERNEL_SOURCE——诱饵未被读作内核目录
      expect(resolveKernelDir(withBait, repoRoot)).toBe("/real-kernel");
      // 只有 pin env 一个都不给合法内核键时，不落回诱饵
      const pinOnly = { ATF_INSTANCE_PIN_ROOT: bait };
      expect(resolveKernelDir(pinOnly, repoRoot)).toBe("");
      expect(resolveKernelDir(pinOnly, repoRoot)).not.toBe(bait);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("仓内共享 pin 回退已消失（不再有 .atf-pinned 缺省）", () => {
    const repoRoot = tempRoot();
    try {
      // 旧行为：返回 <repoRoot>/.atf-pinned。现行为：空串或兄弟目录，绝不含 pin 目录名。
      const resolved = resolveKernelDir({}, repoRoot);
      expect(resolved.includes(".atf-pinned")).toBe(false);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("兼容壳 resolveInstancePinRoot 不再产生「回退共享态」留痕（source 恒 env·note 恒 null）", () => {
    const r = resolveInstancePinRoot({ ATF_KERNEL_SOURCE: "/k" }, "/repo");
    expect(r.root).toBe("/k");
    expect(r.source).toBe("env");
    expect(r.note).toBeNull();
    // 缺席时也不得给出「回退共享态」文案
    const absent = resolveInstancePinRoot({}, "/repo");
    expect(absent.note).toBeNull();
    expect(absent.source).toBe("env");
  });

  it("resolveInstanceKernelDir 与 resolveKernelDir 同值（单源无分叉）", () => {
    const env = { ATF_CLI_PATH: "/k2" };
    expect(resolveInstanceKernelDir(env, "/repo")).toBe(resolveKernelDir(env, "/repo"));
  });
});
