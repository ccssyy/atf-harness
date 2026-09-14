/**
 * L1a 门 2——codec 注册面（任务书 §1.2 / D6）：protocol → codec 实现的分发单点。
 * 未知取值 fail-closed（与配置层同口径，不猜测回退）；共享契约见 codecWire.ts。
 */
import { type ProviderConfigError, PROVIDER_PROTOCOLS } from "./providerConfig.js";
import { anthropicMessagesCodec } from "./anthropicMessagesCodec.js";
import { openaiChatCodec } from "./openaiChatCodec.js";
import { type ProtocolCodec } from "./codecWire.js";

export type CodecLookup =
  | { ok: true; codec: ProtocolCodec }
  | { ok: false; error: ProviderConfigError };

/** protocol → codec（注册面闭集 = D6 两实现；openai-responses 不在面内——预留位语义）。 */
export const getCodec = (protocol: string): CodecLookup => {
  if (!(PROVIDER_PROTOCOLS as readonly string[]).includes(protocol)) {
    const hint = protocol === "openai-responses"
      ? "openai-responses 只预留 codec 位不实现（硬前提：store:false ＋ 禁用对端服务端工具执行，另批评估）"
      : `允许值：${PROVIDER_PROTOCOLS.join(" | ")}`;
    return {
      ok: false,
      error: {
        code: "protocol_unknown",
        message: `未知 protocol: ${JSON.stringify(protocol)}（fail-closed，不猜测回退）。${hint}`,
      },
    };
  }
  return { ok: true, codec: protocol === "openai-chat" ? openaiChatCodec : anthropicMessagesCodec };
};
