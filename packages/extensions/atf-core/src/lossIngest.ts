/**
 * 批㊶-K 项 4——训练日志进料共享面（自 trainingFace.ts 提取，语义逐字不动）。
 *
 * 双消费径：atf_run_training（DSH 面，tmux tee train-stdout.log）与 atf_launch_execute
 * （丙线 runner 面，harness-launch-*.log——此前无人监控＝「重启曲线进料断」根因面之一）。
 * tail 进料循环：解析新日志行→追加 loss-series.json（批⑯协议）。返回停止函数。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** HF Trainer dict 行解析（批⑯ logParser 协议口径）→ loss-series 点。 */
export function parseTrainerLine(line: string): { train_loss: number; grad_norm: number | null; learning_rate: number | null; epoch: number } | null {
  const m = /\{'loss':[^}]+\}/.exec(line);
  if (!m) return null;
  try {
    const d = astEval(m[0]);
    if (typeof d.loss !== "number") return null;
    return {
      train_loss: d.loss,
      grad_norm: typeof d.grad_norm === "number" ? d.grad_norm : null,
      learning_rate: typeof d.learning_rate === "number" ? d.learning_rate : null,
      epoch: typeof d.epoch === "number" ? d.epoch : 0,
    };
  } catch {
    return null;
  }
}

/** 受控字面量求值（HF 日志 dict——单引号 Python 形态；仅本格式，其他内容抛错走 null 路径）。 */
function astEval(text: string): Record<string, number | string> {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- 输入限定为训练日志的 dict 行
  const fn = new Function(`return (${text.replace(/'/g, '"')})`) as () => Record<string, number | string>;
  return fn();
}

/** tail 进料循环：解析新日志行→追加 loss-series.json（批⑯协议）。返回停止函数。 */
export function startLossIngest(logPath: string, seriesPath: string, intervalMs = 3000): () => void {
  const read = (): Array<Record<string, unknown>> => {
    try {
      return JSON.parse(readFileSync(seriesPath, "utf8")) as Array<Record<string, unknown>>;
    } catch {
      return [];
    }
  };
  const timer = setInterval(() => {
    try {
      if (!existsSync(logPath)) return;
      const series = read();
      const text = readFileSync(logPath, "utf8");
      const lines = text.split("\n").filter((l) => l.trim() !== "");
      const points: Array<Record<string, unknown>> = [];
      for (const line of lines) {
        const p = parseTrainerLine(line);
        if (p !== null) {
          points.push({ step: points.length + 1, ...p, at: new Date().toISOString() });
        }
      }
      if (points.length > series.length) {
        const merged = [...series, ...points.slice(series.length)];
        mkdirSync(join(seriesPath, ".."), { recursive: true });
        writeFileSync(seriesPath, `${JSON.stringify(merged, null, 1)}\n`, "utf8");
      }
    } catch { /* 下周期重试 */ }
  }, intervalMs);
  return () => clearInterval(timer);
}
