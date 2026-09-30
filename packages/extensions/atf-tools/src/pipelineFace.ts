/**
 * atf_pipeline_stage（M1 新增）：按段驱动 walkthrough_pipeline（内核仓 main 的
 * tools/walkthrough_pipeline.py，段函数模式）——register/label_qc/…/training_prep
 * 单段触发，为 M3 九要素流转提供管线控制面。
 *
 * 审批必经（指令要求 2）：任何段触发都走 DSH user-approval seam。命令经 Config 注入
 * （缺省 mock 对端——tests/fixtures/mock_pipeline.mjs；真内核走 env/Config 指向
 * python3 tools/walkthrough_pipeline.py）。非零退出/坏 JSON 如实回报，不造数。
 */
import { execFile } from "node:child_process";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { looseObjectOutput, renderAsJsonText, asToolValue } from "./schemaTranslate.js";
import { approvalDeniedResult, requestApproval } from "./approvalFace.js";

/** 走查管线段名（walkthrough_pipeline.py 段函数模式；training 前各段——真跑段零触碰）。 */
export const PIPELINE_STAGES: readonly string[] = ["register", "split", "label_qc", "candidate", "publish", "training_prep"];

const runPipeline = (command: string, args: readonly string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    const [file, ...rest] = command.split(" ");
    execFile(
      file ?? command,
      [...rest, ...args],
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        // 非零退出也返回（如实回报；超时时 code 为 null）
        const rawCode = error === null ? 0 : (error as NodeJS.ErrnoException & { code?: number | string }).code;
        const code = typeof rawCode === "number" ? rawCode : null;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

export const buildPipelineTool = (
  ctx: { get(service: string): unknown },
  pipelineCommand: string,
  pipelineTimeoutMs: number,
): unknown =>
  defineTool({
    name: "atf_pipeline_stage",
    description: `按段驱动 walkthrough_pipeline 管线（审批必经）：单段触发 ${PIPELINE_STAGES.join("/")} 之一。段完成返回该段结构化摘要；非零退出/缺料如实回报。审批面板放行后才会执行。`,
    parameters: {
      stage: { type: "string", required: true, enum: [...PIPELINE_STAGES], description: "要触发的管线段（单段）" },
    },
    output: {
      schema: looseObjectOutput,
      render: renderAsJsonText,
    },
    async execute(args: { stage: string }, exec: { agent?: unknown; callId?: string; signal?: unknown }) {
      const verdict = await requestApproval(ctx, exec, "atf_pipeline_stage", `触发 walkthrough_pipeline 管线段「${args.stage}」`);
      if (!verdict.ok) return approvalDeniedResult("atf_pipeline_stage", verdict.outcome);
      const result = await runPipeline(pipelineCommand, ["--stage", args.stage], pipelineTimeoutMs);
      let summary: unknown = null;
      const trimmed = result.stdout.trim();
      const jsonStart = trimmed.indexOf("{");
      if (jsonStart >= 0) {
        try {
          summary = JSON.parse(trimmed.slice(jsonStart)) as unknown;
        } catch {
          summary = null;
        }
      }
      return asToolValue({
        stage: args.stage,
        ok: result.code === 0,
        exit_code: result.code,
        ...(summary !== null ? { summary } : {}),
        ...(result.code !== 0 ? { stderr_tail: result.stderr.slice(-2000) } : {}),
        ...(summary === null && result.code === 0 ? { note: "段命令成功退出但无 JSON 摘要输出", stdout_head: trimmed.slice(0, 2000) } : {}),
      });
    },
  });
