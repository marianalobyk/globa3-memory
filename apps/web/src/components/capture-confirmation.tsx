'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ExternalLink, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CaptureTopicResearch, type CaptureResearchQuestion } from '@/components/capture-topic-research';
import type { ConfirmationView } from '@/lib/capture-confirmation';
import type { ContactResearchView } from '@/lib/capture-view';

interface Preflight {
  contactName: string;
  clues: { id: string; label: string; value: string; required: boolean }[];
  withheld: { label: string; inThisCapture: boolean }[];
  statement: string;
}

function repeatsLine(text: string, detail: string | null): boolean {
  if (!detail) return false;
  const normalise = (value: string) => value.replace(/\s+/g, ' ').replace(/[.!?]+$/, '').trim().toLowerCase();
  return normalise(text) === normalise(detail);
}

/**
 * The web review's default view of a capture: the same human summary and
 * actions as the phone. The individual records stay below, under "See
 * technical details", for advanced review and audit.
 */
export function CaptureConfirmation({
  proposalId,
  version,
  confirmation: c,
  research,
  canApprove,
  captureId,
  isMock,
  topicQuestions,
}: {
  proposalId: string;
  version: number;
  confirmation: ConfirmationView;
  research: ContactResearchView | null;
  canApprove: boolean;
  captureId: string;
  isMock: boolean;
  topicQuestions: CaptureResearchQuestion[];
}) {
  const router = useRouter();
  const [step, setStep] = useState<'summary' | 'preflight' | 'confirm'>('summary');
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [kept, setKept] = useState<Set<string>>(new Set());
  const [cost, setCost] = useState(false);
  const [disclosure, setDisclosure] = useState(false);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const post = async (key: string, json: Record<string, unknown>) => {
    setWorking(key);
    setError(null);
    try {
      const response = await fetch(`/api/mobile/proposals/${proposalId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(json),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error ?? 'That did not work. Try again.');
      return body;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'That did not work. Try again.');
      return null;
    } finally {
      setWorking(null);
    }
  };

  const chosenItemIds = (c.document?.groups ?? [])
    .flatMap((group) => group.lines)
    .filter((l) => l.optional && l.itemId && chosen.has(l.itemId))
    .flatMap((l) => l.optional!.itemIds);
  const saveItemIds = [...new Set([...c.save.itemIds, ...chosenItemIds])];
  const decisionCount = (c.document?.groups.find((g) => g.key === 'save')?.lines.length ?? 0) + chosen.size;

  const contact = c.contact;
  const status = research?.status ?? 'not_started';
  const canResearch = canApprove && contact !== null && ['not_started', 'no_reliable_match', 'none_of_these', 'needs_context', 'failed'].includes(status);
  const canSave = canApprove && c.save.itemIds.length > 0 && !['researching', 'choose_identity'].includes(c.status);

  if (step === 'confirm') {
    return (
      <section className="space-y-4 rounded-lg border p-5" aria-labelledby="confirm-save">
        <h2 id="confirm-save" className="text-lg font-semibold">You are about to save</h2>
        <ul className="list-disc space-y-1 pl-5">
          {c.save.lines.map((line) => <li key={line}>{line}</li>)}
        </ul>
        {c.save.optional.length > 0 ? (
          <div>
            <p className="text-sm font-medium text-muted-foreground">Also</p>
            <ul className="list-disc space-y-1 pl-5">
              {c.save.optional.map((line) => <li key={line}>{line}</li>)}
            </ul>
          </div>
        ) : null}
        {c.save.keepsNote ? (
          <p className="text-sm text-muted-foreground">
            {c.kind === 'document' ? 'Your document is kept privately as the source.' : 'Your note is kept with them, privately.'}
          </p>
        ) : null}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={working !== null}
            onClick={async () => {
              const done = await post('save', { action: 'approve', expectedVersion: version, itemIds: saveItemIds, closeRest: true });
              if (done) {
                setStep('summary');
                router.refresh();
              }
            }}
          >
            {working === 'save' ? <Loader2 className="animate-spin" /> : null}
            Confirm and save
          </Button>
          <Button variant="ghost" onClick={() => setStep('summary')}>Back</Button>
        </div>
      </section>
    );
  }

  if (step === 'preflight' && preflight && contact) {
    return (
      <section className="space-y-4 rounded-lg border p-5" aria-labelledby="preflight">
        <h2 id="preflight" className="text-lg font-semibold">Research {preflight.contactName}?</h2>
        <div>
          <p className="text-sm font-medium">What will be used to identify this person</p>
          {preflight.clues.map((clue) => (
            <label key={clue.id} className="flex items-center gap-2 py-1 text-sm">
              <input
                type="checkbox"
                checked={clue.required || kept.has(clue.id)}
                disabled={clue.required}
                onChange={() => setKept((current) => { const next = new Set(current); if (next.has(clue.id)) next.delete(clue.id); else next.add(clue.id); return next; })}
              />
              {clue.label}: {clue.value}{clue.required ? ' (always used)' : ''}
            </label>
          ))}
        </div>
        <div>
          <p className="text-sm font-medium">What will not be sent to public web search</p>
          <ul className="list-disc pl-5 text-sm text-muted-foreground">
            {preflight.withheld.map((w) => <li key={w.label}>{w.label}</li>)}
          </ul>
        </div>
        <p className="rounded-md bg-warning/10 p-3 text-sm">{preflight.statement}</p>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={cost} onChange={() => setCost(!cost)} /> I understand this uses AI budget.</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={disclosure} onChange={() => setDisclosure(!disclosure)} /> Use only the clues selected above for external search.</label>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={!cost || !disclosure || working !== null}
            onClick={async () => {
              const clueIds = preflight.clues.filter((x) => !x.required && kept.has(x.id)).map((x) => x.id);
              const done = await post('research', { action: 'research', contactKey: contact.key, acknowledgeCost: true, acknowledgeDisclosure: true, clueIds });
              if (done) {
                setStep('summary');
                router.refresh();
              }
            }}
          >
            Find who this is
          </Button>
          <Button variant="ghost" onClick={() => setStep('summary')}>Cancel</Button>
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-4" aria-labelledby="understood">
      <h2 id="understood" className="text-lg font-semibold">Here is what I understood</h2>
      {c.document ? (
        <div className="space-y-4">
          <div className="space-y-2 rounded-lg border p-5">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Document</p>
            <p className="text-xl font-semibold">{c.document.title}</p>
            <p className="text-sm text-muted-foreground">{c.document.readAs}</p>
            <p className="font-medium">{c.document.headline}</p>
            {isMock ? <p className="text-xs text-muted-foreground">Made without a live AI model (mock), for testing only.</p> : null}
          </div>
          {c.document.groups.map((group) => (
            <div key={group.key} className="space-y-1 rounded-lg border p-4">
              <p className="font-semibold">
                {group.label} ({group.lines.length})
              </p>
              <p className="text-sm text-muted-foreground">{group.why}</p>
              <ul className="space-y-2 pt-2">
                {group.lines.map((l, index) => (
                  <li key={`${l.text}-${index}`}>
                    <p>{l.text}</p>
                    {l.detail && !repeatsLine(l.text, l.detail) ? <p className="text-sm text-muted-foreground">{l.detail}</p> : null}
                    {l.optional && l.itemId ? (
                      <label className="mt-1 flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={chosen.has(l.itemId)}
                          onChange={() =>
                            setChosen((current) => {
                              const next = new Set(current);
                              if (next.has(l.itemId as string)) next.delete(l.itemId as string);
                              else next.add(l.itemId as string);
                              return next;
                            })
                          }
                        />
                        {l.optional.toggleLabel}
                      </label>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : null}
      <div className={`space-y-4 rounded-lg border p-5${c.document ? ' hidden' : ''}`}>
        {contact ? (
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{contact.label}</p>
            <p className="text-2xl font-semibold">{contact.name}</p>
            {contact.line ? <p>{contact.line}</p> : null}
            {contact.similarTo.length ? (
              <p className="text-sm text-muted-foreground">Similar to {contact.similarTo.join(', ')} in your contacts. Kept separate until you confirm who this is.</p>
            ) : null}
          </div>
        ) : (
          <p>{c.summary}</p>
        )}
        {contact && c.context ? <Field label="Context">{c.context}</Field> : null}
        {c.followUps.length ? <Field label="Follow-up">{c.followUps.join('; ')}</Field> : null}
        {c.others.length ? <Field label="Also in your note">{c.others.join(', ')}</Field> : null}
        {c.missing ? <Field label="Still missing"><span className="text-muted-foreground">{c.missing}</span></Field> : null}
        {isMock ? <p className="text-xs text-muted-foreground">Made without a live AI model (mock), for testing only.</p> : null}
      </div>

      {c.status === 'researching' ? (
        <p className="flex items-center gap-2 text-sm"><Loader2 className="size-4 animate-spin" /> Research in progress. Reload in a moment.</p>
      ) : null}

      {c.status === 'choose_identity' && research && contact ? (
        <div className="space-y-3">
          <h3 className="font-semibold">Is this the {contact.name} you met?</h3>
          {research.candidates.map((candidate) => (
            <div key={candidate.index} className="space-y-1 rounded-lg border p-4">
              <p className="font-medium">{candidate.name}</p>
              <p className="text-sm">{[candidate.role, candidate.organization, candidate.location].filter(Boolean).join(' · ')}</p>
              {candidate.nameOnly ? <Badge variant="warning">Only the name matches your note</Badge> : null}
              <p className="text-sm text-muted-foreground">{candidate.explanation}</p>
              <details className="text-sm">
                <summary className="cursor-pointer text-primary">See sources</summary>
                {candidate.sources.map((s) => <a key={s.url} className="block break-all underline" href={s.url} target="_blank" rel="noreferrer">{s.title ?? s.url}</a>)}
              </details>
              <Button size="sm" variant={candidate.nameOnly ? 'outline' : 'default'} disabled={working !== null}
                onClick={async () => { if (await post(`confirm:${candidate.index}`, { action: 'confirm_identity', contactKey: contact.key, choice: candidate.index })) router.refresh(); }}>
                This is the person
              </Button>
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={working !== null}
              onClick={async () => { if (await post('none', { action: 'confirm_identity', contactKey: contact.key, choice: 'none' })) router.refresh(); }}>
              None of these
            </Button>
            <Button asChild variant="ghost"><Link href={`/capture?edit=${captureId}`}>Edit my note instead</Link></Button>
          </div>
        </div>
      ) : null}

      {['no_reliable_match', 'none_of_these', 'failed'].includes(status) && c.status !== 'choose_identity' ? (
        <p className="rounded-md bg-warning/10 p-3 text-sm">
          {status === 'no_reliable_match' ? 'No reliable public match. Nothing was researched.' : status === 'none_of_these' ? 'You said none of them was the person. Nothing was researched.' : 'Research stopped before it finished. Nothing from it was added.'}
        </p>
      ) : null}

      {c.researchFound ? (
        <details open className="rounded-lg border p-4">
          <summary className="cursor-pointer font-medium">Research found</summary>
          <div className="mt-3 space-y-2 text-sm">
            {c.researchFound.confirmedAs ? <p>Confirmed role: {c.researchFound.confirmedAs}</p> : null}
            {c.researchFound.profiles.map((p) => <a key={p.url} href={p.url} target="_blank" rel="noreferrer" className="flex items-center gap-1 underline">{p.label}<ExternalLink className="size-3" /></a>)}
            {c.researchFound.facts.map((f) => <p key={f.text}>{f.text}</p>)}
            {c.researchFound.readings.map((r) => (
              <div key={r.text}>
                <Badge variant={r.label === 'Inference' ? 'warning' : 'secondary'}>{r.label}</Badge>
                <p>{r.text}</p>
                {r.basis ? <p className="text-muted-foreground">{r.label === 'Inference' ? 'Based on' : 'Why'}: {r.basis}</p> : null}
              </div>
            ))}
            <details>
              <summary className="cursor-pointer text-primary">See sources</summary>
              {[...new Set([...c.researchFound.facts.flatMap((f) => f.sources), ...c.researchFound.readings.flatMap((r) => r.sources)])].map((url) => (
                <a key={url} href={url} target="_blank" rel="noreferrer" className="block break-all underline">{url}</a>
              ))}
            </details>
          </div>
        </details>
      ) : null}

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {c.status === 'saved' ? (
        <div className="space-y-4">
          <p className="rounded-md bg-success/10 p-3 text-sm">{contact ? `${contact.name} is saved.` : 'Saved.'}</p>
          <CaptureTopicResearch proposalId={proposalId} questions={topicQuestions} canApprove={canApprove} />
        </div>
      ) : c.status === 'researching' || c.status === 'choose_identity' ? null : canApprove ? (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            {canSave ? (
              <Button onClick={() => setStep('confirm')}>
                {c.document ? `Save ${decisionCount} item${decisionCount === 1 ? '' : 's'}` : c.primaryActionLabel}
              </Button>
            ) : null}
            {canResearch ? (
              <Button
                variant="outline"
                disabled={working !== null}
                onClick={async () => {
                  const body = await post('preflight', { action: 'research_preflight', contactKey: contact!.key });
                  if (body?.preflight) {
                    setPreflight(body.preflight);
                    setKept(new Set(body.preflight.clues.map((x: { id: string }) => x.id)));
                    setCost(false);
                    setDisclosure(false);
                    setStep('preflight');
                  }
                }}
              >
                {status === 'not_started' ? 'Research this person first' : 'Research again'}
              </Button>
            ) : null}
            <Button asChild variant="ghost"><Link href={`/capture?edit=${captureId}`}>Edit</Link></Button>
            <Button
              variant="ghost"
              disabled={working !== null}
              onClick={async () => {
                if (await post('reanalyse', { action: 'reanalyse' })) router.refresh();
              }}
            >
              {c.kind === 'document' ? 'Read this document again' : 'Read this note again'}
            </Button>
          </div>
          {canSave ? <p className="text-sm text-muted-foreground">Nothing is saved until you confirm.</p> : null}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Your role can read this capture but not save it.</p>
      )}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <p>{children}</p>
    </div>
  );
}
