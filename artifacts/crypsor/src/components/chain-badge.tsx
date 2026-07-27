import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const chainStyles: Record<string, string> = {
  solana: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300 border-purple-200 dark:border-purple-800",
  eth: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300 border-blue-200 dark:border-blue-800",
  base: "bg-sky-100 text-sky-800 dark:bg-sky-900/30 dark:text-sky-300 border-sky-200 dark:border-sky-800",
  bsc: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300 border-yellow-200 dark:border-yellow-800",
  polygon: "bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300 border-violet-200 dark:border-violet-800",
  arbitrum: "bg-cyan-100 text-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-300 border-cyan-200 dark:border-cyan-800",
  avalanche: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300 border-red-200 dark:border-red-800",
};

export function ChainBadge({ chain, className }: { chain: string; className?: string }) {
  const normalizedChain = chain.toLowerCase();
  const style = chainStyles[normalizedChain] || "bg-muted text-muted-foreground border-border";
  
  return (
    <Badge variant="outline" className={cn("capitalize font-medium shadow-none", style, className)}>
      {chain}
    </Badge>
  );
}
