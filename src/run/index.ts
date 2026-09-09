/**
 * S5 run 层公开出口。冒烟命令与测试只从这里 import。
 */
export { SurfaceScanResolver, type SurfaceScanTransport } from "./surfaceScanResolver.js";
export {
  ScenarioRunner,
  evaluateExpectations,
  resolveRunExitCode,
  runError,
  type BranchOutcome,
  type BranchRunReport,
  type RunBranchOptions,
  type RunError,
  type RunErrorCode,
  type ToolResultPayload,
} from "./runner.js";
