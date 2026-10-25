/** snapshot.js 的类型面（纯函数集——实现见同名 .js）。 */
export declare const SEGMENTS: ReadonlyArray<{ key: string; label: string }>;
export declare const QUEUE_IDLE_TEXT: string;
export declare const KPI_KEYS: readonly string[];
/** 段内进度面（与 src/core/workspace/runFacts.ts RunProgress 同构——atf-ui 包内独立声明，
 *  零跨包 import；D3/D4 浮卡进度行数据源）。 */
export interface AtfRunProgress {
  round?: number;
  total_rounds?: number;
  step_remaining?: number;
  eta_s?: number;
  loss?: number;
  percentage?: number;
  stale?: boolean;
  updated_at: string;
  source_updated_at?: string;
}
export interface AtfRunScan {
  run_id: string;
  state?: string;
  /** A2 案 a：工作区标注来源（bucket＝runsRoot 分桶缺省；registry＝注册表前缀/实验树）。 */
  workspace_source?: "bucket" | "registry";
  segments?: Record<string, boolean | string>;
  /** 批㊶Q增补二2：progress 输入两形态（顶层直通＋training 子键回退——scanRunDir 实挂后者）。 */
  progress?: AtfRunProgress | null;
  training?: { active?: boolean; loss?: unknown; pending_confirm?: unknown; progress?: AtfRunProgress | null };
  report?: { files?: string[] };
  artifacts?: string[];
  /** 批㉛段1：badcase viewer 发现清单（scanRunDir 两形态推导；缺省空数组＝无挂载面）。 */
  viewers?: string[];
  /** 批㉛段2：Web 发起训练面（train.sh/快照/IterationConfig/prelaunch/摘要；null＝不可发起）。 */
  launch?: unknown;
  /** 批㉛段3.1：评估轮 KPI 面（micro f1/precision/recall＋page_exact_rate；null＝无评估轮）。 */
  metrics?: unknown;
  /** 批㉛段3.1：环境卡面（基模型/数据集键/deepspeed/lane；null＝无 IterationConfig）。 */
  env?: unknown;
  /** 批㉝H：绑卡声明（train_sh＝CUDA_VISIBLE_DEVICES／deploy_effective＝visible_devices；null＝读不到）。 */
  gpu_binding?: { devices: string; source: "train_sh" | "deploy_effective" } | null;
  /** D11-2：产物区 checkpoint 名单（新→旧最多 5 条；缺席＝空数组）。 */
  ckpts?: string[];
  /** 批㉞H：逐 eval 轮对比面（scanEvalRounds 产物；空数组＝无轮产物）。 */
  eval_rounds?: unknown[];
  /** 批㊶-S3 S-B1：评估就绪进度投影（orch/progress.jsonl 读账；null＝无账）。 */
  eval_progress?: unknown;
  /** 批㊶-S3 S-B1：阶段流转＋训练完成可评估通知（读账播报；空数组＝无通知）。 */
  eval_notices?: unknown[];
  /** 批㊶-TRAIN-OBS T3：训练日志尾部投影（两键闭集；null＝缺席）。 */
  trainlog_tail?: unknown;
  /** 批B1：run 显示名（用户改名优先，否则自动名；title 不含 workspace；null＝读失败不造名）。 */
  display?: { title: string } | null;
  /** E8：单据槽位面（additive——server scanRunDirAt 产物；空数组＝无槽位）。 */
  doc_slots?: Array<{ doc_type: string; has_candidate: boolean; has_variants: boolean; rows: number | null }>;
}
export interface AtfGpuStatus {
  offline: boolean;
  utilization?: string;
  memoryUsed?: string;
  memoryTotal?: string;
}
/** 批㉝H：全卡面逐卡条目（queryNvidiaSmiAll 采集——index/utilization/memoryUsed/memoryTotal；
 *  D11-2 纯增可选温度/功耗：[N/A]/空/非数值 → null，旧四字段零改）。 */
export interface AtfGpuCardStatus {
  index: string;
  utilization: string;
  memoryUsed: string;
  memoryTotal: string;
  temperature?: number | null;
  powerDraw?: number | null;
}
export interface AtfMonitorSnapshot {
  schema: string;
  generated_at: string;
  gpu: AtfGpuStatus;
  /** 批㉝H：全卡聚合面（空数组＝不可用/旧快照，client 回退首行单卡面）。 */
  gpu_all: AtfGpuCardStatus[];
  runs: Array<{
    run_id: string;
    state: string;
    /** A2 案 a：工作区标注来源（additive 投影键——两键闭集）。 */
    workspace_source: "bucket" | "registry";
    /** D96：段灯＝内核 STAGE_ORDER 八段（键名逐键一致；训练执行/评估不占灯——独立卡）。 */
    segments: Array<{ key: string; label: string; status: "done" | "active" | "failed" | "pending" }>;
    viewers: string[];
    launch: unknown;
    metrics: unknown;
    env: unknown;
    gpu_binding: { devices: string; source: "train_sh" | "deploy_effective" } | null;
    /** D11-2：产物区 checkpoint 名单（additive——新→旧最多 5 条；缺席＝空数组）。 */
    ckpts: string[];
    /** 批㉞H：逐 eval 轮对比面（两轮对比视图数据源；空数组＝无轮产物）。 */
    eval_rounds: unknown[];
    /** 批㊶-S3 S-B1：评估就绪进度投影（键面白名单五键；null＝无账）。 */
    eval_progress: unknown;
    /** 批㊶-S3 S-B1：通知面（eval_phase 流转＋trainable 可评估；空数组＝无）。 */
    eval_notices: unknown[];
    /** 批㊶-TRAIN-OBS T3：训练日志尾部（capture-pane 采集面；null＝缺席）。 */
    trainlog_tail: unknown;
    /** 批B1：run 显示名（additive 可选——缺席＝旧装配面，client 回退 run_id）。 */
    display?: { title: string } | null;
    /** E8：单据槽位面（additive——联合训练对话框按类呈现的数据源；空数组＝无槽位）。 */
    doc_slots: Array<{ doc_type: string; has_candidate: boolean; has_variants: boolean; rows: number | null }>;
    training: { active: boolean; points: Array<Record<string, unknown>>; pending_confirm: unknown };
    /** 批㊶-N N-3／批㊶Q增补二2：段内进度（恒输出——顶层直通＞training 子键回退＞null；
     *  浮卡进度行数据源）。 */
    progress: AtfRunProgress | null;
  }>;
}
export interface AtfArtifactsSnapshot {
  schema: string;
  generated_at: string;
  runs: Array<{ run_id: string; artifacts: Array<{ name: string; path: string; kind: string }> }>;
}
export declare function buildMonitorSnapshot(runs: AtfRunScan[], gpu?: AtfGpuStatus, gpuAll?: AtfGpuCardStatus[]): AtfMonitorSnapshot;
/** 批㉝H：全卡聚合显示串（空列表 → null）；client.js 有同语义裸服务副本。 */
export declare function formatGpuAll(gpuAll: AtfGpuCardStatus[] | null | undefined): string | null;
/** 批㉝H：绑卡标注（缺席 → null）；client.js 有同语义裸服务副本。 */
export declare function formatGpuBinding(binding: { devices: string; source: "train_sh" | "deploy_effective" } | null | undefined): string | null;
export declare function formatTaskCard(monitorRun: Pick<AtfMonitorSnapshot["runs"][number], "segments">): string;
export declare function buildArtifactsSnapshot(runs: AtfRunScan[]): AtfArtifactsSnapshot;
export declare function parseLossSeries(text: string): Array<Record<string, unknown>>;
export declare function lossSvgPath(points: Array<Record<string, unknown>>, key: string, w?: number, h?: number): string | null;
export declare function deriveKpis(points: Array<Record<string, unknown>>): Record<string, string>;
export declare function deriveTrainingState(points: Array<Record<string, unknown>>): "idle" | "training";
/** D34：决策闭环默认指令（PILLS『走完闭环』胶囊单源文案——含留痕封存步）。 */
export declare const CLOSURE_MESSAGE: string;
export declare function buildTrainLaunchMessage(plan: {
  run_id: string;
  mode: "dry_run" | "real";
  summary?: Array<{ key: string; value: string; source: string }>;
}): string;
