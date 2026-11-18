/**
 * 部署证据门校验器单测（work/20261117-deploy-evidence-gate）——三态演练的机检面：
 * 缺清单拦／缺字段拦／过期拦／齐全放行／no_new_code 放行／交互载体缺交互链路映射拦／
 * expect 失配拦。真仓形态：临时 git 仓两 commit（base→head），证据锚用临时在盘文件。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const VALIDATOR = join(import.meta.url.replace("file://", ""), "..", "..", "..", "deploy", "verify", "check-deploy-evidence.sh");

const roots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "deploy-evidence-test-"));
  roots.push(root);
  return root;
};
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** 临时 git 仓：base 与 head 两个真实 commit，返回 { repo, base, head }。 */
const makeRepo = (root: string, headFiles: string[], baseFiles: string[] = []): { repo: string; base: string; head: string } => {
  const run = (args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf-8" });
  execFileSync("git", ["init", "-q", root]);
  run(["config", "user.email", "t@t"]);
  run(["config", "user.name", "t"]);
  let nonce = 0;
  const commitFiles = (files: string[]): string => {
    nonce += 1;
    for (const f of files) {
      mkdirSync(join(root, f, ".."), { recursive: true });
      writeFileSync(join(root, f), `x${nonce}\n`, "utf-8");
    }
    run(["add", "."]);
    execFileSync("git", ["-C", root, "commit", "-q", "-m", files.join(",")]);
    return run(["rev-parse", "HEAD"]).trim();
  };
  const base = commitFiles(baseFiles.length > 0 ? baseFiles : ["docs/readme.md"]);
  const head = commitFiles(headFiles);
  return { repo: root, base, head };
};

const writeEvidence = (root: string, doc: unknown, stale = false): string => {
  const path = join(root, "evidence.json");
  writeFileSync(path, JSON.stringify(doc, null, 2), "utf-8");
  if (stale) utimesSync(path, new Date(Date.now() - 86_400_000), new Date(Date.now() - 86_400_000));
  return path;
};

const runGate = (evidence: string, repo: string, expectCommit = ""): { status: number; stderr: string; stdout: string } => {
  try {
    const stdout = execFileSync("bash", [VALIDATOR, evidence, repo, expectCommit], { encoding: "utf-8" });
    return { status: 0, stderr: "", stdout };
  } catch (error) {
    const err = error as { status?: number; stderr?: string; stdout?: string };
    return { status: err.status ?? -1, stderr: err.stderr ?? "", stdout: err.stdout ?? "" };
  }
};

describe("部署证据门校验器（DeployEvidence/v1 三态演练机检面）", () => {
  it("缺清单 → 拦 + 指路（改法一/二）", () => {
    const root = tempRoot();
    const result = runGate(join(root, "missing.json"), root);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("证据清单缺席");
    expect(result.stderr).toContain("改法一");
    expect(result.stderr).toContain("no_new_code");
  });

  it("缺 mappings 字段（标准 form）→ 拦 + 指路", () => {
    const root = tempRoot();
    const { repo, head } = makeRepo(root, ["docs/readme.md"]);
    const verdict = join(root, "verdict.md");
    writeFileSync(verdict, "PASS\n", "utf-8");
    const evidence = writeEvidence(root, {
      schema_version: "DeployEvidence/v1",
      batch_slug: "t",
      base_commit: head,
      head_commit: head,
      verdict: { path: verdict, overall: "PASS" },
    });
    const result = runGate(evidence, repo);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("mappings 空");
    expect(result.stderr).toContain("face/test_form/evidence_anchor");
  });

  it("过期证据（mtime < head 提交时间）→ 拦", () => {
    const root = tempRoot();
    const { repo, head } = makeRepo(root, ["docs/readme.md"]);
    const verdict = join(root, "verdict.md");
    writeFileSync(verdict, "PASS\n", "utf-8");
    const anchor = join(root, "anchor-run");
    mkdirSync(anchor);
    const evidence = writeEvidence(root, {
      schema_version: "DeployEvidence/v1",
      batch_slug: "t",
      base_commit: head,
      head_commit: head,
      verdict: { path: verdict, overall: "PASS" },
      mappings: [{ face: "内核段", test_form: "语料回放 run 目录", evidence_anchor: anchor }],
    }, true);
    const result = runGate(evidence, repo);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("旧证据不覆盖新改动");
  });

  it("齐全（verdict PASS+映射+锚在场）→ 放行", () => {
    const root = tempRoot();
    const { repo, base, head } = makeRepo(root, ["docs/readme.md"]);
    const verdict = join(root, "verdict.md");
    writeFileSync(verdict, "PASS\n", "utf-8");
    const anchor = join(root, "anchor-run");
    mkdirSync(anchor);
    const evidence = writeEvidence(root, {
      schema_version: "DeployEvidence/v1",
      batch_slug: "t",
      base_commit: base,
      head_commit: head,
      verdict: { path: verdict, overall: "PASS" },
      mappings: [{ face: "内核段", test_form: "语料回放 run 目录", evidence_anchor: anchor }],
    });
    const result = runGate(evidence, repo);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("DEPLOY-EVIDENCE-GATE 通过");
  });

  it("no_new_code 声明（含理由）→ 放行", () => {
    const root = tempRoot();
    const { repo, head } = makeRepo(root, ["docs/readme.md"]);
    const evidence = writeEvidence(root, {
      schema_version: "DeployEvidence/v1",
      batch_slug: "t",
      base_commit: head,
      head_commit: head,
      no_new_code: { declared: true, reason: "重部署既有 main——无新变更面" },
    });
    const result = runGate(evidence, repo);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("无新代码声明");
  });

  it("no_new_code 声明缺理由 → 拦", () => {
    const root = tempRoot();
    const { repo, head } = makeRepo(root, ["docs/readme.md"]);
    const evidence = writeEvidence(root, {
      schema_version: "DeployEvidence/v1",
      batch_slug: "t",
      base_commit: head,
      head_commit: head,
      no_new_code: { declared: true, reason: "" },
    });
    const result = runGate(evidence, repo);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("缺 reason");
  });

  it("对抗：批次触达交互载体（pipelineFace）而清单无交互链路映射 → 拦", () => {
    const root = tempRoot();
    const { repo, base, head } = makeRepo(root, ["packages/extensions/atf-tools/src/pipelineFace.ts"]);
    const verdict = join(root, "verdict.md");
    writeFileSync(verdict, "PASS\n", "utf-8");
    const anchor = join(root, "anchor-run");
    mkdirSync(anchor);
    const evidence = writeEvidence(root, {
      schema_version: "DeployEvidence/v1",
      batch_slug: "t",
      base_commit: base,
      head_commit: head,
      verdict: { path: verdict, overall: "PASS" },
      mappings: [{ face: "内核段", test_form: "语料回放 run 目录", evidence_anchor: anchor }],
    });
    const result = runGate(evidence, repo);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("交互链路");
    expect(result.stderr).toContain("pipelineFace");
  });

  it("对抗变体：交互载体批次补 face=交互链路 映射 → 放行", () => {
    const root = tempRoot();
    const { repo, base, head } = makeRepo(root, ["packages/extensions/atf-tools/src/pipelineFace.ts"]);
    const verdict = join(root, "verdict.md");
    writeFileSync(verdict, "PASS\n", "utf-8");
    const anchorK = join(root, "anchor-kernel");
    const anchorI = join(root, "anchor-interaction");
    mkdirSync(anchorK);
    mkdirSync(anchorI);
    const evidence = writeEvidence(root, {
      schema_version: "DeployEvidence/v1",
      batch_slug: "t",
      base_commit: base,
      head_commit: head,
      verdict: { path: verdict, overall: "PASS" },
      mappings: [
        { face: "内核段", test_form: "语料回放 run 目录", evidence_anchor: anchorK },
        { face: "交互链路", test_form: "自动驱动器闭环 run 记录", evidence_anchor: anchorI },
      ],
    });
    const result = runGate(evidence, repo);
    expect(result.status).toBe(0);
  });

  it("expect 失配（清单 head_commit ≠ 部署目标 commit）→ 拦", () => {
    const root = tempRoot();
    const { repo, base, head } = makeRepo(root, ["docs/readme.md"]);
    const verdict = join(root, "verdict.md");
    writeFileSync(verdict, "PASS\n", "utf-8");
    const anchor = join(root, "anchor-run");
    mkdirSync(anchor);
    const evidence = writeEvidence(root, {
      schema_version: "DeployEvidence/v1",
      batch_slug: "t",
      base_commit: base,
      head_commit: head,
      verdict: { path: verdict, overall: "PASS" },
      mappings: [{ face: "内核段", test_form: "语料回放 run 目录", evidence_anchor: anchor }],
    });
    const result = runGate(evidence, repo, base);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("不一致");
  });
});
