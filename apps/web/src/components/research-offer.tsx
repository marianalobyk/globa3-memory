'use client';

import { useState } from 'react';
import { Telescope } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api, RequestFailed } from '@/lib/client';

interface Target {
  label: string;
  kind: 'person' | 'company' | 'project';
  entityId: string | null;
}

/**
 * The optional "Research this person / company / project" action.
 *
 * Never automatic. Choosing a name first shows what research will do -- spend
 * AI budget, possibly search external sources -- and only a second, explicit
 * confirmation starts it. The result arrives as its own proposal, separate from
 * this capture and its source.
 */
export function ResearchOffer({
  targets,
  captureId,
  canStart,
}: {
  targets: Target[];
  captureId: string | null;
  canStart: boolean;
}) {
  const [chosen, setChosen] = useState<Target | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (targets.length === 0 || !canStart) return null;

  const start = async () => {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ started: boolean; label: string; isMock: boolean; budgetWarnings: string[] }>(
        '/api/research/requests',
        {
          method: 'POST',
          json: {
            entityId: chosen.entityId,
            label: chosen.entityId ? null : chosen.label,
            targetType: chosen.entityId ? null : chosen.kind,
            captureId,
            acknowledgeCost: true,
          },
        },
      );
      setMessage(
        result.started
          ? `Research on ${result.label} has started${result.isMock ? ' (mock: no model is configured, so results will be synthetic)' : ''}. Its findings will arrive as a separate proposal.`
          : `Research on ${result.label} was already requested today.`,
      );
      setChosen(null);
    } catch (failure) {
      setError(failure instanceof RequestFailed ? failure.payload.error : 'Research could not be started.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-2 rounded-lg border p-4" aria-labelledby="research-offer">
      <h2 id="research-offer" className="flex items-center gap-2 text-sm font-semibold">
        <Telescope className="size-4 text-muted-foreground" aria-hidden />
        Research further (optional)
      </h2>
      <p className="text-xs text-muted-foreground">
        Nothing has been researched. The analysis used only this capture and what is already in memory.
      </p>
      <div className="flex flex-wrap gap-2">
        {targets.map((target) => (
          <Button
            key={`${target.kind}:${target.label}`}
            size="sm"
            variant={chosen === target ? 'default' : 'outline'}
            onClick={() => {
              setChosen(target);
              setMessage(null);
            }}
          >
            Research this {target.kind}: {target.label}
          </Button>
        ))}
      </div>
      {chosen ? (
        <div className="space-y-2 rounded-md border border-warning/40 bg-warning/5 p-3 text-sm">
          <p>
            Research on <span className="font-medium">{chosen.label}</span> uses AI budget and may search external
            sources. What it finds comes back as a separate proposal, with facts, inferences and recommendations kept
            apart, and nothing is saved until you approve it.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={start} loading={busy}>
              Start research
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setChosen(null)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      {message ? <p className="text-sm text-success">{message}</p> : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
