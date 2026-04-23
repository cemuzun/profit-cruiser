import { CitiesManager } from "@/components/CitiesManager";
import { AppNav } from "@/components/AppNav";

export default function Cities() {
  return (
    <div className="min-h-screen bg-background">
      <AppNav />
      <main className="container mx-auto px-4 py-6">
        <CitiesManager />
      </main>
    </div>
  );
}
