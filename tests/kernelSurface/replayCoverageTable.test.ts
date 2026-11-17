// C1 回放覆盖表收口断言（1116 发现 6——contract 段收编无真实 case 是断链漏网根因）：
// 覆盖表（docs/development/回放覆盖表-20261116.md）17 段逐段必须登记 case 形态，
// 形态三分闭集（真实回放/契约回放/挂窗）；「真实回放」段必须有 scripts/evals/ 语料
// 资产支撑（删 case 即红——README 清单登记 digest 对账另有 test_evals_replay_manifest）。
// 本锚为 harness 侧收口断言（内核段覆盖表跨仓对账，ATF_KERNEL_SOURCE env-gated）。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const kernelRoot = process.env.ATF_KERNEL_SOURCE ?? "";

const STAGE_ORDER_17 = [
  "contract", "ingest", "inspect", "register", "label_qc", "snapshot",
  "style_split", "experiment_setup", "family_split", "candidate_build",
  "publish", "admission", "training_prep", "training_run", "checkpoint_eval",
  "badcase_analysis", "iteration_proposal",
];
const FORMS = new Set(["真实回放", "契约回放", "挂窗"]);
// 真实回放段↔语料资产覆盖段闭集（与覆盖表登记一致；资产缺失由
// test_evals_replay_manifest 的 digest 对账面兜底，此处对账段集合）
const REAL_REPLAY_STAGES = new Set(["register", "label_qc", "style_split", "experiment_setup", "family_split"]);

const readTable = (): string => {
  // harness 侧=ATF_KERNEL_SOURCE 指内核仓根（表落内核 docs/development/）
  return readFileSync(
    resolve(kernelRoot, "docs/development/回放覆盖表-20261116.md"),
    "utf-8",
  );
};

describe("C1 回放覆盖表收口断言", () => {
  it.runIf(kernelRoot)("17 段逐段登记在场且形态三分闭集", () => {
    const table = readTable();
    for (const stage of STAGE_ORDER_17) {
      const row = table.split("\n").find((line) => line.startsWith(`| ${stage} |`));
      expect(row, `段 ${stage} 在覆盖表无登记行——新段收编必须登记 case 形态（发现 6）`).toBeTruthy();
      const form = (row!.split("|")[2] ?? "").trim();
      expect(
        FORMS.has(form),
        `段 ${stage} 登记形态「${form}」不在三分闭集（真实回放/契约回放/挂窗）`,
      ).toBe(true);
    }
  });

  it.runIf(kernelRoot)("真实回放段集合与语料资产覆盖一致", () => {
    const table = readTable();
    const realRows = STAGE_ORDER_17.filter((stage) => {
      const row = table.split("\n").find((line) => line.startsWith(`| ${stage} |`));
      return row !== undefined && (row.split("|")[2] ?? "").trim() === "真实回放";
    });
    expect(new Set(realRows)).toEqual(REAL_REPLAY_STAGES);
    // 语料资产在场（删 case 即红的对账面）
    const evalsDir = resolve(kernelRoot, "scripts/evals");
    expect(readFileSync(resolve(evalsDir, "replay_corpus_1113.py"), "utf-8")).toContain("corpus");
    expect(readFileSync(resolve(evalsDir, "replay_corpus_1116.py"), "utf-8")).toContain("corpus");
  });

  it.runIf(kernelRoot)("覆盖边界声明在场（全绿声明的强制附随）", () => {
    const table = readTable();
    expect(table).toContain("覆盖边界");
    expect(table).toContain("不覆盖=编排面/agent 行为面/WebUI 卡面");
  });
});
