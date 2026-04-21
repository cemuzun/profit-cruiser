import { useQuery } from "@tanstack/react-query";
import { userStore } from "@/lib/dataSource";
import type { GlobalCosts } from "@/lib/profitability";

// Global cost assumptions are user state — kept in localStorage so they
// persist across sessions without needing a backend.
export function useGlobalCosts() {
  return useQuery({
    queryKey: ["global-costs"],
    queryFn: async (): Promise<GlobalCosts> => userStore.getGlobal(),
    staleTime: Infinity,
  });
}
