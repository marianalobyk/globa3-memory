'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarClock, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api, RequestFailed } from '@/lib/client';

export interface FormatOption {
  id: string;
  key: string;
  name: string;
  productLine: string;
  coverageHours: number;
  laneCount: number;
  timeZone: string;
  previewCoverage: string;
}

/**
 * Starts a brief run.
 *
 * Runs are manual by design in this version. The coverage window shown here is
 * computed server-side from the format's rules and the chosen date, so the
 * operator can see exactly which window the run will cover before starting it.
 */
export function GenerateBriefPanel({
  formats,
  today,
  timeZone,
}: {
  formats: FormatOption[];
  today: string;
  timeZone: string;
}) {
  const router = useRouter();
  const [formatId, setFormatId] = useState(formats[0]?.id ?? '');
  const [runDate, setRunDate] = useState(today);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const selected = formats.find((f) => f.id === formatId);

  const start = async (force: boolean) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api<{
        runId: string;
        created: boolean;
        budgetWarnings: string[];
        isMock: boolean;
      }>('/api/runs', {
        method: 'POST',
        json: { kind: 'brief', formatId, runDate, force },
      });

      if (!result.created) {
        setNotice(
          'A run already exists for this format and date, so it was not started again. Opening it now.',
        );
      }
      if (result.budgetWarnings.length > 0) {
        setNotice((prev) => [prev, ...result.budgetWarnings].filter(Boolean).join(' '));
      }
      router.push(`/activity/runs/${result.runId}`);
    } catch (failure) {
      setError(
        failure instanceof RequestFailed ? failure.payload.error : 'Could not start the run.',
      );
    } finally {
      setBusy(false);
    }
  };

  if (formats.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Generate a brief</CardTitle>
          <CardDescription>No formats are configured in this workspace yet.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Play className="size-4" />
          Generate a brief
        </CardTitle>
        <CardDescription>
          Each format keeps its own search lanes, sources, scoring and QA gate. Dates and coverage
          windows are computed here, never by the model.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="format">Format</Label>
          <Select value={formatId} onValueChange={setFormatId}>
            <SelectTrigger id="format">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {formats.map((format) => (
                <SelectItem key={format.id} value={format.id}>
                  {format.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="run-date">Run date</Label>
          <Input
            id="run-date"
            type="date"
            value={runDate}
            max={today}
            onChange={(event) => setRunDate(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Today in {timeZone} is {today}.
          </p>
        </div>

        {selected ? (
          <div className="rounded-md border bg-muted/40 p-3 text-xs">
            <p className="flex items-center gap-1.5 font-medium">
              <CalendarClock className="size-3.5" />
              Coverage window for {runDate}
            </p>
            <p className="mt-1 break-words font-mono text-[0.6875rem] leading-relaxed text-muted-foreground">
              {selected.previewCoverage}
            </p>
            <p className="mt-1.5 text-muted-foreground">
              {selected.coverageHours}h window · {selected.laneCount} mandatory research lanes ·{' '}
              {selected.timeZone}
            </p>
          </div>
        ) : null}

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {notice ? <p className="text-sm text-muted-foreground">{notice}</p> : null}

        <div className="flex flex-wrap gap-2">
          <Button onClick={() => start(false)} loading={busy}>
            Start run
          </Button>
          <Button variant="outline" onClick={() => start(true)} disabled={busy}>
            Run again
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          &ldquo;Start run&rdquo; will not create a second run for a format and date that already
          ran. Use &ldquo;Run again&rdquo; when you deliberately want a fresh one.
        </p>
      </CardContent>
    </Card>
  );
}
