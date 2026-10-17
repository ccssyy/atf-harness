/**
 * 卡通道失败诊断面（A1 伴生缺陷收口）——userQuestions.ask() 失败此前零日志：
 * 2026-10-17 dev 现场 BAD_INTENT 两连败在 host stdout/stderr 与 run 目录均无痕迹
 * （真实环境复现存档）。落点＝<runDir>/diagnostics/user-questions.log，JSONL 追加，
 * 每行含时间戳/工具名/问题 id/错误码/消息原文。写失败静默（fail-open——诊断面
 * 不得反噬工具主链）；路径经工具返回 note 带给用户（可定位、零静默）。
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** 诊断文件相对 run 目录的固定路径（note 引用面与测试断言单源）。 */
export const ASK_DIAGNOSTICS_RELPATH = "diagnostics/user-questions.log";

/** 追加一条 ask() 通道失败诊断；返回相对路径供 note 引用。 */
export const appendAskFailureDiagnostic = (runDir: string, tool: string, questionId: string, cause: unknown): string => {
  try {
    const dir = join(runDir, "diagnostics");
    mkdirSync(dir, { recursive: true });
    const code = (cause as { code?: unknown } | null)?.code;
    appendFileSync(
      join(dir, "user-questions.log"),
      `${JSON.stringify({
        at: new Date().toISOString(),
        tool,
        question: questionId,
        ...(typeof code === "string" && code !== "" ? { code } : {}),
        error: String(cause).slice(0, 500),
      })}\n`,
      "utf8",
    );
  } catch {
    // fail-open：诊断写失败不影响工具返回
  }
  return ASK_DIAGNOSTICS_RELPATH;
};
