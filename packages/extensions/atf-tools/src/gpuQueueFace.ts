/**
 * 批㊶-K 项 1——GPU 排队编排面（自 src/webui/gpuQueue.ts 迁移 atf-tools，语义逐点对拍：
 * 入队触发＝真跑 danger 确认放行后；命中阈值＝某卡利用率 <20% 且显存 <10GB 连续 2 周期；
 * 命中＝琥珀再确认卡（人工点卡放行——真跑守门不变，编排器零启动调用）；无超时）。
 *
 * 迁移差异（如实声明）：事件通道 ChatEvent → 工具内等待＋审批面呈现（DSH 审批请求须在
 * open turn 内——队列等待宿主在工具调用存活期，命中即发琥珀确认卡，语义等价）。
 * 增补三（owner 2026-10-08，撤销"gpu0 登记不修"）：命中判定为全卡扫描——逐卡判
 * 阈值取最先满足卡（连续 2 周期稳定判定不变）；命中确认卡明示卡号；零卡满足＝继续排队。
 */
import { queryNvidiaSmiAll, type GpuCardStatus } from "../../../../src/webui/readOnlyTools.js";

/** 命中阈值（利用率 <20% 且显存 <10GB 连续 2 周期）。显存单位 MiB。 */
export const GPU_HIT_UTILIZATION_PCT = 20;
export const GPU_HIT_MEMORY_MIB = 10_000;
export const GPU_HIT_CONSECUTIVE = 2;

/** 编排轮询周期 env（批㊶-K 裁定名；缺省 300000ms——部署模板 overlays env 声明）。 */
export const GPU_QUEUE_POLL_MS_ENV = "ATF_GPU_POLL_MS";
export const GPU_QUEUE_POLL_MS_DEFAULT = 300_000;

/** 单周期探测结果（全卡扫描——增补三：逐卡判阈值取最先满足卡；零卡满足 hit=false）。 */
export const gpuCycleHit = (cards: readonly GpuCardStatus[]): { hit: boolean; gpuIndex: number } => {
  for (const card of cards) {
    const utilization = Number.parseFloat(card.utilization.replace("%", ""));
    const memoryUsed = Number.parseFloat(card.memoryUsed.replace(/[^\d.]/g, ""));
    const index = Number.parseInt(card.index, 10);
    if (Number.isFinite(utilization) && Number.isFinite(memoryUsed) && utilization < GPU_HIT_UTILIZATION_PCT && memoryUsed < GPU_HIT_MEMORY_MIB) {
      return { hit: true, gpuIndex: Number.isFinite(index) ? index : 0 };
    }
  }
  return { hit: false, gpuIndex: -1 };
};

/** 连续命中计数器状态机（fold 单周期结果 → 命中裁决）。 */
export class GpuQueueWatcher {
  private consecutive = 0;

  public constructor(private readonly onHit: (gpuIndex: number, waitedText: string) => void) {}

  /** 每周期喂一次全卡探测结果；连续命中达阈值 → 触发 onHit 一次并复位（等待下一轮入队）。 */
  public cycle(cards: readonly GpuCardStatus[], waitedText: string): void {
    const { hit, gpuIndex } = gpuCycleHit(cards);
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

/** 排队状态文案（工具结果与琥珀卡同源口径）。 */
export const queueStatusText = (waitedText: string): string => `⏳ 排队中 · 已等待 ${waitedText} · 周期自动探测 GPU 空闲`;

/** 命中琥珀确认卡文案（真跑守门不变——仍需人工点卡）。 */
export const queueHitText = (gpuIndex: number): string => `GPU ${String(gpuIndex)} 已空闲，确认开跑？`;

/** 排队开关解析：ATF_GPU_POLL_MS=0 ＝ 不启用排队（直启——测试与无需排队的部署用）；未设＝缺省 300s。 */
export const gpuQueuePollMsFromEnv = (env: NodeJS.ProcessEnv): number | null => {
  const raw = env[GPU_QUEUE_POLL_MS_ENV];
  if (raw === undefined || raw.trim() === "") return GPU_QUEUE_POLL_MS_DEFAULT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return GPU_QUEUE_POLL_MS_DEFAULT;
  return parsed === 0 ? null : parsed;
};

/** 阻塞式编排（DSH 面）：入队后周期探测直至命中或中止；命中回调一次后停止轮询。
 *  返回终态：hit（含等待时长与命中卡位）｜aborted（调用方取消）。 */
export const awaitGpuWindow = async (options: {
  pollMs?: number;
  query?: () => Promise<readonly GpuCardStatus[] | null>;
  signal?: { aborted: boolean };
  onWaitTick?: (waitedText: string) => void;
} = {}): Promise<{ kind: "hit"; gpuIndex: number; waitedText: string } | { kind: "aborted" }> => {
  const pollMs = options.pollMs ?? Number(process.env[GPU_QUEUE_POLL_MS_ENV] ?? GPU_QUEUE_POLL_MS_DEFAULT);
  const query = options.query ?? queryNvidiaSmiAll;
  const startedAt = Date.now();
  return await new Promise((resolvePromise) => {
    const watcher = new GpuQueueWatcher((gpuIndex, waitedText) => {
      clearInterval(timer);
      resolvePromise({ kind: "hit", gpuIndex, waitedText });
    });
    const tick = (): void => {
      if (options.signal?.aborted === true) {
        clearInterval(timer);
        resolvePromise({ kind: "aborted" });
        return;
      }
      const waitedText = formatWaited(Date.now() - startedAt);
      options.onWaitTick?.(waitedText);
      void query().then((status) => {
        if (status !== null) watcher.cycle(status, waitedText);
      });
    };
    const timer = setInterval(tick, pollMs);
    tick();
  });
};
