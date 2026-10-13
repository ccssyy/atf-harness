/**
 * 批㊶-ISO-2 S1 测试锚——实例 pin 根单源（resolveInstancePinRoot／resolveInstanceKernelDir）
 * ＋boot preflight ⑦ pin 树 worktree 实锚校验（tag↔版本串一致，沿 test_release_version_consistency
 * 语义）＋回退共享态留痕。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  INSTANCE_PIN_ROOT_ENV,
  resolveInstanceKernelDir,
  resolveInstancePinRoot,
} from "../../../src/core/workspace/instancePin.js";
import { runBootPreflight, pinVersionFromTree, type PreflightProbes } from "../../../src/core/workspace/bootPreflight.js";

const tempRoot = (): string => mkdtempSync(join(tmpdir(), "iso2-pin-"));

describe("批㊶-ISO-2 S1——resolveInstancePinRoot 单源", () => {
  it("env 显式设置 → 实例 pin 根（source=env·无留痕）", () => {
    const r = resolveInstancePinRoot({ [INSTANCE_PIN_ROOT_ENV]: "/data/atf/dev/pinned" }, "/repo");
    expect(r).toEqual({ root: "/data/atf/dev/pinned", source: "env", note: null });
  });

  it("env 未设 → 兼容回退共享态（root=<repo>/.atf-pinned·note 留痕「回退共享态」）", () => {
    const r = resolveInstancePinRoot({}, "/repo");
    expect(r.root).toBe("/repo/.atf-pinned");
    expect(r.source).toBe("fallback");
    expect(r.note).toContain("pin 路径：回退共享态");
    expect(r.note).toContain(INSTANCE_PIN_ROOT_ENV);
  });

  it("env 空串/纯空白视同未设（回退共享态）", () => {
    expect(resolveInstancePinRoot({ [INSTANCE_PIN_ROOT_ENV]: "   " }, "/repo").source).toBe("fallback");
    expect(resolveInstancePinRoot({ [INSTANCE_PIN_ROOT_ENV]: "" }, "/repo").source).toBe("fallback");
  });

  it("resolveInstanceKernelDir 消费链：ATF_DSH_KERNEL_DIR ＞ ATF_CLI_PATH ＞ 实例 pin 根", () => {
    expect(resolveInstanceKernelDir({ ATF_DSH_KERNEL_DIR: "/k1", ATF_CLI_PATH: "/k2", [INSTANCE_PIN_ROOT_ENV]: "/k3" }, "/repo")).toBe("/k1");
    expect(resolveInstanceKernelDir({ ATF_CLI_PATH: "/k2", [INSTANCE_PIN_ROOT_ENV]: "/k3" }, "/repo")).toBe("/k2");
    expect(resolveInstanceKernelDir({ [INSTANCE_PIN_ROOT_ENV]: "/k3" }, "/repo")).toBe("/k3");
    expect(resolveInstanceKernelDir({}, "/repo")).toBe("/repo/.atf-pinned");
  });
});

describe("批㊶-ISO-2 S1——boot preflight ⑦ pin 树 worktree 实锚校验", () => {
  // ①②（pipeline/bridge 派生）以 env 显式命令跳过——本组只看 ⑦
  const quietEnv = { ATF_DSH_PIPELINE_COMMAND: "x", ATF_DSH_BRIDGE_COMMAND: "y" };
  const baseProbes: PreflightProbes = {
    commandWorks: () => true,
    fileExists: () => true,
    dirExists: () => true,
    listJsonFiles: () => [],
    // readText 不注入——走缺省 readFileSync 读真实夹具文件
  };
  /** pin 版本串夹具（__init__.py 形态）。 */
  const withVersion = (root: string, version: string): void => {
    mkdirSync(join(root, "src", "agentic_training_flow"), { recursive: true });
    writeFileSync(join(root, "src", "agentic_training_flow", "__init__.py"), `__version__ = "${version}"\n`);
  };

  it("pinVersionFromTree：__version__ 提取；缺失＝null", () => {
    const root = tempRoot();
    withVersion(root, "0.7.13b0");
    expect(pinVersionFromTree(root, (p) => `__version__ = "0.7.13b0"\n`)).toBe("0.7.13b0");
    expect(pinVersionFromTree(root, () => null)).toBeNull();
    expect(pinVersionFromTree(root, () => "x = 1\n")).toBeNull();
  });

  it("回退共享态（explicit=false）→ notes 留痕「pin 路径：回退共享态」＋实锚成功注记", () => {
    const root = tempRoot();
    withVersion(root, "0.7.13b0");
    const reportOk = runBootPreflight(quietEnv, { ...baseProbes, gitDescribe: () => "v0.7.13b0" }, undefined, { root, explicit: false });
    expect(reportOk.notes.some((n) => n.includes("pin 路径：回退共享态"))).toBe(true);
    expect(reportOk.notes.some((n) => n.includes("pin 树实锚：v0.7.13b0"))).toBe(true);
    expect(reportOk.fatal).toHaveLength(0);
  });

  it("describe 不可解析 → L2 fatal pin_worktree（附核查命令）", () => {
    const root = tempRoot();
    withVersion(root, "0.7.13b0");
    const report = runBootPreflight(quietEnv, { ...baseProbes, gitDescribe: () => null }, undefined, { root, explicit: true });
    expect(report.fatal).toHaveLength(1);
    expect(report.fatal[0]?.check).toBe("pin_worktree");
    expect(report.fatal[0]?.fix).toContain("git -C");
  });

  it("tag 与版本串不一致 → L2 fatal pin_version_consistency（沿 release_version_consistency 语义）", () => {
    const root = tempRoot();
    withVersion(root, "0.7.13b0");
    const offTag = runBootBootPreflightWith(root, "v0.7.13b0-3-gabc1234");
    expect(offTag.fatal.map((f) => f.check)).toContain("pin_version_consistency");
    const wrongTag = runBootBootPreflightWith(root, "v0.7.11b0");
    expect(wrongTag.fatal.map((f) => f.check)).toContain("pin_version_consistency");
  });

  it("版本串不可读 → L2 fatal pin_version；pin 目录不存在 → ⑦ 跳过（不双报）", () => {
    const root = tempRoot();
    const noVersion = runBootBootPreflightWith(root, "v0.7.13b0");
    expect(noVersion.fatal.map((f) => f.check)).toContain("pin_version");
    // dirExists 换真实探测——目录缺席分支方可触达
    const missing = runBootPreflight(quietEnv, { ...baseProbes, gitDescribe: () => "v0.7.13b0", dirExists: (p: string) => existsSync(p) }, undefined, { root: join(root, "absent"), explicit: true });
    expect(missing.fatal).toHaveLength(0);
  });

  const runBootBootPreflightWith = (root: string, described: string) =>
    runBootPreflight(quietEnv, { ...baseProbes, gitDescribe: () => described }, undefined, { root, explicit: true });
});
