/**
 * atf_pipeline_stage（M1 新增）：按段驱动 walkthrough_pipeline（内核仓 main 的
 * tools/walkthrough_pipeline.py，段函数模式）——register/label_qc/…/training_prep
 * 单段触发，为 M3 九要素流转提供管线控制面。
 *
 * 审批必经（指令要求 2）：任何段触发都走 DSH user-approval seam。命令经 Config 注入
 * （缺省 mock 对端——tests/fixtures/mock_pipeline.mjs；真内核走 env/Config 指向
 * python3 tools/walkthrough_pipeline.py）。非零退出/坏 JSON 如实回报，不造数。
 *
 * A2（2026-10-17 修复批）：run 目录单源解析（resolveRunDir＋会话工作区桶——与
 * confirmFace 同一解析面，不自建第二套推导）。段 exit_code===0 才落会话绑定
 * appendBinding(runDir, sessionId)（sessionId 取 exec.agent.session.id，取不到如实
 * 跳过——fail-open 沿既有语义）；run 目录本地文件，不进 bridge 契约面。
 */
import { execFile } from "node:child_process";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { looseObjectOutput, renderAsJsonText, asToolValue } from "./schemaTranslate.js";
import { approvalDeniedResult, requestApproval } from "./approvalFace.js";
import { appendBinding } from "../../../../src/core/workspace/runFacts.js";
import { resolveRunDir, sessionWorkspaceSlug } from "../../../../src/core/workspace/runLayout.js";

/** 走查管线段名（walkthrough_pipeline.py 段函数模式；training 前各段——真跑段零触碰）。 */
export const PIPELINE_STAGES: readonly string[] = ["register", "split", "label_qc", "candidate", "publish", "training_prep"];

/** 会话身份提取（exec.agent.session.id；取不到＝undefined 如实跳过——confirmFace 同款）。 */
const sessionIdOfExec = (exec: unknown): string | undefined => {
  const id = (exec as { agent?: { session?: { id?: unknown } } }).agent?.session?.id;
  return typeof id === "string" && id !== "" ? id : undefined;
};

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
  runsRoot: string,
): unknown =>
  defineTool({
    name: "atf_pipeline_stage",
    description: `按段驱动 walkthrough_pipeline 管线（审批必经）：单段触发 ${PIPELINE_STAGES.join("/")} 之一。段完成返回该段结构化摘要；非零退出/缺料如实回报。段成功退出（exit 0）即在 run 目录落会话绑定（run 归属——胶囊渲染数据源之一）；非零退出不落任何事实。审批面板放行后才会执行。`,
    parameters: {
      stage: { type: "string", required: true, enum: [...PIPELINE_STAGES], description: "要触发的管线段（单段）" },
      run_id: { type: "string", required: true, description: "run 标识（段事实与会话绑定的落点 run 目录）" },
    },
    output: {
      schema: looseObjectOutput,
      render: renderAsJsonText,
    },
    async execute(args: { stage: string; run_id: string }, exec: { agent?: unknown; callId?: string; signal?: unknown }) {
      const verdict = await requestApproval(ctx, exec, "atf_pipeline_stage", `触发 walkthrough_pipeline 管线段「${args.stage}」（run ${args.run_id}）`);
      if (!verdict.ok) return approvalDeniedResult("atf_pipeline_stage", verdict.outcome);
      // run 目录双形态解析单源（平铺在场＞桶内在场＞新建入桶——runLayout 单源，禁第二套推导）
      const runDir = resolveRunDir(runsRoot, args.run_id, { workspace: sessionWorkspaceSlug(exec) });
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
      // 成功路径：会话绑定（A2——run 归属写入）；非零退出零写入。
      let session_bound = false;
      if (result.code === 0) {
        const sessionId = sessionIdOfExec(exec);
        if (sessionId !== undefined) {
          appendBinding(runDir, sessionId);
          session_bound = true;
        }
      }
      return asToolValue({
        stage: args.stage,
        run_id: args.run_id,
        ok: result.code === 0,
        exit_code: result.code,
        session_bound,
        ...(summary !== null ? { summary } : {}),
        ...(result.code !== 0 ? { stderr_tail: result.stderr.slice(-2000) } : {}),
        ...(summary === null && result.code === 0 ? { note: "段命令成功退出但无 JSON 摘要输出", stdout_head: trimmed.slice(0, 2000) } : {}),
      });
    },
  });
