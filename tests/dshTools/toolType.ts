export type Tool = { name: string; execute: (args: unknown, exec: unknown) => Promise<Record<string, unknown>> };
