/**
 * W2 门 2：TUI 参数面单测（《ATF-Harness_指令_W2门1裁定与门2启动_20260920.md》§二；
 * 设计稿 §6 测试计划 ①–⑥ 全量）——解析/互斥/缺 ws-root 报错/D-2 内核目录/D-3 scope-mode/
 * descriptor 组装。纯面单测：零 spawn、零网络。
 */
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildInitInvocation,
  buildRealPeerDescriptor,
  effectiveScopeMode,
  parseArgs,
  resolveKernelDir,
} from "../../src/ui/tuiArgs.js";

const kernelDirOf = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "w2-args-kernel-"));
  return dir;
};

describe("W2 §6①：--peer real + --ws-root 合法（D-3 缺省 canonical）", () => {
  it("peer=real、wsRoot 落位、scope-mode 未显式给出", () => {
    const parsed = parseArgs(["--peer", "real", "--ws-root", "/tmp/ws-x"]);
    if ("error" in parsed) throw new Error(`不应报错: ${parsed.error}`);
    expect(parsed.peer).toBe("real");
    expect(parsed.wsRoot).toBe("/tmp/ws-x");
    expect(parsed.scopeModeSet).toBe(false);
    expect(effectiveScopeMode(parsed)).toBe("canonical");
  });

  it("peer real + 显式 --scope-mode canonical → 合法且生效值 canonical", () => {
    const parsed = parseArgs(["--peer", "real", "--ws-root", "/tmp/ws-x", "--scope-mode", "canonical"]);
    if ("error" in parsed) throw new Error(`不应报错: ${parsed.error}`);
    expect(effectiveScopeMode(parsed)).toBe("canonical");
  });
});

describe("W2 §6②③④⑤：互斥/必填/误用/非法值（全 fail-closed）", () => {
  it("--peer real 与 --mock 互斥", () => {
    const parsed = parseArgs(["--peer", "real", "--ws-root", "/tmp/ws-x", "--mock", "/tmp/serve.mjs"]);
    expect("error" in parsed && parsed.error.includes("互斥")).toBe(true);
  });

  it("--peer real 缺 --ws-root → 报错", () => {
    const parsed = parseArgs(["--peer", "real"]);
    expect("error" in parsed && parsed.error.includes("--ws-root")).toBe(true);
  });

  it("--ws-root 单独出现（无 --peer real）→ 报错", () => {
    const parsed = parseArgs(["--ws-root", "/tmp/ws-x"]);
    expect("error" in parsed && parsed.error.includes("--peer real")).toBe(true);
  });

  it("--peer 值非 real / 缺值 → 报错", () => {
    expect("error" in parseArgs(["--peer", "mock-value"])).toBe(true);
    expect("error" in parseArgs(["--peer"])).toBe(true);
  });

  it("peer real + 显式非 canonical scope-mode → 报错（D-3）", () => {
    const headless = parseArgs(["--peer", "real", "--ws-root", "/tmp/ws-x", "--scope-mode", "headless"]);
    expect("error" in headless && headless.error.includes("canonical")).toBe(true);
    const simulation = parseArgs(["--peer", "real", "--ws-root", "/tmp/ws-x", "--scope-mode", "simulation"]);
    expect("error" in simulation).toBe(true);
  });

  it("缺省（无新旗标）→ mock 轨现状逐位不变（零回归）", () => {
    const parsed = parseArgs([]);
    if ("error" in parsed) throw new Error(`不应报错: ${parsed.error}`);
    expect(parsed.peer).toBe("mock");
    expect(parsed.wsRoot).toBeUndefined();
    expect(parsed.scopeMode).toBe("headless");
    expect(effectiveScopeMode(parsed)).toBe("headless");
    expect(parsed.mockPath.endsWith("tests/fixtures/mock_atf.mjs")).toBe(true);
  });
});

describe("W2 §6⑥＋D-2：内核目录解析（ATF_CLI_PATH 覆盖 > 缺省 .atf-pinned）", () => {
  it("ATF_CLI_PATH 已设置且目录存在 → 覆盖缺省", () => {
    const dir = kernelDirOf();
    try {
      const resolved = resolveKernelDir({ ATF_CLI_PATH: dir }, "/nonexistent-repo");
      expect(resolved.ok).toBe(true);
      if (resolved.ok) {
        expect(resolved.path).toBe(dir);
        expect(resolved.source).toBe("ATF_CLI_PATH");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ATF_CLI_PATH 指向不存在目录 → fail-closed", () => {
    const resolved = resolveKernelDir({ ATF_CLI_PATH: "/nonexistent-atf-copy" }, "/nonexistent-repo");
    expect(!resolved.ok && resolved.error.includes("不存在")).toBe(true);
  });

  it("env 未设 + 仓内无 .atf-pinned → fail-closed 并给 worktree 引导", () => {
    const resolved = resolveKernelDir({}, "/nonexistent-repo");
    expect(!resolved.ok && resolved.error.includes("worktree add")).toBe(true);
  });

  it("env 未设 + 仓内 .atf-pinned 存在 → 缺省命中", () => {
    const repo = mkdtempSync(join(tmpdir(), "w2-args-repo-"));
    mkdirSync(join(repo, ".atf-pinned"), { recursive: true });
    try {
      const resolved = resolveKernelDir({}, repo);
      expect(resolved.ok).toBe(true);
      if (resolved.ok) {
        expect(resolved.path).toBe(join(repo, ".atf-pinned"));
        expect(resolved.source).toBe("缺省 .atf-pinned");
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("W2：descriptor 与 init 调用面组装（deriveAtfCommand 单点衍生）", () => {
  it("serve descriptor：argv/cwd/env 三要素（HOME 隔离＋ATF_WORKSPACE_ROOT 注入）", () => {
    const descriptor = buildRealPeerDescriptor("/kern", "/ws", "/home-iso");
    expect(descriptor.argv).toEqual(["python3", "-m", "agentic_training_flow", "serve"]);
    expect(descriptor.cwd).toBe("/kern");
    expect(descriptor.env?.["PYTHONPATH"]).toBe("/kern/src");
    expect(descriptor.env?.["HOME"]).toBe("/home-iso");
    expect(descriptor.env?.["ATF_WORKSPACE_ROOT"]).toBe("/ws");
    expect(descriptor.env?.["ATF_SKILLS_AUTO_INSTALL"]).toBe("0");
    expect(descriptor.env?.["PYTHONDONTWRITEBYTECODE"]).toBe("1");
  });

  it("init 调用面（D-1）：init --workspace-root 幂等预置，cwd=内核目录", () => {
    const init = buildInitInvocation("/kern", "/ws");
    expect(init.command).toBe("python3");
    expect(init.args).toEqual(["-m", "agentic_training_flow", "init", "--workspace-root", "/ws"]);
    expect(init.cwd).toBe("/kern");
  });
});
