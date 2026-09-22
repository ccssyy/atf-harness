/**
 * 前端一（自有 UI · TUI）——训练启动确认卡（批 3 §三，owner 裁决②；DDL 关键路径）。
 *
 * 触发：turn 内 atf_scratch_exec 成功执行后，harness 侧确定性检测 scratch 内出现 launch.sh
 * （G5 preview 闭合 → launch_ready_but_not_executed）；turn 收口后出卡（载体同批 2.5 确认卡
 * ——过程流多行＋输入行应答，不劫持输入）。
 *
 * 纪律：检测与摘要是 harness 侧确定性产出（launch.sh 文本解析 TRAIN_DIR → launch_manifest）；
 * IterationConfig 以字节级 sha256 对拍（对不上不给 config 字段——fail-honest）。确认后经
 * A2.5 既有 pendingAction 机制确定性合成 atf_launch_execute（模型不重生成参数），审批弹窗
 * 第二道人审不变（CAS 一次性消费）。同一启动目标（launch.sh+sha）只出一次卡（跳过后不再重弹）。
 */
import { type LaunchReady } from "../core/workspace/index.js";
import type { PendingConfirmAction } from "../core/run/runner.js";

/** 出卡去重键：同 launch.sh 且同配置 sha 只出一次。 */
export const launchCardKey = (ready: LaunchReady): string =>
  `${ready.launch_sh}|${ready.iteration_config_sha256 ?? "-"}`;

const sha12 = (sha: string | undefined): string =>
  sha !== undefined && sha.length >= 12 ? `${sha.slice(0, 12)}…` : (sha ?? "（未取得）");

/** 启动确认卡 → 过程流多行（人读中文＋计划摘要；值单源＝launch_manifest 检测产物）。 */
export const launchCardLines = (ready: LaunchReady): string[] => [
  "┌─ 确认卡 · 训练启动（G5 就绪：launch_ready_but_not_executed）",
  "│ 训练计划已在工作区就绪，等待你的放行。计划摘要：",
  `│   · 计划标识（run_id）：${ready.run_id ?? "（未取得）"}`,
  `│   · 配置指纹（iteration_config_sha256）：${sha12(ready.iteration_config_sha256)}`,
  ...(ready.global_batch !== undefined ? [`│   · 全局批量：${String(ready.global_batch)}`] : []),
  ...(ready.nnodes !== undefined ? [`│   · 节点数：${String(ready.nnodes)}`] : []),
  `│   · 启动脚本：${ready.launch_sh}`,
  `│   · 配置文件：${ready.config ?? "（未在工作区找到字节级匹配的 IterationConfig——确认后将按账本现状执行）"}`,
  "│ 确认后 harness 将：① 按配置登记训练放行记录（内核审批账本）；② 执行 launch.sh",
  "│   （其内置闸门会核对该记录；训练进程启动后日志落盘、状态可查）。",
  "│ 注意：确认即真实启动训练（长任务；再放行需再次确认）。",
  "└─ 应答（1=确认放行并启动；直接输入其他指令＝暂不启动）",
];

/** harness 译码：确认应答 → 规范化确认文本（落 user/message，模型不转写用户口语）。 */
export const launchConfirmationText = (ready: LaunchReady): string =>
  `【确认卡·训练启动】训练计划已确认放行：launch.sh=${ready.launch_sh}` +
  (ready.config !== undefined ? `，配置=${ready.config}` : "") +
  "。系统将按确认直接执行启动（先登记放行记录、再执行 launch.sh，不经模型改写）；请读执行结果并继续后续流程（评估→badcase 分析）。";

/** 确定性合成（A2.5 同构）：确认 → atf_launch_execute 派发动作（无 LLM 参与）。 */
export const synthesizeLaunchAction = (ready: LaunchReady): PendingConfirmAction => ({
  tool: "atf_launch_execute",
  params: {
    launch_sh: ready.launch_sh,
    ...(ready.config !== undefined ? { config: ready.config } : {}),
  },
  origin: "confirm_card",
});
