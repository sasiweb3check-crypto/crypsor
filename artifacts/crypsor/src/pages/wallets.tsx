import { useState, useMemo } from "react";
import { Copy, Plus, Trash2, ArrowUpDown, Wallet, X } from "lucide-react";
import { useGetWallets, useCreateWallet, useDeleteWallet } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { getGetWalletsQueryKey } from "@workspace/api-client-react";
import { truncateAddress, formatDate } from "@/lib/utils";
import { ChainBadge } from "@/components/chain-badge";
import type { WalletInputChain } from "@workspace/api-client-react";

type SortField = "label" | "chain" | "createdAt";
type SortOrder = "asc" | "desc";

const CHAINS = ["solana","eth","base","bsc","polygon","arbitrum","avalanche"];

export default function Wallets() {
  const { data: wallets, isLoading } = useGetWallets();
  const createWallet = useCreateWallet();
  const deleteWallet = useDeleteWallet();
  const { toast }    = useToast();
  const queryClient  = useQueryClient();

  const [sortField, setSortField] = useState<SortField>("createdAt");
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc");
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [newLabel,   setNewLabel]   = useState("");
  const [newAddress, setNewAddress] = useState("");
  const [newChain,   setNewChain]   = useState("solana");

  const sortedWallets = useMemo(() => {
    if (!wallets) return [];
    return [...wallets].sort((a, b) => {
      let cmp = 0;
      if (sortField === "label")     cmp = a.label.localeCompare(b.label);
      if (sortField === "chain")     cmp = a.chain.localeCompare(b.chain);
      if (sortField === "createdAt") cmp = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      return sortOrder === "asc" ? cmp : -cmp;
    });
  }, [wallets, sortField, sortOrder]);

  const handleSort = (field: SortField) => {
    if (sortField === field) setSortOrder(o => o === "asc" ? "desc" : "asc");
    else { setSortField(field); setSortOrder("asc"); }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast({ description: "Address copied", duration: 2000 });
  };

  const handleAdd = () => {
    if (!newLabel || !newAddress || !newChain) return;
    createWallet.mutate(
      { data: { label: newLabel, address: newAddress, chain: newChain as WalletInputChain } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetWalletsQueryKey() });
          setIsAddOpen(false);
          setNewLabel(""); setNewAddress(""); setNewChain("solana");
          toast({ title: "Wallet added" });
        },
        onError: err => toast({ title: "Failed to add wallet", description: String(err), variant: "destructive" }),
      },
    );
  };

  const handleDelete = (id: number) => {
    deleteWallet.mutate({ id }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetWalletsQueryKey() });
        toast({ title: "Wallet removed" });
      },
    });
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <div>
          <h1 className="text-lg font-bold text-[#f59e0b] tracking-widest uppercase flex items-center gap-2">
            <Wallet className="w-4 h-4" />
            Wallets
          </h1>
          <p className="text-[#484f58] text-[10px] mt-0.5 tracking-widest uppercase">
            {wallets?.length ?? 0} monitored data sources
          </p>
        </div>
        <button
          onClick={() => setIsAddOpen(true)}
          className="flex items-center gap-1.5 h-8 px-3 text-[9px] font-bold uppercase tracking-widest border border-[#f59e0b]/40 text-[#f59e0b] bg-[#f59e0b]/5 hover:bg-[#f59e0b]/10 transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          Add Wallet
        </button>
      </div>

      {/* Add Wallet modal */}
      {isAddOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-[#161b22] border border-[#30363d] w-full max-w-md mx-4">
            <div className="flex items-center justify-between px-5 py-4 border-b border-[#30363d]">
              <h2 className="text-[#f59e0b] font-bold text-sm tracking-widest uppercase">Add Wallet</h2>
              <button onClick={() => setIsAddOpen(false)} className="text-[#484f58] hover:text-[#c9d1d9] transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="px-5 py-4 space-y-4">
              <div>
                <label className="text-[9px] text-[#484f58] uppercase tracking-widest block mb-1.5">Label</label>
                <input
                  value={newLabel}
                  onChange={e => setNewLabel(e.target.value)}
                  placeholder="e.g. Smart Money 1"
                  className="w-full h-9 px-3 text-[11px] bg-[#0d1117] border border-[#30363d] text-[#c9d1d9] placeholder-[#484f58] focus:outline-none focus:border-[#f59e0b]/50 font-mono"
                />
              </div>
              <div>
                <label className="text-[9px] text-[#484f58] uppercase tracking-widest block mb-1.5">Address</label>
                <input
                  value={newAddress}
                  onChange={e => setNewAddress(e.target.value)}
                  placeholder="0x… or Solana address"
                  className="w-full h-9 px-3 text-[11px] bg-[#0d1117] border border-[#30363d] text-[#c9d1d9] placeholder-[#484f58] focus:outline-none focus:border-[#f59e0b]/50 font-mono"
                />
              </div>
              <div>
                <label className="text-[9px] text-[#484f58] uppercase tracking-widest block mb-1.5">Chain</label>
                <div className="flex flex-wrap gap-1.5">
                  {CHAINS.map(c => (
                    <button
                      key={c}
                      onClick={() => setNewChain(c)}
                      className={`h-7 px-2.5 text-[9px] font-bold uppercase tracking-widest border transition-colors ${
                        newChain === c
                          ? "border-[#f59e0b]/40 bg-[#f59e0b]/10 text-[#f59e0b]"
                          : "border-[#30363d] text-[#484f58] hover:text-[#8b949e] bg-[#0d1117]"
                      }`}
                    >
                      {c}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="px-5 py-4 border-t border-[#30363d] flex justify-end gap-2">
              <button
                onClick={() => setIsAddOpen(false)}
                className="h-8 px-4 text-[9px] font-bold uppercase tracking-widest border border-[#30363d] text-[#8b949e] hover:text-[#c9d1d9] transition-colors"
              >
                Cancel
              </button>
              <button
                disabled={createWallet.isPending || !newLabel || !newAddress}
                onClick={handleAdd}
                className="h-8 px-4 text-[9px] font-bold uppercase tracking-widest border border-[#f59e0b]/40 bg-[#f59e0b]/10 text-[#f59e0b] hover:bg-[#f59e0b]/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {createWallet.isPending ? "Adding…" : "Add Wallet"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="border border-[#30363d] bg-[#0d1117] overflow-hidden">
        {/* Header row */}
        <div className="grid grid-cols-[1fr_1fr_auto_auto_auto] gap-3 px-4 py-2.5 border-b border-[#30363d] bg-[#161b22]">
          {[
            { field: "label" as SortField, label: "Label" },
            { field: null, label: "Address" },
            { field: "chain" as SortField, label: "Chain" },
            { field: "createdAt" as SortField, label: "Added" },
            { field: null, label: "" },
          ].map((col, i) => (
            col.field ? (
              <button
                key={i}
                onClick={() => handleSort(col.field!)}
                className={`flex items-center gap-1 text-[9px] font-bold uppercase tracking-widest text-left transition-colors ${
                  sortField === col.field ? "text-[#f59e0b]" : "text-[#484f58] hover:text-[#8b949e]"
                }`}
              >
                {col.label}
                <ArrowUpDown className="w-2.5 h-2.5 opacity-50" />
              </button>
            ) : (
              <span key={i} className="text-[9px] font-bold uppercase tracking-widest text-[#484f58]">{col.label}</span>
            )
          ))}
        </div>

        {isLoading ? (
          <div className="divide-y divide-[#30363d]/50">
            {Array(4).fill(0).map((_, i) => (
              <div key={i} className="grid grid-cols-[1fr_1fr_auto_auto_auto] gap-3 px-4 py-3.5 items-center animate-pulse">
                <div className="h-3 w-28 bg-[#161b22]" />
                <div className="h-3 w-24 bg-[#161b22]" />
                <div className="h-5 w-16 bg-[#161b22]" />
                <div className="h-3 w-20 bg-[#161b22]" />
                <div className="w-6 h-6" />
              </div>
            ))}
          </div>
        ) : sortedWallets.length === 0 ? (
          <div className="py-20 text-center">
            <Wallet className="w-8 h-8 mx-auto mb-3 text-[#30363d]" />
            <p className="text-[#484f58] text-xs tracking-widest uppercase">No Wallets Configured</p>
            <p className="text-[#30363d] text-[10px] mt-1">Add one to begin monitoring</p>
          </div>
        ) : (
          <div className="divide-y divide-[#30363d]/40">
            {sortedWallets.map((wallet, i) => (
              <div
                key={wallet.id}
                className={`group grid grid-cols-[1fr_1fr_auto_auto_auto] gap-3 px-4 py-3 items-center transition-colors hover:bg-[#1c2128] ${
                  i % 2 === 0 ? "bg-[#0d1117]" : "bg-[#161b22]/20"
                }`}
              >
                <span className="text-[#c9d1d9] text-sm font-bold">{wallet.label}</span>
                <div className="flex items-center gap-2 text-[#484f58] font-mono text-[10px]">
                  {truncateAddress(wallet.address)}
                  <button
                    onClick={() => copyToClipboard(wallet.address)}
                    className="opacity-0 group-hover:opacity-100 transition-opacity text-[#484f58] hover:text-[#f59e0b]"
                  >
                    <Copy className="w-3 h-3" />
                  </button>
                </div>
                <ChainBadge chain={wallet.chain} />
                <span className="text-[#484f58] text-[10px] whitespace-nowrap">{formatDate(wallet.createdAt)}</span>
                <button
                  onClick={() => handleDelete(wallet.id)}
                  className="opacity-0 group-hover:opacity-100 transition-opacity p-1.5 text-[#484f58] hover:text-[#ef4444] border border-transparent hover:border-[#ef4444]/20 hover:bg-[#ef4444]/5"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
