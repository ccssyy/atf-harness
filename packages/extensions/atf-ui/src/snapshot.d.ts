/** snapshot.js 的类型面（纯函数集——实现见同名 .js）。 */
export declare const SEGMENTS: ReadonlyArray<{ key: string; label: string }>;
export declare const QUEUE_IDLE_TEXT: string;
export declare const KPI_KEYS: readonly string[];
export interface AtfRunScan {
  run_id: string;
  state?: string;
  segments?: Record<string, boolean | string>;
  training?: { active?: boolean; loss?: unknown; pending_confirm?: unknown };
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
}
export interface AtfGpuStatus {
  offline: boolean;
  utilization?: string;
  memoryUsed?: string;
  memoryTotal?: string;
}
/** 批㉝H：全卡面逐卡条目（queryNvidiaSmiAll 采集——index/utilization/memoryUsed/memoryTotal）。 */
export interface AtfGpuCardStatus {
  index: string;
  utilization: string;
  memoryUsed: string;
  memoryTotal: string;
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
    segments: Array<{ key: string; label: string; status: "done" | "active" | "failed" | "pending" }>;
    viewers: string[];
    launch: unknown;
    metrics: unknown;
    env: unknown;
    gpu_binding: { devices: string; source: "train_sh" | "deploy_effective" } | null;
    training: { active: boolean; points: Array<Record<string, unknown>>; pending_confirm: unknown };
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
export declare function buildTrainLaunchMessage(plan: {
  run_id: string;
  mode: "dry_run" | "real";
  summary?: Array<{ key: string; value: string; source: string }>;
}): string;
