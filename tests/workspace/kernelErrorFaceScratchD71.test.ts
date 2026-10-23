/**
 * D71 补做——scratch 通道内核错误码封口四形态（指令件
 * 《ATF_裁定与更正_D71补做_E判据口径_20261023.md》§三第三步）。
 *
 * 判据面（产品测试黑盒：只断言 atf_scratch_exec 工具返回体与 scratch 观测账落盘事实，
 * 不引 handler 内部符号）：
 * - T1 码在 stderr 且带路径括号 → stderr_tail 人话 + note 人话
 * - T2 码只在 stdout（D71 实测向量：内核失败 JSON 信封）→ stdout 散文零码
 * - T3 exit_code==0 但 stdout 含码 → 同样换人话（扫描不看退出码）
 * - T4 未知码（信封 code 位不属闭集）→ 原样保留 + 观测账 unknown_code 一行
 * 全形态通用：码与原文落 <scratch>/.harness/kernel-error-face.jsonl（账面可查，行号可贴）。
 * D77（裁定《ATF_裁定_H判不通过_D77模型面对账面_20261023》）：完整码从模型可见返回体
 * 移出——T1/T2 断言返回体**序列化后不含** token_budget_missing；账本仍写 known_code 一行。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WORKSPACE_TOOL_HANDLERS, type LocalToolHost } from "../../src/core/tools/index.js";
import {
  KERNEL_ERROR_FACE_CODES,
  kernelErrorEnvelopeCode,
  replaceKernelErrorFace,
} from "../../src/core/workspace/kernelErrorFace.js";

const makeTemp = (label: string): string => mkdtempSync(join(tmpdir(), `atf-d71-${label}-`));

const makeHost = (scratch: string, home: string, kernelDir: string): LocalToolHost => ({
  scratchDir: scratch,
  kernelDir,
  home,
  baseEnv: {},
});

/** scratch 内落一个发射脚本（argv[0]=python3 白名单直通；避免 -c 引号转义噪声）。 */
const emitScript = (scratch: string, body: string): string[] => {
  writeFileSync(join(scratch, "emit.py"), body, "utf8");
  return ["python3", "emit.py"];
};

const readObservationLog = (scratch: string): Array<Record<string, unknown>> => {
  const logPath = join(scratch, ".harness", "kernel-error-face.jsonl");
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
};

describe("D71 封口：替换单源（kernelErrorFace 纯函数）", () => {
  it("无命中＝null（调用方零改动）；命中＝code:detail 全片段换人话；闭集外码不命中", () => {
    expect(replaceKernelErrorFace("plain output\n")).toBeNull();
    expect(replaceKernelErrorFace("")).toBeNull();
    const hit = replaceKernelErrorFace('{"error": "token_budget_missing:未给 --token-budget"}');
    expect(hit).not.toBeNull();
    if (hit !== null) {
      expect(hit.text).toContain("预算文件缺失");
      expect(hit.text).not.toContain("token_budget_missing");
      expect(hit.hits).toHaveLength(1);
      expect(hit.hits[0]?.code.startsWith("token_budget_missing")).toBe(true);
      // 替换后全文＝信封外壳保留、code:detail 片段位换 note（其余字节不动）
      expect(hit.text).toBe(`{"error": "${hit.hits[0]?.note}"}`);
    }
    // 冒号 detail 形态（token_budget_inconsistent:<detail>）同命中
    const inconsistent = replaceKernelErrorFace("token_budget_inconsistent:cutoff_len_mismatch:8000≠9000");
    expect(inconsistent).not.toBeNull();
    if (inconsistent !== null) expect(inconsistent.text).toContain("预算不一致");
  });

  it("信封 code 位识别：内核失败信封给出 base；非信封形态＝null（不猜正文）", () => {
    expect(kernelErrorEnvelopeCode('{"error": "some_new_code:细节说明"}')).toEqual({ base: "some_new_code" });
    expect(kernelErrorEnvelopeCode('{"error": "token_budget_missing:未给"}')?.base).toBe("token_budget_missing");
    expect(kernelErrorEnvelopeCode("token_budget_missing 裸码但非信封")).toBeNull();
    expect(kernelErrorEnvelopeCode("")).toBeNull();
    expect(kernelErrorEnvelopeCode('{"other": "x"}')).toBeNull();
  });

  it("闭集纪律：仍是四码，未扩未缩", () => {
    expect([...KERNEL_ERROR_FACE_CODES].sort()).toEqual([
      "gpu_capacity_insufficient",
      "token_budget_inconsistent",
      "token_budget_missing",
      "token_gate_not_configured",
    ]);
  });
});

describe("D71 封口：atf_scratch_exec 四形态（scratch 通道）", () => {
  it("T1 码在 stderr 且带路径括号 → stderr_tail 人话 + note 人话（返回体零码）", { timeout: 60_000 }, async () => {
    const scratch = makeTemp("t1");
    const home = makeTemp("t1home");
    const kernelDir = makeTemp("t1kernel");
    try {
      const argv = emitScript(
        scratch,
        "import sys\nsys.stderr.write('token_budget_missing:/abs/run/prep (--out 不在 run 树内)\\n')\nsys.exit(2)\n",
      );
      const result = await WORKSPACE_TOOL_HANDLERS["atf_scratch_exec"]!({ argv }, makeHost(scratch, home, kernelDir));
      expect(result.kind).toBe("executed");
      if (result.kind !== "executed") throw new Error("unreachable");
      const payload = result.result as Record<string, unknown>;
      expect((payload["exit_code"] as number)).toBe(2);
      expect(String(payload["stderr_tail"])).not.toContain("token_budget_missing");
      expect(String(payload["stderr_tail"])).toContain("预算文件缺失");
      expect(String(payload["note"])).toContain("预算文件缺失");
      // D77：完整码不进模型可见返回体（序列化面断言）；对账面＝观测账
      expect("kernel_error" in payload).toBe(false);
      expect(JSON.stringify(payload)).not.toContain("token_budget_missing");
      // stdout 无码 → 原样空串；观测账一行（stderr 键、原文可查）
      expect(payload["stdout"]).toBe("");
      const log = readObservationLog(scratch);
      expect(log).toHaveLength(1);
      expect(log[0]?.["kind"]).toBe("known_code");
      expect(log[0]?.["key"]).toBe("stderr_tail");
      expect(log[0]?.["tool"]).toBe("atf_scratch_exec");
      expect(String(log[0]?.["raw"])).toContain("token_budget_missing:/abs/run/prep");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
      rmSync(kernelDir, { recursive: true, force: true });
    }
  });

  it("T2 码只在 stdout（D71 实测向量：内核失败 JSON 信封）→ stdout 散文零码 + 观测账原文（返回体零码）", { timeout: 60_000 }, async () => {
    const scratch = makeTemp("t2");
    const home = makeTemp("t2home");
    const kernelDir = makeTemp("t2kernel");
    try {
      const argv = emitScript(
        scratch,
        "print('{\"error\": \"token_budget_missing:未给 --token-budget 或 --run-dir(重生成前先落 <run>/prep/token_budget.json)\"}')\nraise SystemExit(2)\n",
      );
      const result = await WORKSPACE_TOOL_HANDLERS["atf_scratch_exec"]!({ argv }, makeHost(scratch, home, kernelDir));
      expect(result.kind).toBe("executed");
      if (result.kind !== "executed") throw new Error("unreachable");
      const payload = result.result as Record<string, unknown>;
      expect((payload["exit_code"] as number)).toBe(2);
      const stdout = String(payload["stdout"]);
      expect(stdout).not.toContain("token_budget_missing");
      expect(stdout).toContain("预算文件缺失");
      expect(String(payload["note"])).toContain("预算文件缺失");
      // D77：完整码不进模型可见返回体（序列化面断言——H 复跑泄漏面即模型照抄返回体键）；
      // 对账面＝观测账（known_code 一行仍落，原文可查）
      expect("kernel_error" in payload).toBe(false);
      expect(JSON.stringify(payload)).not.toContain("token_budget_missing");
      const log = readObservationLog(scratch);
      expect(log).toHaveLength(1);
      expect(log[0]?.["kind"]).toBe("known_code");
      expect(log[0]?.["key"]).toBe("stdout");
      expect(String(log[0]?.["raw"])).toContain("token_budget_missing:未给 --token-budget 或 --run-dir");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
      rmSync(kernelDir, { recursive: true, force: true });
    }
  });

  it("T3 exit_code==0 但 stdout 含码 → 同样换人话（扫描不看退出码）", { timeout: 60_000 }, async () => {
    const scratch = makeTemp("t3");
    const home = makeTemp("t3home");
    const kernelDir = makeTemp("t3kernel");
    try {
      const argv = emitScript(
        scratch,
        "print('上游提示: token_budget_missing:预算文件缺失请先落盘')\n",
      );
      const result = await WORKSPACE_TOOL_HANDLERS["atf_scratch_exec"]!({ argv }, makeHost(scratch, home, kernelDir));
      expect(result.kind).toBe("executed");
      if (result.kind !== "executed") throw new Error("unreachable");
      const payload = result.result as Record<string, unknown>;
      expect((payload["exit_code"] as number)).toBe(0);
      const stdout = String(payload["stdout"]);
      expect(stdout).not.toContain("token_budget_missing");
      expect(stdout).toContain("预算文件缺失，先确认实验配置");
      // 上游前缀散文保留（业务描述完整，不做整体吞换）
      expect(stdout).toContain("上游提示:");
      // D77：返回体序列化零码（码唯一落观测账）
      expect("kernel_error" in payload).toBe(false);
      expect(JSON.stringify(payload)).not.toContain("token_budget_missing");
      expect(readObservationLog(scratch)).toHaveLength(1);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
      rmSync(kernelDir, { recursive: true, force: true });
    }
  });

  it("T4 未知码 → 原样保留 + 观测账 unknown_code 一行 + 返回体无 note/kernel_error", { timeout: 60_000 }, async () => {
    const scratch = makeTemp("t4");
    const home = makeTemp("t4home");
    const kernelDir = makeTemp("t4kernel");
    try {
      const argv = emitScript(
        scratch,
        "print('{\"error\": \"some_future_code:某新增内核码细节\"}')\nraise SystemExit(2)\n",
      );
      const result = await WORKSPACE_TOOL_HANDLERS["atf_scratch_exec"]!({ argv }, makeHost(scratch, home, kernelDir));
      expect(result.kind).toBe("executed");
      if (result.kind !== "executed") throw new Error("unreachable");
      const payload = result.result as Record<string, unknown>;
      // 原样保留（不替换不猜改）；无 note/kernel_error 键（typert lossless 条件 spread）
      expect(String(payload["stdout"])).toContain("some_future_code:某新增内核码细节");
      expect("note" in payload).toBe(false);
      expect("kernel_error" in payload).toBe(false);
      const log = readObservationLog(scratch);
      expect(log).toHaveLength(1);
      expect(log[0]?.["kind"]).toBe("unknown_code");
      expect(log[0]?.["key"]).toBe("stdout");
      expect(log[0]?.["code"]).toBe("some_future_code");
      expect(String(log[0]?.["raw"])).toContain("some_future_code:某新增内核码细节");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
      rmSync(kernelDir, { recursive: true, force: true });
    }
  });

  it("零码执行：无命中时返回体与观测账零改动（回归锚——正常输出不误伤）", { timeout: 60_000 }, async () => {
    const scratch = makeTemp("t0");
    const home = makeTemp("t0home");
    const kernelDir = makeTemp("t0kernel");
    try {
      const argv = emitScript(scratch, "print('hello scratch')\n");
      const result = await WORKSPACE_TOOL_HANDLERS["atf_scratch_exec"]!({ argv }, makeHost(scratch, home, kernelDir));
      expect(result.kind).toBe("executed");
      if (result.kind !== "executed") throw new Error("unreachable");
      const payload = result.result as Record<string, unknown>;
      expect(String(payload["stdout"])).toContain("hello scratch");
      expect("note" in payload).toBe(false);
      expect("kernel_error" in payload).toBe(false);
      expect(readObservationLog(scratch)).toHaveLength(0);
      expect(existsSync(join(scratch, ".harness"))).toBe(false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
      rmSync(kernelDir, { recursive: true, force: true });
    }
  });
});
