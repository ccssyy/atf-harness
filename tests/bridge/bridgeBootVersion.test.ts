/**
 * 批㊶-ISO-2 S2 测试锚——bridge 命令模板（PYTHONPATH=<pin>/src 前置）＋boot 桥版本行
 * 实载化（probeBridgeHandshakeVersionSync：握手实载为准／describe 交叉核对／不一致双显）。
 *
 * 定形冒烟：`PYTHONPATH=<pin>/src python3 -m agentic_training_flow serve` 可起、握手可通
 * ——对仓内 pin 树（.atf-pinned，present 时）真跑：握手 version 须＝pin 树版本串
 * （__init__.py __version__）——即「bridge 载荷随 pin 走」的端到端锚（沿契约测试隔离纪律：
 * HOME 临时夹具＋ATF_SKILLS_AUTO_INSTALL=0；pin 缺席整组跳过）。
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  formatBridgeBootVersionText,
  parseCommandWithEnvPrefix,
  probeBridgeHandshakeVersionSync,
  resolveBridgeDeployment,
  type BridgeDeployment,
} from "../../src/bridge/bridgeCommand.js";
import { LEGACY_PIN_ROOT_RELPATH } from "../../src/core/workspace/instancePin.js";

const repoRoot = join(import.meta.dirname, "..", "..");
const mockPeer = join(repoRoot, "tests", "fixtures", "mock_atf.mjs");
const tempRoots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "iso2-bridge-"));
  tempRoots.push(root);
  return root;
};
afterAll(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const mockDeployment = (kernelRoot: string | null): BridgeDeployment => ({
  mode: "real",
  argv: ["node", mockPeer],
  childEnv: {},
  kernelRoot,
});

describe("批㊶-ISO-2 S2——PYTHONPATH 前置模板（env-profiles 形态）", () => {
  it("模板定形解析：PYTHONPATH=<pin>/src 前置 → 子进程私有 env＋kernelRoot=pin 根（src 布局推导）", () => {
    const parsed = parseCommandWithEnvPrefix("PYTHONPATH=/data/atf/dev/pinned/src python3 -m agentic_training_flow serve");
    expect(parsed.argv).toEqual(["python3", "-m", "agentic_training_flow", "serve"]);
    expect(parsed.env["PYTHONPATH"]).toBe("/data/atf/dev/pinned/src");
    const deployment = resolveBridgeDeployment({
      commandValue: "PYTHONPATH=/data/atf/dev/pinned/src python3 -m agentic_training_flow serve",
      kernelDir: "/data/atf/dev/pinned",
      env: { ATF_DSH_BRIDGE_COMMAND: "PYTHONPATH=/data/atf/dev/pinned/src python3 -m agentic_training_flow serve" },
      probe: () => true,
    });
    expect(deployment.mode).toBe("real");
    expect(deployment.childEnv["PYTHONPATH"]).toBe("/data/atf/dev/pinned/src");
    expect(deployment.kernelRoot).toBe("/data/atf/dev/pinned"); // basename=src → 上级
    expect(deployment.argv).toEqual(["python3", "-m", "agentic_training_flow", "serve"]);
  });

  it("boot 版本行消费同一 deployment（装配面 kernelDir＝实例 pin 单源——模板即真命令形态）", () => {
    // resolveBridgeDeployment 不改命令串本身——前置 KEY=VALUE 词法已由既有单源承载
    const noPrefix = resolveBridgeDeployment({
      commandValue: "python3 -m agentic_training_flow serve",
      kernelDir: "/pin",
      env: { ATF_DSH_BRIDGE_COMMAND: "python3 -m agentic_training_flow serve" },
      probe: (p: string) => p === join("/pin", "src", "agentic_training_flow"),
    });
    expect(noPrefix.mode).toBe("real");
    expect(noPrefix.childEnv["PYTHONPATH"]).toBe(join("/pin", "src")); // 缺省派生链仍在（兼容态）
  });
});

describe("批㊶-ISO-2 S2——boot 桥版本行实载化（probeBridgeHandshakeVersionSync）", () => {
  it("mock 对端握手：handshake＝对端实载版本；describe 缺席 → 无不一致告警；显示面标注「握手实载」", () => {
    const surface = probeBridgeHandshakeVersionSync(mockDeployment(null));
    expect(surface.handshake).toBe("v0.2.0b7-mock");
    expect(surface.handshakeError).toBeNull();
    expect(surface.describe).toBeNull();
    expect(surface.mismatchWarning).toBeNull();
    expect(formatBridgeBootVersionText(surface)).toContain("v0.2.0b7-mock（握手实载）");
  });

  it("describe 与握手不一致 → mismatchWarning 双显＋warning（以实载为准）", () => {
    // 造临时 git 仓打 tag 充 pin 工作树（describe 可解析、与 mock 版本必不一致）
    const fakePin = tempRoot();
    const git = (args: string[]): void => {
      execFileSync("git", ["-C", fakePin, ...args], { stdio: "ignore" });
    };
    git(["init", "-q"]);
    git(["config", "user.email", "t@t"]);
    git(["config", "user.name", "t"]);
    writeFileSync(join(fakePin, "x"), "x");
    git(["add", "."]);
    git(["commit", "-qm", "pin"]);
    git(["tag", "v9.9.9-mismatch"]);
    const surface = probeBridgeHandshakeVersionSync(mockDeployment(fakePin));
    expect(surface.describe).toBe("v9.9.9-mismatch");
    expect(surface.handshake).toBe("v0.2.0b7-mock");
    expect(surface.mismatchWarning).toContain("v9.9.9-mismatch");
    expect(surface.mismatchWarning).toContain("v0.2.0b7-mock");
    expect(surface.mismatchWarning).toContain("以握手实载为准");
    expect(formatBridgeBootVersionText(surface)).toContain("不一致——以实载为准");
  });

  it("describe tag 与握手版本一致（v 前缀归一）→ 无告警；显示面「交叉核对一致」", () => {
    const fakePin = tempRoot();
    const git = (args: string[]): void => {
      execFileSync("git", ["-C", fakePin, ...args], { stdio: "ignore" });
    };
    git(["init", "-q"]);
    git(["config", "user.email", "t@t"]);
    git(["config", "user.name", "t"]);
    writeFileSync(join(fakePin, "x"), "x");
    git(["add", "."]);
    git(["commit", "-qm", "pin"]);
    git(["tag", "v0.2.0b7-mock"]); // describe 去 v 前缀＝握手版本
    const surface = probeBridgeHandshakeVersionSync(mockDeployment(fakePin));
    expect(surface.mismatchWarning).toBeNull();
    expect(formatBridgeBootVersionText(surface)).toContain("describe 交叉核对一致");
  });

  it("握手不可达（对端不存在）→ handshake null＋fail-soft 留因；显示面如实降级 describe 未核对", () => {
    const deployment: BridgeDeployment = { mode: "real", argv: ["node", join(repoRoot, "tests", "fixtures", "no-such-peer.mjs")], childEnv: {}, kernelRoot: null };
    const surface = probeBridgeHandshakeVersionSync(deployment, 3_000);
    expect(surface.handshake).toBeNull();
    expect(surface.handshakeError).not.toBeNull();
    expect(formatBridgeBootVersionText(surface)).toContain("握手不可达");
  });
});

// —— 定形冒烟（真内核·pin 在场才跑；沿契约测试隔离纪律） ——
const pinRoot = join(repoRoot, LEGACY_PIN_ROOT_RELPATH);
const pinServeReady = existsSync(join(pinRoot, "src", "agentic_training_flow"));
const describeSmoke = pinServeReady ? describe : describe.skip;

describeSmoke("批㊶-ISO-2 S2 定形冒烟（真内核 serve @ 仓内 pin）", () => {
  const pinVersion = (() => {
    const run = spawnSync("python3", ["-c", "import sys; sys.path.insert(0, sys.argv[1]); import agentic_training_flow; print(agentic_training_flow.__version__)", join(pinRoot, "src")], { encoding: "utf8", timeout: 30_000 });
    return run.status === 0 ? (run.stdout ?? "").trim() : null;
  })();

  it(`PYTHONPATH=<pin>/src serve 可起＋握手可通＋实载版本＝pin 树版本串${pinVersion === null ? "（版本串读取失败——skip 语义）" : `（期望 ${pinVersion}）`}`, { timeout: 30_000 }, async () => {
    if (pinVersion === null) {
      console.warn("[iso2-smoke] pin 树版本串不可读——冒烟如实跳过");
      return;
    }
    const home = mkdtempSync(join(tmpdir(), "iso2-serve-home-"));
    tempRoots.push(home);
    const deployment: BridgeDeployment = {
      mode: "real",
      argv: ["python3", "-m", "agentic_training_flow", "serve"],
      childEnv: { PYTHONPATH: join(pinRoot, "src"), HOME: home, ATF_SKILLS_AUTO_INSTALL: "0", PYTHONDONTWRITEBYTECODE: "1" },
      kernelRoot: pinRoot,
    };
    const surface = probeBridgeHandshakeVersionSync(deployment, 20_000);
    expect(surface.handshakeError ?? "ok").toBe("ok");
    expect(surface.handshake).toBe(pinVersion); // 实载＝pin 树版本串——bridge 载荷随 pin 走
    expect(surface.describe).toMatch(/^v/);
    expect(surface.mismatchWarning).toBeNull(); // describe=v<version> 与握手同指
  });
});
