'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Activity,
  BookOpen,
  ClipboardCheck,
  FileText,
  Settings,
  Telescope,
} from 'lucide-react';
import { cn } from '@/lib/utils';

const NAV = [
  { href: '/briefs', label: 'Briefs', icon: FileText, hint: 'Generate and read briefs' },
  { href: '/research', label: 'Research', icon: Telescope, hint: 'Deep research on selected topics' },
  { href: '/review', label: 'Review', icon: ClipboardCheck, hint: 'Approve proposed changes' },
  { href: '/knowledge', label: 'Knowledge', icon: BookOpen, hint: 'Search and ask the knowledge base' },
  { href: '/activity', label: 'Activity', icon: Activity, hint: 'Runs, changes and costs' },
  { href: '/settings', label: 'Settings', icon: Settings, hint: 'Formats, context and budgets' },
];

/**
 * Primary navigation. A sidebar on large screens, a horizontal scroller on
 * mobile so the same five sections stay reachable one-handed.
 */
export function AppNav({ canApprove, role }: { canApprove: boolean; role: string }) {
  const pathname = usePathname();

  const isActive = (href: string): boolean =>
    pathname === href || pathname.startsWith(`${href}/`);

  return (
    <nav
      aria-label="Sections"
      className="min-w-0 border-b lg:w-56 lg:shrink-0 lg:border-b-0 lg:border-r"
    >
      <ul className="flex w-full gap-1 overflow-x-auto px-2 py-2 lg:w-auto lg:flex-col lg:gap-0.5 lg:px-3 lg:py-4">
        {NAV.map((item) => {
          const active = isActive(item.href);
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
              </Link>
            </li>
          );
        })}
      </ul>
      <div className="hidden px-4 pb-4 text-xs text-muted-foreground lg:block">
        <p className="font-medium capitalize">{role}</p>
        <p>{canApprove ? 'Can approve records' : 'Cannot approve records'}</p>
      </div>
    </nav>
  );
}
