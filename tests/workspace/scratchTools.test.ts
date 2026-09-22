/**
 * 批 3「创作执行面」单元用例（§一/§二）：scratch 受控执行引擎＋SkillCatalog。
 * 判据：路径越界拒绝／argv 白名单（shell 拒绝、pin 内 .py 放行）／env 白名单（凭据不进）／
 * 超时／stdout 上限截断／G5 检测（TRAIN_DIR→manifest→IterationConfig sha256 对拍）／
 * skills frontmatter 解析与附属文件路径守卫。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildScratchExecEnv,
  findPython3,
  guardScratchArgv,
  guardedScratchWrite,
  runScratchCommand,
  scanLaunchReady,
  SCRATCH_EXEC_STDOUT_CAP_BYTES,
  SCRATCH_WRITE_MAX_BYTES,
} from "../../src/core/workspace/index.js";
import {
  listSkills,
  parseSkillFrontmatter,
  readSkillBody,
  readSkillFile,
  skillsSuffixText,
} from "../../src/core/workspace/index.js";

const makeTemp = (label: string): string => mkdtempSync(join(tmpdir(), `atf-b3-${label}-`));

const python = findPython3();

describe("批 3 §一：scratch 路径与 argv 白名单", () => {
  it("guardedScratchWrite：正常写入返回 sha256；.. 越界与绝对路径拒绝；超限拒绝", async () => {
    const scratch = makeTemp("ws");
    try {
      const okWrite = await guardedScratchWrite({ scratchDir: scratch, relPath: "prep/config.json", content: '{"a":1}', maxBytes: SCRATCH_WRITE_MAX_BYTES });
      expect(okWrite.ok).toBe(true);
      if (okWrite.ok) {
        expect(okWrite.value.path).toBe("prep/config.json");
        expect(okWrite.value.sha256).toMatch(/^[0-9a-f]{64}$/);
      }
      const escape = await guardedScratchWrite({ scratchDir: scratch, relPath: "../escape.txt", content: "x", maxBytes: SCRATCH_WRITE_MAX_BYTES });
      expect(escape.ok).toBe(false);
      if (!escape.ok) expect(escape.error.reason).toBe("path_escape");
      const absolute = await guardedScratchWrite({ scratchDir: scratch, relPath: "/etc/passwd", content: "x", maxBytes: SCRATCH_WRITE_MAX_BYTES });
      expect(absolute.ok).toBe(false);
      if (!absolute.ok) expect(absolute.error.reason).toBe("path_escape");
      const tooLarge = await guardedScratchWrite({ scratchDir: scratch, relPath: "big.bin", content: "x".repeat(SCRATCH_WRITE_MAX_BYTES + 1), maxBytes: SCRATCH_WRITE_MAX_BYTES });
      expect(tooLarge.ok).toBe(false);
      if (!tooLarge.ok) expect(tooLarge.error.reason).toBe("content_too_large");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("guardScratchArgv：python3 放行；pin 内 .py 放行并经解释器执行；shell 与 scratch 外路径拒绝", () => {
    const scratch = makeTemp("argv");
    const kernelDir = makeTemp("kernel");
    try {
      const pythonPath = "/usr/bin/python3";
      const pythonOk = guardScratchArgv({ argv: ["python3", "-c", "print(1)"], scratchDir: scratch, kernelDir, pythonPath });
      expect(pythonOk).toEqual({ ok: true, spawnArgv: [pythonPath, "-c", "print(1)"] });

      const pinScript = join(kernelDir, "skills", "atf-run-training", "scripts", "gen.py");
      const pinOk = guardScratchArgv({ argv: [pinScript, "--out", "launch"], scratchDir: scratch, kernelDir, pythonPath });
      expect(pinOk.ok).toBe(true);
      if (pinOk.ok) expect(pinOk.spawnArgv[0]).toBe(pythonPath);

      const scratchScript = join(scratch, "tool.py");
      const scratchOk = guardScratchArgv({ argv: [scratchScript], scratchDir: scratch, kernelDir, pythonPath });
      expect(scratchOk.ok).toBe(true);

      const bash = guardScratchArgv({ argv: ["bash", "x.sh"], scratchDir: scratch, kernelDir, pythonPath });
      expect(bash.ok).toBe(false);
      if (!bash.ok) expect(bash.reason).toBe("argv0_not_allowed");

      const outside = guardScratchArgv({ argv: ["/usr/bin/ls"], scratchDir: scratch, kernelDir, pythonPath });
      expect(outside.ok).toBe(false);

      const shortArgv = guardScratchArgv({ argv: [], scratchDir: scratch, kernelDir, pythonPath });
      expect(shortArgv.ok).toBe(false);
      if (!shortArgv.ok) expect(shortArgv.reason).toBe("argv_invalid");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
      rmSync(kernelDir, { recursive: true, force: true });
    }
  });

  it("buildScratchExecEnv：白名单形态——PYTHONPATH 指内核 src、TMPDIR 落 scratch、ATF_LLM_* 凭据不透传、宿主任意 env 不继承", () => {
    const scratch = makeTemp("env");
    const kernelDir = makeTemp("kernel");
    try {
      process.env["ATF_LLM_KEY_DEEPSEEK"] = "sk-secret-test";
      process.env["ATF_TEST_PLAIN"] = "plain-value";
      const env = buildScratchExecEnv({
        scratchDir: scratch,
        kernelDir,
        baseEnv: { HOME: "/home/isolated", ATF_WORKSPACE_ROOT: "/ws/root", ATF_SKILLS_AUTO_INSTALL: "0" },
        pythonPath: "/usr/bin/python3",
      });
      expect(env["PYTHONPATH"]).toBe(join(kernelDir, "src"));
      expect(env["TMPDIR"]).toBe(join(scratch, ".tmp"));
      expect(env["HOME"]).toBe("/home/isolated");
      expect(env["ATF_WORKSPACE_ROOT"]).toBe("/ws/root");
      expect(env["PATH"]).toContain("/usr/bin");
      expect(env["ATF_LLM_KEY_DEEPSEEK"]).toBeUndefined();
      expect(env["ATF_TEST_PLAIN"]).toBe("plain-value");
      expect(env["HOME_OVERRIDE_UNRELATED"]).toBeUndefined();
      delete process.env["ATF_LLM_KEY_DEEPSEEK"];
      delete process.env["ATF_TEST_PLAIN"];
    } finally {
      rmSync(scratch, { recursive: true, force: true });
      rmSync(kernelDir, { recursive: true, force: true });
    }
  });
});

describe("批 3 §一：受控执行（python 径）", () => {
  it.runIf(python !== "python3" || process.env["ATF_B3_PY"] !== undefined)("cwd 恒 scratch、stdout 捕获、exit code 如实", { timeout: 30_000 }, async () => {
    const scratch = makeTemp("exec");
    try {
      mkdirSync(join(scratch, ".tmp"), { recursive: true });
      const ran = await runScratchCommand({
        argv: [python, "-c", "import os;print(os.getcwd());raise SystemExit(3)"],
        cwd: scratch,
        env: buildScratchExecEnv({ scratchDir: scratch, kernelDir: scratch, baseEnv: {}, pythonPath: python }),
        timeoutMs: 15_000,
      });
      expect(ran.ok).toBe(true);
      if (ran.ok) {
        expect(ran.value.exit_code).toBe(3);
        expect(ran.value.stdout.trim()).toBe(scratch);
        expect(ran.value.timed_out).toBe(false);
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it.runIf(python !== "python3" || process.env["ATF_B3_PY"] !== undefined)("超时置 timed_out；stdout 超限截断并标注", { timeout: 30_000 }, async () => {
    const scratch = makeTemp("exec2");
    try {
      mkdirSync(join(scratch, ".tmp"), { recursive: true });
      const env = buildScratchExecEnv({ scratchDir: scratch, kernelDir: scratch, baseEnv: {}, pythonPath: python });
      const timed = await runScratchCommand({
        argv: [python, "-c", "import time;time.sleep(5)"],
        cwd: scratch,
        env,
        timeoutMs: 300,
      });
      expect(timed.ok).toBe(true);
      if (timed.ok) expect(timed.value.timed_out).toBe(true);

      const big = await runScratchCommand({
        argv: [python, "-c", `print("x" * ${String(SCRATCH_EXEC_STDOUT_CAP_BYTES * 4)})`],
        cwd: scratch,
        env,
        timeoutMs: 15_000,
      });
      expect(big.ok).toBe(true);
      if (big.ok) {
        expect(big.value.stdout_truncated).toBe(true);
        expect(Buffer.byteLength(big.value.stdout, "utf8")).toBeLessThanOrEqual(SCRATCH_EXEC_STDOUT_CAP_BYTES);
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("批 3 §三：G5 就绪检测（确定性）", () => {
  it("launch.sh + TRAIN_DIR manifest + IterationConfig sha256 对拍命中 config；无匹配不给 config", async () => {
    const scratch = makeTemp("detect");
    try {
      const kernelDir = makeTemp("kernel2");
      const trainDir = join(scratch, "prep", "launch");
      mkdirSync(trainDir, { recursive: true });
      writeFileSync(join(trainDir, "iteration-config.json"), JSON.stringify({ schema_version: "IterationConfig/v1", run_id: "run-x" }));
      const configSha = createHash("sha256").update(readFileSync(join(trainDir, "iteration-config.json"))).digest("hex");
      writeFileSync(join(trainDir, "launch_manifest.json"), JSON.stringify({ run_id: "run-x", iteration_config_sha256: configSha, global_batch: 16, nnodes: 1 }));
      const outDir = join(scratch, "out");
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, "launch.sh"), `#!/usr/bin/env bash\nTRAIN_DIR='${trainDir}'\necho hi\n`);
      rmSync(kernelDir, { recursive: true, force: true });

      const ready = await scanLaunchReady(scratch);
      expect(ready).not.toBeNull();
      expect(ready?.launch_sh).toBe(join("out", "launch.sh"));
      expect(ready?.run_id).toBe("run-x");
      expect(ready?.iteration_config_sha256).toBe(configSha);
      expect(ready?.global_batch).toBe(16);
      expect(ready?.config).toBe(join("prep", "launch", "iteration-config.json"));

      // 换 manifest sha（对拍不上）→ config 缺省（fail-honest）
      writeFileSync(join(trainDir, "launch_manifest.json"), JSON.stringify({ run_id: "run-x", iteration_config_sha256: "0".repeat(64) }));
      const ready2 = await scanLaunchReady(scratch);
      expect(ready2?.iteration_config_sha256).toBe("0".repeat(64));
      expect(ready2?.config).toBeUndefined();

      // 无 launch.sh → null
      const empty = makeTemp("detect-empty");
      try {
        expect(await scanLaunchReady(empty)).toBeNull();
      } finally {
        rmSync(empty, { recursive: true, force: true });
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("批 3 §二：SkillCatalog", () => {
  it("frontmatter 解析（含续行）；清单一行/技能；全文与附属文件路径守卫", async () => {
    expect(parseSkillFrontmatter("---\nname: atf-run-training\nversion: 1.5\ndescription: 启动编排生成\n---\n\n# 正文\n")?.name).toBe("atf-run-training");
    expect(parseSkillFrontmatter("no frontmatter")).toBeNull();

    const skillsRoot = makeTemp("skills");
    try {
      const dir = join(skillsRoot, "atf-evaluate-checkpoints");
      mkdirSync(join(dir, "references"), { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), "---\nname: atf-evaluate-checkpoints\ndescription: 评估 checkpoint\n---\n\n# 评估\n按此执行。");
      writeFileSync(join(dir, "references", "method.md"), "# 方法");
      const other = join(skillsRoot, "not-a-skill");
      mkdirSync(other, { recursive: true });
      writeFileSync(join(other, "README.md"), "no skill");

      const listed = await listSkills(skillsRoot);
      expect(listed.ok).toBe(true);
      if (listed.ok) {
        expect(listed.value).toHaveLength(1);
        expect(listed.value[0]?.name).toBe("atf-evaluate-checkpoints");
        expect(skillsSuffixText(listed.value)).toContain("- atf-evaluate-checkpoints — 评估 checkpoint");
        expect(skillsSuffixText(listed.value)).toContain("atf_scratch_exec");
      }

      const body = await readSkillBody(skillsRoot, "atf-evaluate-checkpoints");
      expect(body.ok).toBe(true);
      if (body.ok) {
        expect(body.value.body).toContain("# 评估");
        expect(body.value.body).not.toContain("description:");
        expect(body.value.references).toContain("references/method.md");
      }

      const ref = await readSkillFile(skillsRoot, "atf-evaluate-checkpoints", "references/method.md");
      expect(ref.ok).toBe(true);
      if (ref.ok) expect(ref.value.body).toBe("# 方法");

      const escape = await readSkillFile(skillsRoot, "atf-evaluate-checkpoints", "../../etc/passwd");
      expect(escape.ok).toBe(false);
      if (!escape.ok) expect(escape.error.code).toBe("skill_file_forbidden");

      const outsideSkill = await readSkillBody(skillsRoot, "../escape");
      expect(outsideSkill.ok).toBe(false);
      if (!outsideSkill.ok) expect(outsideSkill.error.code).toBe("skill_unknown");

      const missingRoot = await listSkills(join(skillsRoot, "absent"));
      expect(missingRoot.ok).toBe(false);
      if (!missingRoot.ok) expect(missingRoot.error.code).toBe("skills_root_missing");
    } finally {
      rmSync(skillsRoot, { recursive: true, force: true });
    }
  });
});
