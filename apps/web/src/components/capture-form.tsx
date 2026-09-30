'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Paperclip, Send, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import { api, RequestFailed } from '@/lib/client';
import { cn } from '@/lib/utils';

/**
 * The capture box: one field for anything.
 *
 * A note, a pasted link, or a file. No record type to choose, no form to fill:
 * the analysis proposes what it should become, and a person approves it. The
 * source is stored privately; nothing reaches knowledge from here.
 */
export function CaptureForm({
  variant = 'full',
  initialText = '',
  replacesCaptureId,
  autoFocus = false,
}: {
  variant?: 'full' | 'compact';
  initialText?: string;
  replacesCaptureId?: string;
  autoFocus?: boolean;
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(initialText);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const compact = variant === 'compact';
  const ready = text.trim().length > 0 || file !== null;

  const submit = async (event?: React.FormEvent) => {
    event?.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('text', text);
      if (file) form.append('file', file);
      if (replacesCaptureId) form.append('replacesCaptureId', replacesCaptureId);
      const result = await api<{ captureId: string; created: boolean }>('/api/captures', {
        method: 'POST',
        body: form,
      });
      setText('');
      setFile(null);
      router.push(`/capture/${result.captureId}`);
      router.refresh();
    } catch (failure) {
      setError(failure instanceof RequestFailed ? failure.payload.error : 'The capture could not be saved.');
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className={cn('space-y-2', compact && 'space-y-1.5')}>
      <Textarea
        id={compact ? 'capture-quick' : 'capture-text'}
        value={text}
        onChange={(event) => setText(event.target.value)}
        autoFocus={autoFocus}
        placeholder={
          compact
            ? 'Add anything… a note from a call, a link, a name'
            : 'Add anything. Paste a note from a meeting, a link, or write what just happened — no need to decide what kind of record it is.'
        }
        className={cn('w-full resize-y', compact ? 'min-h-[52px] text-base' : 'min-h-[132px] text-base')}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void submit();
        }}
      />

      {file ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Paperclip className="size-3.5" aria-hidden />
          <span className="min-w-0 truncate">{file.name}</span>
          <button type="button" onClick={() => setFile(null)} className="text-foreground underline underline-offset-2">
            <X className="size-3" aria-hidden />
            <span className="sr-only">Remove the attached file</span>
          </button>
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" loading={busy} disabled={!ready}>
          <Send />
          {replacesCaptureId ? 'Capture again' : 'Capture'}
        </Button>
        <Button type="button" variant="outline" onClick={() => fileRef.current?.click()} disabled={busy}>
          <Paperclip />
          Attach
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".md,.markdown,.txt,.pdf"
          className="hidden"
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
        />
        <p className="order-last w-full text-xs text-muted-foreground sm:order-none sm:w-auto">
          Stored privately as a source. Nothing is saved to knowledge until you approve it.
        </p>
      </div>
    </form>
  );
}
