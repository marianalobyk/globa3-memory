import { redirect } from 'next/navigation';
import { hasSupabaseAuth } from '@g3/core';
import { getSession } from '@/lib/session';
import { LoginForm } from './login-form';

export default async function LoginPage() {
  const session = await getSession();
  if (session) redirect('/briefs');
  return <LoginForm supabaseAuthConfigured={hasSupabaseAuth()} />;
}
