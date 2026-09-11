export function applyExpoNodeHeapEnv(
  baseEnv: NodeJS.ProcessEnv | undefined,
  options?: Readonly<{
    envKey?: string;
    defaultSizeMb?: number;
  }>,
): NodeJS.ProcessEnv;
