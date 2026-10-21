/**
 * D51（门 2 收口）——测试隔离 guard（vitest setupFiles 首位）。
 *
 * 规则：测试/验收只写 /tmp（含 os.tmpdir）与 testws/；live 机器树一律禁写（读不受限
 * ——取证面）。违规＝测试进程失败。先例＝tmux 双轴隔离（tmuxTestSocket.ts——setupFiles
 * 次位）。
 *
 * 两层机制（如实声明边界）：
 *  ① mtime tripwire（权威层）：setup 对 live 树做有界快照（path→mtimeMs/在位集），
 *    进程退出时复检——新增文件/mtime 变化/删除即判违规：stderr 点名路径＋exitCode=1
 *    （后验判定，对任意写路径（fs/shell/子进程）零漏报；判定在退出时点＝零竞态）。
 *  ② node:fs CJS exports 补丁（纵深层）：createRequire 触达 CJS 模块对象包装写族函数，
 *    require 面同步即抛（node:fs 的 ESM 命名空间 sealed 不可重定义——具名 import 面
 *    由 ① 兜底，两层不重复宣称覆盖）。
 *
 * live 清单＝/data/atf/* 运行面（prodtest/dev/uat/datasets/instances/logs/kernel-runs）
 * ＋内核仓主工作树＋uat checkout＋pin worktree＋/root/.atf 账本面。快照有界（深度/条目
 * 封顶；超限子树按目录 mtime 判写痕）。
 */
import { createRequire } from "node:module";
import * as nodeFs from "node:fs";
import * as nodePath from "node:path";

export const LIVE_WRITE_FORBIDDEN_ROOTS: readonly string[] = [
  "/data/atf/prodtest", "/data/atf/dev", "/data/atf/uat", "/data/atf/datasets",
  "/data/atf/instances", "/data/atf/logs", "/data/atf/kernel-runs",
  "/data/sam/AgenticTrainingFlow", "/data/sam/ATF-Harness-uat",
  "/data/sam/ATF-Harness/.atf-pinned", "/root/.atf",
];

/** 快照有界参数（大子树截断——目录级 mtime 仍可判写痕）。 */
const SNAPSHOT_MAX_DEPTH = 6;
const SNAPSHOT_MAX_ENTRIES = 200_000;

const isLiveWritePath = (p: unknown): boolean => {
  if (typeof p !== "string" || p === "") return false;
  let abs: string;
  try { abs = nodePath.resolve(p); } catch { abs = String(p); }
  return LIVE_WRITE_FORBIDDEN_ROOTS.some((root) => abs === root || abs.startsWith(`${root}/`));
};

const testIsolationError = (op: string, p: unknown): Error =>
  new Error(`test_isolation_violation: 测试进程对 live 路径执行 ${op}: ${String(p)}——测试/验收只允许写 /tmp 或 testws/（D51）`);

// ── ② CJS 写族补丁（require 面） ──
type FsWriteFn = (...args: never[]) => unknown;
const fsCjs = createRequire(import.meta.url)("node:fs") as Record<string, FsWriteFn>;
const FS_WRITE_OPS: ReadonlyArray<{ name: string; targetIndex: number }> = [
  { name: "writeFileSync", targetIndex: 0 },
  { name: "appendFileSync", targetIndex: 0 },
  { name: "mkdirSync", targetIndex: 0 },
  { name: "rmSync", targetIndex: 0 },
  { name: "rmdirSync", targetIndex: 0 },
  { name: "unlinkSync", targetIndex: 0 },
  { name: "truncateSync", targetIndex: 0 },
  { name: "renameSync", targetIndex: 1 },
  { name: "cpSync", targetIndex: 1 },
  { name: "copyFileSync", targetIndex: 1 },
];
for (const op of FS_WRITE_OPS) {
  const original = fsCjs[op.name];
  if (typeof original !== "function") continue;
  fsCjs[op.name] = ((...args: never[]) => {
    if (isLiveWritePath(args[op.targetIndex])) throw testIsolationError(op.name, args[op.targetIndex]);
    return original(...args);
  }) as FsWriteFn;
}

// ── ① mtime tripwire（权威层：setup 快照 → 退出复检） ──
export interface LiveTreeSnapshot {
  entries: Map<string, { mtimeMs: number; isFile: boolean }>;
  truncatedDirs: Set<string>;
}

const snapshotTree = (root: string): LiveTreeSnapshot => {
  const entries = new Map<string, { mtimeMs: number; isFile: boolean }>();
  const truncatedDirs = new Set<string>();
  const walk = (dir: string, depth: number): void => {
    let names: string[];
    try { names = nodeFs.readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (entries.size >= SNAPSHOT_MAX_ENTRIES) { truncatedDirs.add(dir); return; }
      const path = nodePath.join(dir, name);
      try {
        const st = nodeFs.statSync(path);
        entries.set(path, { mtimeMs: st.mtimeMs, isFile: st.isFile() });
        if (st.isDirectory() && depth < SNAPSHOT_MAX_DEPTH) walk(path, depth + 1);
      } catch { /* 消失/不可 stat＝跳过（在场性变化由复检发现） */ }
    }
  };
  try {
    const rootSt = nodeFs.statSync(root);
    entries.set(root, { mtimeMs: rootSt.mtimeMs, isFile: false });
  } catch { /* 根缺席＝复检时新增在场即违规（若测试创建了它） */ }
  walk(root, 0);
  return { entries, truncatedDirs };
};

/** 快照入口（导出供测试锚——生产面由本文件 setup 直接消费）。 */
export const snapshotLiveTreeForTest = (root: string): LiveTreeSnapshot => snapshotTree(root);

/** 复检（导出供测试锚直调）：返回违规描述清单（空＝干净）。 */
export const verifyTreeUntouched = (root: string, before: LiveTreeSnapshot): string[] => {
  const violations: string[] = [];
  const after = snapshotTree(root);
  for (const [path, prior] of before.entries) {
    const now = after.entries.get(path);
    if (now === undefined) violations.push(`live 路径被删除/移走: ${path}`);
    else if (now.mtimeMs !== prior.mtimeMs || now.isFile !== prior.isFile) violations.push(`live 路径被改动: ${path}`);
  }
  for (const path of after.entries.keys()) {
    if (!before.entries.has(path)) violations.push(`live 树新增写入: ${path}`);
  }
  for (const dir of before.truncatedDirs) {
    const prior = before.entries.get(dir);
    const now = after.entries.get(dir);
    if (prior !== undefined && now !== undefined && now.mtimeMs !== prior.mtimeMs) violations.push(`live 超限子树有写痕（目录 mtime 变化）: ${dir}`);
  }
  return violations;
};

const beforeSnapshots = LIVE_WRITE_FORBIDDEN_ROOTS.map((root) => ({ root, snapshot: snapshotTree(root) }));
process.on("exit", () => {
  const violations = beforeSnapshots.flatMap(({ root, snapshot }) => verifyTreeUntouched(root, snapshot));
  if (violations.length > 0) {
    process.exitCode = 1;
    console.error(`[test-isolation-guard] test_isolation_violation ×${String(violations.length)}——测试进程写/动了 live workspace（只允许 /tmp 或 testws/；D51）：\n  ${violations.slice(0, 20).join("\n  ")}`);
  }
});
