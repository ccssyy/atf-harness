/**
 * pi-ai 换库批（门 2）——DeepSeek 真实端点 trial 脚手架（指令 §五；裁定件 §二授权范围）。
 *
 * ⚠️ 真实付费调用。前置闸（逐项确认，任一不满足即 fail-closed 退出，不发任何请求）：
 *   ① DeepSeek 充值到账（余额 >0）——人工确认后以 ATF_TRIAL_PIAI_ACK=1 显式放行
 *     （裁定件：默认不授权；本脚本不复用任何旧授权/快照）；
 *   ② fixture 等价性五组＋全量 vitest 零回归＋fresh build（执行前须 npm run build && npm test 全绿）；
 *   ③ 本脚本启动即记录 dist 关键产物 sha256（fresh snapshot，落 trial 证据）。
 *
 * 授权范围三场景（最小链路，预计 <10 次调用；建议 off-peak 半价时段）：
 *   1. deepseek-flash 真实链路：三类决策全通＋effort=max×393216 多轮工具往返＋
 *      出站请求 reasoning_content 断言（onPayload 捕获）；
 *   2. length 场景：极小 max_tokens（ATF_TRIAL_LENGTH_MAX_TOKENS，缺省 64）构造截断 →
 *      R1 恰重试 1 次 → 收口带缺口卡（或重试后自然收束——两种终局均验 R1 有界性）；
 *   3. effort 运行时切换：setReasoningEffort(low) 后新请求 providerThinkingLevel 回显断言。
 *
 * 对端：tests/fixtures/mock_atf.mjs（本批 trial 目标＝harness↔DeepSeek 段；工具执行面用
 * mock 对端保持密闭与最小成本，与 trialL1aReal 的真实内核链无关）。
 *
 * 配置：owner 两层配置经 ATF_LLM_CONFIG；若选中 provider protocol ≠ "pi-ai"，以
 * ATF_TRIAL_PIAI_MODEL（缺省 deepseek-flash）派生 pi-ai 形态的运行时配置（不改 owner 文件）。
 * 凭据：api_key_env 解析链照旧；值不打印、不落盘（ADR-09）。
 *
 * 用法（owner 前置闸全过后）：ATF_TRIAL_PIAI_ACK=1 ATF_LLM_CONFIG=… npm run trial:piai-real
 * 退出码：三场景全过 = 0；前置闸未过/任一场景失败 = 1。
 */
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPiAiRuntimeConfig, runTrialScenarios } from "./trialPiAiShared.js";
import { loadLlmProviderConfig } from "../llm/index.js";
import { err, ok } from "../bridge/index.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const mockPath = join(repoRoot, "tests", "fixtures", "mock_atf.mjs");

function fail(message: string): never {
  console.error(`trial 前置闸未过 ✗: ${message}`);
  process.exit(1);
}

const main = async (): Promise<void> => {
  // ── 前置闸 ①：显式放行（裁定件 §二：默认不授权） ──
  if (process.env["ATF_TRIAL_PIAI_ACK"] !== "1") {
    console.error("trial 前置闸未过 ✗: 真实端点 trial 未获本次放行（前置闸清单：① DeepSeek 充值到账（余额>0）；");
    console.error("   ② §四 fixture 等价性＋全量 vitest 零回归＋fresh build；③ fresh snapshot 由本脚本启动即记录）。");
    console.error("   前置全过后以 ATF_TRIAL_PIAI_ACK=1 显式放行（不复用旧授权）。");
    process.exit(1);
  }
  const configPath = process.env["ATF_LLM_CONFIG"];
  if (configPath === undefined || configPath === "") fail("ATF_LLM_CONFIG 未设置（owner 两层配置，0600）");

  // ── 前置闸 ③：fresh snapshot（关键产物 sha256 记录进 trial 证据） ──
  const evidence: string[] = [];
  for (const rel of ["dist/llm/piAiProvider.js", "dist/core/run/runner.js", "dist/core/run/providerSwitch.js", "dist/run/trialPiAiReal.js"]) {
    const bytes = await readFile(join(repoRoot, rel));
    evidence.push(`snapshot ${rel} sha256=${createHash("sha256").update(bytes).digest("hex")}`);
  }

  // ── 配置（派生 pi-ai 形态；不改 owner 文件） ──
  const derived = await createPiAiRuntimeConfig(process.env, async (env) => {
    const loaded = await loadLlmProviderConfig(env);
    return loaded.ok ? ok(loaded.value) : err(loaded.error.message);
  });
  if (!derived.ok) fail(derived.error);
  evidence.push(`配置 provider=${derived.value.provider_id}（派生 protocol=pi-ai）model=${derived.value.model} reasoning_effort=${derived.value.reasoning_effort} max_tokens=${String(derived.value.max_tokens)}（凭据值不落任何输出）`);

  const result = await runTrialScenarios({
    repoRoot,
    mockPath,
    config: derived.value,
    lengthMaxTokens: Number(process.env["ATF_TRIAL_LENGTH_MAX_TOKENS"] ?? 64),
    runSuffix: randomUUID().slice(0, 8),
    log: (line) => {
      evidence.push(line);
      console.log(`  - ${line}`);
    },
  });
  if (!result.ok) {
    console.error(`trial 场景失败 ✗: ${result.error}`);
    console.error(evidence.join("\n"));
    process.exit(1);
  }
  console.log("pi-ai 换库批真实端点 trial 通过 ✓（三场景：真实链路往返／length R1／档位切换）");
  for (const line of evidence) console.log(`  - ${line}`);
};

main().catch((cause: unknown) => {
  console.error(cause);
  process.exit(1);
});
