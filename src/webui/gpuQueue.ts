/**
 * 批⑯ 增量 A（2026-09-30，指令 f4ef32e2）——GPU 排队语义（产品功能，非运维探测）。
 *
 * 训练段状态从静态 gpu_window_pending 升级为排队语义：
 *   - 排队中：`⏳ 排队中 · 已等待 <时长> · 每 5 分钟自动探测`（进度卡＋对话流各一条入队 notice）
 *   - 轮询：复用 atf_gpu_status（queryNvidiaSmi），每 5 分钟（env ATF_WEBUI_GPU_POLL_MS 可配，测试注入）
 *   - 命中条件：某卡利用率 <20% 且显存 <10GB 连续 2 个周期
 *   - 命中 → 琥珀确认态：`GPU <n> 已空闲，确认开跑？`（danger_confirm 守门不变——仍需用户点确认）
 * 纯函数判定面（queueHit 判定＋等待时长格式化）与本类编排分离——合成测试直接锚判定。
 */
import { queryNvidiaSmi, type GpuStatus } from "./readOnlyTools.js";
import type { ChatEvent } from "./chatModel.js";

/** 命中阈值（指令口径：利用率 <20% 且显存 <10GB 连续 2 周期）。显存单位 MiB。 */
export const GPU_HIT_UTILIZATION_PCT = 20;
export const GPU_HIT_MEMORY_MIB = 10_000;
export const GPU_HIT_CONSECUTIVE = 2;

/** 单周期探测结果（某卡命中判定——多卡取最优命中卡）。 */
export const gpuCycleHit = (status: GpuStatus): { hit: boolean; gpuIndex: number } => {
  const utilization = Number.parseFloat(status.utilization.replace("%", ""));
  const memoryUsed = Number.parseFloat(status.memoryUsed.replace(/[^\d.]/g, ""));
  const hit = Number.isFinite(utilization) && Number.isFinite(memoryUsed) && utilization < GPU_HIT_UTILIZATION_PCT && memoryUsed < GPU_HIT_MEMORY_MIB;
  return { hit, gpuIndex: 0 };
};

/** 连续命中计数器状态机（fold 单周期结果 → 命中裁决）。 */
export class GpuQueueWatcher {
  private consecutive = 0;

  public constructor(private readonly onHit: (gpuIndex: number, waitedText: string) => void) {}

  /** 每周期喂一次探测结果；连续命中达阈值 → 触发 onHit 一次并复位（等待下一轮入队）。 */
  public cycle(status: GpuStatus, waitedText: string): void {
    const { hit, gpuIndex } = gpuCycleHit(status);
    this.consecutive = hit ? this.consecutive + 1 : 0;
    if (this.consecutive >= GPU_HIT_CONSECUTIVE) {
      this.consecutive = 0;
      this.onHit(gpuIndex, waitedText);
    }
  }

  public reset(): void {
    this.consecutive = 0;
  }
}

/** 等待时长人读格式（⏳ 排队中 · 已等待 <时长>）。 */
export const formatWaited = (sinceMs: number): string => {
  const seconds = Math.floor(sinceMs / 1000);
  if (seconds < 60) return `${String(seconds)} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)} 分 ${String(seconds % 60)} 秒`;
  return `${String(Math.floor(minutes / 60))} 时 ${String(minutes % 60)} 分`;
};

/** 排队状态卡文案（进度卡与对话流同源——§A 状态可见性）。 */
export const queueStatusText = (waitedText: string): string =>
  `⏳ 排队中 · 已等待 ${waitedText} · 每 5 分钟自动探测`;

/** 命中琥珀确认卡文案（danger_confirm 标题；真跑守门不变）。 */
export const queueHitText = (gpuIndex: number): string => `GPU ${String(gpuIndex)} 已空闲，确认开跑？`;

/** 排队编排器（会话级；管理定时器与事件发射——测试注入 pollMs 与 query）。 */
export class GpuQueueOrchestrator {
  private timer: ReturnType<typeof setInterval> | null = null;
  private watcher: GpuQueueWatcher | null = null;
  private readonly pollMs: number;
  private readonly query: () => Promise<GpuStatus | null>;

  public constructor(options: { pollMs?: number; query?: () => Promise<GpuStatus | null> } = {}) {
    this.pollMs = options.pollMs ?? Number(process.env["ATF_WEBUI_GPU_POLL_MS"] ?? 300_000);
    this.query = options.query ?? queryNvidiaSmi;
  }

  /**
   * 入队：发排队 notice＋启动 5 分钟轮询；命中 → 琥珀确认卡事件＋停止轮询（等用户点确认——
   * danger 守门在会话层 emitDangerConfirm，本编排器只产出命中事件）。
   */
  public enqueue(runId: string, emit: (event: ChatEventInputOf) => void, onHit: () => void): void {
    const startedAt = Date.now();
    emit({ kind: "system_notice", level: "warn", text: queueStatusText(formatWaited(0)), at: new Date().toISOString() });
    this.watcher = new GpuQueueWatcher((gpuIndex, waitedText) => {
      this.stop();
      emit({ kind: "system_notice", level: "warn", text: `${queueHitText(gpuIndex)}（已等待 ${waitedText}）——请点确认卡放行（真跑守门不变）`, at: new Date().toISOString() });
      void runId;
      onHit();
    });
    this.timer = setInterval(() => {
      void this.query().then((status) => {
        if (status !== null) this.watcher?.cycle(status, formatWaited(Date.now() - startedAt));
      });
    }, this.pollMs);
  }

  public stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.watcher?.reset();
  }
}

type ChatEventInputOf = ChatEvent extends infer T ? (T extends { seq: number } ? Omit<T, "seq"> : never) : never;
