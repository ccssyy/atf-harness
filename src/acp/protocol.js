/**
 * 前端二（ACP agent 外壳）——协议面（L1 门 2 T04；《ATF独立Harness_L1门2任务书_20260915.md》§2.3）。
 *
 * ★轴三归属单一文件：ACP 协议版本（ACP_PROTOCOL_VERSION）只在本文件定义——与轴一
 * （会话协议版本，session.contract.yaml）、轴二（桥接契约版本，bridge.contract.yaml）
 * 三轴各自归属单一文件（re-pin 事故防呆口径）。
 *
 * D8（手写）：以下线缆类型为本仓手写本地类型（转写自 ACP v1 官方规范 + acpx@0.15.1
 * 事实底稿，见 docs/_owner/ATF独立Harness_acpx客户端核实_20260915.md），**不引任何
 * SDK**——类型仅编译期使用（import type 擦除），线缆面为纯 JSON。v1 只转写本批实际
 * 使用的方法面；未使用面（fs/*、terminal/*、elicitation/*、authenticate、session/
 * set_mode 等）不声明（D7 能力面代理禁用的镜像纪律）。
 */
/** ★轴三：ACP 协议版本（v1 稳定；本批恒以 1 应答，客户端请求更高版本亦回 1——
 *  我方只讲 v1，协商结果由客户端裁决是否继续）。 */
export const ACP_PROTOCOL_VERSION = 1;
/** agent 标识（initialize 应答；_meta 内亦以此登记 provider 线索）。 */
export const ACP_AGENT_NAME = "atf-harness-acp";
export const ACP_AGENT_TITLE = "ATF Harness（ACP 配件外壳）";
/** 方法名（官方原文方法名，v1 使用面）。 */
export const ACP_METHODS = {
    initialize: "initialize",
    sessionNew: "session/new",
    sessionPrompt: "session/prompt",
    sessionLoad: "session/load",
    sessionCancel: "session/cancel",
    sessionUpdate: "session/update",
    sessionRequestPermission: "session/request_permission",
};
