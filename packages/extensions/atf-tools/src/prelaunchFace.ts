/**
 * atf_prelaunch_report（E4-乙改动 4）——训练启动前报告只读生成/回读工具。
 *
 * 消费内核件 skills/atf-prepare-training/scripts/build_prelaunch_report.py（TRAINING_RELEASE
 * 授权前必出材料；本报告未生成视为放行准入未闭合——prepare SKILL 合同）：入参 run_id＋
 * workspace_path，定位 run 树（resolvePipelineRunDir 同源——canonical 优先/legacy 兜底，
 * run 不存在即拒，只读不代建）→ 探测 IterationConfig 两形态（live prep/iteration-config.json
 * ＞legacy prep/iteration-config/iteration-config.json）→ 派生内核脚本生成
 * <run>/launch/prelaunch-report.md（脚本写产物＝内核产物由内核件写，harness 零直写——
 * 「快照是唯一出口」红线不破）→ 读回路径＋摘要返回。
 *
 * 不承担审批（材料不是闸）：本工具免审批——放行闸在 atf_launch_execute／atf_run_training
 * 的既有审批链；本工具只产材料。也不设第二套来源校验（E4-乙改动 3）：iteration-config 的
 * param_sources 来源串校验单源在内核 build_prelaunch_report（validate_param_sources——
 * 内核 b9 起接受 user_confirmed(ref=stage:training_overrides)：内核 training_prep 段按
 * --training-overrides 落账的确认来源）；harness 不复制该闸门、不因来源形态拒绝——
 * 脚本退出非零时如实回传 stderr（内核裁决原文）。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { looseObjectOutput, renderAsJsonText, asToolValue } from "./schemaTranslate.js";
import { resolvePipelineRunDir, runPipeline } from "./pipelineFace.js";

/** 报告读回摘要行数上限（head 截断——全文落盘在 report_path，摘要仅呈现面）。 */
const REPORT_SUMMARY_HEAD_LINES = 24;

/** IterationConfig 两形态探测（读序＝内核 RunLayout 单源：目录形态 live ＞ 平铺 legacy；
 *  都不在＝拒并指路）。
 *
 *  真机教训（ws2 联合 run）：两者并存时按「平铺优先」会读到 01:21 的陈旧副本
 *  （sha 与 launch_manifest 指纹不符），而内核实际写的是目录形态——优先级必须与
 *  RunLayout 一致，否则预检/放行在陈旧件上对账。 */
const detectIterationConfig = (runDir: string): { path: string; form: "live" | "legacy" } | null => {
  const live = join(runDir, "prep", "iteration-config", "iteration-config.json");
  if (existsSync(live)) return { path: live, form: "live" };
  const legacy = join(runDir, "prep", "iteration-config.json");
  if (existsSync(legacy)) return { path: legacy, form: "legacy" };
  return null;
};

export const buildPrelaunchReportTool = (
  ctx: { get(service: string): unknown },
  deps: { kernelDir: string; timeoutMs?: number },
): unknown => {
  void ctx; // 免审批（材料不是闸）——无 approval 消费；保留形参与既有 build* 工具装配签名一致
  const script = join(deps.kernelDir, "skills", "atf-prepare-training", "scripts", "build_prelaunch_report.py");
  return defineTool({
    name: "atf_prelaunch_report",
    description:
      "生成/回读训练启动前报告（只读材料面，免审批）：定位 run 树（workspace_path＋run_id——与 atf_pipeline_stage 同值；run 不存在即拒，不代建）→ 探测 IterationConfig（prep/iteration-config.json，legacy 深层形态兜底）→ 调内核 build_prelaunch_report.py 在 <run>/launch/prelaunch-report.md 生成报告（需 launch 产物在场：launch.sh/launch_manifest——缺即拒并指路先跑 training_prep）→ 返回报告路径＋字节＋摘要（头部行）。" +
      "材料不是闸：放行仍走 atf_launch_execute／atf_run_training 既有审批链；param_sources 来源串校验单源在内核脚本（b9 起接受 user_confirmed(ref=stage:training_overrides)）——本工具不设第二套来源校验，脚本裁决如实回传。报告已生成时幂等重跑（内核脚本覆盖重写）。",
    parameters: {
      run_id: { type: "string", required: true, description: "run 标识（落点 <workspace_path>/runs/<run_id>——与 atf_pipeline_stage 同值；run 不存在即拒）" },
      workspace_path: { type: "string", required: true, description: "workspace 根（绝对路径——与 atf_pipeline_stage 的 workspace_path 同值；落点解析 canonical RunLayout 优先）" },
    },
    output: {
      schema: looseObjectOutput,
      render: renderAsJsonText,
    },
    async execute(
      args: { run_id: string; workspace_path?: string },
      _exec: { agent?: unknown; callId?: string; signal?: unknown },
    ) {
      const workspacePath = typeof args.workspace_path === "string" ? args.workspace_path.trim() : "";
      if (workspacePath === "") {
        return asToolValue({ ok: false, run_id: args.run_id, error: "workspace_path_missing", note: "workspace_path 必填（绝对路径——与 atf_pipeline_stage 同值），不做 env 隐式缺省" });
      }
      const resolvedRun = resolvePipelineRunDir(workspacePath, args.run_id);
      if ("error" in resolvedRun) {
        return asToolValue({ ok: false, run_id: args.run_id, error: resolvedRun.error, note: resolvedRun.note });
      }
      const runDir = resolvedRun.runDir;
      const config = detectIterationConfig(runDir);
      if (config === null) {
        return asToolValue({ ok: false, run_id: args.run_id, run_dir: runDir, error: "iteration_config_missing", note: "run 目录无 IterationConfig（prep/iteration-config.json 与 legacy 深层形态皆缺席）——先跑 training_prep 段生成配置" });
      }
      const launchDir = join(runDir, "launch");
      if (!existsSync(join(launchDir, "launch.sh"))) {
        return asToolValue({ ok: false, run_id: args.run_id, run_dir: runDir, error: "launch_artifacts_missing", note: "launch 产物缺席（<run>/launch/launch.sh 不在）——报告消费环节①产物（launch.sh/launch_manifest），先跑 generate_train_launch 生成" });
      }
      if (!existsSync(script)) {
        return asToolValue({ ok: false, run_id: args.run_id, run_dir: runDir, error: "prelaunch_script_missing", note: `内核报告脚本不在位（${script}）——pin 未含或 kernelDir 配置漂移，不 mock 不猜` });
      }
      const reportPath = join(launchDir, "prelaunch-report.md");
      const result = await runPipeline(
        `python3 ${script}`,
        ["--config", config.path, "--launch-dir", launchDir, "--out", reportPath],
        deps.timeoutMs ?? 120_000,
      );
      if (result.code !== 0) {
        // 内核裁决原文如实回传（param_source_invalid 等来源串拒绝＝内核闸单源——本工具不预判不复制）
        return asToolValue({
          ok: false,
          run_id: args.run_id,
          run_dir: runDir,
          error: "prelaunch_report_failed",
          exit_code: result.code,
          stderr_tail: result.stderr.slice(-1500),
          note: "内核报告脚本非零退出——见 stderr_tail（配置/来源串/产物形态由内核脚本单源裁决）",
        });
      }
      let bytes = 0;
      let head = "";
      try {
        const text = readFileSync(reportPath, "utf8");
        bytes = statSync(reportPath).size;
        head = text.split("\n").slice(0, REPORT_SUMMARY_HEAD_LINES).join("\n");
      } catch {
        return asToolValue({ ok: false, run_id: args.run_id, run_dir: runDir, error: "prelaunch_report_unreadable", note: `脚本退出 0 但报告不可读：${reportPath}` });
      }
      return asToolValue({
        ok: true,
        run_id: args.run_id,
        run_dir: runDir,
        run_dir_layout: resolvedRun.layout,
        config_used: config.path,
        config_form: config.form,
        report_path: reportPath,
        report_bytes: bytes,
        summary_head: head,
        note: "训练启动前材料（不承担审批——放行走 atf_launch_execute/atf_run_training 既有审批链）",
      });
    },
  });
};
