/**
 * 批㊶Q增补三 段1——放行账本单源收口（偿还 10-08 在册债：cr_r2 三连败实锚）。
 *
 * 双轴根因（本批实证）：写入方＝内核 generate_train_launch.py --record-training-release
 * 经受控执行宿主（home=execHome 轴）落账本；检查器＝train.sh 在 tmux 会话内解析
 * ${ATF_APPROVAL_LEDGER:-$HOME/...}（tmux 服务端 env 不随客户端新变量传播——旧服务端
 * HOME 为另一轴）→ 写读分轴。收口三件：
 *   ① 实例 env 统一注入 ATF_APPROVAL_LEDGER 绝对路径（deploy/instances/*.env——写入方
 *      经 scratchExec ATF_* 白名单自动透传；检查器经 trainingFace tmux 命令显式前缀注入）；
 *   ② 启动校验（本模块）：env 与进程 $HOME 推导不一致 → 启动即告警（日志明示两路径，
 *      杜绝静默分轴）；env 显式配置而目录不可写 → fail-fast（atf-tools apply 抛错拒绝启动）；
 *   ③ train.sh 生成面审计注释（appendLedgerAuditComment）：harness 启动前把生效路径写入
 *      脚本注释（幂等），便于事后审计；内核生成器闭集零触碰（`${ATF_APPROVAL_LEDGER:-...}`
 *      语义原样保留）。
 */
import { accessSync, appendFileSync, constants, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const LEDGER_ENV = "ATF_APPROVAL_LEDGER";

/** $HOME 推导路径（train.sh 检查器同款缺省式：$HOME/.atf/approval-ledger/training-release.jsonl）。 */
export const homeLedgerPathOf = (home: string): string => join(home, ".atf", "approval-ledger", "training-release.jsonl");

export interface ApprovalLedgerStartupCheck {
  /** env 显式值（缺席 null＝回退 $HOME 推导位）。 */
  envPath: string | null;
  /** 进程 $HOME 推导路径（告警对照面）。 */
  homePath: string;
  /** 生效路径（env ?? $HOME 推导）——写入方与检查器须同源的唯一真相。 */
  effectivePath: string;
  /** 生效路径所在目录可写（env 显式配置时含 mkdir 供给＋W_OK；回退位不建不阻塞恒 true）。 */
  dirWritable: boolean;
  /** env 与 $HOME 推导不一致（静默分轴风险——启动即告警）。 */
  mismatch: boolean;
  /** 人读一行（不一致时明示两路径）。 */
  message: string;
}

/** 路径规整（尾斜杠剥离——比对语义等价）。 */
const normalizePath = (p: string): string => p.replace(/\/+$/, "");

/** 启动校验（纯推导＋至多一次 mkdir/access；不抛错——裁决归调用方）。 */
export const checkApprovalLedgerStartup = (env: Readonly<Record<string, string | undefined>>): ApprovalLedgerStartupCheck => {
  const rawEnv = env[LEDGER_ENV];
  const envSet = typeof rawEnv === "string" && rawEnv.trim() !== "";
  const envPath = envSet ? (rawEnv as string).trim() : null;
  const homePath = homeLedgerPathOf(env["HOME"] ?? "");
  const effectivePath = envPath ?? homePath;
  let dirWritable = true;
  if (envSet) {
    try {
      mkdirSync(dirname(effectivePath), { recursive: true });
      accessSync(dirname(effectivePath), constants.W_OK);
      dirWritable = true;
    } catch {
      dirWritable = false;
    }
  }
  const mismatch = envSet ? normalizePath(envPath as string) !== normalizePath(homePath) : false;
  const message = envSet
    ? mismatch
      ? `放行账本双轴告警：${LEDGER_ENV}=${envPath} 与进程 $HOME 推导 ${homePath} 不一致——写入方与检查器须同源，请核对实例 env`
      : `放行账本单源：${effectivePath}（${LEDGER_ENV} 与 $HOME 推导一致）`
    : `放行账本回退位：${effectivePath}（${LEDGER_ENV} 未设——写入方/检查器各按 $HOME 解析，实例部署应显式注入）`;
  return { envPath, homePath, effectivePath, dirWritable, mismatch, message };
};

/** train.sh 审计注释幂等标记（重复追加防护；纯运营语义——用户可见面零开发叙事）。 */
export const LEDGER_AUDIT_MARKER = "[atf-harness 审计]";

/** POSIX 单引号转义（路径面——' → '\''）。 */
export const shellSingleQuoted = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

/** tmux 命令 env 前缀（旧 tmux 服务端不传播新 env 变量——检查器侧显式注入；未设回退空串）。 */
export const ledgerEnvPrefixForShell = (env: Readonly<Record<string, string | undefined>>): string => {
  const raw = env[LEDGER_ENV];
  if (typeof raw !== "string" || raw.trim() === "") return "";
  return `env ${LEDGER_ENV}=${shellSingleQuoted(raw.trim())} `;
};

/**
 * train.sh 生成面审计注释（段1③——幂等；追加于脚本尾，注释行不改变执行语义，
 * `${ATF_APPROVAL_LEDGER:-$HOME/...}` 生成语义原样保留）。写失败静默 fail-open（审计面非闸门）。
 * @returns 是否实际追加了注释（已带标记/写失败＝false）。
 */
export const appendLedgerAuditComment = (trainShPath: string, env: Readonly<Record<string, string | undefined>>): boolean => {
  try {
    if (!existsSync(trainShPath)) return false;
    const text = readFileSync(trainShPath, "utf8");
    if (text.includes(LEDGER_AUDIT_MARKER)) return false;
    const effectivePath = env[LEDGER_ENV]?.trim() || homeLedgerPathOf(env["HOME"] ?? "");
    const line = `# ${LEDGER_AUDIT_MARKER} 生效放行账本=${effectivePath}（脚本内解析序 \${ATF_APPROVAL_LEDGER:-$HOME/.atf/approval-ledger/training-release.jsonl} 保留；本注释行由 harness 追加，不参与执行）\n`;
    appendFileSync(trainShPath, line, "utf8");
    return true;
  } catch {
    return false;
  }
};
