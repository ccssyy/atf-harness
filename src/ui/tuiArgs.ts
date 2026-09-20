/**
 * TUI 参数面（W2 `--peer real` 门 2；《ATF-Harness_指令_W2门1裁定与门2启动_20260920.md》D-1～D-5）。
 *
 * 从 tui.ts 抽出为纯模块供单测（tui.ts 顶层 await main 不可直接 import）。
 * 职责：参数解析与组合校验（全部 fail-closed，参数错误 exit 1）＋真内核对端的**纯**组装面
 * （内核目录解析 D-2 / serve descriptor / init 调用面 D-1）；一切子进程效果（init、git、
 * mkdtemp）归 tui.ts，本模块零副作用。
 *
 * 裁定口径：--peer 仅接受 real（缺省 mock；与 --mock 互斥）；--peer real 必填 --ws-root
 * （不带 --peer real 时给出即报错）；--peer real 下 scope-mode 强制 canonical（显式非
 * canonical 报错，缺省自动取 canonical——内核 ScopeMode 枚举不含 headless，runner.ts 注记）；
 * 内核目录 = ATF_CLI_PATH 覆盖 > <repoRoot>/.atf-pinned 缺省（D-2）。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveAtfCommand, type AtfCliInvocation } from "../bridge/atfCommand.js";
import type { PeerSpawnDescriptor } from "../core/run/index.js";

export type PeerMode = "mock" | "real";
export type ScopeMode = "headless" | "canonical" | "simulation";

export interface TuiArgs {
  runsRoot: string;
  runId?: string;
  instruction?: string;
  scenarioId: string;
  scopeMode: ScopeMode;
  /** D-3：--scope-mode 是否显式给出（peer real 缺省 canonical 依据） */
  scopeModeSet: boolean;
  /** mock 对端 serve 脚本（peer real 时无意义；与 --peer real 互斥） */
  mockPath: string;
  peer: PeerMode;
  wsRoot?: string;
  help: boolean;
}

export const usage = (): string =>
  [
    "ATF Harness TUI（前端一 · 主入口，同进程直连 core）",
    "",
    "用法: node dist/ui/tui.js [--runs-root <dir>] [--run-id <id>] [--instruction <text>]",
    "      [--scenario-id <id>] [--scope-mode headless|canonical|simulation]",
    "      [--mock <path> | --peer real --ws-root <path>]",
    "",
    "  --runs-root      run 工作区根目录（缺省 <repo>/tmp/ui-runs）",
    "  --run-id         run 标识（缺省交互补问）",
    "  --instruction    触发指令（缺省交互补问）",
    "  --scenario-id    场景账面标识（缺省 l1ui-session）",
    "  --scope-mode     账本 scope_mode（缺省 headless；--peer real 下强制 canonical）",
    "  --mock           内核桥接 serve 脚本（缺省 mock 夹具；与 --peer real 互斥）",
    "  --peer           对端类型：real＝内置真内核对端（.atf-pinned/ATF_CLI_PATH，隔离 HOME，",
    "                   启动时按 --ws-root 预置 atf init；缺省 mock）",
    "  --ws-root        真内核 workspace 根（--peer real 时必填；run 骨架经走查 prep 脚本前置）",
    "",
    "红线: provider 配置经 ATF_LLM_CONFIG 注入（沿用 L1a）；审批应答只能由人在本界面给出。",
  ].join("\n");

export const parseArgs = (argv: readonly string[]): TuiArgs | { error: string } => {
  const args: TuiArgs = {
    runsRoot: join(repoRootDefault(), "tmp", "ui-runs"),
    scenarioId: "l1ui-session",
    scopeMode: "headless",
    scopeModeSet: false,
    mockPath: join(repoRootDefault(), "tests", "fixtures", "mock_atf.mjs"),
    peer: "mock",
    help: false,
  };
  let mockSet = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    const take = (): string => {
      i += 1;
      return next as string;
    };
    const takeChecked = (): string | undefined => {
      if (next === undefined) return undefined;
      i += 1;
      return next;
    };
    switch (arg) {
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--runs-root":
        args.runsRoot = take();
        break;
      case "--run-id":
        args.runId = take();
        break;
      case "--instruction":
        args.instruction = take();
        break;
      case "--scenario-id":
        args.scenarioId = take();
        break;
      case "--mock":
        args.mockPath = take();
        mockSet = true;
        break;
      case "--peer": {
        const value = takeChecked();
        if (value === undefined) return { error: "--peer 缺值（仅支持 real；缺省 mock）" };
        if (value !== "real") return { error: `--peer 非法: ${value}（仅支持 real；缺省 mock）` };
        args.peer = "real";
        break;
      }
      case "--ws-root": {
        const value = takeChecked();
        if (value === undefined) return { error: "--ws-root 缺值（--peer real 时必填）" };
        args.wsRoot = value;
        break;
      }
      case "--scope-mode": {
        const value = take();
        if (value !== "headless" && value !== "canonical" && value !== "simulation") {
          return { error: `--scope-mode 非法: ${value}（允许 headless|canonical|simulation）` };
        }
        args.scopeMode = value;
        args.scopeModeSet = true;
        break;
      }
      default:
        return { error: `未知参数: ${arg ?? "(空)"}（--help 查看用法）` };
    }
  }
  // 组合校验（裁定 §一：互斥/必填/D-3）
  if (args.peer === "real" && mockSet) {
    return { error: "--peer real 与 --mock 互斥（内置真内核对端不接 serve 脚本）" };
  }
  if (args.peer === "real" && args.wsRoot === undefined) {
    return { error: "--peer real 必填 --ws-root <path>（真内核 workspace 根）" };
  }
  if (args.peer !== "real" && args.wsRoot !== undefined) {
    return { error: "--ws-root 仅在 --peer real 下可用（mock 对端无 workspace 根）" };
  }
  if (args.peer === "real" && args.scopeModeSet && args.scopeMode !== "canonical") {
    return { error: `--peer real 下 scope-mode 强制 canonical（显式传 ${args.scopeMode} 不接受）` };
  }
  return args;
};

/** D-3：生效 scope_mode——peer real 恒 canonical（真实内核拒绝 headless，runner.ts 注记）。 */
export const effectiveScopeMode = (args: TuiArgs): ScopeMode => (args.peer === "real" ? "canonical" : args.scopeMode);

export interface KernelDirResolution {
  ok: true;
  path: string;
  /** 来源账面（首屏/报错文案用） */
  source: "ATF_CLI_PATH" | "缺省 .atf-pinned";
}

/** D-2：内核目录解析——ATF_CLI_PATH 已设置时覆盖，否则 <repoRoot>/.atf-pinned；目录须存在。 */
export const resolveKernelDir = (env: NodeJS.ProcessEnv, repoRoot: string): KernelDirResolution | { ok: false; error: string } => {
  const fromEnv = env["ATF_CLI_PATH"]?.trim();
  if (fromEnv !== undefined && fromEnv !== "") {
    if (!existsSync(fromEnv)) return { ok: false, error: `ATF_CLI_PATH 指向的目录不存在: ${fromEnv}` };
    return { ok: true, path: fromEnv, source: "ATF_CLI_PATH" };
  }
  const fallback = join(repoRoot, ".atf-pinned");
  if (!existsSync(fallback)) {
    return {
      ok: false,
      error: `缺省内核副本不存在: ${fallback}——先建 pin worktree：git -C <ATF_KERNEL_DIR> worktree add ${fallback} <pin tag>（或以 ATF_CLI_PATH 指向 checkout 在 pin 上的只读副本）`,
    };
  }
  return { ok: true, path: fallback, source: "缺省 .atf-pinned" };
};

/** serve 对端 descriptor（D-1/D-2 组装；env 注入 HOME 隔离与 ATF_WORKSPACE_ROOT，模板变量链用）。 */
export const buildRealPeerDescriptor = (kernelDir: string, wsRoot: string, home: string): PeerSpawnDescriptor => {
  const invocation = deriveAtfCommand(kernelDir, ["serve"]);
  return {
    argv: [invocation.command, ...invocation.args],
    cwd: invocation.cwd,
    env: { ...invocation.env, HOME: home, ATF_WORKSPACE_ROOT: wsRoot },
  };
};

/** D-1 预置 init 调用面（幂等；cwd/env 由 deriveAtfCommand 单点，HOME 由调用方并入）。 */
export const buildInitInvocation = (kernelDir: string, wsRoot: string): AtfCliInvocation =>
  deriveAtfCommand(kernelDir, ["init", "--workspace-root", wsRoot]);

/** 仓库根（tui.ts 与本模块缺省值共用；dist/ui/tuiArgs.js → 仓库根两级之上）。 */
export const repoRootDefault = (): string => fileURLToPath(new URL("../..", import.meta.url));
