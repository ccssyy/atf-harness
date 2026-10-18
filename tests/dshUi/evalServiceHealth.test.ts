// 批C1-1 D6——评估服务健康面（端口来源读取＋内核探针调用壳；fail-closed 不造假）。
//
// - 端口来源：eval/services.jsonl 末行 port（缺账/坏行/非整数＝null）；
// - 健康组装：端口缺/无 kernelDir/脚本缺/执行失败/输出坏 → null（零假健康）；
// - 探测执行器注入桩：单测零真实 python 依赖；argv 断言（脚本目录＋端口）。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  evalProbeScriptCandidates,
  evalServicePortOf,
  probeEvalServiceHealth,
  type PythonProbeRunner,
} from "../../src/core/workspace/evalServiceHealth.js";

const tempRoots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "atf-evalhealth-"));
  tempRoots.push(root);
  return root;
};
afterEach(() => {
  for (const r of tempRoots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const seedRegistry = (runDir: string, lines: string[]): void => {
  mkdirSync(join(runDir, "eval"), { recursive: true });
  writeFileSync(join(runDir, "eval", "services.jsonl"), lines.join("\n") + "\n", "utf8");
};

/** 假内核目录（两候选布局之一在位即可被取用）。 */
const seedKernel = (): string => {
  const kernel = tempRoot();
  const scripts = evalProbeScriptCandidates(kernel)[0]!;
  mkdirSync(scripts, { recursive: true });
  writeFileSync(join(scripts, "eval_service_probe.py"), "def probe_local_vllm_process(port):\n    return {}\n", "utf8");
  return kernel;
};

describe("批C1-1 D6 端口来源（eval/services.jsonl 末行——append-only 登记账）", () => {
  it("末行 port 生效（前旧行不遮末行）；两形态 int 均收", () => {
    const runDir = tempRoot();
    seedRegistry(runDir, ['{"ts":"a","port":8100}', '{"ts":"b","port":8200}']);
    expect(evalServicePortOf(runDir)).toBe(8200);
  });
  it("缺账/空账/坏 JSON/port 非整数或非正 → null（不猜）", () => {
    const runDir = tempRoot();
    mkdirSync(runDir, { recursive: true });
    expect(evalServicePortOf(runDir)).toBeNull();
    seedRegistry(runDir, []);
    expect(evalServicePortOf(runDir)).toBeNull();
    seedRegistry(runDir, ["not json"]);
    expect(evalServicePortOf(runDir)).toBeNull();
    seedRegistry(runDir, ['{"port":"8100"}', '{"port":0}']);
    expect(evalServicePortOf(runDir)).toBeNull();
  });
});

describe("批C1-1 D6 健康组装（probeEvalServiceHealth——fail-closed 零假值）", () => {
  const stub: PythonProbeRunner = async (argv) => ({
    stdout: `{"alive": ${argv[1] === "8100" ? "true" : "false"}, "checked_at": "2026-10-18T03:00:00+00:00"}\n`,
  });

  it("端口在位＋内核脚本在位 → 探测回包组装三键闭集（argv＝脚本目录＋端口）", async () => {
    const runDir = tempRoot();
    seedRegistry(runDir, ['{"port":8100}']);
    const kernel = seedKernel();
    const seen: string[][] = [];
    const out = await probeEvalServiceHealth({
      runDir, kernelDir: kernel,
      runPython: async (argv) => { seen.push([...argv]); return stub(argv); },
    });
    expect(out).toEqual({ alive: true, port: 8100, checked_at: "2026-10-18T03:00:00+00:00" });
    expect(seen[0]?.[0]).toBe(join(kernel, "skills", "atf-evaluate-checkpoints", "scripts"));
    expect(seen[0]?.[1]).toBe("8100");
  });
  it("alive=false（服务停）如实透传——停服务一轮内可见的数据面", async () => {
    const runDir = tempRoot();
    seedRegistry(runDir, ['{"port":8200}']);
    const out = await probeEvalServiceHealth({ runDir, kernelDir: seedKernel(), runPython: stub });
    expect(out).toEqual({ alive: false, port: 8200, checked_at: "2026-10-18T03:00:00+00:00" });
  });
  it("端口缺（无服务登记）→ 不触探测即 null；kernelDir null（mock 对端）→ null", async () => {
    const runDir = tempRoot();
    mkdirSync(runDir, { recursive: true });
    const boom: PythonProbeRunner = async () => { throw new Error("must not run"); };
    expect(await probeEvalServiceHealth({ runDir, kernelDir: seedKernel(), runPython: boom })).toBeNull();
    seedRegistry(runDir, ['{"port":8100}']);
    expect(await probeEvalServiceHealth({ runDir, kernelDir: null, runPython: boom })).toBeNull();
  });
  it("内核脚本两候选均缺 → null；执行失败 → null；输出坏 JSON/缺键 → null", async () => {
    const runDir = tempRoot();
    seedRegistry(runDir, ['{"port":8100}']);
    const emptyKernel = tempRoot();
    expect(await probeEvalServiceHealth({ runDir, kernelDir: emptyKernel, runPython: stub })).toBeNull();
    expect(await probeEvalServiceHealth({ runDir, kernelDir: seedKernel(), runPython: async () => null })).toBeNull();
    expect(await probeEvalServiceHealth({
      runDir, kernelDir: seedKernel(),
      runPython: async () => ({ stdout: "garbage\n" }),
    })).toBeNull();
    expect(await probeEvalServiceHealth({
      runDir, kernelDir: seedKernel(),
      runPython: async () => ({ stdout: '{"checked_at":"x"}\n' }),
    })).toBeNull();
  });
});
