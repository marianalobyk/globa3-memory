import Link from 'next/link';
import { FileQuestion } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 p-8 text-center">
      <FileQuestion className="size-8 text-muted-foreground" />
      <div>
        <h1 className="text-lg font-semibold">Page not found</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          That page does not exist, or it belongs to a workspace you cannot see.
        </p>
      </div>
      <Button asChild variant="outline">
        <Link href="/">Back to Today</Link>
      </Button>
    </main>
  );
}
