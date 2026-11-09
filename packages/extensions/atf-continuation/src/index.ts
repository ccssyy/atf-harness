/**
 * D250 输出截断自动续写扩展——dsh web 编排层插件。
 *
 * 背景（台账 D250）：dsh 对 max-tokens 停轮的处理是 sticky 停轮+UI 提示手动
 * 发「继续」（上游 0.2.2-rc.1 仍无自动续写）；GLM 平台输出配额 131072 下
 * High 档长思考高频触发，长任务链每次撞顶都要人工兜底。本扩展在 harness
 * 编排层补自动续写（zcode 方案移植，owner 2026-11-09 裁定），vendor 零改动。
 *
 * 装载：cordis.patch.template.yml insert 行 + node_modules/@atf 符号链接
 * （与 atf-tools 同款手工链接先例——TSX 模块解析沿目录树向上找到仓根
 * node_modules）。任务书 docs/agents/task-briefs/20261109-d250-output-continuation.md。
 */

import z from "@deepseek-ai/schemastery";
import {
  makeContinuationCoordinator,
  type ContinuationAgent,
} from "./coordinator.js";

/** Cordis 插件名（loader 诊断用）。 */
export const name = "atf-continuation";

/** 无 dsh service 依赖：全走 ctx 运行期属性（agents 注册表）。 */
export const inject: string[] = [];

export interface AtfContinuationConfig {
  /** 每会话续写预算上限（zcode/Codex 公约数 3）。 */
  maxContinuations: number;
}

export const Config = z.object({
  maxContinuations: z.number().step(1).min(1).max(10).default(3),
});

export function apply(ctx: any, config: AtfContinuationConfig): void {
  // agents 注册表：dsh AgentLoop 服务（服务键 agents），agent.id === sessionId
  // （agent.ts:124 readonly id: SessionId）。get 返回 undefined = 该会话 agent
  // 已释放（已关会话不续写）。
  const deps = {
    max: config.maxContinuations,
    getAgent(sessionId: string): ContinuationAgent | undefined {
      return ctx.agents?.get(sessionId);
    },
  };
  const coordinator = makeContinuationCoordinator(deps);
  ctx.on("session/event", (session: any, event: any) => {
    try {
      coordinator.onSessionEvent(session, event);
    } catch (error) {
      console.warn(`[atf-continuation] 事件处理异常（不中断会话）: ${String(error)}`);
    }
  });
  ctx.on("session/disposed", (session: any) => {
    try {
      coordinator.onSessionDisposed(session);
    } catch {
      // 清理失败无治理影响，静默。
    }
  });
  console.log(
    `[atf-continuation] 已装配——max-tokens turn-end 自动续写（预算 ${config.maxContinuations} 次/会话）`,
  );
}
