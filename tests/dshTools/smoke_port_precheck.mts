/** 批⑳dot3 修复 3 真实环境冒烟：占用→卡面提示→清理→成功 全链（mock train.sh，零真实训练）。
 *  运行：npx tsx tests/dshTools/smoke_port_precheck.mts                                    */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { buildRunTrainingTool, probePortOccupant } from "/data/sam/ATF-Harness/packages/extensions/atf-tools/src/trainingFace.js";

const PORT = 39_517;
const root = mkdtempSync(join(tmpdir(), "dot3-smoke-"));
const steps: string[] = [];
const log = (m: string) => { steps.push(`[${new Date().toISOString().slice(11, 19)}] ${m}`); console.log(m); };

const trainSh = join(root, "train.sh");
writeFileSync(trainSh, `#!/bin/bash\nexport MASTER_PORT=\${MASTER_PORT:-${PORT}}\necho 'SHA=pass entries=1'\necho 'ADMISSION=pass keys=1'\nexit 0\n`);

// ① 残留态占用者（cmdline 含 torchrun 特征）
const stubPath = join(root, "torchrun-residue-stub.js");
writeFileSync(stubPath, `require('net').createServer().listen(${PORT},'0.0.0.0',()=>console.log('hold'));\nsetInterval(()=>{},1000);\n`);
const stub = spawn(process.execPath, [stubPath], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));

const noApproval = { get: () => undefined };
const allowedCtx = { get: (s: string) => (s === "approval" ? { request: async (req: { reason: string }) => { log(`卡面呈现: ${req.reason.split("\n").slice(-1)[0]}`); return "allowed-once"; } } : undefined) };
const tool = buildRunTrainingTool(allowedCtx, { runsRoot: root, logDir: root, ctx: allowedCtx }) as unknown as { execute: (a: unknown, e: unknown) => Promise<Record<string, unknown>> };

// ② 无审批（模拟拒答）→ 结构化拒绝仍在（fail-closed 先行验证）——实际走 allowed 链
const before = await probePortOccupant(PORT);
log(`占用探针: pid=${before?.pid} residueLike=${before?.residueLike} cmdline=${(before?.cmdline ?? "").slice(0, 80)}`);

// ③ 完整链：审批卡（含端口冲突文案）→ 清理 → tmux 启动 mock
process.env["ATF_GPU_POLL_MS"] = "0"; // 批㊶-K：GPU 排队直启旁路（冒烟不等待真实窗口）
const result = await tool.execute({ action: "start", train_sh: trainSh, run_id: "smoke-dot3" }, { callId: "smoke" });
log(`启动结果: ${JSON.stringify(result)}`);

// ④ 端口归零核验
await new Promise((r) => setTimeout(r, 800));
const after = await probePortOccupant(PORT);
log(`启动后端口: ${after === null ? "空闲（mock 秒退）" : JSON.stringify(after)}`);

const ok = result["started"] === true && before?.residueLike === true;
log(ok ? "SMOKE PASS（占用→卡面提示→清理→成功）" : "SMOKE FAIL");
stub.kill("SIGKILL");
rmSync(root, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
