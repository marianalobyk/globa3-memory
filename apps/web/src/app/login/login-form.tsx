'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { KeyRound, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';
import { api, RequestFailed } from '@/lib/client';

export function LoginForm({ supabaseAuthConfigured }: { supabaseAuthConfigured: boolean }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/api/auth/login', { method: 'POST', json: { email, password } });
      router.replace('/briefs');
      router.refresh();
    } catch (failure) {
      setError(
        failure instanceof RequestFailed ? failure.payload.error : 'Could not sign in. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-dvh items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <div className="flex size-9 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <KeyRound className="size-4" />
          </div>
          <CardTitle>Globa 3 Intelligence</CardTitle>
          <CardDescription>Sign in to continue.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!supabaseAuthConfigured ? (
            <div className="flex items-start gap-2.5 rounded-md border border-warning/40 bg-warning/10 p-3 text-xs">
              <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" />
              <p>
                <span className="font-medium">Local development sign-in.</span> Supabase Auth is not
                configured, so this form authenticates against the local database. Set{' '}
                <code className="font-mono">SUPABASE_URL</code> and{' '}
                <code className="font-mono">SUPABASE_ANON_KEY</code> to use Supabase Auth.
              </p>
            </div>
          ) : null}

          <form onSubmit={submit} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <Button type="submit" className="w-full" loading={busy}>
              Sign in
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
