/**
 * 批㊶-M M-4——任务卡四态推导纯函数（client.js taskStateOf 同源；vitest 直测面）。
 * 四态：active（训练中）／fail（任一段失败）／done（任一段完成）／idle。
 */
export interface TaskRunLike {
  run_id?: string;
  training?: { active?: boolean };
  segments?: Array<{ key?: string; status?: string }>;
}

export function taskStateOf(_active: unknown, run: TaskRunLike | null | undefined): "active" | "fail" | "done" | "idle" {
  if (run === null || run === undefined) return "idle";
  if (run.training?.active === true) return "active";
  const statuses = (run.segments ?? []).map((seg) => seg.status);
  if (statuses.includes("fail")) return "fail";
  if (statuses.includes("done")) return "done";
  return "idle";
}
