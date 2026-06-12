export type LocalModelChoice = {
  id: "qwen2.5-coder-1.5b" | "qwen2.5-coder-3b" | "qwen2.5-coder-7b";
  reason: string;
};

export function selectLocalModel(totalRamGb: number, hasDedicatedGpu = false): LocalModelChoice {
  if (totalRamGb < 12) return { id: "qwen2.5-coder-1.5b", reason: "low_ram" };
  if (totalRamGb >= 24 || hasDedicatedGpu) return { id: "qwen2.5-coder-7b", reason: hasDedicatedGpu ? "gpu_available" : "high_ram" };
  return { id: "qwen2.5-coder-3b", reason: "default_driver" };
}

export function offlineMode(hasNetwork: boolean, hasApiKeys: boolean): "offline" | "local" | "cloud" {
  if (!hasNetwork || !hasApiKeys) return "offline";
  return "cloud";
}
