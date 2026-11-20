/**
 * 批C1-1 D6——评估服务健康面（复用内核 eval_service_probe，只读零写入）。
 *
 * 探测实现单源纪律：alive 判定不在本仓复刻——spawn `python3 -c` 导入内核
 * eval_service_probe（ps 进程表按端口反查 vllm serve，两形态等价判定），本模块只做
 * 端口来源读取（run 的 eval/services.jsonl 末行 port——append-only 服务登记账）与
 * 结果解析。取不到＝null（端口缺/脚本缺/python 失败/解析失败——fail-closed 不造假）。
 * 内核脚本路径＝桥装配同源 kernelDir（resolveInstanceKernelDir）派生 skills 与
 * _skills_pack 两候选（pin worktree 双布局），无 kernelDir（mock 对端）＝null。
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** 健康面（eval_progress.health——三键闭集；alive＝本机进程表实测）。 */
export interface EvalServiceHealthFace {
  alive: boolean;
  port: number;
  checked_at: string;
}

/** 探测执行器（可注入桩——单测零 python 依赖；缺省真跑 python3）。 */
export type PythonProbeRunner = (argv: readonly string[]) => Promise<{ stdout: string } | null>;

/** 内核探针脚本两候选路径（pin worktree 双布局：skills/ 源树与 src/ 包内 _skills_pack）。 */
export const evalProbeScriptCandidates = (kernelDir: string): string[] => [
  join(kernelDir, "skills", "atf-evaluate-checkpoints", "scripts"),
  join(kernelDir, "src", "agentic_training_flow", "_skills_pack", "atf-evaluate-checkpoints", "scripts"),
];

/**
 * 端口来源读取：run 的 eval/services.jsonl（内核服务登记账——append-only）末行 port。
 * 无账/坏行/非整数＝null（不猜）。纯读，键面白名单收窄。
 */
export const evalServicePortOf = (runDir: string): number | null => {
  const path = join(runDir, "eval", "services.jsonl");
  try {
    const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "");
    if (lines.length === 0) return null;
    const entry = JSON.parse(lines[lines.length - 1] as string) as Record<string, unknown>;
    const port = entry["port"];
    return typeof port === "number" && Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
};

/**
 * 只读探测脚本（经 argv 注入：脚本目录＋目标端口；输出单行 JSON
 * {alive, checked_at}——alive 判定全在内核 eval_service_probe.probe_local_vllm_process）。
 */
const PROBE_PY = [
  "import json, sys",
  "sys.path.insert(0, sys.argv[1])",
  "import eval_service_probe as probe",
  "result = probe.probe_local_vllm_process(int(sys.argv[2]))",
  "print(json.dumps({'alive': result.get('found') is True, 'checked_at': probe.utc_now_iso()}))",
].join("\n");

const defaultRunner: PythonProbeRunner = (argv) =>
  new Promise((resolve) => {
    execFile("python3", ["-c", PROBE_PY, ...argv], { timeout: 8_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      resolve(error === null ? { stdout: String(stdout) } : null);
    });
  });

/**
 * 健康面组装：端口在位＋内核探针脚本在位 → 真探测；任一缺席/失败 → null（无假健康）。
 * @param inputs.runDir - run 目录（服务登记账读取位）。
 * @param inputs.kernelDir - 内核目录（桥装配单源值；null＝mock 对端，健康面 null）。
 * @param inputs.runPython - 探测执行器（缺省真跑 python3；单测注入桩）。
 */
export const probeEvalServiceHealth = async (inputs: {
  runDir: string;
  kernelDir: string | null;
  runPython?: PythonProbeRunner;
}): Promise<EvalServiceHealthFace | null> => {
  const port = evalServicePortOf(inputs.runDir);
  if (port === null) return null;
  if (inputs.kernelDir === null) return null;
  const scriptsDir = evalProbeScriptCandidates(inputs.kernelDir).find((dir) => existsSync(join(dir, "eval_service_probe.py")));
  if (scriptsDir === undefined) return null;
  const run = inputs.runPython ?? defaultRunner;
  const result = await run([scriptsDir, String(port)]);
  if (result === null) return null;
  const lastLine = result.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "").pop() ?? "";
  try {
    const parsed = JSON.parse(lastLine) as Record<string, unknown>;
    const alive = parsed["alive"];
    const checkedAt = parsed["checked_at"];
    if (typeof alive !== "boolean" || typeof checkedAt !== "string" || checkedAt === "") return null;
    return { alive, port, checked_at: checkedAt };
  } catch {
    return null;
  }
};
