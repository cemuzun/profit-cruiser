import { NavLink } from "react-router-dom";
import { BarChart3, Calculator, Bookmark, Settings, Car, CalendarRange, GitCompare } from "lucide-react";
import { cn } from "@/lib/utils";

const links = [
  { to: "/", label: "Dashboard", icon: BarChart3 },
  { to: "/analyzer", label: "Analyzer", icon: Calculator },
  { to: "/watchlist", label: "Watchlist", icon: Bookmark },
  { to: "/compare", label: "Compare", icon: GitCompare },
  { to: "/seasonality", label: "Seasonality", icon: CalendarRange },
  { to: "/settings", label: "Settings", icon: Settings },
];

export function AppNav() {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur">
      <div className="container mx-auto flex h-14 items-center gap-6 px-4">
        <div className="flex items-center gap-2 font-semibold">
          <Car className="h-5 w-5 text-primary" />
          <span>Turo Profit Lab</span>
        </div>
        <nav className="flex items-center gap-1">
          {links.map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              end={l.to === "/"}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-secondary text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )
              }
            >
              <l.icon className="h-4 w-4" />
              {l.label}
            </NavLink>
          ))}
        </nav>
      </div>
    </header>
  );
}
