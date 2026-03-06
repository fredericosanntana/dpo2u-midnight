import { Link, useLocation } from "wouter";
import { Activity, Code2, Home, Shield } from "lucide-react";

export default function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();

  const navItems = [
    { href: "/", label: "Overview", icon: Home },
    { href: "/contracts", label: "Contracts", icon: Code2 },
    { href: "/dashboard", label: "Analytics", icon: Activity },
    { href: "/lgpd-kit", label: "Compliance (LGPD)", icon: Shield },
  ];

  return (
    <div className="min-h-screen flex flex-col bg-[#09090b] text-[#f4f4f5] font-sans">
      {/* NavBar */}
      <header className="fixed top-0 left-0 right-0 z-50 border-b border-[#27272a] bg-[#09090b]/90 backdrop-blur-lg">
        <div className="container flex items-center justify-between h-16">
          {/* Logo */}
          <Link href="/" className="flex items-center gap-3 no-underline cursor-pointer group">
            <div className="w-9 h-9 border-2 border-[#3f3f46] rounded-md flex items-center justify-center bg-[#18181b] group-hover:border-[#38bdf8] transition-colors">
              <Shield className="w-5 h-5 text-[#38bdf8]" />
            </div>
            <span className="font-display text-[15px] font-bold tracking-wide text-white">
              DPO2U <span className="text-[#a1a1aa] font-normal">Governance</span>
            </span>
          </Link>

          {/* Nav Links */}
          <nav className="flex items-center gap-2">
            {navItems.map((item) => {
              const isActive = location === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md transition-colors ${isActive
                      ? "bg-[#18181b] text-[#38bdf8]"
                      : "text-[#a1a1aa] hover:bg-[#18181b] hover:text-[#f4f4f5]"
                    }`}
                >
                  <item.icon className="w-4 h-4" />
                  <span className="hidden sm:inline">{item.label}</span>
                </Link>
              );
            })}
          </nav>

          {/* Network Badge */}
          <div className="hidden md:flex items-center gap-2 px-3 py-1 bg-[#18181b] border border-[#27272a] rounded-full">
            <div className="w-2 h-2 rounded-full bg-[#4ade80]" />
            <span className="text-[11px] font-medium text-[#a1a1aa] tracking-wider uppercase">Midnight DevNet</span>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 pt-16">{children}</main>

      {/* Footer */}
      <footer className="border-t border-[#27272a] bg-[#09090b] py-8">
        <div className="container flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-[13px] text-[#71717a]">
            &copy; 2026 DPO2U Platform. Secure Compliance Protocol.
          </p>
          <div className="flex items-center gap-6 text-[13px] text-[#71717a]">
            <span className="hover:text-white cursor-pointer transition-colors">Documentation</span>
            <span className="hover:text-white cursor-pointer transition-colors">Support</span>
            <span className="hover:text-white cursor-pointer transition-colors">System Status</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
