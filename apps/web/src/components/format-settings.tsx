'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Save, Settings2 } from 'lucide-react';
import type { FormatConfig } from '@g3/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';
import { api, RequestFailed } from '@/lib/client';
import { titleCase } from '@/lib/utils';

/**
 * One format's rules, shown as the code actually consumes them: lanes, source
 * tiers, scoring rubric, thresholds, freshness vocabulary, window shape, reader
 * structure and QA checks.
 *
 * Editable here: the models. The rule set itself is versioned in the repository
 * and in prompt_versions, so it is changed as a reviewed diff rather than by
 * free-typing into a production form.
 */
export function FormatSettings({
  formatId,
  formatKey,
  name,
  productLine,
  defaultModel,
  researchModel,
  config,
  canEdit,
}: {
  formatId: string;
  formatKey: string;
  name: string;
  productLine: string | null;
  defaultModel: string | null;
  researchModel: string | null;
  config: FormatConfig;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState(defaultModel ?? '');
  const [researchDraft, setResearchDraft] = useState(researchModel ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [open, setOpen] = useState(false);

  const save = async () => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api('/api/formats', {
        method: 'PATCH',
        json: {
          formatId,
          defaultModel: draft.trim() === '' ? null : draft.trim(),
          researchModel: researchDraft.trim() === '' ? null : researchDraft.trim(),
        },
      });
      setSaved(true);
      router.refresh();
    } catch (failure) {
      setError(failure instanceof RequestFailed ? failure.payload.error : 'Could not save.');
    } finally {
      setBusy(false);
    }
  };

  const automatedChecks = config.qaChecks.filter((c) => c.automated).length;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="text-sm">{name}</CardTitle>
            <CardDescription>
              <code className="font-mono text-xs">{formatKey}</code>
              {productLine ? ` · ${productLine}` : ''}
            </CardDescription>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setOpen((v) => !v)}>
            <Settings2 />
            {open ? 'Hide rules' : 'Show rules'}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4 [&>*]:min-w-0">
          <Fact label="Coverage window" value={`${config.windowShape.coverageHours}h`} />
          <Fact label="Timezone" value={config.windowShape.timeZone} />
          <Fact
            label="Backstop"
            value={config.windowShape.backstopHours ? `${config.windowShape.backstopHours}h` : '—'}
          />
          <Fact
            label="Rolling context"
            value={
              config.windowShape.rollingContextDays
                ? `${config.windowShape.rollingContextDays}d`
                : '—'
            }
          />
          <Fact label="Research lanes" value={String(config.researchLanes.length)} />
          <Fact label="Source families" value={String(config.sourceFamilies.length)} />
          <Fact label="Reader sections" value={String(config.readerSections.length)} />
          <Fact
            label="QA checks"
            value={`${config.qaChecks.length} (${automatedChecks} in code)`}
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2 [&>*]:min-w-0">
          <div className="space-y-1.5">
            <Label htmlFor={`model-${formatId}`}>Drafting model</Label>
            <Input
              id={`model-${formatId}`}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Inherit from OPENAI_MODEL"
              disabled={!canEdit}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`research-model-${formatId}`}>Research model</Label>
            <Input
              id={`research-model-${formatId}`}
              value={researchDraft}
              onChange={(event) => setResearchDraft(event.target.value)}
              placeholder="Inherit from OPENAI_RESEARCH_MODEL"
              disabled={!canEdit}
            />
          </div>
        </div>

        {canEdit ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={save} loading={busy}>
              <Save />
              Save models
            </Button>
            {saved ? <span className="text-xs text-success">Saved.</span> : null}
            {error ? <span className="text-xs text-destructive">{error}</span> : null}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            Only a workspace admin can change format settings.
          </p>
        )}

        {open ? (
          <div className="space-y-4 rounded-md border bg-muted/30 p-4 text-xs">
            <Section title="Mandatory research lanes">
              <ul className="space-y-1">
                {config.researchLanes.map((lane) => (
                  <li key={lane.key}>
                    <span className="font-medium">
                      {lane.key}. {lane.label}
                    </span>
                    <span className="text-muted-foreground"> — {lane.detail}</span>
                  </li>
                ))}
              </ul>
            </Section>

            <Section title="Source families">
              <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
                {config.sourceFamilies.map((family, index) => (
                  <li key={index}>{family}</li>
                ))}
              </ul>
            </Section>

            <Section title="Source tiers and rules">
              <ul className="space-y-1">
                {config.sourceTiers.map((tier) => (
                  <li key={tier.tier}>
                    <span className="font-medium">{tier.label}</span>
                    <span className="text-muted-foreground"> — {tier.detail}</span>
                  </li>
                ))}
              </ul>
              <ul className="mt-2 list-disc space-y-0.5 pl-4 text-muted-foreground">
                {config.sourceRules.map((rule, index) => (
                  <li key={index}>{rule}</li>
                ))}
              </ul>
            </Section>

            <Section title="Scoring and thresholds">
              <ul className="space-y-0.5">
                {config.scoring.dimensions.map((dimension) => (
                  <li key={dimension.key}>
                    <span className="font-medium">{dimension.label}</span>
                    <span className="text-muted-foreground"> 0–{dimension.max}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-muted-foreground">
                Maximum {config.scoring.maxScore}. Scores are never shown to the reader.
              </p>
              <ul className="mt-2 space-y-0.5">
                {config.thresholds.map((threshold) => (
                  <li key={threshold.tier}>
                    <Badge variant="outline">{threshold.tier}</Badge>{' '}
                    <span className="text-muted-foreground">
                      {threshold.minScore}–{threshold.maxScore}
                      {threshold.requires ? ` · requires ${threshold.requires.join(', ')}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </Section>

            <Section title="Freshness labels">
              <ul className="space-y-0.5">
                {config.freshnessLabels.map((label) => (
                  <li key={label.key}>
                    <code className="font-mono">{label.key}</code>{' '}
                    <span className="text-muted-foreground">
                      {label.label}
                      {label.elevatable ? '' : ' — may not be elevated'}
                    </span>
                  </li>
                ))}
              </ul>
            </Section>

            <Section title="Reader structure">
              <ol className="list-decimal space-y-0.5 pl-4 text-muted-foreground">
                {config.readerSections.map((section) => (
                  <li key={section.key}>
                    {section.heading}
                    {section.required ? '' : ' (optional)'}
                  </li>
                ))}
              </ol>
            </Section>

            <Section title="QA and release gate">
              <ul className="space-y-1">
                {config.qaChecks.map((check) => (
                  <li key={check.key} className="flex flex-wrap items-start gap-1.5">
                    <Badge
                      variant={
                        check.severity === 'critical'
                          ? 'destructive'
                          : check.severity === 'major'
                            ? 'warning'
                            : 'muted'
                      }
                    >
                      {check.severity}
                    </Badge>
                    <Badge variant="outline">{check.automated ? 'code' : 'review'}</Badge>
                    <span className="min-w-0 flex-1 text-muted-foreground">{check.assertion}</span>
                  </li>
                ))}
              </ul>
            </Section>

            <Section title="External-use statuses">
              <ul className="space-y-0.5">
                {config.externalUseStatuses.map((status) => (
                  <li key={status.key}>
                    <span className="font-medium">{titleCase(status.key)}</span>
                    <span className="text-muted-foreground"> — {status.detail}</span>
                  </li>
                ))}
              </ul>
            </Section>

            <p className="text-muted-foreground">
              These rules are versioned in the repository and in{' '}
              <code className="font-mono">prompt_versions</code>, so a change is a reviewable diff
              rather than an untracked edit to a live form.
            </p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-background p-2">
      <p className="text-muted-foreground">{label}</p>
      <p className="mt-0.5 font-medium">{value}</p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1 font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>
      {children}
    </div>
  );
}
