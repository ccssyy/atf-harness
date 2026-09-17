/**
 * L1 门 2 T06 冒烟——smoke:l1mcp（前端三 MCP server 外壳全链；
 * 《ATF独立Harness_L1门2任务书_20260915.md》§4 VERIFY 8/9 自动化承载）。
 *
 * 链路：spawn dist/mcp/main.js（本进程 stdio 即 MCP 客户端；WorkBuddy 对端试验经
 * SSH stdio 桥、按 owner 授权在 A800 侧执行——本冒烟固化协议与治理语义）→
 * initialize → tools/list（恰 7 工具）→ 只读链（bind_run→workspace_status→fact_scan，
 * 零审批（B7 N1：gate query 亦免审批）→ 写治理链（admit_data：白名单＋问答轨 mcp 通道留痕放行）
 * → 账本工具直通（query 可用；consume 无记录 → 业务拒绝 exit 1）→ 未知工具 -32602。
 * 断言：D4 留痕（channel=mcp/host_id/requires_human_review）＋审计流逐对配对＋
 * 退出码进 tool result。
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/** 最小 MCP 客户端桩（JSON-RPC 2.0 over stdio；规范嵌套/扁平应答两形态兼容）。 */
class McpClient {
  private buffer = "";
  private readonly pending = new Map<number, (message: Record<string, unknown>) => void>();
  private nextId = 1;

  public constructor(private readonly child: ReturnType<typeof spawn>) {
    child.stdout?.on("data", (chunk: Buffer | string) => {
      this.buffer += String(chunk);
      for (;;) {
        const index = this.buffer.indexOf("\n");
        if (index === -1) break;
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        if (line === "") continue;
        const message = JSON.parse(line) as Record<string, unknown>;
        const id = message["id"];
        if (id !== undefined && this.pending.has(id as number)) {
          const resolve = this.pending.get(id as number) as (message: Record<string, unknown>) => void;
          this.pending.delete(id as number);
          resolve(message);
        }
      }
    });
  }

  public request(method: string, params: unknown, timeoutMs = 30_000): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP 请求超时: ${method}`));
      }, timeoutMs);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      this.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  public notify(method: string, params: unknown): void {
    this.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  /** tools/call 便捷面：断言协议成功并解析 tool result。 */
  public async callTool(name: string, args: Record<string, unknown> = {}): Promise<{ body: Record<string, unknown>; isError: boolean }> {
    const message = await this.request("tools/call", { name, arguments: args });
    if (message["error"] !== undefined) {
      throw new Error(`tools/call(${name}) 协议错误: ${JSON.stringify(message["error"])}`);
    }
    const result = message["result"] as { content: Array<{ type: string; text: string }>; isError?: boolean };
    return { body: JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>, isError: result.isError === true };
  }
}

const HOST_ID = "workbuddy-l1mcp-smoke";
const RUN_ID = "mcp-l1smoke-run";

const smoke = async (): Promise<string[]> => {
  const evidence: string[] = [];
  const workDir = join(tmpdir(), `l1mcp-smoke-${randomUUID()}`);
  const runsRoot = join(workDir, "runs");
  await mkdir(runsRoot, { recursive: true });

  const preauthPath = join(workDir, "mcp-preauth.json"); // B1：先不存在（阶段 A 默认拒绝），后写入（阶段 B 放行）
  const child = spawn(process.execPath, [join(repoRoot, "dist", "mcp", "main.js"), "--runs-root", runsRoot, "--preauth", preauthPath], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderrText = "";
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderrText += String(chunk);
  });
  const client = new McpClient(child);
  try {
    // ① 握手：initialize 版本轴命中回显 + notifications/initialized
    const init = await client.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: HOST_ID, version: "0.0.1" },
    });
    const initResult = init["result"] as Record<string, unknown>;
    if (initResult["protocolVersion"] !== "2025-03-26") throw new Error("initialize 版本回显失败");
    client.notify("notifications/initialized", {});
    evidence.push("握手: initialize 版本回显 2025-03-26 + notifications/initialized（host_id=clientInfo.name）");

    // ② tools/list：恰 7 细粒度工具（D11）
    const listed = await client.request("tools/list", {});
    const tools = (listed["result"] as { tools: Array<{ name: string }> }).tools;
    const names = tools.map((tool) => tool.name);
    if (JSON.stringify(names) !== JSON.stringify(["atf_bind_run", "atf_workspace_status", "atf_fact_scan", "atf_gate", "atf_admit_data", "ledger_query", "ledger_consume"])) {
      throw new Error(`tools/list 非 7 工具: ${JSON.stringify(names)}`);
    }
    evidence.push(`tools/list: 恰 7 细粒度工具（${names.join("/")}）——VERIFY 8 工具面可见`);

    // ③ 绑定界：未绑定 isError（exit 1 编码）；bind 成功；重复绑定拒绝
    const early = await client.callTool("atf_workspace_status");
    if (!early.isError || early.body["exit_code"] !== 1 || !(early.body["reason"] as string).includes("未绑定")) {
      throw new Error("未绑定调用未被 isError/exit 1 拦截");
    }
    const bound = await client.callTool("atf_bind_run", { run_id: RUN_ID });
    if (bound.isError || bound.body["exit_code"] !== 0) throw new Error(`atf_bind_run 失败: ${JSON.stringify(bound.body)}`);
    const again = await client.callTool("atf_bind_run", { run_id: "other-run" });
    if (!again.isError) throw new Error("重复绑定未被拒绝（v1 一进程一绑定）");
    evidence.push("绑定界: 未绑定 isError(exit 1) → bind 成功 → 重复绑定拒绝（会话以 atf_bind_run 为界）");

    // ④ 只读链（VERIFY 8）：零审批直执行
    const status = await client.callTool("atf_workspace_status");
    if (status.isError || (status.body["result"] as Record<string, unknown>)["run_id"] !== RUN_ID) throw new Error("workspace_status 失败");
    const scan = await client.callTool("atf_fact_scan");
    if (scan.isError) throw new Error("fact_scan 失败");
    evidence.push("只读链: workspace_status / fact_scan 免审批直执行，canonical 返回正常（exit 0）");

    // ⑤-B1 阶段 A：白名单外（配置文件未建＝空白名单）→ 默认拒绝三段式，无审批链
    const refused = await client.callTool("atf_admit_data", { dataset_id: "ds-l1mcp" });
    if (!refused.isError || refused.body["reason"] !== "mcp_write_not_preauthorized") {
      throw new Error(`B1 阶段 A：白名单外 admit 未被默认拒绝: ${JSON.stringify(refused.body)}`);
    }
    const refusalDetail = refused.body["detail"] as string;
    if (!refusalDetail.includes("①写动作被默认拒绝（未执行）") || !refusalDetail.includes("②原因") || !refusalDetail.includes("③修复：在")) {
      throw new Error(`B1 三段式拒绝文案不完整: ${refusalDetail}`);
    }
    evidence.push("B1 阶段 A: 白名单外 admit 默认拒绝（三段式文案；不进 ToolExecutor、无 approval/request）");

    // ⑤-B1 阶段 B：写入预授权配置（server 每次 tools/call 重新读取，无需重启）→ 放行留痕
    await writeFile(preauthPath, JSON.stringify({ schema_version: "McpPreauth/v1", hosts: [{ host_id: HOST_ID, tools: ["atf_admit_data", "atf_gate"] }] }), { mode: 0o600 });
    await chmod(preauthPath, 0o600);
    evidence.push("B1 阶段 B: 预授权配置热生效（hosts 增 workbuddy-l1mcp-smoke；0600）");

    // ⑤ 写治理链（VERIFY 9；B7 N1：gate query 免审批自主执行，advance 才须审批）：
    // admit_data 白名单内 → 问答轨 mcp 通道留痕放行 → 真执行
    const gate = await client.callTool("atf_gate", { gate: "g1", action: "query" });
    if (gate.isError || gate.body["exit_code"] !== 0) throw new Error(`gate(query) 失败: ${JSON.stringify(gate.body)}`);
    const admit = await client.callTool("atf_admit_data", { dataset_id: "ds-l1mcp" });
    if (admit.isError || admit.body["exit_code"] !== 0) throw new Error(`atf_admit_data 失败: ${JSON.stringify(admit.body)}`);
    const admitResult = admit.body["result"] as Record<string, unknown>;
    if (admitResult["journal_type"] !== "dataset-registry" || admitResult["sha256_digest"] === undefined) {
      throw new Error("admit canonical 形态不符");
    }
    evidence.push("写治理链: gate(query) 免审批自主执行（B7 N1）；admit_data 经问答轨授权放行，canonical 三元组落定（exit 0）");

    // ⑥ 账本工具直通：query 可用；consume 无记录 → 业务拒绝 exit 1（一次性语义在对端强制）
    const query = await client.callTool("ledger_query", {
      scope_ref: { project_id: "agentic-training-flow", scope_type: "run", scope_id: RUN_ID, scope_mode: "canonical" },
    });
    if (query.isError || !Array.isArray((query.body["result"] as { records: unknown[] }).records)) throw new Error("ledger_query 失败");
    const consume = await client.callTool("ledger_consume", { approval_ref: "nonexistent", record_id: "nonexistent" });
    if (!consume.isError || consume.body["exit_code"] !== 1) throw new Error("ledger_consume 业务拒绝未被编码为 exit 1");
    evidence.push("账本直通: ledger_query canonical 正常；ledger_consume 无记录 → 业务拒绝 exit 1（对端一次性语义）");

    // ⑦ 未知工具 → 协议错误 -32602（D11 闭集）
    const unknown = await client.request("tools/call", { name: "atf_run_prompt", arguments: {} });
    const unknownError = unknown["error"] as { code?: number } | undefined;
    if (unknownError?.code !== -32602) throw new Error("未知工具未被 -32602 拒绝");
    evidence.push("D11 闭集: 未列入的工具 → -32602（无整流程工具增补）");

    // ⑧ 落盘审计流：D4 留痕 + tool/call↔tool/result 逐对配对
    const streamText = await readFile(join(runsRoot, RUN_ID, "session.jsonl"), "utf8");
    const lines = streamText.split("\n").filter((line) => line !== "");
    const responses = lines.filter((line) => line.includes('"type":"approval/response"')).map((line) => JSON.parse(line) as { id: number; payload: Record<string, unknown> });
    if (responses.length !== 1) throw new Error(`approval/response 数量不符: ${String(responses.length)} ≠ 1（B7 N1：仅 admit 走问答轨）`);
    for (const response of responses) {
      if (response.payload["channel"] !== "mcp" || response.payload["host_id"] !== HOST_ID || response.payload["requires_human_review"] !== true || response.payload["verdict"] !== "granted") {
        throw new Error(`D4 留痕不完整: ${JSON.stringify(response.payload)}`);
      }
    }
    // B1：写类（admit）审批应答带 pre_authorization:true；非写类（gate query）不带
    const toolOfResponse = (response: { id: number; payload: Record<string, unknown> }): string | null => {
      const request = lines.map((line) => JSON.parse(line) as { id: number; type: string; payload: { request_event_ref?: number; tool?: string } }).find((event) => event.type === "approval/request" && event.id === response.payload["request_event_ref"]);
      return request?.payload.tool ?? null;
    };
    const admitResponse = responses.find((response) => toolOfResponse(response) === "atf_admit_data");
    if (admitResponse === undefined || admitResponse.payload["pre_authorization"] !== true) {
      throw new Error("B1 留痕缺失: admit 应答无 pre_authorization:true");
    }
    // B7 N1：gate(query) 免审批——流内无 gate 的 approval/response（越界留痕面消失）
    const calls = lines.filter((line) => line.includes('"type":"tool/call"'));
    const results = lines.filter((line) => line.includes('"type":"tool/result"'));
    if (calls.length !== results.length) throw new Error(`审计流不配对: call=${String(calls.length)} result=${String(results.length)}`);
    evidence.push(`落盘审计: approval/response×${String(responses.length)}（仅 admit，写类）全带 channel=mcp/host_id/requires_human_review/pre_authorization；tool/call↔tool/result ${String(calls.length)} 对逐配对`);

    // ⑨ 脱敏冒烟自检：stderr 与流内无敏感痕迹（本壳零凭据路径）
    if ((stderrText + streamText).includes("api_key")) throw new Error("脱敏违例：输出出现凭据字样");
    evidence.push("脱敏: server 零凭据路径（无 provider 配置依赖），输出/流内无凭据痕迹");

    // 收口：关闭 stdin → server 进程退出
    child.stdin?.end();
    await new Promise((resolve) => child.on("close", resolve));

    return evidence;
  } finally {
    child.kill();
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
};

try {
  const evidence = await smoke();
  console.log("L1 MCP 冒烟（smoke:l1mcp）通过 ✓");
  for (const line of evidence) console.log(`  - ${line}`);
} catch (cause) {
  console.error(`✗ smoke:l1mcp 失败: ${(cause as Error).message}`);
  process.exitCode = 1;
}
