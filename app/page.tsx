import Link from 'next/link';

export default function MarketingHome() {
  return (
    <main className="min-h-screen flex items-center justify-center px-6">
      <div className="card p-8 max-w-md w-full text-center space-y-4">
        <h1 className="text-3xl font-bold tracking-tight">Mid-South WX</h1>
        <p className="text-wx-mute">
          Severe weather alerts for your area, delivered by Telegram.
        </p>
        <div className="grid grid-cols-2 gap-3 pt-4">
          <Link href="/signup" className="btn">Sign up for alerts</Link>
          <Link href="/login" className="btn-ghost">Operator sign-in</Link>
        </div>
      </div>
    </main>
  );
}
