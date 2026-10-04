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
}
export interface AtfGpuStatus {
  offline: boolean;
  utilization?: string;
  memoryUsed?: string;
  memoryTotal?: string;
}
export interface AtfMonitorSnapshot {
  schema: string;
  generated_at: string;
  gpu: AtfGpuStatus;
  runs: Array<{
    run_id: string;
    state: string;
    segments: Array<{ key: string; label: string; status: "done" | "active" | "failed" | "pending" }>;
    viewers: string[];
    launch: unknown;
    training: { active: boolean; points: Array<Record<string, unknown>>; pending_confirm: unknown };
  }>;
}
export interface AtfArtifactsSnapshot {
  schema: string;
  generated_at: string;
  runs: Array<{ run_id: string; artifacts: Array<{ name: string; path: string; kind: string }> }>;
}
export declare function buildMonitorSnapshot(runs: AtfRunScan[], gpu?: AtfGpuStatus): AtfMonitorSnapshot;
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
