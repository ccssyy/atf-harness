/** 批㉕B 段3 真实冒烟（owner 02:19 授权：本机 A800／vLLM 服务＋推理冒烟／formal-02 ckpt／≤10 页／零训练）：
 *  atf_evaluate 正道链全链——生成服务件→确认报告→确认卡（allowed-once）→账本登记→编排（tmux）。
 *  运行：vendor tsx tests/dshTools/smoke_eval_chain.mts start|status   */
import { buildEvalTools } from "/data/sam/ATF-Harness/packages/extensions/atf-tools/src/trainingFace.js";

const runsRoot = "/data/sam/atf-walkthrough/ws-walkthrough-pipeline/runs";
const runId = "run-regress-formal-02";
const kernelDir = "/data/sam/ATF-Harness/.atf-pinned";
const ws = "/data/sam/atf-walkthrough/ws-walkthrough-pipeline";

const mode = process.argv[2] ?? "start";
const allowedCtx = {
  get: (s: string) => (s === "approval"
    ? { request: async (req: { reason: string }) => {
        console.log("[确认卡]", req.reason.slice(0, 600).replace(/\n/g, "\n[卡] "));
        return "allowed-once";
      } }
    : undefined),
};
const tools = buildEvalTools(allowedCtx, {
  runsRoot, logDir: `${runsRoot}/${runId}/training-logs`, kernelDir,
});
const evaluate = (tools as Array<{ name: string; execute: (a: unknown, e: unknown) => Promise<Record<string, unknown>> }>)
  .find((t) => t.name === "atf_evaluate");
if (evaluate === undefined) throw new Error("atf_evaluate missing");

const args = mode === "start"
  ? {
      action: "start", run_id: runId,
      adapter_path: `${runsRoot}/${runId}/training/checkpoint-141`,
      eval_assets_dir: `${runsRoot}/walkthrough-m12-real/eval-assets`,
      field_config: `${kernelDir}/tools/walkthrough_assets/field-config-pl.json`,
      service_config: `${runsRoot}/${runId}/eval-b25/EvalServiceConfig.v1.json`,
      env_profile: "b25-eval-a800",
      deploy: `${ws}/deploy-eval-b25.local.yaml`,
    }
  : { action: "status", run_id: runId, adapter_path: "", eval_assets_dir: "", field_config: "", service_config: "", env_profile: "" };

const result = await evaluate.execute(args, { callId: `smoke-b25-seg3-${mode}` });
console.log(JSON.stringify(result, null, 1));
