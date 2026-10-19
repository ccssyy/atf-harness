#!/usr/bin/env node
/**
 * walkthrough_pipeline 段触发 mock 对端（E10b/E10d 测试基建，非内核代码）：
 * 内核 main E10f --auto-style-cluster 三态＋拒绝面 user_message 的夹具化仿真（summary 走内核
 * WalkthroughPipelineReport/v1 形态：rejections 数组＋results[].raw_response 嵌套
 * style_cluster_state 证据与 user_message 业务文案——原文照内核 E10e-1/E10f 常量，页数按
 * 夹具 pagesTotal 代入）。env MOCK_CLUSTER_STATE 控制 盘面证据态：
 *   not_clustered（缺省）／ambiguous／already_clustered。
 * env MOCK_NO_USER_MESSAGE=1 → 拒绝记录不带 user_message（harness 兜底面测试）。
 * env MOCK_SMALL_CLUSTER=1 → on 在全小簇盘面：无 --allow-small-cluster-test → exit 2
 *   split_partition_empty:test＋小簇业务文案；带开关 → exit 0＋警告行＋Manifest 行（E10f 锚⑤⑥）。
 * 行为对照内核 E10e/E10f 决策矩阵（顺序恒定）：已聚类→不复聚直接分层（on/off/auto 同途）；
 * auto×未聚类/语义不明 → exit 2 两码＋user_message；off×未聚类 → exit 2
 * style_cluster_declared_but_absent＋user_message（off 声明已聚类与盘上无簇矛盾）；
 * off×语义不明 → exit 2 style_cluster_state_ambiguous＋user_message。
 * summary.argv 回显完整下传参数（argv 断言面）。
 */
const argv = process.argv.slice(2);
const stageIndex = argv.indexOf("--stage");
const stage = stageIndex >= 0 ? argv[stageIndex + 1] : undefined;
const runIdIndex = argv.indexOf("--run-id");
const runId = runIdIndex >= 0 ? argv[runIdIndex + 1] : "";
const modeIndex = argv.indexOf("--auto-style-cluster");
const mode = modeIndex >= 0 ? argv[modeIndex + 1] : "auto";
const allowSmallClusterTest = argv.includes("--allow-small-cluster-test");
const state = process.env["MOCK_CLUSTER_STATE"] ?? "not_clustered";
const noUserMessage = process.env["MOCK_NO_USER_MESSAGE"] === "1";
const smallCluster = process.env["MOCK_SMALL_CLUSTER"] === "1";

const pagesTotal = 6;
const pagesWithCluster = state === "already_clustered" ? pagesTotal : state === "ambiguous" ? 3 : 0;
const evidence = {
  state,
  pages_total: pagesTotal,
  pages_with_cluster: pagesWithCluster,
  manifest_present: state === "already_clustered",
  requested_auto_style_cluster: mode,
};
// 内核 E10e-1/E10f user_message 常量原文（页数按夹具代入；禁内部词）
const USER_MESSAGE = {
  not_clustered:
    `这批数据没有找到版式分组信息（共 ${pagesTotal} 页，0 页带分组），因此没有继续切分。` +
    "如果数据确实分过组：请提供带分组信息的数据文件；如果没分过组：可以改为先分组、再切分。",
  ambiguous:
    `这批数据里只有部分页带版式分组（${pagesTotal} 页中 ${pagesWithCluster} 页），` +
    "无法判断是否已分好组。请确认后重试：已分好组请提供完整分组；未分过组可先分组再切分。",
  declared_but_absent:
    `这批数据没有找到版式分组信息（共 ${pagesTotal} 页，0 页带分组），` +
    "与“已分组”的选择不一致。请确认：如果分过组，请提供带分组信息的数据；" +
    "如果没有，可以改为先分组再切分。",
  small_clusters:
    "这批数据的版式分组都太小（每类不足 5 页），无法留出测试集。" +
    "可以把相近的小类合并后再试，或声明全部用于训练，" +
    "也可以选择让每个小类各留 1 页做测试（测试样本会很少）。",
};

const results = [];
let exitCode = 0;
if (stage === "family_split") {
  if (state === "already_clustered") {
    // 已聚类（用户提供簇）：直接按簇分层，不复聚（on/off/auto 同途）。
    results.push({
      stage,
      status: "ok",
      reason_codes: [],
      missing: [
        `版式聚类三态:already_clustered(证据页 ${pagesWithCluster}/${pagesTotal} 带 cluster_id,manifest=在,入参=${mode},生效 auto_style_cluster=False)`,
      ],
      raw_response: { gates: [], style_cluster_state: { ...evidence, effective_auto_style_cluster: false } },
    });
  } else if (state === "ambiguous") {
    // 语义不明（auto/off）：宁 ambiguous 不猜＋业务文案。
    exitCode = 2;
    results.push({
      stage,
      status: "blocked",
      reason_codes: ["style_cluster_state_ambiguous"],
      missing: [
        `版式聚类三态判定:语义不明(证据页 3/${pagesTotal} 带 cluster_id)——宁 ambiguous 不猜`,
        "先确认版式聚类状态(已聚类/未聚类)再显式传 --auto-style-cluster on 或 off 重跑",
      ],
      raw_response: {
        style_cluster_state: { ...evidence, effective_auto_style_cluster: null },
        ...(noUserMessage ? {} : { user_message: USER_MESSAGE.ambiguous }),
      },
    });
  } else if (mode === "off") {
    // off×未聚类：声明「已聚类」与盘上无簇事实矛盾（E10e 新码）＋业务文案。
    exitCode = 2;
    results.push({
      stage,
      status: "blocked",
      reason_codes: ["style_cluster_declared_but_absent"],
      missing: ["版式聚类三态判定:未聚类但入参声明已聚类——两者矛盾,拒绝切分"],
      raw_response: {
        style_cluster_state: { ...evidence, effective_auto_style_cluster: null },
        ...(noUserMessage ? {} : { user_message: USER_MESSAGE.declared_but_absent }),
      },
    });
  } else if (mode === "auto") {
    // 未聚类 + auto：不自动开一刀切＋业务文案。
    exitCode = 2;
    results.push({
      stage,
      status: "blocked",
      reason_codes: ["style_cluster_state_not_clustered"],
      missing: [
        `版式聚类三态判定:未聚类(证据页 0/${pagesTotal} 带 cluster_id,无 StyleClusterManifest/v1)——不自动开一刀切`,
        "确认本目录确未做版式聚类后,用 --auto-style-cluster on 重跑(内核按既有机制确定性补齐并产出 StyleClusterManifest/v1);若已聚类证据在别处,核查 --split-id 指向的 split 证据目录",
      ],
      raw_response: {
        style_cluster_state: { ...evidence, effective_auto_style_cluster: null },
        ...(noUserMessage ? {} : { user_message: USER_MESSAGE.not_clustered }),
      },
    });
  } else if (smallCluster && !allowSmallClusterTest) {
    // on×全小簇×strict：守恒护栏拒绝＋业务文案（E10f D3）。
    exitCode = 2;
    results.push({
      stage,
      status: "blocked",
      reason_codes: ["split_partition_empty:test"],
      missing: ["版式分组都太小,无法留出测试集(内部守恒护栏拒绝)"],
      raw_response: {
        error: "ValueError('split_partition_empty:test')",
        style_cluster_state: { ...evidence, effective_auto_style_cluster: true },
        ...(noUserMessage ? {} : { user_message: USER_MESSAGE.small_clusters }),
      },
    });
  } else {
    // on（含 allow 开关放行面）：切分通过＋证据如实＋警告行。
    results.push({
      stage,
      status: "ok",
      reason_codes: [],
      missing: [
        `版式聚类三态:${state}(证据页 ${pagesWithCluster}/${pagesTotal} 带 cluster_id,manifest=无,入参=${mode},生效 auto_style_cluster=True)`,
        "内核按既有机制确定性补齐并产出 StyleClusterManifest/v1,按簇分层",
        ...(smallCluster && allowSmallClusterTest ? ["小类测试仅 1 页，指标参考性有限"] : []),
      ],
      raw_response: { gates: [], style_cluster_state: { ...evidence, effective_auto_style_cluster: true } },
    });
  }
} else {
  results.push({ stage, status: "ok", reason_codes: [], missing: [], raw_response: {} });
}

process.stdout.write(
  `${JSON.stringify({
    schema_version: "WalkthroughPipelineReport/v1",
    mode: "stage",
    stage,
    run_id: runId,
    exit_code: exitCode,
    stages: { [stage]: exitCode === 0 ? "ok" : "blocked" },
    rejections: results
      .filter((entry) => entry.status !== "ok")
      .map(({ stage: s, reason_codes, missing }) => ({ stage: s, reason_codes, missing })),
    results,
    argv,
  })}\n`,
);
process.exit(exitCode);
