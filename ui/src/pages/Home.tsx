import { Link } from "wouter";
import { Shield, Zap, Code2, Activity, ChevronRight, Lock } from "lucide-react";
import data from "../data/deployed.json";

const features = [
  {
    icon: Lock,
    title: "Zero-Knowledge Proofs",
    desc: "Generate and verify ZK proofs on-chain using Compact circuits. Prove compliance without exposing sensitive data.",
    color: "text-sky-400 bg-sky-400/10 border-sky-400/20",
  },
  {
    icon: Code2,
    title: "Compact Smart Contracts",
    desc: "Deploy DPO2U Privacy Protocol contracts on Midnight for autonomous self-funding with $NIGHT tokens.",
    color: "text-purple-400 bg-purple-400/10 border-purple-400/20",
  },
  {
    icon: Shield,
    title: "LGPD/GDPR Compliance",
    desc: "On-chain compliance verification for Brazilian LGPD and European GDPR regulations with cryptographic proof.",
    color: "text-green-400 bg-green-400/10 border-green-400/20",
  },
  {
    icon: Zap,
    title: "Self-Funding Protocol",
    desc: "Autonomous fee distribution: 40/60 split between compliance experts and auditors, enforced by ZK constraints.",
    color: "text-amber-400 bg-amber-400/10 border-amber-400/20",
  },
];

const specs = [
  { label: "Compact Runtime", value: "0.14.0+" },
  { label: "Compact Compiler", value: "0.29.0" },
  { label: "Language Version", value: "0.21.0" },
  { label: "Midnight.js", value: "v3.1.0+" },
  { label: "Compact JS", value: "v2.4.0" },
  { label: "Wallet SDK", value: "1.0.0+" },
  { label: "Contracts", value: data.contracts.length.toString() },
  { label: "Network", value: "DEVNET" },
];

export default function Home() {
  return (
    <div className="min-h-screen bg-[#09090b]">
      {/* Hero */}
      <section className="relative pt-32 pb-24 overflow-hidden border-b border-[#27272a]">
        {/* Subtle grid background */}
        <div
          className="absolute inset-0 opacity-[0.03]"
          style={{
            backgroundImage: "linear-gradient(#f4f4f5 1px, transparent 1px), linear-gradient(90deg, #f4f4f5 1px, transparent 1px)",
            backgroundSize: "40px 40px"
          }}
        />

        <div className="container relative z-10 text-center sm:text-left">
          <div className="max-w-4xl mx-auto sm:mx-0">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#18181b] border border-[#27272a] mb-8">
              <span className="w-2 h-2 rounded-full bg-[#38bdf8] animate-pulse"></span>
              <span className="text-[12px] font-medium text-[#a1a1aa] tracking-widest uppercase">System Operational v1.0.0</span>
            </div>

            <div className="mb-6">
              <h1 className="font-display text-4xl sm:text-5xl md:text-7xl font-bold leading-tight mb-4 tracking-tight text-[#f4f4f5]">
                DPO2U
                <span className="block text-[#38bdf8]">Self-Funding Protocol</span>
              </h1>
            </div>

            <p className="font-sans text-base sm:text-lg text-[#a1a1aa] max-w-2xl mb-10 leading-relaxed mx-auto sm:mx-0">
              Autonomous on-chain DPO combining <strong className="text-[#f4f4f5] font-semibold">LGPD/GDPR compliance</strong> with <strong className="text-[#f4f4f5] font-semibold">zero-knowledge proofs</strong> and self-funding fee distribution on the Midnight Network.
            </p>

            <div className="flex flex-wrap items-center justify-center sm:justify-start gap-4">
              <Link href="/contracts" className="no-underline">
                <button className="bg-[#f4f4f5] text-[#09090b] hover:bg-[#e4e4e7] border border-transparent font-sans text-[14px] font-semibold px-6 py-3 rounded-lg transition-all flex items-center gap-2 shadow-sm">
                  <Code2 className="w-4 h-4" />
                  Explore Contracts
                </button>
              </Link>
              <Link href="/dashboard" className="no-underline">
                <button className="bg-[#18181b] text-[#f4f4f5] hover:bg-[#27272a] border border-[#3f3f46] font-sans text-[14px] font-semibold px-6 py-3 rounded-lg transition-all flex items-center gap-2 shadow-sm">
                  <Activity className="w-4 h-4" />
                  View Dashboard
                </button>
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Stats bar */}
      <section className="bg-[#18181b] border-b border-[#27272a]">
        <div className="container py-8">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8 divide-x divide-[#27272a]/0 md:divide-[#27272a]">
            {[
              { label: "Active Contracts", value: data.contracts.length },
              { label: "ZK Circuits", value: data.totalCircuits },
              { label: "Platform Version", value: `v${data.compilerVersion}` },
              { label: "System Status", value: "Operational", color: "text-[#4ade80]" },
            ].map((stat, i) => (
              <div key={stat.label} className={`text-center ${i !== 0 ? 'md:pl-8' : ''}`}>
                <p className={`font-display text-3xl font-bold mb-1 ${stat.color || 'text-[#f4f4f5]'}`}>{stat.value}</p>
                <p className="font-sans text-[13px] font-medium text-[#71717a] uppercase tracking-wider">{stat.label}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="py-24 bg-[#09090b]">
        <div className="container">
          <div className="mb-16 text-center max-w-2xl mx-auto">
            <h2 className="font-display text-3xl font-bold text-[#f4f4f5] mb-4">Core Infrastructure</h2>
            <p className="text-[#a1a1aa] leading-relaxed">Enterprise-grade compliance mechanisms powered by zero-knowledge proofs and decentralized registries.</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {features.map((feat) => (
              <div key={feat.title} className="bg-[#18181b] border border-[#27272a] rounded-xl p-8 hover:border-[#3f3f46] transition-colors group">
                <div className={`w-12 h-12 rounded-lg border flex items-center justify-center mb-6 transition-transform group-hover:scale-110 ${feat.color}`}>
                  <feat.icon className="w-6 h-6" />
                </div>
                <h3 className="font-display text-[18px] font-bold text-[#f4f4f5] mb-3">{feat.title}</h3>
                <p className="text-[15px] text-[#a1a1aa] leading-relaxed">{feat.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Architecture Diagram */}
      <section className="py-24 bg-[#18181b] border-y border-[#27272a]">
        <div className="container text-center">
          <h2 className="font-display text-3xl font-bold text-[#f4f4f5] mb-12">Protocol Architecture</h2>
          <div className="bg-[#09090b] border border-[#27272a] rounded-xl p-8 max-w-3xl mx-auto font-mono text-sm text-[#a1a1aa] overflow-x-auto shadow-inner text-left flex justify-center">
            <pre className="inline-block leading-loose text-[#d4d4d8]">
              {`  [ User Organization ]
           │
           ▼ (Pays Fiat/Crypto)
   [ Payment Gateway ]
           │
           ▼ (Mint $NIGHT)
   [ Fee Distributor ] ─── 40% ──► [ Compliance Expert ]
           │
           ▼ 60%
     [ DPO Auditor ]
           │
           ▼ (Attest ZK Proof)
[ LgpdKitRegistry Contract ] 
      (Midnight Chain) `}
            </pre>
          </div>
        </div>
      </section>

      {/* Bottom nav links */}
      <section className="py-16 bg-[#09090b]">
        <div className="container">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
            {[
              { href: "/", label: "Overview", desc: "Protocol architecture & design" },
              { href: "/contracts", label: "Smart Contracts", desc: "Explore deployed ledgers" },
              { href: "/dashboard", label: "Analytics", desc: "System utilization and stats" },
            ].map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="bg-[#18181b] border border-[#27272a] rounded-lg p-6 flex flex-col justify-between hover:border-[#38bdf8]/50 hover:bg-[#27272a] transition-all no-underline group"
              >
                <div>
                  <h4 className="font-sans text-[15px] font-bold text-[#f4f4f5] mb-2">{item.label}</h4>
                  <p className="font-sans text-[14px] text-[#71717a] leading-relaxed">{item.desc}</p>
                </div>
                <div className="mt-6 flex justify-end">
                  <ChevronRight className="w-5 h-5 text-[#52525b] group-hover:text-[#38bdf8] transition-colors transform group-hover:translate-x-1" />
                </div>
              </Link>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
