/**
 * H-E9b（2026-10-25）——评估编排 argv 组装单点。
 *
 * 抽出的原因：N=1 与 N>1 必须是**同一条组装路径的两种入参形态**，
 * 且 N=1 的 argv 必须与改前逐字恒等（一票否决）——只有把组装抽成纯函数，
 * 恒等才能被断言而不是靠人眼看。
 *
 * 两种形态（内核 generate_eval_orchestration.py 的 CLI 契约，b16 实读）：
 * - 单类快路径（N=1）：--assets / --field-config / [--split-manifest] 显式单值三参；
 * - 逐类模式（N>1）：--run <runDir>，逐类三参由内核按权威槽位表 doc_slots 派生；
 *   与单值三参**互斥**（内核 eval_run_inputs_exclusive 生成期即拒，禁来源歧义）。
 */
export interface EvalOrchArgsInput {
  /** 内核编排生成器脚本绝对路径。 */
  readonly orchestration: string;
  /** 环节③服务目录（含 evalservice.sh / service_manifest.json）。 */
  readonly serviceDir: string;
  /** 环节④checkpoint staging 计划目录。 */
  readonly ckptPlanDir: string;
  /** 本轮编排输出目录（<轮>/orch）。 */
  readonly orchDir: string;
  /** 既有 formal eval runner 脚本。 */
  readonly runner: string;
  /** prompt 渲染器（run_formal_eval.py 必填参数，D58 生成期即拒）。 */
  readonly promptRenderer: string;
  /** 服务端口（base_url 取 manifest 端口——G11 收口，不设第二套缺省）。 */
  readonly port: number;
  /** 环境档案（existing 模式接入既有服务）。 */
  readonly envProfile: string;
  /** 推理并发（恒传，缺省 1）。 */
  readonly concurrency: number;
  /** 逐类模式入口：run 根目录（N>1 时给，N=1 不给）。 */
  readonly runDir?: string;
  /** 单类路径：L1 eval 资产目录（与 runDir 互斥）。 */
  readonly assetsDir?: string;
  /** 单类路径：字段配置（与 runDir 互斥）。 */
  readonly fieldConfig?: string;
  /** 单类路径：分区清单（可选；与 runDir 互斥）。 */
  readonly splitManifest?: string;
  /** 外部 eval-assets 显式确认（仅单类路径）。 */
  readonly assetsExternalConfirm?: boolean;
}

/** 返回 argv（不含 `python3` 前缀，与调用点 `runCapture("python3", argv, …)` 同式）。 */
export const buildEvalOrchArgs = (input: EvalOrchArgsInput): string[] => {
  const base = [
    input.orchestration,
    "--service", input.serviceDir,
    "--ckpt", input.ckptPlanDir,
    "--out", input.orchDir,
    "--eval-runner", input.runner,
    "--prompt-renderer", input.promptRenderer,
  ];
  const tail = [
    "--base-url", `http://127.0.0.1:${String(input.port)}/v1`,
    "--env-profile", input.envProfile,
    // 批D17：并发贯通编排（恒传，缺省 1）
    "--concurrency", String(input.concurrency),
  ];
  // 逐类模式：单值三参一个都不给（给了即内核 eval_run_inputs_exclusive 拒）
  if (input.runDir !== undefined) {
    const conflicts = [
      input.assetsDir !== undefined ? "assetsDir" : null,
      input.fieldConfig !== undefined ? "fieldConfig" : null,
      input.splitManifest !== undefined ? "splitManifest" : null,
    ].filter((v): v is string => v !== null);
    if (conflicts.length > 0) {
      // 来源歧义在 harness 侧就拒（内核同判据 eval_run_inputs_exclusive，此处不让它走到内核）
      throw new Error(`eval_orch_args_conflict：runDir 与单值参数互斥（${conflicts.join("/")}）`);
    }
    return [...base, "--run", input.runDir, ...tail];
  }
  return [
    ...base,
    "--assets", input.assetsDir ?? "",
    "--field-config", input.fieldConfig ?? "",
    ...tail,
    ...(input.splitManifest !== undefined ? ["--split-manifest", input.splitManifest] : []),
    ...(input.assetsExternalConfirm === true ? ["--assets-external-confirm"] : []),
  ];
};
