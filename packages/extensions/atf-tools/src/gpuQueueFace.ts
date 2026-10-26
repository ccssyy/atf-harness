/**
 * 批㊶-K 项 1——GPU 排队编排面（自 src/webui/gpuQueue.ts 迁移 atf-tools）。
 * 批㊶-W F6 探活修正四合一（本文件当前形态）：
 *   ① 快速二次确认——首探命中 → RECHECK_DELAY_MS 复探一次，仍命中即放行
 *     （替代旧「连续 2 个轮询周期」——轮询间隔不再参与命中判定）；
 *   ② 排队轮询缺省 30s（GPU_QUEUE_POLL_MS_DEFAULT 300_000 → 30_000）；
 *   ③ 整组判定——按本次训练方案 nproc 所需卡集合全部空闲才命中（替代旧「任一卡命中」；
 *     requiredCards 缺省 1）；global batch 无关，本面只管卡窗口；
 *   ④ 归属判定——compute-apps 进程归属（gpu_uuid→index 对表，readOnlyTools 单源），
 *     区分空闲（无进程）/常驻（基线内非训练进程）/训练（进程名命中训练特征）；
 *     10GB 显存固定阈值退役（GPU_HIT_MEMORY_MIB 删除——判定不再看显存数值）。
 *   ⑤ amber 卡与 atf_gpu_status 报全卡状态表＋归属（formatCardTable）。
 * 真跑守门不变：命中琥珀再确认卡人工放行（全自动档免再确认——通报化）。
 */
import { queryNvidiaSmiAll, queryGpuComputeApps, type GpuCardStatus, type GpuComputeApp } from "../../../../src/webui/readOnlyTools.js";

/** 训练进程特征（cmdline/进程名任一命中即训练占用——trainingFace 同源 re-export）。 */
export const TRAINING_RESIDUE_PATTERN = /torchrun|launcher\.py|llamafactory|deepspeed|pt_elastic/i;

/** 卡占用三态（F6 ④归属判定）。 */
export type GpuOccupancy = "idle" | "resident" | "training";

/** 逐卡状态行（全卡状态表单行——amber 卡/gpu_status 呈现面）。 */
export interface GpuCardOccupancy {
  index: string;
  occupancy: GpuOccupancy;
  utilization: string;
  memoryUsed: string;
  /** 占用进程摘要（idle＝空串；resident/training＝"pid name" 首条）。 */
  process: string;
}

/** 快速二次确认间隔（首探命中 → 本间隔后复探一次；5-10s 段位取中）。 */
export const GPU_RECHECK_DELAY_MS = 7_000;

/** 排队轮询周期 env（批㊶-K 裁定名；批㊶-W F6 缺省 300_000 → 30_000）。 */
export const GPU_QUEUE_POLL_MS_ENV = "ATF_GPU_POLL_MS";
export const GPU_QUEUE_POLL_MS_DEFAULT = 30_000;

/** 常驻基线快照（模块级 lazy——首次 compute-apps 查询成功时记录 pid→进程名；
 *  后续探测中基线内进程＝resident。boot 后新出现的非训练进程同样 resident——
 *  归属只影响呈现，空闲判定恒＝卡上无 compute-apps）。 */
const residentBaseline = new Map<string, string>();
let baselineTaken = false;

/** 基线快照采集（探测入口调用；空输出也记——空基线＝合法状态）。 */
export const takeResidentBaseline = (apps: readonly GpuComputeApp[]): void => {
  if (baselineTaken) return;
  baselineTaken = true;
  for (const app of apps) residentBaseline.set(app.pid, app.processName);
};

/** 测试注入面：重置基线（生产零调用）。 */
export const resetResidentBaselineForTest = (): void => {
  residentBaseline.clear();
  baselineTaken = false;
};

/** 单卡归属分类（F6 ④）：训练特征 ＞ 基线常驻 ＞ 新占用（同 resident 归类）；无进程＝idle。 */
export const classifyCard = (apps: readonly GpuComputeApp[]): GpuOccupancy => {
  if (apps.length === 0) return "idle";
  for (const app of apps) {
    if (TRAINING_RESIDUE_PATTERN.test(app.processName)) return "training";
  }
  return "resident";
};

/** 全卡状态表（F6 ③④⑤）：逐卡 index/占用三态/利用率/显存/进程摘要。 */
export const buildCardOccupancyTable = (cards: readonly GpuCardStatus[], apps: readonly GpuComputeApp[]): GpuCardOccupancy[] => {
  const byIndex = new Map<string, GpuComputeApp[]>();
  for (const app of apps) {
    if (app.gpuIndex === null) continue;
    const list = byIndex.get(app.gpuIndex) ?? [];
    list.push(app);
    byIndex.set(app.gpuIndex, list);
  }
  return cards.map((card) => {
    const cardApps = byIndex.get(card.index) ?? [];
    const first = cardApps[0];
    return {
      index: card.index,
      occupancy: classifyCard(cardApps),
      utilization: card.utilization,
      memoryUsed: card.memoryUsed,
      process: first !== undefined ? `${first.pid} ${first.processName.split(/[\\/]/).pop() ?? first.processName}` : "",
    };
  });
};

/** 整组判定（F6 ③）：所需卡数（requiredCards）张全部 idle 才命中；返回命中卡位集合与全卡表。
 *  apps 为 null（compute-apps 不可得）＝保守不命中（fail-closed——不猜测归属）。 */
export const gpuGroupWindow = (
  cards: readonly GpuCardStatus[],
  apps: readonly GpuComputeApp[] | null,
  requiredCards: number,
): { hit: boolean; gpuIndexes: number[]; table: GpuCardOccupancy[] } => {
  const table = buildCardOccupancyTable(cards, apps ?? []);
  const idleIndexes = table.filter((row) => row.occupancy === "idle").map((row) => Number.parseInt(row.index, 10)).filter((n) => Number.isFinite(n));
  const hit = apps !== null && idleIndexes.length >= requiredCards;
  return { hit, gpuIndexes: idleIndexes.slice(0, Math.max(0, requiredCards)), table };
};

/** 全卡状态表人读格式（amber 卡附加面：「GPU0 空闲/常驻/训练 · util 0% · 0MiB · pid cmd」逐行）。 */
export const formatCardTable = (table: readonly GpuCardOccupancy[]): string => {
  const label: Record<GpuOccupancy, string> = { idle: "空闲", resident: "常驻", training: "训练" };
  return table
    .map((row) => `GPU${row.index} ${label[row.occupancy]} · util ${row.utilization} · ${row.memoryUsed}${row.process !== "" ? ` · ${row.process}` : ""}`)
    .join("\n");
};

/** 等待时长人读格式（⏳ 排队中 · 已等待 <时长>）。 */
export const formatWaited = (sinceMs: number): string => {
  const seconds = Math.floor(sinceMs / 1000);
  if (seconds < 60) return `${String(seconds)} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)} 分 ${String(seconds % 60)} 秒`;
  return `${String(Math.floor(minutes / 60))} 时 ${String(minutes % 60)} 分`;
};

/** 排队状态文案（工具结果与琥珀卡同源口径）。 */
export const queueStatusText = (waitedText: string, requiredCards: number): string =>
  `⏳ 排队中 · 已等待 ${waitedText} · 周期自动探测 GPU（整组 ${String(requiredCards)} 卡空闲判定）`;

/** 命中琥珀确认卡文案（真跑守门不变——仍需人工点卡；F6 ⑤附加全卡状态表）。 */
export const queueHitText = (gpuIndexes: readonly number[], table: readonly GpuCardOccupancy[]): string =>
  `GPU ${gpuIndexes.join("、")} 已空闲（整组 ${gpuIndexes.length} 卡全部空闲），确认开跑？\n${formatCardTable(table)}`;

/** 排队开关解析：ATF_GPU_POLL_MS=0 ＝ 不启用排队（直启——测试与无需排队的部署用）；
 *  未设＝缺省 30s（批㊶-W F6）。 */
export const gpuQueuePollMsFromEnv = (env: NodeJS.ProcessEnv): number | null => {
  const raw = env[GPU_QUEUE_POLL_MS_ENV];
  if (raw === undefined || raw.trim() === "") return GPU_QUEUE_POLL_MS_DEFAULT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return GPU_QUEUE_POLL_MS_DEFAULT;
  return parsed === 0 ? null : parsed;
};

export interface GpuWindowSnapshot {
  waitedText: string;
  gpuIndexes: number[];
  table: GpuCardOccupancy[];
}

/** 排队状态反馈（批㊶-W owner 反馈增补：所需卡数＞当前空闲时必须即时反馈而非默默轮询——
 *  「需 N 卡、空闲 M、已等待 X」首探即报＋空闲数变化即报，呈现面自定）。 */
export interface GpuQueueStatus {
  required: number;
  idle: number;
  waitedText: string;
  table: GpuCardOccupancy[];
}

/** 阻塞式编排（DSH 面）：入队后周期探测直至整组命中或中止；快速二次确认（首探命中 →
 *  GPU_RECHECK_DELAY_MS 复探一次，仍命中即放行——轮询周期不参与命中判定）；
 *  命中回调一次后停止轮询。返回终态：hit（含等待时长/命中卡位/全卡状态表）｜aborted。
 *  onQueueStatus＝每轮探测后回调（呈现面限频自定——建议首探＋空闲数变化时）。 */
export const awaitGpuWindow = async (options: {
  pollMs?: number;
  recheckMs?: number;
  requiredCards?: number;
  query?: () => Promise<readonly GpuCardStatus[] | null>;
  queryApps?: () => Promise<readonly GpuComputeApp[] | null>;
  signal?: { aborted: boolean };
  onWaitTick?: (waitedText: string) => void;
  onQueueStatus?: (status: GpuQueueStatus) => void;
  sleep?: (ms: number) => Promise<void>;
} = {}): Promise<{ kind: "hit"; snapshot: GpuWindowSnapshot } | { kind: "aborted" }> => {
  const pollMs = options.pollMs ?? Number(process.env[GPU_QUEUE_POLL_MS_ENV] ?? GPU_QUEUE_POLL_MS_DEFAULT);
  const recheckMs = options.recheckMs ?? GPU_RECHECK_DELAY_MS;
  const requiredCards = Math.max(1, Math.floor(options.requiredCards ?? 1));
  const query = options.query ?? queryNvidiaSmiAll;
  const queryApps = options.queryApps ?? queryGpuComputeApps;
  const step = options.sleep ?? ((delay: number) => new Promise<void>((r) => setTimeout(r, delay)));
  const startedAt = Date.now();
  const aborted = (): boolean => options.signal?.aborted === true;
  let lastReportedIdle = -1;
  for (;;) {
    if (aborted()) return { kind: "aborted" };
    const waitedText = formatWaited(Date.now() - startedAt);
    options.onWaitTick?.(waitedText);
    const [cards, appsRaw] = await Promise.all([query(), queryApps()]);
    if (cards !== null) {
      const apps = appsRaw ?? [];
      takeResidentBaseline(apps);
      const first = gpuGroupWindow(cards, apps, requiredCards);
      // 排队反馈：首探必报；此后空闲数变化才再报（避免 30s 轮询刷屏）。
      // idle 取全表真实空闲数（gpuIndexes 已按 required 截断，不作反馈值）。
      const idleNow = first.table.filter((row) => row.occupancy === "idle").length;
      if (options.onQueueStatus !== undefined && idleNow !== lastReportedIdle) {
        lastReportedIdle = idleNow;
        options.onQueueStatus({ required: requiredCards, idle: idleNow, waitedText, table: first.table });
      }
      if (first.hit) {
        // ① 快速二次确认：复探一次，仍整组命中才放行（隔 7s——捕捉毫秒级撞车）
        await step(recheckMs);
        if (aborted()) return { kind: "aborted" };
        const [cards2, apps2Raw] = await Promise.all([query(), queryApps()]);
        if (cards2 !== null) {
          const apps2 = apps2Raw ?? [];
          const second = gpuGroupWindow(cards2, apps2, requiredCards);
          if (second.hit) {
            return { kind: "hit", snapshot: { waitedText, gpuIndexes: second.gpuIndexes, table: second.table } };
          }
        }
      }
    }
    await step(pollMs);
  }
};
