/**
 * F8 锚：atf_analyze_badcases 透传内核链 stdout 顶层的 review_coverage{pages_total,
 * pages_reviewed,status} 与 incomplete；解析不到＝review_coverage:null＋
 * incomplete_reason:"chain_output_missing"（不静默编造覆盖度）。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildEvalTools, reviewCoverageOf } from "../../packages/extensions/atf-tools/src/trainingFace.js";

type Tool = { name: string; execute: (args: unknown, exec: unknown) => Promise<Record<string, unknown>> };

const roots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "f8-analyze-"));
  roots.push(root);
  return root;
};
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** mock pin：冻结账本脚本写账本文件；一键链脚本按 chainStdout 打 stdout。 */
const seedRun = (chainStdout: string): { runsRoot: string; kernelDir: string } => {
  const kernelDir = join(tempRoot(), "kernel");
  const runsRoot = join(tempRoot(), "runs");
  const runDir = join(runsRoot, "run-f8");
  mkdirSync(join(runDir, "eval"), { recursive: true });
  writeFileSync(join(runDir, "eval", "badcases.jsonl"), "{}\n", "utf8");
  writeFileSync(join(runDir, "eval", "raw_predictions.jsonl"), "{}\n", "utf8");
  mkdirSync(join(runDir, "l1", "eval"), { recursive: true });
  mkdirSync(join(runDir, "l1", "images"), { recursive: true });
  writeFileSync(join(runDir, "l1", "images", "a.png"), "PNG", "utf8");
  writeFileSync(join(runDir, "l1", "eval", "eval_labels.jsonl"), `${JSON.stringify({ image: "images/a.png", labels: {} })}\n`, "utf8");

  const freezeDir = join(kernelDir, "skills", "atf-evaluate-checkpoints", "scripts");
  mkdirSync(freezeDir, { recursive: true });
  writeFileSync(join(freezeDir, "build_raw_badcase_input.py"), [
    "import json, os, sys",
    "args = sys.argv[1:]",
    "out = args[args.index('--out-dir') + 1]",
    "os.makedirs(out, exist_ok=True)",
    "open(os.path.join(out, 'raw-badcase-analysis.v1.json'), 'w').write(json.dumps({'schema_version': 'RawBadcaseAnalysis/v1'}))",
    "print('frozen')",
  ].join("\n"), "utf8");

  const chainDir = join(kernelDir, "skills", "atf-analyze-badcases", "scripts");
  mkdirSync(chainDir, { recursive: true });
  writeFileSync(join(chainDir, "run_analysis_chain.py"), [
    "import os, sys",
    "args = sys.argv[1:]",
    "out = args[args.index('--output-dir') + 1]",
    "os.makedirs(os.path.join(out, 'viewer'), exist_ok=True)",
    "os.makedirs(os.path.join(out, 'report'), exist_ok=True)",
    "print('chain start')",
    ...(chainStdout === ""
      ? ["print('done without json')"]
      : [`print(${JSON.stringify(chainStdout)})`]),
  ].join("\n"), "utf8");
  return { runsRoot, kernelDir };
};

const analyzeOf = (fixture: { runsRoot: string; kernelDir: string }): Tool => {
  const tools = buildEvalTools(
    { get: () => undefined },
    { runsRoot: fixture.runsRoot, logDir: join(fixture.runsRoot, "logs"), kernelDir: fixture.kernelDir },
  ) as unknown as Tool[];
  const tool = tools.find((entry) => entry.name === "atf_analyze_badcases");
  if (tool === undefined) throw new Error("atf_analyze_badcases 未挂载");
  return tool;
};

describe("F8 reviewCoverageOf（纯函数）", () => {
  it("tail JSON 透传三键；incomplete 照抄内核布尔", () => {
    const out = reviewCoverageOf('log line\n{"review_coverage":{"pages_total":10,"pages_reviewed":4,"status":"partial"},"incomplete":false}\n');
    expect(out.review_coverage).toEqual({ pages_total: 10, pages_reviewed: 4, status: "partial" });
    expect(out.incomplete).toBe(false);
    expect(out.incomplete_reason).toBeUndefined();
  });

  it("内核没给 incomplete → 按 pages_reviewed==0 判", () => {
    const zero = reviewCoverageOf('{"review_coverage":{"pages_total":10,"pages_reviewed":0,"status":"none"}}');
    expect(zero.incomplete).toBe(true);
    const some = reviewCoverageOf('{"review_coverage":{"pages_total":10,"pages_reviewed":3,"status":"partial"}}');
    expect(some.incomplete).toBe(false);
  });

  it("无 JSON／形状不全 → null＋chain_output_missing（不编造）", () => {
    expect(reviewCoverageOf("chain done")).toEqual({ review_coverage: null, incomplete: true, incomplete_reason: "chain_output_missing" });
    expect(reviewCoverageOf("")).toEqual({ review_coverage: null, incomplete: true, incomplete_reason: "chain_output_missing" });
    expect(reviewCoverageOf('{"review_coverage":{"pages_total":"x"}}').review_coverage).toBeNull();
  });

  it("多行 JSON（最后一段完整对象）也能取到", () => {
    const out = reviewCoverageOf('{"stage":"start"}\n{"review_coverage":{"pages_total":2,"pages_reviewed":2,"status":"full"},"incomplete":false}');
    expect(out.review_coverage?.status).toBe("full");
  });
});

describe("F8 atf_analyze_badcases 回执透传（真子进程 mock pin）", () => {
  it("链 stdout 带 review_coverage → 回执原值透传＋incomplete", async () => {
    const fixture = seedRun('{"review_coverage":{"pages_total":8,"pages_reviewed":3,"status":"partial"},"incomplete":false}');
    const receipt = await analyzeOf(fixture).execute({ run_id: "run-f8", lane: "goods" }, { callId: "f8-1" });
    expect(receipt["ok"]).toBe(true);
    expect(receipt["review_coverage"]).toEqual({ pages_total: 8, pages_reviewed: 3, status: "partial" });
    expect(receipt["incomplete"]).toBe(false);
    expect(receipt["incomplete_reason"]).toBeUndefined();
  });

  it("链 stdout 无 JSON → review_coverage:null＋incomplete_reason=chain_output_missing", async () => {
    const fixture = seedRun("");
    const receipt = await analyzeOf(fixture).execute({ run_id: "run-f8", lane: "goods" }, { callId: "f8-2" });
    expect(receipt["ok"]).toBe(true);
    expect(receipt["review_coverage"]).toBeNull();
    expect(receipt["incomplete"]).toBe(true);
    expect(receipt["incomplete_reason"]).toBe("chain_output_missing");
  });
});

describe("F8 审阅件入口接线（图核审阅能进链）", () => {
  it("参数面暴露 cluster_reviews 与 review_check（缺则审阅件无处可传）", () => {
    const tool = analyzeOf(seedRun("")) as unknown as { parameters?: { properties?: Record<string, unknown> } };
    const keys = Object.keys(tool.parameters?.properties ?? {});
    expect(keys).toContain("cluster_reviews");
    expect(keys).toContain("review_check");
  });

  it("传 cluster_reviews → 链 argv 带上 --cluster-reviews（回注/决策才可能发生）", async () => {
    const fixture = seedRun('{"review_coverage":{"pages_total":2,"pages_reviewed":2,"status":"complete"}}');
    const chain = join(fixture.kernelDir, "skills", "atf-analyze-badcases", "scripts", "run_analysis_chain.py");
    writeFileSync(chain, [
      "import json, os, sys",
      "args = sys.argv[1:]",
      "out = args[args.index('--output-dir') + 1]",
      "os.makedirs(os.path.join(out, 'viewer'), exist_ok=True)",
      "os.makedirs(os.path.join(out, 'report'), exist_ok=True)",
      "open(os.path.join(out, 'argv.json'), 'w').write(json.dumps(args))",
      "print(json.dumps({'review_coverage': {'pages_total': 2, 'pages_reviewed': 2, 'status': 'complete'}}))",
    ].join("\n"), "utf8");
    const reviews = join(fixture.runsRoot, "run-f8", "review-round1", "cluster-reviews.v1.json");
    mkdirSync(join(fixture.runsRoot, "run-f8", "review-round1"), { recursive: true });
    writeFileSync(reviews, "{}", "utf8");
    const receipt = await analyzeOf(fixture).execute(
      { run_id: "run-f8", lane: "goods", cluster_reviews: reviews }, { callId: "f8-3" });
    expect(receipt["ok"]).toBe(true);
    const argv = JSON.parse(readFileSync(join(fixture.runsRoot, "run-f8", "analysis", "argv.json"), "utf8")) as string[];
    expect(argv).toContain("--cluster-reviews");
    expect(argv[argv.indexOf("--cluster-reviews") + 1]).toBe(reviews);
  });
});
