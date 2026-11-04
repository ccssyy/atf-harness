/**
 * RunInputs/v1 prompt 决策的落账与读回（D163/W3 读写同源；ci-bl-1103 起补读侧——
 * prompt 决策 run 级一次，多类联合训练逐类 register 不重复弹卡）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** D163/W3：prompt 选择落账 inputs.json.prompt（resolved_via）。落账失败不阻断（fail-open 到内置缺省）。 */
export const writeInputsPromptChoice = (
  runDir: string,
  entry: Record<string, unknown>,
): void => {
  const path = join(runDir, "config", "inputs.json");
  let doc: Record<string, unknown> = {};
  try {
    doc = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    doc = {};
  }
  doc.schema_version = "RunInputs/v1";
  doc.prompt = {
    ...(typeof doc.prompt === "object" && doc.prompt !== null ? doc.prompt : {}),
    resolved_via: entry.resolved_via,
    decided_at: new Date().toISOString(),
    // ci-bl-1103:用户在卡上自述的原文落账凭据(resolved_via=user_stated 时在场,
    // agent 是否真按用户文本渲染可对账;空自述不写键)
    ...(typeof entry.quote === "string" && entry.quote.trim() !== "" ? { quote: entry.quote.slice(0, 2000) } : {}),
  };
  try {
    // F1e(ci-bl-1103-3):落账不得 mkdir run 树——run 目录不在场即跳过(防幽灵 run 目录)。
    if (!existsSync(runDir)) return;
    mkdirSync(join(runDir, "config"), { recursive: true });
    writeFileSync(path, `${JSON.stringify(doc, null, 1)}\n`, "utf8");
  } catch {
    // 落账失败不阻断（fail-open 到内置缺省）
  }
};

/** B-去重(ci-bl-1103)：prompt 决策 run 级一次——已落账 resolved_via 的 run 不再弹卡。
 * 多类联合训练逐类 register 成功时每类都会进 prompt 确认块,而 owner 裁定 prompt
 * 全局一套(含评估),重复弹卡会被用户当成「每个单据都要再确认一次训练 prompt」。 */
export const readInputsPromptResolvedVia = (runDir: string): string | null => {
  try {
    const doc = JSON.parse(readFileSync(join(runDir, "config", "inputs.json"), "utf8")) as {
      prompt?: { resolved_via?: unknown } | null;
    };
    return typeof doc?.prompt?.resolved_via === "string" && doc.prompt.resolved_via !== ""
      ? doc.prompt.resolved_via
      : null;
  } catch {
    return null;
  }
};
