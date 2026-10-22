/**
 * 批次 R H1-3——内核错误码 → 用户文案单源映射（提前接线）。
 *
 * 四码来自内核 v0.7.24b0（K1–K4，TokenBudget/构造闸/GPU 容量——**未发版**，当前无真实
 * 来源）：harness 先行接线展示层，测试以构造的错误对象驱动；内核发版后错误经既有通道
 * （atf CLI stdout/stderr、train.sh 日志）流回时命中即转人话。接线面＝pipelineFace
 * （构造段失败）与 trainingFace（启动失败）——工具返回 note 即聊天/卡面提示面。
 * 未知码一律返回 null（不猜不编造——原样走既有 note，不覆盖）。
 */

/** 已知内核错误码闭集（token_budget_missing / token_budget_inconsistent:<detail> /
 *  token_gate_not_configured / gpu_capacity_insufficient）。 */
export const KERNEL_ERROR_FACE_CODES: ReadonlySet<string> = new Set([
  "token_budget_missing",
  "token_budget_inconsistent",
  "token_gate_not_configured",
  "gpu_capacity_insufficient",
]);

/** 人话文案选项：gpuFreeRows＝每卡 free 表行（gpu_capacity_insufficient 专属——由调用方
 *  从 nvidia-smi 机器事实派生，模块保持纯函数零 IO）。 */
export interface KernelErrorFaceOptions {
  detail?: string;
  gpuFreeRows?: ReadonlyArray<string>;
}

/** 单码 → 人话文案（含下一步指引）。code 支持冒号 detail 形态
 *  （token_budget_inconsistent:<detail>——detail 剥离后并入文案展示两值）。 */
export const humanizeKernelError = (code: string, opts: KernelErrorFaceOptions = {}): string | null => {
  const base = code.split(":")[0] ?? "";
  const detail = code.includes(":") ? code.slice(code.indexOf(":") + 1) : (opts.detail ?? "");
  switch (base) {
    case "token_budget_missing":
      return "预算文件缺失，先确认实验配置——run 缺 token 预算文件（token_budget.json），构造被拒。下一步：先走实验配置确认（九要素确认卡）落 TokenBudget 三要素（预算/训练截断/推理窗口）后重推构造";
    case "token_budget_inconsistent":
      return `预算不一致${detail !== "" ? `：${detail}` : "（预算三要素不一致）"}——展示两值指到对应字段：请回九要素确认卡核对 max_total_tokens / cutoff_len / max_model_len 三要素（预算 ≤ 训练截断 cutoff、预算 ≤ 推理窗口两条不变式须成立）。下一步：修正对应字段后重新确认`;
    case "token_gate_not_configured":
      return "数据构造未配置 token 审计，已拒绝构造——构造命令未传 token provider（token 审计不再可选，D59 实锚：跳过闸门会把超限样本放行给训练截断）。下一步：构造命令带上 token provider（--token-provider）后重推";
    case "gpu_capacity_insufficient": {
      const table = opts.gpuFreeRows !== undefined && opts.gpuFreeRows.length > 0
        ? `每卡 free：\n${opts.gpuFreeRows.map((row) => `  ${row}`).join("\n")}\n`
        : "";
      return `GPU 显存/算力不足（gpu_capacity_insufficient）——不自动降档。\n${table}建议：按每卡 free 表换空闲卡，或由你显式决定降 batch / 降 LoRA rank / 换量化档（降档是用户决策，harness 不代选）后重推`;
    }
    default:
      return null;
  }
};

/** 从错误文本（内核 stdout/stderr/日志尾——多段拼接）扫描第一个已知码 → { code, note }。
 *  未命中＝null（调用方保持既有 note 不覆盖）。detail 段容空格与多级冒号
 *  （token_budget_inconsistent:cutoff_len_mismatch:8000≠9000），止于引号/括号/换行。 */
export const scanKernelErrorFace = (texts: ReadonlyArray<string>): { code: string; note: string } | null => {
  for (const text of texts) {
    if (typeof text !== "string" || text === "") continue;
    for (const code of KERNEL_ERROR_FACE_CODES) {
      const hit = new RegExp(`${code}(:[^"'{}\\[\\]\\n]*)?`).exec(text);
      if (hit !== null) {
        const note = humanizeKernelError(hit[0]);
        if (note !== null) return { code: hit[0], note };
      }
    }
  }
  return null;
};
