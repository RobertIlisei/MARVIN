import Link from "next/link";

export default function Home() {
  return (
    <main className="min-h-screen p-10 flex flex-col gap-6 max-w-3xl mx-auto">
      <header className="flex items-baseline gap-4">
        <h1 className="text-4xl font-bold tracking-tight text-[var(--accent)]">MARVIN</h1>
        <span className="text-sm text-[var(--foreground)]/60">
          Moderately Advanced Robotic Virtual Intelligence Network
        </span>
      </header>

      <section className="rounded border border-[var(--muted)] bg-[var(--muted)]/30 p-4">
        <p className="italic text-[var(--foreground)]/80">
          &ldquo;Here I am, brain the size of a planet, and they ask me to render a
          placeholder homepage. Call me when there&rsquo;s actual work.&rdquo;
        </p>
        <p className="mt-2 text-xs text-[var(--foreground)]/60">— MARVIN, Phase 1</p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold text-[var(--foreground)]/90">Smoke test</h2>
        <p className="text-sm text-[var(--foreground)]/70">
          The baseline <code>/api/chat</code> endpoint streams a MARVIN-voiced reply
          from the Claude CLI. Hit it with:
        </p>
        <pre className="rounded bg-black/50 p-3 text-xs overflow-x-auto">
{`curl -N http://localhost:3030/api/chat \\
  -H "Content-Type: application/json" \\
  -d '{"message":"hello","cwd":"/path/to/your/project"}'`}
        </pre>
      </section>

      <section className="flex flex-col gap-2 text-sm">
        <Link href="/api/health" className="text-[var(--accent)]">
          /api/health — runtime auth + binary status
        </Link>
      </section>

      <footer className="mt-auto text-xs text-[var(--foreground)]/40">
        Phase 1 · see <code>PLAN.md</code> for what ships next.
      </footer>
    </main>
  );
}
