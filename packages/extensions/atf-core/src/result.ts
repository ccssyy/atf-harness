/**
 * Result<T, E>——桥接层一切可能失败操作的统一返回形态（借鉴 Pi 分层纪律）。
 * 约束：禁止裸 throw 穿过桥接边界；失败一律折算为 { ok: false, error }。
 */
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });
