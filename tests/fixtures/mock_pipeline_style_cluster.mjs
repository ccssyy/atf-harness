#!/usr/bin/env node
/**
 * walkthrough_pipeline 段触发 mock 对端（E10b 测试基建，非内核代码）：
 * 内核 main E10a --auto-style-cluster 三态行为的夹具化仿真（summary 走内核
 * WalkthroughPipelineReport/v1 形态：rejections 数组＋results[].raw_response.
 * style_cluster_state 五键证据）。env MOCK_CLUSTER_STATE 控制 盘面证据态：
 *   not_clustered（缺省）／ambiguous／already_clustered。
 * 行为对照内核 E10a：auto＋未聚类 → exit 2 style_cluster_state_not_clustered；
 * auto＋ambiguous → exit 2 style_cluster_state_ambiguous；
 * auto＋已聚类 → exit 0 生效 False（不复聚）；on → exit 0 生效 True；
 * off＋未聚类 → exit 2 split_recompute_cluster_required（内核既有闸语义不变）。
 * summary.argv 回显完整下传参数（argv 断言面）。
 */
const argv = process.argv.slice(2);
const stageIndex = argv.indexOf("--stage");
const stage = stageIndex >= 0 ? argv[stageIndex + 1] : undefined;
const runIdIndex = argv.indexOf("--run-id");
const runId = runIdIndex >= 0 ? argv[runIdIndex + 1] : "";
const modeIndex = argv.indexOf("--auto-style-cluster");
const mode = modeIndex >= 0 ? argv[modeIndex + 1] : "auto";
const state = process.env["MOCK_CLUSTER_STATE"] ?? "not_clustered";

const pagesTotal = 6;
const pagesWithCluster = state === "already_clustered" ? pagesTotal : state === "ambiguous" ? 3 : 0;
const evidence = {
  state,
  pages_total: pagesTotal,
  pages_with_cluster: pagesWithCluster,
  manifest_present: state === "already_clustered",
  requested_auto_style_cluster: mode,
};

const results = [];
let exitCode = 0;
if (stage === "family_split") {
  if (mode === "auto" && state === "not_clustered") {
    exitCode = 2;
    results.push({
      stage,
      status: "blocked",
      reason_codes: ["style_cluster_state_not_clustered"],
      missing: [
        `版式聚类三态判定:未聚类(证据页 0/${pagesTotal} 带 cluster_id,无 StyleClusterManifest/v1)——不自动开一刀切`,
        "确认本目录确未做版式聚类后,用 --auto-style-cluster on 重跑(内核按既有机制确定性补齐并产出 StyleClusterManifest/v1);若已聚类证据在别处,核查 --split-id 指向的 split 证据目录",
      ],
      raw_response: { style_cluster_state: { ...evidence, effective_auto_style_cluster: null } },
    });
  } else if (mode === "auto" && state === "ambiguous") {
    exitCode = 2;
    results.push({
      stage,
      status: "blocked",
      reason_codes: ["style_cluster_state_ambiguous"],
      missing: [
        `版式聚类三态判定:语义不明(证据页 3/${pagesTotal} 带 cluster_id)——宁 ambiguous 不猜`,
        "先确认版式聚类状态(已聚类/未聚类)再显式传 --auto-style-cluster on 或 off 重跑",
      ],
      raw_response: { style_cluster_state: { ...evidence, effective_auto_style_cluster: null } },
    });
  } else if (mode === "off" && state === "not_clustered") {
    exitCode = 2;
    results.push({
      stage,
      status: "blocked",
      reason_codes: ["split_recompute_cluster_required"],
      missing: ["split_recompute_cluster_required"],
      raw_response: { style_cluster_state: { ...evidence, effective_auto_style_cluster: false } },
    });
  } else {
    const effective = mode === "on";
    results.push({
      stage,
      status: "ok",
      reason_codes: [],
      missing: [
        `版式聚类三态:${state}(证据页 ${pagesWithCluster}/${pagesTotal} 带 cluster_id,manifest=${evidence.manifest_present ? "在" : "无"},入参=${mode},生效 auto_style_cluster=${effective ? "True" : "False"})`,
        ...(mode === "on" ? ["内核按既有机制确定性补齐并产出 StyleClusterManifest/v1,按簇分层"] : []),
      ],
      raw_response: { gates: [], style_cluster_state: { ...evidence, effective_auto_style_cluster: effective } },
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
