'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Activity, BookOpen, ClipboardCheck, Home, Inbox, Settings } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Primary navigation, in the order work flows: see what is waiting (Today),
 * add what you know (Capture), decide (Review), look things up (Knowledge),
 * check what happened (Activity). Settings is for administrators only and sits
 * apart from the everyday sections. A count appears only when something is
 * waiting for a person.
 */
export function AppNav({
  canApprove,
  role,
  counts,
}: {
  canApprove: boolean;
  role: string;
  counts: { review: number };
}) {
  const pathname = usePathname();

  const nav = [
    { href: '/', label: 'Today', icon: Home, hint: 'What needs you today', match: (p: string) => p === '/' },
    {
      href: '/capture',
      label: 'Capture',
      icon: Inbox,
      hint: 'Add a note, a link or a file',
      match: (p: string) => p.startsWith('/capture'),
    },
    {
      href: '/review',
      label: 'Review',
      icon: ClipboardCheck,
      hint: 'Proposed changes awaiting review',
      count: counts.review,
      countHint: `${counts.review} proposal(s) awaiting review`,
      match: (p: string) => p === '/review' || p.startsWith('/review/'),
    },
    {
      href: '/knowledge',
      label: 'Knowledge',
      icon: BookOpen,
      hint: 'Search and ask what is saved',
      match: (p: string) => p.startsWith('/knowledge'),
    },
    {
      href: '/activity',
      label: 'Activity',
      icon: Activity,
      hint: 'What was captured, analysed and saved',
      match: (p: string) => p.startsWith('/activity'),
    },
  ];

  return (
    <nav
      aria-label="Sections"
      className="flex min-w-0 flex-col border-b lg:w-56 lg:shrink-0 lg:border-b-0 lg:border-r"
    >
      <ul className="flex w-full gap-1 overflow-x-auto px-2 py-2 lg:w-auto lg:flex-col lg:gap-0.5 lg:px-3 lg:py-4">
        {nav.map((item) => {
          const active = item.match(pathname);
          const Icon = item.icon;
          return (
            <li key={item.href} className="shrink-0 lg:shrink">
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                title={item.hint}
                className={cn(
                  'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                  active
                    ? 'bg-secondary text-secondary-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                )}
              >
                <Icon className="size-4 shrink-0" aria-hidden />
                {item.label}
                {item.count ? (
                  <span
                    className="ml-auto rounded-full bg-warning px-1.5 py-px text-[0.6875rem] font-semibold tabular-nums text-warning-foreground"
                    title={item.countHint}
                  >
                    {item.count}
                    <span className="sr-only"> — {item.countHint}</span>
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
      <div className="mt-auto hidden space-y-2 px-4 pb-4 text-xs text-muted-foreground lg:block">
        {role === 'admin' ? (
          <Link
            href="/settings"
            className={cn(
              'flex items-center gap-2 rounded-md py-1 hover:text-foreground',
              pathname.startsWith('/settings') && 'text-foreground',
            )}
          >
            <Settings className="size-3.5" aria-hidden />
            Settings
          </Link>
        ) : null}
        <p>
          <span className="capitalize">{role}</span> · {canApprove ? 'can approve changes' : 'cannot approve changes'}
        </p>
      </div>
    </nav>
  );
}
