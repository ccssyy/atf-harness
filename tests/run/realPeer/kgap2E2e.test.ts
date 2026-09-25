import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { ok } from "../../../src/bridge/index.js";
import { stableStringify } from "../../../src/core/tools/approvalKey.js";
import { type LlmDecision, type LlmProvider, type Scenario } from "../../../src/llm/index.js";
import { ScenarioRunner, type BranchRunReport } from "../../../src/core/run/index.js";
import { createRealPeerFixture, realPeerCliPath, type RealPeerFixture } from "./fixture.js";

/**
 * K-Gap-2 接线批真内核 e2e（决议件《排期_F6实施先行与R3开批》§四：re-pin v0.7.3b0 后的合入判据）：
 * propose →（缺料时）atf_style_cluster.execute → request 携确认态——真内核对端（方法面 12）＋
 * 脚本桩 provider（零真实 provider）。链路各拍断言收口形态（stage 翻转／clusters 落料／
 * policy.source=confirmed／human_summary 六字段）；启动 env 含 ATF_SKILLS_AUTO_INSTALL=0
 * 实测断言（隔离环境口径）。
 * 真实写授权边界：仅 /tmp 夹具根内合成数据（k2-e2e-* 标识）。
 */

const cli = realPeerCliPath();
const describeIfPinned = cli.ok ? describe : describe.skip;

const openFixtures: RealPeerFixture[] = [];
const tempRoots: string[] = [];

afterEach(async () => {
  while (openFixtures.length > 0) {
    const fixture = openFixtures.pop();
    if (fixture !== undefined) await fixture.cleanup().catch(() => undefined);
  }
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

const scenarioOf = (runId: string, instruction: string): Scenario => ({
  scenario_id: "kgap2-e2e",
  version: 1,
  provider: "faux",
  description: "K-Gap-2 接线批真内核 e2e",
  branches: {
    main: {
      branch_id: "main",
      run_id: runId,
      trigger_instruction: instruction,
      purpose: "kgap2-real-peer",
      setup: { ledger: [] },
      steps: [],
      expect: { outcome: "completed", exit_code: 0 },
    },
  },
});

const grantedStub = async (): Promise<{ verdict: "granted"; actor: string }> => ({ verdict: "granted", actor: "k2-e2e-host" });

const CLUSTER_PARAMS = {
  algorithm_version: "bbox_layout_v1",
  granularity: "page",
  metric: "cosine",
  linkage: "average",
  threshold: "auto_candidates",
  min_cluster_size: "1",
};

/** 合成 2 页成对样本（1×1 PNG＋width/height/marks 标注，布局互异；零真实业务内容）。 */
const makeSyntheticPairs = async (): Promise<{ sourceRoot: string; splitRoot: string }> => {
  const sourceRoot = await mkdtemp(join(tmpdir(), "k2-e2e-src-"));
  const splitRoot = await mkdtemp(join(tmpdir(), "k2-e2e-split-"));
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const label = (boxes: Array<[number, number, number, number]>): string =>
    `${JSON.stringify({
      width: 100,
      height: 100,
      marks: boxes.map(([x0, y0, x1, y1], index) => ({
        pselect: `field_${index}`,
        points: [
          { x: x0, y: y0 },
          { x: x1, y: y0 },
          { x: x1, y: y1 },
          { x: x0, y: y1 },
        ],
      })),
    })}\n`;
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(splitRoot, { recursive: true });
  const pages: Array<[string, Array<[number, number, number, number]>]> = [
    ["k2-e2e-pair-1", [[10, 10, 40, 40], [50, 50, 90, 90]]],
    ["k2-e2e-pair-2", [[10, 60, 90, 95], [15, 10, 35, 30]]],
  ];
  for (const [name, boxes] of pages) {
    await writeFile(join(sourceRoot, `${name}.png`), png);
    await writeFile(join(sourceRoot, `${name}.json`), label([...boxes]));
  }
  return { sourceRoot, splitRoot };
};

describeIfPinned("K-Gap-2 接线批真内核 e2e——propose→（缺料时）execute→request 携确认态", () => {
  it(
    "全链：登记→propose(聚类确认)→execute 落料→propose(划分确认)→request 携确认态→completed；env 含 ATF_SKILLS_AUTO_INSTALL=0（K2 回滚门 ATF_LABEL_QC_REQUIRED=0——本链定位 K-Gap-2，体检必经归重跑②专验）",
    { timeout: 240_000 },
    async () => {
      // pin 实测锚：当前 checkout HEAD == v0.7.7b0（45c0533）
      const headSha = await new Promise<string>((resolve, reject) => {
        execFile("git", ["-C", cli.ok ? (cli as { ok: true; path: string }).path : "", "rev-parse", "HEAD"], (error, stdout) =>
          error === null ? resolve(stdout.trim()) : reject(error),
        );
      });
      expect(headSha).toBe("45c05339078575534653d1ca3b0dc1cc91fa50f4");

      // K2 体检必经回滚门（re-pin 2026-09-23）：本用例定位 K-Gap-2 料门链路；
      // 体检必经链路归重跑②专验——此处显式回滚旧语义，进程 env 经 fixture baseEnv 透传。
      const qcRequiredSaved = process.env["ATF_LABEL_QC_REQUIRED"];
      process.env["ATF_LABEL_QC_REQUIRED"] = "0";
      try {
      const fixture = await createRealPeerFixture(`k2-e2e-${randomUUID().slice(0, 8)}`);
      openFixtures.push(fixture);
      // 启动 env 实测确认（隔离环境口径；值断言＝"0"，非仅存在性）
      const serveEnv = fixture.serveSpawn().env;
      expect(serveEnv["ATF_SKILLS_AUTO_INSTALL"]).toBe("0");
      expect(serveEnv["ATF_LABEL_QC_REQUIRED"]).toBe("0");

      const { sourceRoot, splitRoot } = await makeSyntheticPairs();
      tempRoots.push(sourceRoot, splitRoot);
      const runsRoot = await mkdtemp(join(tmpdir(), "k2-e2e-runs-"));
      tempRoots.push(runsRoot);

      let calls = 0;
      let derivedId = "";
      const provider: LlmProvider = {
        providerId: "k2-e2e-model",
        decide: async (context) => {
          calls += 1;
          const text = JSON.stringify(context);
          if (calls === 1) {
            return ok({ type: "tool_call", tool: "atf_admit_data", params: { source_root: sourceRoot, split_root: splitRoot } });
          }
          const match = /ds-[0-9a-f]{12}/.exec(text);
          derivedId = match?.[0] ?? "ds-unresolved";
          switch (calls) {
            case 2: // 纯读：阶段判定（缺料 → 聚类确认）
              return ok({ type: "tool_call", tool: "atf_preparation_propose", params: { dataset_id: derivedId } });
            case 3: // 写：按确认参数执行聚类落料
              return ok({ type: "tool_call", tool: "atf_style_cluster_execute", params: { dataset_id: derivedId, cluster_params: CLUSTER_PARAMS } });
            case 4: // 纯读：复查阶段（应翻转到划分确认）
              return ok({ type: "tool_call", tool: "atf_preparation_propose", params: { dataset_id: derivedId } });
            case 5: {
              // request 携确认态：骨架＝propose 回显的 policy_template（契约冻结面；上下文为
              // 排序键序、正则提取不稳，故直构并断言与回显等价——见下方 policyTemplateEcho 断言）。
              // integrity_digest 为可复算自承载字段（内核变更单 §1：digest 可复算、同输入同产出）——
              // 本桩按公开算法镜像（canonical JSON＝sorted-keys 紧凑序列化；纯 ASCII 策略与
              // 内核 canonical_json 等价），内核侧复验。
              const body = {
                schema_version: "DatasetSplitPolicy/v2",
                policy_id: "k2-e2e-policy-1",
                target_ratios: { train: 0.8, test: 0.2 },
                seed: 7,
                assignment_mode: "recompute_with_policy",
                split_strategy: "cluster_content_family_seeded",
                auto_style_cluster: false,
                training_lanes: ["train", "test"],
              };
              const digest = createHash("sha256").update(stableStringify(body), "utf8").digest("hex");
              return ok({
                type: "tool_call",
                tool: "atf_data_admission_request",
                params: { dataset_id: derivedId, split_policy: { ...body, integrity_digest: `sha256:${digest}` } },
              });
            }
            default:
              return ok({ type: "final_answer", text: "划分与准入检查已按确认策略执行完毕，结果已汇报。" });
          }
        },
      };

      const ran = await ScenarioRunner.runBranch(scenarioOf(fixture.runId, "把合成对数据准备好用于训练"), "main", {
        runsRoot,
        mockCommand: {
          argv: fixture.serveSpawn().argv,
          cwd: fixture.serveSpawn().cwd,
          env: fixture.serveSpawn().env,
        },
        scopeMode: "canonical",
        modelProvider: provider,
        approvalSurface: { stub: grantedStub },
      });
      expect(ran.ok, !ran.ok ? JSON.stringify(ran.error) : "").toBe(true);
      if (!ran.ok) return;
      const report: BranchRunReport = ran.value;
      const results = report.events
        .filter((event) => event.type === "tool/result")
        .map((event) => event.payload as { tool?: string; ok?: boolean; reason?: string; result?: unknown });

      // ① propose：聚类确认（缺料）
      const propose1 = results.find((entry) => entry.tool === "atf_preparation_propose" && entry.ok === true);
      expect(propose1).toBeDefined();
      let value = (propose1?.result ?? {}) as Record<string, unknown>;
      expect(value["stage"]).toBe("cluster_confirmation");
      expect(value["cluster_material"]).toBe("absent");
      expect(Object.keys(value["human_summary"] as Record<string, unknown>).sort()).toEqual([
        "actions", "headline", "metrics", "notes", "pending_confirmations", "sections",
      ]);

      // ② execute：确定性聚类落料（写，已过审批）
      const executed = results.find((entry) => entry.tool === "atf_style_cluster_execute" && entry.ok === true);
      expect(executed).toBeDefined();
      value = (executed?.result ?? {}) as Record<string, unknown>;
      expect(value["source"]).toBe("kernel");
      expect(value["cluster_count"] as number).toBeGreaterThanOrEqual(1);
      expect(typeof value["assignment_ref"]).toBe("string");
      expect(Object.keys(value["human_summary"] as Record<string, unknown>).sort()).toEqual([
        "actions", "headline", "metrics", "notes", "pending_confirmations", "sections",
      ]);

      // ③ propose 复查：阶段翻转
      const propose2 = results.filter((entry) => entry.tool === "atf_preparation_propose" && entry.ok === true)[1];
      expect(propose2).toBeDefined();
      value = (propose2?.result ?? {}) as Record<string, unknown>;
      expect(value["stage"]).toBe("split_confirmation");
      const echo = value["policy_template"] as Record<string, unknown>;
      expect(echo["target_ratios"]).toMatchObject({ train: 0.8, test: 0.2 });
      // 桩直构骨架与内核回显等价（policy_id/seed 外的冻结字段逐键一致）
      expect(echo["schema_version"]).toBe("DatasetSplitPolicy/v2");
      expect(echo["assignment_mode"]).toBe("recompute_with_policy");
      expect(echo["split_strategy"]).toBe("cluster_content_family_seeded");
      expect(echo["auto_style_cluster"]).toBe(false);

      // ④ request 携确认态：K3 顺序性短路（re-pin v0.7.7b0）——本 fixture 为合成对数据、
      // 无提取契约（合同）包，准入在 G1 入口短路（零读数零落盘，fail-closed）：status=blocked、
      // g1_short_circuit=true、gates 变长仅 G1（evaluated:true）、执行面字段 null、
      // human_summary 六字段仍齐（同源六键）。policy.source=confirmed 全链断言候
      // 合同包 fixture 备料后恢复（登记待办，归 re-pin 批报告）。
      const request = results.find((entry) => entry.tool === "atf_data_admission_request" && entry.ok === true);
      expect(request).toBeDefined();
      value = (request?.result ?? {}) as Record<string, unknown>;
      expect(value["status"]).toBe("blocked");
      expect(value["g1_short_circuit"]).toBe(true);
      const gates = value["gates"] as Array<Record<string, unknown>>;
      const g1 = gates[0] as Record<string, unknown>;
      expect(gates).toHaveLength(1);
      expect(g1).toMatchObject({ gate_id: "extraction-contract-valid", verdict: "block", evaluated: true });
      expect(g1["reason_codes"]).toContain("extraction_contract_bundle_missing");
      expect(value["summary_ref"]).toBeNull();
      expect(value["summary_sha256"]).toBeNull();
      expect((value["policy"] as Record<string, unknown>)["source"]).toBeNull();
      expect(Object.keys(value["human_summary"] as Record<string, unknown>).sort()).toEqual([
        "actions", "headline", "metrics", "notes", "pending_confirmations", "sections",
      ]);

      // 收口
      expect(report.outcome.kind).toBe("completed");
      expect(report.exit_code).toBe(0);
      } finally {
        if (qcRequiredSaved === undefined) delete process.env["ATF_LABEL_QC_REQUIRED"];
        else process.env["ATF_LABEL_QC_REQUIRED"] = qcRequiredSaved;
      }
    },
  );
});

if (!cli.ok) {
  it("ATF_CLI_PATH 未设置 → K-Gap-2 真内核 e2e 组跳过", () => {
    expect(cli.ok).toBe(false);
  });
}
