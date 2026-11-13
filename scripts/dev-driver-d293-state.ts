/**
 * D293 state 深查驱动：复刻 runChildSubtask 内部（assembleV1Agent+prompt(images)），
 * 打印 agent.state.messages 全量——看真模型对「图+工单指令」到底回了什么。
 * 用法: tsx scripts/dev-driver-d293-state.ts <workspace_root> <source_root> <workorders_path>
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { runChildSubtask, type SubagentDeps } from "../src/agent/subagent.js";
import { assembleV1Agent } from "../src/agent/cli.js";
import { createJsonlSessionRepo } from "../src/agent/sessionMirror.js";
import { ensureTemBranch } from "../src/agent/tem/store.js";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";

const [workspaceRoot, sourceRoot, workordersPath] = process.argv.slice(2);

// —— 复刻 plugin 的模型面（真 provider）——
const cfg = JSON.parse(readFileSync(process.env.ATF_LLM_CONFIG ?? "", "utf8")) as {
  default_provider: string; default_model: string;
  providers: Record<string, { base_url: string; api_key_env: string }>;
};
const p = cfg.providers[cfg.default_provider];
console.log("[v2] provider:", cfg.default_provider, cfg.default_model, p.base_url);

const { createProviderStreamFn } = await import("../src/agent/providerStreamFn.js");
const assembledProvider = createProviderStreamFn({
  provider_id: cfg.default_provider,
  model: cfg.default_model,
  base_url: p.base_url,
  api_key: process.env[p.api_key_env] ?? "",
});

// —— 复刻工单 loader（与 plugin 同逻辑）——
const doc = JSON.parse(readFileSync(workordersPath, "utf8")) as {
  doc_type: string;
  workorders: Array<{ label: string; pages: string[]; instruction: string }>;
};
const wave = doc.workorders[0];
const docDir = join(sourceRoot, doc.doc_type);
const images = wave.pages.map((page) => {
  const stem = page.endsWith(".json") ? page.slice(0, -".json".length) : page;
  const hit = readdirSync(docDir).find((name) => {
    const candidate = name === stem ? name : name.startsWith(stem + ".") ? name : null;
    if (candidate === null) return false;
    const ext = candidate.slice(candidate.lastIndexOf(".") + 1).toLowerCase();
    return ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "webp";
  });
  if (!hit) throw new Error(`页图定位失败: ${page}`);
  const f = join(docDir, hit);
  const ext = f.slice(f.lastIndexOf(".") + 1).toLowerCase();
  return { type: "image", data: readFileSync(f).toString("base64"), mimeType: ext === "png" ? "image/png" : "image/jpeg" };
});
console.log("[v2] 片:", wave.label, "| pages:", wave.pages.join(","), "| images:", images.length, "| instruction len:", wave.instruction.length);

// —— 复刻 runChildSubtask 内部 ——
const bridgeStub = { request: async () => ({ ok: true as const, value: {} }) };
const repo = createJsonlSessionRepo(mkdtempSync(join(tmpdir(), "d293-state-")));
import { mkdirSync } from "node:fs";
const stateRoot = join(tmpdir(), "d293-state");
mkdirSync(stateRoot, { recursive: true });
const childSessionRoot = mkdtempSync(join(stateRoot, "dispatch-"));
const childSession = await repo.create({ cwd: childSessionRoot } as never, BACKGROUND_CONTEXT);
await ensureTemBranch(childSession as never);
const assembled = assembleV1Agent({
  bridge: bridgeStub as never,
  session: childSession as never,
  maxTurns: 8,
  streamFn: assembledProvider.streamFn as never,
  modelTag: cfg.default_model,
  model: assembledProvider.model,
  approval: { kind: "headless" },
  steeringMode: "all",
  followUpMode: "all",
  contextTokens: 200_000,
} as never);
console.log("[v2] prompt 中…");
await assembled.agent.prompt(wave.instruction, images as never);
console.log("[v2] === state.messages ===");
for (const m of assembled.agent.state.messages as Array<Record<string, unknown>>) {
  const role = m.role;
  const content = m.content;
  if (Array.isArray(content)) {
    for (const b of content as Array<Record<string, unknown>>) {
      const bt = b.type;
      if (bt === "text") console.log(role, "TEXT:", String(b.text).slice(0, 300));
      else if (bt === "toolCall") console.log(role, "TOOLCALL:", b.name);
      else if (bt === "thinking") console.log(role, "THINKING len:", String(b.thinking ?? "").length);
      else console.log(role, "BLOCK:", bt);
    }
  } else {
    console.log(role, "RAW:", String(content).slice(0, 150), "| images:", Array.isArray(m.images) ? m.images.length : 0);
  }
}
console.log("[v2] stopReason:", JSON.stringify(assembled.agent.state.stopReason ?? assembled.agent.state.status ?? "n/a").slice(0, 200));
process.exit(0);
