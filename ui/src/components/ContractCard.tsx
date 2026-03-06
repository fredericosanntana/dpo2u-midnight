import { useState } from "react";
import { ChevronDown, ChevronUp, FileCode2, Cpu } from "lucide-react";

interface Circuit {
  name: string;
  pure: boolean;
  proof: boolean;
  args: string[];
  returns: string;
}

interface ContractData {
  name: string;
  address: string;
  txHash: string;
  blockHeight: number;
  fees: string;
  status: string;
  compilerVersion: string;
  source: string;
  circuits: Circuit[];
}

function truncateHash(hash: string): string {
  return hash.length > 20 ? `${hash.slice(0, 10)}...${hash.slice(-8)}` : hash;
}

function formatFees(fees: string): string {
  const n = BigInt(fees);
  return n.toLocaleString();
}

export default function ContractCard({ contract }: { contract: ContractData }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="bg-[#18181b] border border-[#3f3f46] rounded-xl overflow-hidden hover:border-[#38bdf8]/50 transition-colors shadow-sm mb-4">
      {/* Header */}
      <div
        className="p-5 cursor-pointer flex items-center justify-between bg-[#18181b] hover:bg-[#27272a] transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-4">
          <div className="w-10 h-10 border border-[#3f3f46] rounded-md flex items-center justify-center bg-[#09090b]">
            <FileCode2 className="w-5 h-5 text-[#38bdf8]" />
          </div>
          <div>
            <h3 className="font-sans text-[15px] font-bold text-white mb-0.5">
              {contract.name}
            </h3>
            <span className="font-mono text-[12px] text-[#38bdf8]">{truncateHash(contract.address)}</span>
          </div>
        </div>

        <div className="flex items-center gap-6">
          {/* Status */}
          <div className="hidden sm:flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-[#4ade80]" />
            <span className="font-sans text-[12px] font-semibold tracking-wider text-[#4ade80] uppercase">
              DEPLOYED
            </span>
          </div>
          {/* Circuits count */}
          <span className="font-sans text-[13px] text-[#a1a1aa] font-medium bg-[#27272a] px-3 py-1 rounded-full">
            {contract.circuits.length} circuits
          </span>
          {expanded ? (
            <ChevronUp className="w-5 h-5 text-[#a1a1aa]" />
          ) : (
            <ChevronDown className="w-5 h-5 text-[#a1a1aa]" />
          )}
        </div>
      </div>

      {/* Meta bar */}
      <div className="px-5 pb-5 pt-2 flex flex-wrap gap-x-8 gap-y-2 bg-[#18181b]">
        <div className="flex items-center gap-2">
          <span className="font-sans text-[12px] font-semibold text-[#71717a] uppercase tracking-wider">Block</span>
          <span className="font-mono text-[13px] text-[#f4f4f5]">
            #{contract.blockHeight}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="font-sans text-[12px] font-semibold text-[#71717a] uppercase tracking-wider">Fees</span>
          <span className="font-mono text-[13px] text-[#f4f4f5]">
            {formatFees(contract.fees)}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="font-sans text-[12px] font-semibold text-[#71717a] uppercase tracking-wider">Compiler</span>
          <span className="font-mono text-[13px] text-[#f4f4f5]">
            v{contract.compilerVersion}
          </span>
        </div>
      </div>

      {/* Expanded content */}
      {expanded && (
        <div className="border-t border-[#3f3f46] bg-[#09090b]">
          {/* Circuits */}
          <div className="p-6">
            <h4 className="font-sans text-[13px] font-bold text-[#d4d4d8] uppercase tracking-wider mb-4">Circuits Registry</h4>
            <div className="space-y-3">
              {contract.circuits.map((circuit) => (
                <div
                  key={circuit.name}
                  className="border border-[#27272a] bg-[#18181b] rounded-lg p-4"
                >
                  <div className="flex items-center gap-3 mb-3">
                    <Cpu className="w-4 h-4 text-[#c084fc]" />
                    <span className="font-sans text-[14px] text-[#f4f4f5] font-bold">
                      {circuit.name}
                    </span>
                    {circuit.proof && (
                      <span className="font-sans text-[11px] font-bold text-[#c084fc] bg-[#3b0764]/50 border border-[#9333ea]/50 rounded-full px-2 py-0.5">
                        ZK-PROOF
                      </span>
                    )}
                  </div>
                  <div className="font-mono text-[13px] text-[#a1a1aa] space-y-1 bg-[#09090b] p-3 rounded border border-[#27272a]">
                    {circuit.args.length > 0 ? (
                      circuit.args.map((arg, i) => (
                        <div key={i} className="pl-2">
                          <span className="text-[#d4d4d8]">{arg}</span>
                        </div>
                      ))
                    ) : (
                      <div className="pl-2 text-[#71717a]">// no arguments</div>
                    )}
                    <div className="pl-2 mt-2 pt-2 border-t border-[#27272a]">
                      <span className="text-[#71717a]">returns </span>
                      <span className="text-[#38bdf8]">{circuit.returns}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Source */}
          <div className="px-6 pb-6 mt-2">
            <h4 className="font-sans text-[13px] font-bold text-[#d4d4d8] uppercase tracking-wider mb-3">Compact Source</h4>
            <pre className="bg-[#18181b] border border-[#27272a] rounded-lg p-5 overflow-x-auto text-[13px] text-[#d4d4d8] leading-relaxed custom-scrollbar shadow-inner">
              {contract.source}
            </pre>
          </div>

          {/* TX Hash */}
          <div className="px-6 pb-6 pt-2 border-t border-[#27272a] bg-[#18181b]">
            <div className="pt-4">
              <span className="font-sans text-[12px] font-semibold text-[#71717a] uppercase tracking-wider block mb-1">Full Contract Address</span>
              <p className="font-mono text-[13px] text-[#38bdf8] break-all bg-[#09090b] p-2 rounded border border-[#27272a]">{contract.address}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
