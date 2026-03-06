import { FileCode2, Cpu, Coins, Blocks } from "lucide-react";

interface StatsGridProps {
  totalContracts: number;
  totalCircuits: number;
  totalFees: string;
  network: string;
}

function formatFees(fees: string): string {
  const n = BigInt(fees);
  // Show in billions for readability
  const billions = Number(n / 1_000_000n);
  return `${billions.toLocaleString()}M`;
}

export default function StatsGrid({ totalContracts, totalCircuits, totalFees, network }: StatsGridProps) {
  const stats = [
    {
      label: "Active Contracts",
      value: totalContracts.toString(),
      icon: <FileCode2 className="w-5 h-5 text-[#38bdf8]" />,
      color: "text-[#f4f4f5]",
    },
    {
      label: "ZK Circuits",
      value: totalCircuits.toString(),
      icon: <Cpu className="w-5 h-5 text-[#c084fc]" />,
      color: "text-[#f4f4f5]",
    },
    {
      label: "Total Fees Tracked",
      value: formatFees(totalFees),
      icon: <Coins className="w-5 h-5 text-[#fcd34d]" />,
      color: "text-[#fcd34d]",
    },
    {
      label: "Network Environment",
      value: network.toUpperCase(),
      icon: <Blocks className="w-5 h-5 text-[#4ade80]" />,
      color: "text-[#4ade80]",
    },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-6">
      {stats.map((stat) => (
        <div key={stat.label} className="bg-[#18181b] border border-[#27272a] rounded-xl p-6 flex flex-col items-center text-center shadow-sm">
          <div className="w-12 h-12 rounded-full bg-[#09090b] border border-[#3f3f46] flex justify-center items-center mb-4">
            {stat.icon}
          </div>
          <p className={`font-display text-3xl font-bold mb-1 ${stat.color}`}>{stat.value}</p>
          <p className="font-sans text-[12px] font-semibold text-[#71717a] uppercase tracking-wider mt-1">{stat.label}</p>
        </div>
      ))}
    </div>
  );
}
