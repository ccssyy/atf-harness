// 批甲-FIX T3——GLM coding 端点真调用实测（owner 已授权：仅本批冒烟·最小请求）。
//
// 指令件：ATF_指令_批甲-FIX_思考档位按模型能力修正_20261015.md（sha256 前缀 37d57012）。
// 实测项：flash／flashx 的 low/high/max 各一拍验证档位生效（回复时间/思考 token 差如实记录）；
// 送 off 验证「thinking 不可关闭」语义（flashx 无 off 档——端点行为如实记录，不造行为）；
// glm-5.3 一拍 sanity（四值模型，off/开对照官方文档面）。
// wire 形态＝pi-ai zai thinkingFormat 原文复刻（dist/api/openai-completions.js）：
//   档位 on  → thinking: {type:"enabled", clear_thinking:false} + reasoning_effort:<档位>
//   off      → thinking: {type:"disabled"}（dsh llm-pi-ai adapter 把 off 映射为不送 effort——
//              "off＝不送思考参数" 的 zai 语义位）
// key：隔离根 glm-key.env（仓根，gitignored 0600）；结果落 docs/_owner 报告证据节。
//
// 用法：node tests/dshUi/smoke_effort_real_call.mjs
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = "/data/sam/ATF-Harness";
const ENDPOINT = "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions";
const QUESTION = "9.8 和 9.11 哪个大？只回答结论，不要解释。";

let key = "";
for (const line of readFileSync(join(REPO, "glm-key.env"), "utf8").split("\n")) {
  const m = /^ATF_LLM_KEY_GLM=(.*)\s*$/.exec(line.trim());
  if (m) key = m[1].replace(/^["']|["']$/g, "");
}
if (key === "") { console.error("FAIL: glm-key.env 无 ATF_LLM_KEY_GLM"); process.exit(1); }

/** 一拍实测：非流式最小请求；返回 {ok, elapsedMs, http, reason, content, reasoningTokens, completionTokens}。 */
async function beat(model, tier) {
  const body = {
    model,
    messages: [{ role: "user", content: QUESTION }],
    max_tokens: 2048,
    stream: false,
    // zai wire 复刻（off＝disabled 不送 effort；其余 enabled＋reasoning_effort）
    thinking: tier === "off" ? { type: "disabled" } : { type: "enabled", clear_thinking: false },
    ...(tier === "off" ? {} : { reasoning_effort: tier }),
  };
  const t0 = Date.now();
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });
    const elapsedMs = Date.now() - t0;
    const text = await res.text();
    if (!res.ok) return { ok: false, elapsedMs, http: res.status, reason: text.slice(0, 300) };
    const data = JSON.parse(text);
    const choice = data.choices?.[0]?.message ?? {};
    const details = data.usage?.completion_tokens_details ?? {};
    return {
      ok: true,
      elapsedMs,
      http: res.status,
      content: String(choice.content ?? "").slice(0, 120),
      reasoningTokens: details.reasoning_tokens ?? null,
      completionTokens: data.usage?.completion_tokens ?? null,
    };
  } catch (cause) {
    return { ok: false, elapsedMs: Date.now() - t0, http: null, reason: String(cause).slice(0, 200) };
  }
}

const MATRIX = [
  ["glm-5.3-flash", "low"], ["glm-5.3-flash", "high"], ["glm-5.3-flash", "max"], ["glm-5.3-flash", "off"],
  ["glm-5.3-flashx", "low"], ["glm-5.3-flashx", "high"], ["glm-5.3-flashx", "max"], ["glm-5.3-flashx", "off"],
  ["glm-5.3", "low"],
];

const rows = [];
for (const [model, tier] of MATRIX) {
  const r = await beat(model, tier);
  rows.push({ model, tier, ...r });
  console.log(
    `${r.ok ? "BEAT" : "ERR "} ${model} ${tier.padEnd(4)} ${r.elapsedMs}ms http=${r.http}` +
    (r.ok ? ` reason_tok=${r.reasoningTokens} completion_tok=${r.completionTokens} answer=${JSON.stringify(r.content)}` : ` reason=${r.reason?.slice(0, 160)}`),
  );
}

console.log("\n=== 汇总（模型/档位/耗时ms/思考token/完成token/结论） ===");
for (const r of rows) {
  console.log([r.model, r.tier, r.ok ? r.elapsedMs : `HTTP${r.http}`, r.reasoningTokens ?? "—", r.completionTokens ?? "—", r.ok ? "ok" : "err"].join(" | "));
}
const hardFail = rows.filter((r) => !r.ok && !(r.model === "glm-5.3-flashx" && r.tier === "off"));
console.log(hardFail.length === 0 ? "\nPROBE DONE（全部拍可达；off 语义以实测行为为准）" : `\nFAILURES: ${hardFail.map((r) => `${r.model}/${r.tier}`).join(", ")}`);
process.exit(0);
