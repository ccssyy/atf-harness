/**
 * core/ 公开出口（L1 门 2 T01）。
 *
 * core = 三层前端共享的中间层（门 1 D1）：run 绑定 · 审批闸（账本轨/问答轨）·
 * append-only 日志（唯一跨进程凭证）· 三层工作区 T0/T1/T2 · 工具定义与 canonical ·
 * 会话/投影。能力面各自以子目录 index.ts 为公开出口，本文件只汇出投影面并钉住边界：
 *
 *   src/core/session/    会话事件 schema · append-only 日志（SessionLog）· compaction · 上下文管道
 *   src/core/tools/      工具定义 · canonical 校验 · ToolExecutor（审批闸消费点）· 审批键/凭据
 *   src/core/workspace/  三层工作区（RunWorkspace）· 晋升 · Catalog · GuardedSessionLog（铁律一）
 *   src/core/run/        run 引擎（ScenarioRunner）· 审批闸编排（approvalTrack）· resume/loop 状态
 *   src/core/projection  投影订阅面（本文件）
 *
 * 边界纪律（T01 交付判据，tests/core/boundary.test.ts 守卫）：core 不依赖任何外壳
 * （src/ui/ · src/acp/ · src/mcp/ 都是它的消费者）；core 向下可依赖 src/bridge/（内核桥接）
 * 与 src/llm/（模型面 provider 接口）。桥接契约与内核 pin 仍以 bridge.contract.yaml 为
 * 唯一真相源，本层零改动。
 */
export {
  createProjectionHub,
  type ProjectionHub,
  type ProjectionOrigin,
  type RunEventSubscriber,
} from "./projection.js";
