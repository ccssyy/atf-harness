/** 批㉕B 段1 真跑冒烟：formal-02 现场数据两步链（冻结账本→一键链→viewer/report 实产出）。
 *  脚本一律 pin（.atf-pinned/skills）；只读评估产物，写 analysis/（旧产物先备份）。
 *  运行：npx tsx tests/dshTools/smoke_analyze_two_step.mts            */
import { cpSync, existsSync, statSync } from "node:fs";
import { buildEvalTools } from "/data/sam/ATF-Harness/packages/extensions/atf-tools/src/trainingFace.js";

const runsRoot = "/data/sam/atf-walkthrough/ws-walkthrough-pipeline/runs";
const runId = "run-regress-formal-02";
const kernelDir = "/data/sam/ATF-Harness/.atf-pinned";
const assets = "/data/sam/atf-walkthrough/ws-walkthrough-pipeline/runs/walkthrough-m12-real/eval-assets";
const runDir = `${runsRoot}/${runId}`;

// 旧产物保全（批㉔审计前的 formal-02 evidence 不覆盖）
for (const dir of ["analysis", "analysis-input"]) {
  const bak = `${runDir}/${dir}.bak-b24`;
  if (existsSync(`${runDir}/${dir}`) && !existsSync(bak)) {
    cpSync(`${runDir}/${dir}`, bak, { recursive: true });
    console.log(`backup: ${dir} -> ${dir}.bak-b24`);
  }
}

const noApproval = { get: () => undefined };
const tools = buildEvalTools(noApproval, { runsRoot, logDir: `${runDir}/training-logs`, kernelDir });
const analyze = (tools as Array<{ name: string; execute: (a: unknown, e: unknown) => Promise<Record<string, unknown>> }>)
  .find((t) => t.name === "atf_analyze_badcases");
if (analyze === undefined) throw new Error("atf_analyze_badcases missing");

console.log(`[smoke] run=${runId}\n[smoke] assets=${assets}`);
const t0 = Date.now();
const result = await analyze.execute({
  run_id: runId, eval_assets_dir: assets, lane: "goods",
  // formal-02 评估集声明坐标制（旧链跑通时的同款声明——GT/预测均 0..1000 轴制）
  coordinate_space: "qwen_axis_1000", gt_coordinate_space: "qwen_axis_1000",
}, { callId: "smoke-b25-seg1" });
console.log(JSON.stringify(result, null, 1));
console.log(`[smoke] elapsed=${((Date.now() - t0) / 1000).toFixed(1)}s`);

const ok = result["ok"] === true
  && result["viewer_ready"] === true
  && result["report_ready"] === true
  && statSync(String(result["viewer_html"])).size > 1000
  && statSync(String(result["report_md"])).size > 500;
console.log(ok ? "SMOKE PASS" : "SMOKE FAIL");
if (!ok) process.exit(1);
