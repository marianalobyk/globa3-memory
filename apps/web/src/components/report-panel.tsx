'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { FileDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';
import { Markdown } from '@/components/markdown';
import { api, RequestFailed } from '@/lib/client';

/**
 * Builds the daily change report.
 *
 * The report is rendered from applied_changes only, so it describes what was
 * actually written, who approved it, and which brief it came from.
 */
export function ReportPanel({ timeZone }: { timeZone: string }) {
  const router = useRouter();
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ bodyMd: string; changeCount: number } | null>(null);

  const build = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ bodyMd: string; changeCount: number }>('/api/reports', {
        method: 'POST',
        json: { reportDate: date },
      });
      setPreview(result);
      router.refresh();
    } catch (failure) {
      setError(
        failure instanceof RequestFailed ? failure.payload.error : 'Could not build the report.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <FileDown className="size-4" />
          Daily change report
        </CardTitle>
        <CardDescription>
          A Markdown record of the concrete changes made on a date, with the approver and the brief
          each change came from. Day boundaries use the workspace timezone ({timeZone}).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1.5">
            <Label htmlFor="report-date">Date</Label>
            <Input
              id="report-date"
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
              className="w-auto"
            />
          </div>
          <Button onClick={build} loading={busy}>
            Build report
          </Button>
        </div>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {preview ? (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              {preview.changeCount} change(s) on {date}.
            </p>
            <div className="max-h-96 overflow-y-auto rounded-md border p-4">
              <Markdown>{preview.bodyMd}</Markdown>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
