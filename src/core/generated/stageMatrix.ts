// 自动生成(D318 M2 段×参数矩阵 codegen)——内核 stage_registry 唯一源,请勿手改;
// 重生成: npm run codegen:stage-matrix (源=ATF_KERNEL_SOURCE stage_registry)
// SOURCE_ROOT_ARGV_STAGES 手写形态退役(D317b 时代两仓各持一份的断裂温床根治)。
export interface StageMatrixDoc { source_root_explicit: readonly string[]; source_root_recoverable: readonly string[]; base_model_explicit: readonly string[]; }
export const STAGE_MATRIX: StageMatrixDoc = {"source_root_explicit":["contract","ingest","inspect","register"],"source_root_recoverable":["label_qc","style_split","family_split","candidate_build","publish"],"base_model_explicit":["training_prep"]};
export const SOURCE_ROOT_ARGV_STAGES: ReadonlySet<string> = new Set(STAGE_MATRIX.source_root_explicit);
export const SOURCE_ROOT_RECOVERABLE_STAGES: ReadonlySet<string> = new Set(STAGE_MATRIX.source_root_recoverable);
