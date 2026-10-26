/**
 * T5 测试夹具——内核 tools/training_preflight.py（141a5dec 起）三节 schema 的 mock 对端。
 *
 * 形态与内核 docstring 的固定 schema 逐键一致（TrainingPreflight/v1 + 派生三节）：
 * - derivable[]：能推的（value/basis/effective/mode）；
 * - must_ask[]：该问的（业务话 question + why_not_derivable）；本夹具给 4 项以触发软上限；
 * - degraded[]：推不动的（reason；step 为内部断点，用户面不呈现）；
 * - must_ask_overflow_reason：软上限原因（含内部前缀 must_ask=N 与 R8 括注——验证 harness 清洗）。
 *
 * --apply：派生项全部生效（pending_action → effective），其余节原样。
 */
const args = process.argv.slice(2);
const runDirAt = args.indexOf("--run-dir");
if (runDirAt < 0 || (args[runDirAt + 1] ?? "") === "") {
  process.stderr.write("mock_preflight_t5: --run-dir <abs> required\n");
  process.exit(2);
}
const apply = args.includes("--apply");

const ORDER = ["source_pairs", "field_config", "token_provider", "token_budget", "coordinate_pending", "lane_facts", "grouping_preset"];

const mustAsk = [
  {
    id: "source_pairs",
    question: "这批训练素材（图片 + 同名标注文件）放在哪个目录？",
    why_not_derivable: "run 内没有可用的数据集登记件（登记段未完成或注册引用缺失）",
    blocking: true,
    detail: "源配对未就绪",
    action: "给出素材目录后重跑预检",
  },
  {
    id: "field_config",
    question: "这批单据要抽取哪些字段？（按什么顺序输出）",
    why_not_derivable: "显式给的字段配置路径不在场，实验门亦无登记副本",
    blocking: true,
    detail: "字段配置未就绪",
    action: "给出字段配置或先跑实验门",
  },
  {
    id: "token_provider",
    question: "token 计量脚本放在哪里？（内置脚本文件不在场）",
    why_not_derivable: "内置计量脚本不在场，显式路径也没给",
    blocking: true,
    detail: "计量口径未定",
    action: "给出计量脚本路径",
  },
  {
    id: "grouping_preset",
    question: "训练样本怎么分组？（按单据层级分成一组，还是按必带条目分组）",
    why_not_derivable: "分组必须用户确认——agent 给出的只是候选",
    blocking: true,
    detail: "分组方案待确认",
    action: "确认分组方案后重跑",
  },
];

const derivableBefore = [
  {
    id: "token_budget",
    value: "9000 tokens（来自实验门确认值）",
    basis: "实验门已确认的预算",
    source: "derived",
    effective: true,
    mode: "effective",
    detail: "预算已按实验门值落盘",
    action: "无需动作",
  },
  {
    id: "coordinate_pending",
    value: null,
    basis: "预算就绪后整批重算",
    source: "derived",
    effective: false,
    mode: "pending_action",
    detail: "坐标换算待整批重试",
    action: "执行可派生项",
  },
];

const degraded = [
  {
    id: "lane_facts",
    step: "registry:DatasetRegistration/refs.source_root",
    reason: "准入 lane 事实要读的那份标注清单不在场",
    detail: "每类样本的归属没读出来",
    action: "补齐登记件后重跑预检",
  },
];

const beforeApply = {
  schema_version: "TrainingPreflight/v1",
  generated_at: "2026-10-26T09:00:00Z",
  run_dir: args[runDirAt + 1],
  items: mustAsk.map((entry) => ({
    id: entry.id,
    state: "needs_confirm",
    detail: entry.detail,
    action: entry.action,
    depends_on: [],
  })),
  order: ORDER,
  derivable: derivableBefore,
  must_ask: mustAsk,
  degraded,
  summary: {
    missing: 0,
    derivable: 2,
    confirm: 4,
    derivable_effective: 1,
    derivable_pending_action: 1,
    must_ask: 4,
    must_ask_blocking: 4,
    degraded: 1,
  },
  must_ask_overflow_reason:
    "must_ask=4 超过软上限 3:这些项互不替代(缺任一项都不能生成训练配置),合并提问会丢业务取舍,故一次性列全并注明原因(R8 软上限,非硬拒绝)",
};

const afterApply = {
  ...beforeApply,
  generated_at: "2026-10-26T09:01:00Z",
  derivable: derivableBefore.map((entry) => (entry.effective ? entry : { ...entry, value: "已整批重算 3 对", effective: true, mode: "effective" })),
  summary: { ...beforeApply.summary, derivable_pending_action: 0, derivable_effective: 2 },
};

process.stdout.write(`${JSON.stringify(apply ? afterApply : beforeApply, null, 1)}\n`);
