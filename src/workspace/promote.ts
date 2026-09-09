/**
 * 晋升闸 A（任务书 §4.3 / ADR-08）：scratch(T0) → artifacts(T1) 的三闸校验——
 *   ① 幂等：catalog 已登记同源 → blocked(already_promoted)，已有 Artifact 一律不覆盖；
 *   ② 可复现：登记于产物元数据的复现命令由 harness 侧子进程重跑恰好一次（owner 口径 #3，
 *      本阶段不调用真实内核），stdout 字节 sha256 与源产物不一致 → blocked(not_reproducible)；
 *   ③ sha 指纹：通过两闸后写入 artifacts/，对产物字节计算 sha256 并登记 Artifact Catalog（owner 口径 #6）。
 *
 * 纪律：
 * - 基础设施故障（IO / spawn 失败 / 超时 / stdout 超限 / 清单损坏）≠ 闸门裁决 → Result err，不猜测；
 * - 一致性 fail-closed：catalog 已登记但产物文件缺失、artifacts/ 出现未登记同名文件 → err(corrupt_catalog)；
 * - 写入顺序 = 先产物文件后 catalog；catalog 写失败回滚刚写的产物文件并如实报告（不静默留不一致）；
 * - 禁止异常穿越边界：execute 永不抛出。
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { err, ok, type Result } from "../bridge/index.js";
import { loadCatalog, saveCatalog, type CatalogEntry } from "./catalog.js";
import { workspaceError, type PromoteOutcome, type WorkspaceError } from "./errors.js";
import { REPRODUCE_META_SUFFIX, RunWorkspace, safeScratchPath } from "./runWorkspace.js";

/** 复现命令超时（库内常量；promote 可注入覆盖以便测试）。与桥接请求超时同量级。 */
export const REPRODUCE_TIMEOUT_MS = 30_000;

/** 复现 stdout 字节上限（防御性常量；超限 = 基础设施故障，不猜测）。 */
export const MAX_REPRODUCE_STDOUT_BYTES = 10 * 1024 * 1024;

export interface PromoteOptions {
  /** 时间源注入（默认 UTC ISO 8601）；测试可用固定时钟。 */
  now?: () => string;
  /** 复现命令超时覆盖（测试用）。 */
  timeoutMs?: number;
}

export const sha256Hex = (bytes: Buffer | Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/** 晋升闸 A 唯一入口：promote(scratch 内相对路径 → artifacts)。 */
export const promoteArtifact = async (
  workspace: RunWorkspace,
  sourceRel: string,
  options: PromoteOptions = {},
): Promise<Result<PromoteOutcome, WorkspaceError>> => {
  const guard = safeScratchPath(workspace.scratchDir, sourceRel);
  if (!guard.ok) return guard;

  // ---------- 输入守卫：源产物 + 复现命令 sidecar（owner 口径 #3：命令登记于产物元数据） ----------
  let sourceBytes: Buffer;
  try {
    sourceBytes = await readFile(join(workspace.scratchDir, sourceRel));
  } catch (cause) {
    return err(workspaceError("invalid_input", `源产物不存在或不可读: ${sourceRel}`, {
      code: (cause as NodeJS.ErrnoException).code,
    }));
  }
  const meta = await readReproduceMeta(workspace, sourceRel);
  if (!meta.ok) return meta;

  // ---------- catalog 读入（损坏即停）与幂等闸 ----------
  const catalog = await loadCatalog(workspace.catalogPath);
  if (!catalog.ok) return catalog;
  const existing = catalog.value.artifacts.find((entry) => entry.artifact_id === sourceRel);
  const artifactPath = join(workspace.artifactsDir, sourceRel);
  if (existing !== undefined) {
    // 已登记：产物文件必须仍在——登记/文件失配 = 状态不自洽，fail-closed
    if (!(await fileExists(artifactPath))) {
      return err(workspaceError("corrupt_catalog", `catalog 已登记但产物文件缺失: ${sourceRel}`, { entry: existing }));
    }
    return ok({
      kind: "blocked",
      block: {
        reason: "already_promoted",
        message: `幂等闸拒绝：同源已晋升（已有 Artifact 不覆盖）: ${sourceRel}`,
        source: sourceRel,
        detail: { sha256: existing.sha256, promoted_at: existing.promoted_at },
      },
    });
  }
  // 未登记但 artifacts/ 已存在同名文件：未登记产物 = 状态不自洽，拒绝吸收也拒绝覆盖
  if (await fileExists(artifactPath)) {
    return err(workspaceError("corrupt_catalog", `artifacts/ 存在未登记文件，拒绝覆盖: ${sourceRel}`, { path: artifactPath }));
  }

  // ---------- 可复现闸（owner 口径 #3：harness 侧子进程执行一次，比对 stdout hash） ----------
  const sourceDigest = sha256Hex(sourceBytes);
  const reproduced = await runReproduce(
    meta.value.command,
    workspace.rootDir,
    options.timeoutMs ?? REPRODUCE_TIMEOUT_MS,
  );
  if (!reproduced.ok) return reproduced;
  if (reproduced.value.kind === "failed") {
    return ok({
      kind: "blocked",
      block: {
        reason: "not_reproducible",
        message: `可复现闸拒绝：复现命令退出码非 0（${String(reproduced.value.exit_code)}）`,
        source: sourceRel,
        detail: { exit_code: reproduced.value.exit_code, stderr_tail: reproduced.value.stderr_tail },
      },
    });
  }
  const reproducedDigest = sha256Hex(reproduced.value.stdout);
  if (reproducedDigest !== sourceDigest) {
    return ok({
      kind: "blocked",
      block: {
        reason: "not_reproducible",
        message: "可复现闸拒绝：复现输出与源产物 hash 不一致",
        source: sourceRel,
        detail: { expected_sha256: sourceDigest, actual_sha256: reproducedDigest },
      },
    });
  }

  // ---------- sha 指纹 + 写入（先产物文件后 catalog；catalog 失败回滚产物文件） ----------
  const now = options.now ?? ((): string => new Date().toISOString());
  const entry: CatalogEntry = {
    artifact_id: sourceRel,
    source: `scratch/${sourceRel}`,
    sha256: sourceDigest,
    bytes: sourceBytes.byteLength,
    promoted_at: now(),
    reproduce: { command: [...meta.value.command] },
  };
  try {
    await mkdir(join(workspace.artifactsDir, join(sourceRel, "..")), { recursive: true });
    await writeFile(artifactPath, sourceBytes);
  } catch (cause) {
    return err(workspaceError("io_error", `产物文件写入失败: ${(cause as Error).message}`, {
      path: artifactPath,
      code: (cause as NodeJS.ErrnoException).code,
    }));
  }
  const saved = await saveCatalog(workspace.catalogPath, {
    schema_version: 0,
    artifacts: [...catalog.value.artifacts, entry],
  });
  if (!saved.ok) {
    const rolledBack = await rm(artifactPath).then(
      () => true,
      (cause: NodeJS.ErrnoException) => {
        console.error(`晋升回滚失败（artifacts 留有未登记文件，须人工处置）: ${String(cause.message)}`);
        return false;
      },
    );
    return err(workspaceError("io_error", `catalog 写入失败，已${rolledBack ? "" : "未"}回滚产物文件`, {
      cause: saved.error,
      artifact_rolled_back: rolledBack,
    }));
  }
  return ok({ kind: "promoted", artifact: entry });
};

// ------------------------------------------------------------------ 内部

/** 读取并校验复现命令 sidecar（与源产物严格对应；缺失/不符/非法 = err(invalid_input)）。 */
const readReproduceMeta = async (
  workspace: RunWorkspace,
  sourceRel: string,
): Promise<Result<{ command: string[] }, WorkspaceError>> => {
  const metaPath = join(workspace.scratchDir, `${sourceRel}${REPRODUCE_META_SUFFIX}`);
  let text: string;
  try {
    text = await readFile(metaPath, "utf8");
  } catch (cause) {
    return err(workspaceError("invalid_input", `产物元数据缺失（晋升须先登记复现命令）: ${sourceRel}`, {
      metaPath,
      code: (cause as NodeJS.ErrnoException).code,
    }));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return err(workspaceError("invalid_input", "产物元数据非法 JSON", { metaPath }));
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return err(workspaceError("invalid_input", "产物元数据不是 JSON 对象", { metaPath }));
  }
  const record = parsed as Record<string, unknown>;
  if (record["artifact"] !== sourceRel) {
    return err(workspaceError("invalid_input", "产物元数据与晋升请求的源不一致", {
      metaPath,
      registered: record["artifact"],
      requested: sourceRel,
    }));
  }
  const reproduce = record["reproduce"];
  if (typeof reproduce !== "object" || reproduce === null || Array.isArray(reproduce)) {
    return err(workspaceError("invalid_input", "产物元数据缺少 reproduce 对象", { metaPath }));
  }
  const command = (reproduce as Record<string, unknown>)["command"];
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    command.some((part) => typeof part !== "string" || part === "")
  ) {
    return err(workspaceError("invalid_input", "复现命令非法（须为非空 argv 数组）", { metaPath, command }));
  }
  return ok({ command: [...command] });
};

/**
 * 复现命令执行（harness 侧子进程，argv 形态、无 shell、cwd = run 根）。
 * - 正常退出（exit 0）→ ok(ok) 携带 stdout 字节（hash 比对由晋升闸做）；
 * - 非零退出 → ok(failed)——这是闸门裁决输入（→ blocked not_reproducible）；
 * - spawn 失败 / 超时 / stdout 超限 → err(reproduce_failure)——基础设施故障，不猜测。
 */
const runReproduce = (
  command: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<Result<
  { kind: "ok"; stdout: Buffer } | { kind: "failed"; exit_code: number | null; stderr_tail: string },
  WorkspaceError
>> =>
  new Promise((resolve) => {
    let stdout: Buffer = Buffer.alloc(0);
    let stderrText = "";
    let settled = false;
    let child;
    try {
      child = spawn(command[0] as string, command.slice(1), { cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch (cause) {
      resolve(err(workspaceError("reproduce_failure", `复现命令 spawn 失败: ${String(cause)}`, { command })));
      return;
    }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      resolve(err(workspaceError("reproduce_failure", `复现命令超时（>${String(timeoutMs)} ms），不猜测可复现性`, {
        command,
        timeout_ms: timeoutMs,
      })));
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = Buffer.concat([stdout, chunk]);
      if (stdout.byteLength > MAX_REPRODUCE_STDOUT_BYTES && !settled) {
        settled = true;
        clearTimeout(timer);
        child.kill("SIGTERM");
        resolve(err(workspaceError("reproduce_failure", `复现输出超限（>${String(MAX_REPRODUCE_STDOUT_BYTES)} 字节）`, {
          command,
        })));
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrText = stderrText + chunk.toString("utf8");
    });
    child.on("error", (cause: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(err(workspaceError("reproduce_failure", `复现命令执行失败: ${cause.message}`, { command, cause })));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve(ok({ kind: "ok", stdout }));
        return;
      }
      const tail = stderrText.length > 2048 ? `…(截断)${stderrText.slice(-2048)}` : stderrText;
      resolve(ok({ kind: "failed", exit_code: code, stderr_tail: tail }));
    });
  });

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};
