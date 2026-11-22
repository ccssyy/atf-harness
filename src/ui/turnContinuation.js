const INTERACTIVE_CONTINUE_KINDS = ["completed", "turn_failed", "failed", "aborted"];
export const continuesInteractive = (outcomeKind, isTTY) => isTTY && INTERACTIVE_CONTINUE_KINDS.includes(outcomeKind);
