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
}
export interface AtfMonitorSnapshot {
  schema: string;
  generated_at: string;
  runs: Array<{
    run_id: string;
    state: string;
    segments: Array<{ key: string; label: string; status: "done" | "active" | "failed" | "pending" }>;
    training: { active: boolean; points: Array<Record<string, unknown>>; pending_confirm: unknown };
  }>;
}
export interface AtfArtifactsSnapshot {
  schema: string;
  generated_at: string;
  runs: Array<{ run_id: string; artifacts: Array<{ name: string; path: string; kind: string }> }>;
}
export declare function buildMonitorSnapshot(runs: AtfRunScan[]): AtfMonitorSnapshot;
export declare function buildArtifactsSnapshot(runs: AtfRunScan[]): AtfArtifactsSnapshot;
export declare function parseLossSeries(text: string): Array<Record<string, unknown>>;
export declare function lossSvgPath(points: Array<Record<string, unknown>>, key: string, w?: number, h?: number): string | null;
export declare function deriveKpis(points: Array<Record<string, unknown>>): Record<string, string>;
export declare function deriveTrainingState(points: Array<Record<string, unknown>>): "idle" | "training";
