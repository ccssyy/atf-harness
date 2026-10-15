// 批㊶-S4b-T4b 六步冒烟·按内容路由的本地端点（真 HTTP 回环·openai-completions SSE wire）。
// 路由：user 含「开始执行」→ tool_call(atf_launch_execute)；含 tool 结果 → final(S4B_SMOKE_DONE)；
// 其余（会话标题生成旁路）→ padding 文本——顺序脚本被标题旁路吃项的教训固化（S4b T4 实证）。
// 用法：node s4b_router_driver.mjs  →  stdout 输出 PORT=<port>
import { createServer } from "node:http";
import { piAiSseTextReply, piAiSseToolCallsReply } from "/data/sam/ATF-Harness/dist/llm/scriptedPiAiEndpoint.js";
const MODEL = "s4b-smoke";
const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    let body = null;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* ignore */ }
    const msgs = Array.isArray(body?.messages) ? body.messages : [];
    const hasTool = msgs.some((m) => m.role === "tool" || m.role === "function");
    const userText = msgs.filter((m) => m.role === "user").map((m) => String(m.content ?? "")).join(" ");
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    if (hasTool) {
      console.error("[router] tool 结果回合 → final");
      res.end(piAiSseTextReply(MODEL, "S4B_SMOKE_DONE：atf_launch_execute 已返回，结果含 queued_hit。"));
    } else if (userText.includes("开始执行")) {
      console.error("[router] 主链回合 → tool_call(atf_launch_execute)");
      res.end(piAiSseToolCallsReply(MODEL, [{ id: "call_0", tool: "atf_launch_execute", args: JSON.stringify({ launch_sh: "out/launch.sh" }) }]));
    } else {
      console.error("[router] 旁路回合（标题生成等）→ padding");
      res.end(piAiSseTextReply(MODEL, "padding"));
    }
  });
});
const wantPort = Number(process.argv[2] ?? 0);
server.listen(wantPort, "127.0.0.1", () => {
  const port = server.address().port;
  console.log("PORT=" + String(port));
  console.error("[router] 已监听 " + String(port));
});
