import { redirect } from 'next/navigation';
import { authMode } from '@g3/core';
import { getSession } from '@/lib/session';
import { LoginForm } from './login-form';

export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  const session = await getSession();
  if (session) redirect('/');
  return <LoginForm mode={authMode()} />;
}
