import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";
import StatsGrid from "../components/StatsGrid.tsx";
import data from "../data/deployed.json";

const chartData = data.contracts.map((c) => ({
  name: c.name.replace(/([A-Z])/g, " $1").trim(),
  fees: Number(BigInt(c.fees) / 1_000_000n),
  circuits: c.circuits.length,
}));

const COLORS = [
  "#38bdf8", // sky-400
  "#818cf8", // indigo-400
  "#c084fc", // purple-400
];

export default function Dashboard() {
  return (
    <div className="min-h-screen bg-[#09090b]">
      <section className="pt-24 pb-16">
        <div className="container">
          {/* Header */}
          <div className="mb-10">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#18181b] border border-[#27272a] mb-4">
              <span className="text-[12px] font-medium text-[#a1a1aa] tracking-widest uppercase">System Analytics</span>
            </div>
            <h1 className="font-display text-4xl font-bold tracking-tight text-[#f4f4f5] mb-2">
              Network Dashboard
            </h1>
            <p className="font-sans text-[15px] text-[#a1a1aa]">
              Deployment analytics for {data.network} // Last updated: {data.deployedAt}
            </p>
          </div>

          {/* Stats Grid */}
          <StatsGrid
            totalContracts={data.contracts.length}
            totalCircuits={data.totalCircuits}
            totalFees={data.totalFees}
            network={data.network}
          />

          {/* Charts */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-8">
            {/* Fees Chart */}
            <div className="bg-[#18181b] border border-[#27272a] rounded-xl p-6 shadow-sm">
              <div className="mb-6">
                <h3 className="font-display text-[16px] font-bold text-[#f4f4f5]">
                  Protocol Fees Tracked
                </h3>
                <p className="font-sans text-[13px] text-[#71717a]">Measured in $NIGHT tokens</p>
              </div>

              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData}>
                    <XAxis
                      dataKey="name"
                      tick={{ fill: "#a1a1aa", fontFamily: "Inter", fontSize: 11 }}
                      axisLine={{ stroke: "#3f3f46" }}
                      tickLine={false}
                    />
                    <YAxis
                      tick={{ fill: "#a1a1aa", fontFamily: "Inter", fontSize: 11 }}
                      axisLine={{ stroke: "#3f3f46" }}
                      tickLine={false}
                    />
                    <Tooltip
                      contentStyle={{
                        background: "#09090b",
                        border: "1px solid #3f3f46",
                        borderRadius: "8px",
                        fontFamily: "Inter",
                        fontSize: "13px",
                        color: "#f4f4f5",
                        boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.1)"
                      }}
                      itemStyle={{ color: "#38bdf8", fontWeight: "bold" }}
                      formatter={(value: number) => [`${value.toLocaleString()}M`, "Fees"]}
                    />
                    <Bar dataKey="fees" radius={[4, 4, 0, 0]}>
                      {chartData.map((_, index) => (
                        <Cell key={index} fill={COLORS[index % COLORS.length]} fillOpacity={0.9} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Circuits Chart */}
            <div className="bg-[#18181b] border border-[#27272a] rounded-xl p-6 shadow-sm">
              <div className="mb-6">
                <h3 className="font-display text-[16px] font-bold text-[#f4f4f5]">
                  Zero-Knowledge Circuits
                </h3>
                <p className="font-sans text-[13px] text-[#71717a]">Compiled logic components per contract</p>
              </div>

              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData}>
                    <XAxis
                      dataKey="name"
                      tick={{ fill: "#a1a1aa", fontFamily: "Inter", fontSize: 11 }}
                      axisLine={{ stroke: "#3f3f46" }}
                      tickLine={false}
                    />
                    <YAxis
                      tick={{ fill: "#a1a1aa", fontFamily: "Inter", fontSize: 11 }}
                      axisLine={{ stroke: "#3f3f46" }}
                      tickLine={false}
                      allowDecimals={false}
                    />
                    <Tooltip
                      contentStyle={{
                        background: "#09090b",
                        border: "1px solid #3f3f46",
                        borderRadius: "8px",
                        fontFamily: "Inter",
                        fontSize: "13px",
                        color: "#f4f4f5",
                        boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.1)"
                      }}
                      itemStyle={{ color: "#c084fc", fontWeight: "bold" }}
                      formatter={(value: number) => [value, "Circuits"]}
                    />
                    <Bar dataKey="circuits" radius={[4, 4, 0, 0]}>
                      {chartData.map((_, index) => (
                        <Cell key={index} fill={COLORS[(index + 1) % COLORS.length]} fillOpacity={0.9} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
