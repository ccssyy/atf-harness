/**
 * 批㊶-E-H 项 2.1/2.3 测试锚——桥对端装配单源（src/bridge/bridgeCommand.ts）：
 * env 注入机制化（ATF_DSH_BRIDGE_COMMAND 在场＝真内核 argv＋PYTHONPATH 桥子进程私有
 * env；缺席＝mock）＋内核版本面（git describe fail-soft）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { kernelVersionSync, parseCommandWithEnvPrefix, resolveBridgeDeployment } from "../../src/bridge/bridgeCommand.js";

const repoRoot = "/data/sam/ATF-Harness";
const tempRoots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "bridge-cmd-test-"));
  tempRoots.push(root);
  return root;
};
afterEach(() => { for (const r of tempRoots.splice(0)) rmSync(r, { recursive: true, force: true }); });

describe("批㊶-E 项 2.1 parseCommandWithEnvPrefix（前导 KEY=VALUE 词法）", () => {
  it("纯 argv 无前缀；env 前缀剥入 env（带引号值脱引号）；前缀后 argv 不再误吞", () => {
    expect(parseCommandWithEnvPrefix("python3 -m agentic_training_flow serve")).toEqual({
      argv: ["python3", "-m", "agentic_training_flow", "serve"],
      env: {},
    });
    expect(parseCommandWithEnvPrefix('PYTHONPATH=/k/src python3 -m x')).toEqual({
      argv: ["python3", "-m", "x"],
      env: { PYTHONPATH: "/k/src" },
    });
    expect(parseCommandWithEnvPrefix('PYTHONPATH="/a b/src" node mock.mjs FOO=bar')).toEqual({
      argv: ["node", "mock.mjs", "FOO=bar"],
      env: { PYTHONPATH: "/a b/src" },
    });
  });
});

describe("批㊶-E 项 2.1 resolveBridgeDeployment（mock 缺省／真内核 env 注入／PYTHONPATH 派生）", () => {
  const mockCommand = `node ${join(repoRoot, "tests", "fixtures", "mock_atf.mjs")}`;
  const realCommand = "python3 -m agentic_training_flow serve";

  it("缺省（无 env、Config 缺省 mock 串）＝mock 对端：无 PYTHONPATH、kernelRoot null", () => {
    const d = resolveBridgeDeployment({ commandValue: mockCommand, kernelDir: "/k", env: {} });
    expect(d.mode).toBe("mock");
    expect(d.argv).toEqual(["node", join(repoRoot, "tests", "fixtures", "mock_atf.mjs")]);
    expect(d.childEnv).toEqual({});
    expect(d.kernelRoot).toBeNull();
  });

  it("ATF_DSH_BRIDGE_COMMAND 在场＝real：argv 解析＋PYTHONPATH 自 kernelDir/src 派生（探测包在位）", () => {
    const d = resolveBridgeDeployment({
      commandValue: realCommand,
      kernelDir: "/k",
      env: { ATF_DSH_BRIDGE_COMMAND: realCommand },
      probe: (p) => p === join("/k", "src", "agentic_training_flow"),
    });
    expect(d.mode).toBe("real");
    expect(d.argv).toEqual(["python3", "-m", "agentic_training_flow", "serve"]);
    expect(d.childEnv).toEqual({ PYTHONPATH: join("/k", "src") });
    expect(d.kernelRoot).toBe("/k");
  });

  it("显式 PYTHONPATH 前缀胜过派生（不探 fs）；basename=src 取上级为 kernelRoot", () => {
    const value = "PYTHONPATH=/data/k/src python3 -m agentic_training_flow serve";
    let probed = false;
    const d = resolveBridgeDeployment({
      commandValue: value,
      kernelDir: "/elsewhere",
      env: { ATF_DSH_BRIDGE_COMMAND: value },
      probe: () => { probed = true; return true; },
    });
    expect(probed).toBe(false);
    expect(d.childEnv).toEqual({ PYTHONPATH: "/data/k/src" });
    expect(d.kernelRoot).toBe("/data/k");
  });

  it("派生不出（包不在位）不猜：无 PYTHONPATH 注入，kernelRoot 如实回退 kernelDir（握手期报错回流）", () => {
    const d = resolveBridgeDeployment({
      commandValue: realCommand,
      kernelDir: "/k",
      env: { ATF_DSH_BRIDGE_COMMAND: realCommand },
      probe: () => false,
    });
    expect(d.mode).toBe("real");
    expect(d.childEnv).toEqual({});
    expect(d.kernelRoot).toBe("/k");
  });

  it("无 env 但 Config 显式指真内核（profile 配置路径）＝real——两条注入路径同判", () => {
    const d = resolveBridgeDeployment({ commandValue: realCommand, kernelDir: "/k", env: {}, probe: () => true });
    expect(d.mode).toBe("real");
  });
});

describe("批㊶-E 项 2.3 kernelVersionSync（git describe fail-soft）", () => {
  it("git 仓（本仓）出非空版本串；非 git 目录如实 null", () => {
    expect(kernelVersionSync(repoRoot)).toMatch(/^v?\S+/);
    expect(kernelVersionSync(tempRoot())).toBeNull();
    expect(kernelVersionSync(null)).toBeNull();
  });
});
