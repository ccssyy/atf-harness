/**
 * D94-harness 护栏事实面采集（guard.test.ts 与 guard.negative.test.ts 共享——
 * 测试文件互不 import（防 describe 重放，realPeer fixture 同纪律），采集逻辑单落本件）。
 */
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTO_STYLE_CLUSTER_VALUES,
  GROUPING_PRESET_VALUES,
  buildPipelineTool,
} from "../../packages/extensions/atf-tools/src/pipelineFace.js";
import { SEGMENT_ORDER } from "../../src/core/workspace/runFacts.js";
import { SEGMENT_FACT_BY_KERNEL_STAGE } from "../../src/core/workspace/segmentFacts.js";
import { KERNEL_ERROR_FACE_CODES } from "../../src/core/workspace/kernelErrorFace.js";
import { CONFIG_CONFIRM_KEYS, READONLY_CONFIG_KEYS } from "../../src/webui/configConfirm.js";
import type { HarnessSurfaceFacts, SurfaceSnapshot } from "./guard.js";

const WALKTHROUGH = "tools/walkthrough_pipeline.py";
const BUILD_EXPERIMENT_SETUP = "skills/atf-admit-training-data/scripts/build_experiment_setup.py";
const GENERATE_ITERATION_CONFIG = "skills/atf-prepare-training/scripts/generate_iteration_config.py";

export const snapshotOf = (): SurfaceSnapshot =>
  JSON.parse(
    readFileSync(join(import.meta.dirname, "../fixtures/kernel/argparse_surface.json"), "utf8"),
  ) as SurfaceSnapshot;

export const pipelineFaceSource = readFileSync(
  join(import.meta.dirname, "../../packages/extensions/atf-tools/src/pipelineFace.ts"),
  "utf8",
);
export const kernelErrorFaceSource = readFileSync(
  join(import.meta.dirname, "../../src/core/workspace/kernelErrorFace.ts"),
  "utf8",
);
export const bridgeContractText = readFileSync(
  join(import.meta.dirname, "../../bridge.contract.yaml"),
  "utf8",
);
const mockSource = readFileSync(
  join(import.meta.dirname, "../fixtures/mock_pipeline_params.mjs"),
  "utf8",
);

/** mock KNOWN 段闭集（fixtures 源码扫描——数组字面量提取）。 */
export const mockKnownStages = (/\bKNOWN = \[([^\]]+)\]/.exec(mockSource)?.[1] ?? "")
  .split(",")
  .map((item) => item.trim().replace(/^"|"$/g, ""))
  .filter((item) => item !== "");

/** humanizeKernelError switch case 键集（源码扫描）。 */
export const errorFaceCaseKeys = [...kernelErrorFaceSource.matchAll(/case "([a-z0-9_]+)":/g)].map(
  (hit) => hit[1] ?? "",
);

/** 工具参数键 → 内核旗标单源映射（参数面护栏的登记表；新增工具参数键必须同步在册）。 */
export const FLAG_BY_PARAM: Readonly<Record<string, string>> = {
  stage: "--stage",
  run_id: "--run-id",
  workspace_path: "--workspace",
  source_root: "--source-root",
  base_model_path: "--base-model",
  auto_style_cluster: "--auto-style-cluster",
  allow_small_cluster_test: "--allow-small-cluster-test",
  grouping_preset: "--grouping-preset",
  negative_ratio_target: "--negative-ratio-target",
  doc_type: "--doc-type",
  lane_suffix: "--lane-suffix",
  field_config: "--field-config",
  train_all: "--train-all",
  assignment_source: "--assignment-source",
  reuse_experiment_setup: "--reuse-experiment-setup",
  token_provider: "--token-provider",
  retry_coordinate_pending: "--retry-coordinate-pending",
};

/** 九要素键 → 消费点登记表（「可编辑不消费」禁的正向登记；旗标空串＝脚本级组装消费
 *  ——值经脚本组装进产物文件，非 CLI 参数直收）。新增卡键必须同步在册：消费点参数级
 *  （旗标）优先，仅组装面消费的登记脚本级。 */
export const KEY_CONSUMPTION: Readonly<Record<string, ReadonlyArray<readonly [string, string]>>> = {
  negative_ratio_target: [
    [WALKTHROUGH, "--negative-ratio-target"],
    [BUILD_EXPERIMENT_SETUP, "--negative-ratio-target"],
  ],
  max_total_tokens: [
    [BUILD_EXPERIMENT_SETUP, "--max-total-tokens"],
    [GENERATE_ITERATION_CONFIG, "--token-budget"],
  ],
  cutoff_len: [[GENERATE_ITERATION_CONFIG, "--token-budget"]],
  image_min_pixels: [
    [BUILD_EXPERIMENT_SETUP, "--image-min-pixels"],
    [GENERATE_ITERATION_CONFIG, "--image-min-pixels"],
  ],
  image_max_pixels: [
    [BUILD_EXPERIMENT_SETUP, "--image-max-pixels"],
    [GENERATE_ITERATION_CONFIG, "--image-max-pixels"],
  ],
  visible_devices: [[GENERATE_ITERATION_CONFIG, "--visible-devices"]],
  base_model_path: [
    [WALKTHROUGH, "--base-model"],
    [GENERATE_ITERATION_CONFIG, "--base-model"],
  ],
  num_train_epochs: [[GENERATE_ITERATION_CONFIG, "--epochs"]],
  per_device_train_batch_size: [[GENERATE_ITERATION_CONFIG, ""]],
  gradient_accumulation_steps: [[GENERATE_ITERATION_CONFIG, ""]],
  deepspeed: [[BUILD_EXPERIMENT_SETUP, "--deepspeed"]],
  lora_rank: [[GENERATE_ITERATION_CONFIG, "--lora-rank"]],
  lora_alpha: [[GENERATE_ITERATION_CONFIG, "--lora-alpha"]],
  learning_rate: [[GENERATE_ITERATION_CONFIG, ""]],
  nproc_per_node: [[BUILD_EXPERIMENT_SETUP, "--nproc-per-node"]],
};

interface DshToolLike {
  name: string;
  parameters: Record<string, { properties?: Record<string, unknown> }>;
  execute: (args: unknown, exec: unknown) => Promise<unknown>;
}

const approvalCtx = (): { get(service: string): unknown } => ({
  get: (service: string) =>
    (service === "approval"
      ? { request: async () => "allowed-once" }
      : undefined),
});
const MOCK = join(import.meta.dirname, "../fixtures/mock_pipeline_params.mjs");

/** 行为面采集：atf_pipeline_stage 四段大满贯（register/experiment_setup/family_split/
 *  training_prep——覆盖全部工具参数键），mock 对端回显 argv 拼接为全 token 序列。 */
export const collectArgvTokens = async (): Promise<string[]> => {
  const tool = buildPipelineTool(approvalCtx(), `node ${MOCK}`, 30_000) as unknown as DshToolLike;
  const fakeExec = { agent: undefined, callId: "d94-guard", signal: undefined };
  const tempRoot = mkdtempSync(join(tmpdir(), "d94-guard-"));
  const calls: Array<Record<string, unknown>> = [
    {
      stage: "register",
      run_id: "d94-register",
      workspace_path: tempRoot,
      source_root: join(tempRoot, "src"),
      doc_type: "invoice",
      lane_suffix: "goods",
      field_config: join(tempRoot, "field-config.json"),
    },
    {
      stage: "experiment_setup",
      run_id: "d94-setup",
      workspace_path: tempRoot,
      grouping_preset: "A",
      negative_ratio_target: "0.03,0.06",
      train_all: true,
    },
    {
      stage: "family_split",
      run_id: "d94-split",
      workspace_path: tempRoot,
      auto_style_cluster: "on",
      allow_small_cluster_test: true,
    },
    {
      stage: "training_prep",
      run_id: "d94-prep",
      workspace_path: tempRoot,
      base_model_path: join(tempRoot, "model-dir"),
    },
  ];
  const tokens: string[] = [];
  try {
    for (const call of calls) {
      const result = (await tool.execute(call, fakeExec)) as { summary?: { argv?: string[] } };
      tokens.push(...(result.summary?.argv ?? []));
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
  return tokens;
};

export const factsOf = (argvTokens: readonly string[]): HarnessSurfaceFacts & { mockKnownStages: readonly string[] } => ({
  argvTokens,
  toolParamKeys: Object.keys(
    ((buildPipelineTool(approvalCtx(), `node ${MOCK}`, 30_000) as unknown as DshToolLike).parameters as { properties?: Record<string, unknown> }).properties ?? {},
  ),
  flagByParam: FLAG_BY_PARAM,
  pipelineStages: SEGMENT_ORDER,
  segmentFactKeys: Object.keys(SEGMENT_FACT_BY_KERNEL_STAGE),
  groupingPresetValues: GROUPING_PRESET_VALUES,
  autoStyleClusterValues: AUTO_STYLE_CLUSTER_VALUES,
  approvalModeValue: "ui",
  configConfirmKeys: CONFIG_CONFIRM_KEYS.map((entry) => entry.key),
  readonlyConfigKeys: [...READONLY_CONFIG_KEYS],
  keyConsumption: KEY_CONSUMPTION,
  kernelErrorFaceCodes: [...KERNEL_ERROR_FACE_CODES],
  errorFaceCaseKeys,
  kernelScriptRefs: [
    "walkthrough_pipeline.py",
    "build_experiment_setup.py",
    "generate_iteration_config.py",
    "generate_train_launch.py",
  ],
  docContractText: pipelineFaceSource,
  docKernelErrorText: kernelErrorFaceSource,
  bridgeContractText,
  summaryPathTemplateLiteral: pipelineFaceSource,
  mockKnownStages,
});
