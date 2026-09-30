import { useState, type ReactNode } from 'react';
import { ActivityIndicator, Linking, Pressable, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import * as api from '@/api';
import type { Confirmation, DocumentLine, DocumentReview, IdentityCandidate, ProposalView, ProposedChange, ResearchPreflight } from '@/types';
import { useLoad } from '@/use-load';
import { Body, Button, Card, ErrorNote, Heading, Loading, Pill, Screen, Small, usePalette } from '@/ui';

/**
 * Capture confirmation: "Here is what I understood", then what next.
 *
 *   summary  -> one card: who, their role, what happened, what is missing.
 *               Save contact / Research this person first / Edit.
 *   research -> privacy and cost preflight, then "Is this the X you met?".
 *               Results come back into the same summary under "Research found".
 *   confirm  -> "You are about to save ..." and one Confirm and save.
 *
 * The person never sees records, findings, links or dependencies unless they
 * open "See technical details". What "Save contact" keeps is decided by the
 * server (confirmation.save) and approved against the exact version shown.
 */
type Step = 'summary' | 'preflight' | 'confirm';

export default function ProposalScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  // Polls only while identity search or research is running.
  const { data, setData, error, reload } = useLoad<ProposalView>(() => api.getProposal(String(id)), {
    pollWhile: (view) => view.researchActive,
    intervalMs: 2500,
  });
  const [step, setStep] = useState<Step>('summary');
  const [preflight, setPreflight] = useState<ResearchPreflight | null>(null);
  /** Optional items the person turned on. Off by default, always. */
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [working, setWorking] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  if (!data) return error ? <Screen><ErrorNote message={error} /></Screen> : <Loading label="Opening" />;
  const c = data.confirmation;
  if (!c) return <TechnicalOnly data={data} />;

  const act = async (key: string, run: () => Promise<{ proposal: ProposalView | null } | void>) => {
    setWorking(key);
    setActionError(null);
    try {
      const result = await run();
      if (result && result.proposal) setData(result.proposal);
      else if (!result) void reload();
    } catch (failure) {
      setActionError(failure instanceof api.ApiError ? failure.message : 'That did not work. Try again.');
    } finally {
      setWorking(null);
    }
  };

  // What "Save" would keep: the default set, plus any optional item turned on.
  const chosenItemIds = (c.document?.groups ?? [])
    .flatMap((group) => group.lines)
    .filter((l) => l.optional && l.itemId && chosen.has(l.itemId))
    .flatMap((l) => l.optional!.itemIds);
  const saveItemIds = [...new Set([...c.save.itemIds, ...chosenItemIds])];
  const decisionCount = (c.document?.groups.find((g) => g.key === 'save')?.lines.length ?? 0) + chosen.size;

  const contact = c.contact;
  const research = data.contacts.find((x) => x.key === contact?.key)?.research ?? null;
  const researchStatus = research?.status ?? 'not_started';
  const canResearch =
    data.canApprove &&
    c.canResearch &&
    ['not_started', 'no_reliable_match', 'none_of_these', 'needs_context', 'failed'].includes(researchStatus);
  // After a search that found nobody, offering "Research again" unchanged would
  // just repeat it: the way forward is to save as is, or add more detail first.
  const noMatch = researchStatus === 'no_reliable_match' || researchStatus === 'none_of_these';
  const canSave = data.canApprove && c.save.itemIds.length > 0 && !['researching', 'choose_identity'].includes(c.status);
  const editCapture = () =>
    data.capture ? router.push({ pathname: '/capture', params: { edit: data.capture.id } }) : undefined;

  const openPreflight = () =>
    act('preflight', async () => {
      if (!contact) return { proposal: null };
      setPreflight(await api.researchPreflight(data.id, contact.key));
      setStep('preflight');
      return { proposal: null };
    });

  const confirmSave = () =>
    act('save', async () => {
      const result = await api.approveChanges(data.id, data.version, saveItemIds, { closeRest: true });
      router.replace(`/saved/${data.id}`);
      return result;
    });

  // -- Final confirmation --------------------------------------------------
  if (step === 'confirm') {
    return (
      <Screen>
        <Heading>You are about to save</Heading>
        <Card style={{ gap: 10 }}>
          <Bullets items={c.save.lines} />
          {chosen.size > 0 ? (
            <>
              <Small style={{ fontWeight: '600' }}>You also chose to keep</Small>
              <Bullets
                items={(c.document?.groups ?? [])
                  .flatMap((group) => group.lines)
                  .filter((l) => l.itemId && chosen.has(l.itemId))
                  .map((l) => l.text)}
              />
            </>
          ) : null}
          {c.save.optional.length > 0 ? (
            <>
              <Small style={{ fontWeight: '600' }}>Also</Small>
              <Bullets items={c.save.optional} />
            </>
          ) : null}
          {c.save.keepsNote ? (
            <Small>{c.kind === 'document' ? 'Your document is kept privately as the source.' : 'Your note is kept with them, privately.'}</Small>
          ) : null}
        </Card>
        <ErrorNote message={actionError} />
        <Button
          label={c.document ? `Confirm and save ${decisionCount} item${decisionCount === 1 ? '' : 's'}` : 'Confirm and save'}
          busy={working === 'save'}
          disabled={working !== null}
          onPress={confirmSave}
        />
        <Button label="Back" variant="quiet" disabled={working !== null} onPress={() => setStep('summary')} />
        <TechnicalDetails data={data} included={new Set(saveItemIds)} />
      </Screen>
    );
  }

  // -- Research preflight --------------------------------------------------
  if (step === 'preflight' && preflight && contact) {
    return (
      <Screen>
        <ResearchPreflightCard
          preflight={preflight}
          busy={working === 'research'}
          onCancel={() => setStep('summary')}
          onStart={(clueIds) =>
            act('research', async () => {
              const result = await api.researchContact(data.id, contact.key, clueIds);
              setStep('summary');
              return result;
            })
          }
        />
        <ErrorNote message={actionError} />
      </Screen>
    );
  }

  // -- "Here is what I understood" ------------------------------------------
  return (
    <Screen>
      <Heading>Here is what I understood</Heading>
      {c.document ? (
        <DocumentCard
          document={c.document}
          isMock={data.isMock}
          chosen={chosen}
          onToggle={(itemId) =>
            setChosen((current) => {
              const next = new Set(current);
              if (next.has(itemId)) next.delete(itemId);
              else next.add(itemId);
              return next;
            })
          }
        />
      ) : (
        <SummaryCard confirmation={c} isMock={data.isMock} />
      )}

      {c.status === 'researching' ? (
        <Card>
          <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
            <ActivityIndicator />
            <Body style={{ flex: 1 }}>
              {researchStatus === 'identifying'
                ? `Looking for who ${contact?.name ?? 'this'} is, using only the clues you kept…`
                : `Researching ${research?.confirmed?.name ?? contact?.name ?? 'this person'}…`}
            </Body>
          </View>
        </Card>
      ) : null}

      {c.status === 'choose_identity' && research && contact ? (
        <View style={{ gap: 10 }}>
          <Heading>Is this the {contact.name} you met?</Heading>
          {research.candidates.map((candidate) => (
            <CandidateCard
              key={candidate.index}
              candidate={candidate}
              busy={working === `confirm:${candidate.index}`}
              disabled={working !== null}
              onConfirm={() => act(`confirm:${candidate.index}`, () => api.confirmIdentity(data.id, contact.key, candidate.index))}
            />
          ))}
          <Button
            label="None of these"
            variant="secondary"
            busy={working === 'none'}
            disabled={working !== null}
            onPress={() => act('none', () => api.confirmIdentity(data.id, contact.key, 'none'))}
          />
          <Button
            label="Edit my note instead"
            variant="quiet"
            disabled={working !== null}
            onPress={() =>
              act('context', async () => {
                const result = await api.confirmIdentity(data.id, contact.key, 'needs_context');
                editCapture();
                return result;
              })
            }
          />
        </View>
      ) : null}

      {noMatch && c.status !== 'choose_identity' ? (
        <Card tone="warn" style={{ gap: 6 }}>
          <Body style={{ fontWeight: '600' }}>
            {researchStatus === 'no_reliable_match'
              ? 'We could not confidently identify this person from public information.'
              : 'You said none of them was the person you met.'}
          </Body>
          <Small>Nothing was researched, and nothing was added to this capture.</Small>
        </Card>
      ) : null}
      {researchStatus === 'failed' && c.status !== 'choose_identity' ? (
        <Card tone="warn">
          <Small>Research stopped before it finished. Nothing from it was added.</Small>
        </Card>
      ) : null}

      {c.researchFound ? <ResearchFound found={c.researchFound} /> : null}

      <ErrorNote message={actionError} />

      {c.status === 'researching' || c.status === 'choose_identity' ? null : c.status === 'saved' ? (
        <Button label="See what was saved" onPress={() => router.push(`/saved/${data.id}`)} />
      ) : !data.canApprove ? (
        <Small>Your role can read this capture but not save it.</Small>
      ) : (
        <View style={{ gap: 8 }}>
          {canSave ? (
            <Button
              label={
                c.document
                  ? `Save ${decisionCount} item${decisionCount === 1 ? '' : 's'}`
                  : noMatch
                    ? 'Save contact without research'
                    : c.primaryActionLabel
              }
              disabled={working !== null}
              onPress={() => setStep('confirm')}
            />
          ) : null}
          {canResearch && noMatch ? (
            <Button
              label="Add more details and try again"
              variant="secondary"
              disabled={working !== null}
              onPress={editCapture}
            />
          ) : canResearch ? (
            <Button
              label="Research this person"
              variant="secondary"
              busy={working === 'preflight'}
              disabled={working !== null}
              onPress={openPreflight}
            />
          ) : null}
          <EditChoice
            isDocument={c.kind === 'document'}
            onEdit={editCapture}
            onReanalyse={() =>
              act('reanalyse', async () => {
                const again = await api.reanalyseProposal(data.id);
                router.replace(`/capture/${again.captureId}`);
                return { proposal: null };
              })
            }
            onDiscard={() => act('discard', async () => { await api.discardProposal(data.id); router.replace('/'); return { proposal: null }; })}
            busy={working === 'discard'}
          />
          {canSave ? <Small style={{ textAlign: 'center' }}>Nothing is saved until you confirm.</Small> : null}
        </View>
      )}
    </Screen>
  );
}
/**
 * Material you captured, not a person you met: what it is, what it changes, and
 * what stays in the document. Four groups, in the order a person decides.
 */
function DocumentCard({
  document,
  isMock,
  chosen,
  onToggle,
}: {
  document: DocumentReview;
  isMock: boolean;
  chosen: Set<string>;
  onToggle: (itemId: string) => void;
}) {
  const p = usePalette();
  const TONE: Record<string, string> = { save: p.ink, research: p.accent, source_only: p.muted, unclear: p.warnInk };
  return (
    <View style={{ gap: 12 }}>
      <Card style={{ gap: 8, paddingVertical: 18 }}>
        <Text style={{ fontSize: 12, fontWeight: '700', letterSpacing: 0.5, color: p.muted, textTransform: 'uppercase' }}>
          Document
        </Text>
        <Text style={{ fontSize: 20, fontWeight: '700', color: p.ink }}>{document.title}</Text>
        <Small>{document.readAs}</Small>
        <Body style={{ fontWeight: '600' }}>{document.headline}</Body>
        {isMock ? <Small>Made without a live AI model (mock), for testing only.</Small> : null}
      </Card>
      {document.groups.map((group) => (
        <Card key={group.key} style={{ gap: 6 }}>
          <Text style={{ fontSize: 15, fontWeight: '700', color: TONE[group.key] ?? p.ink }}>
            {group.label} ({group.lines.length})
          </Text>
          <Small>{group.why}</Small>
          {group.lines.map((line, index) => (
            <DocumentLineView
              key={`${line.text}-${index}`}
              line={line}
              on={Boolean(line.itemId && chosen.has(line.itemId))}
              onToggle={onToggle}
            />
          ))}
        </Card>
      ))}
    </View>
  );
}

/** One line of a document review. An optional line is a choice, off by default. */
function DocumentLineView({ line, on, onToggle }: { line: DocumentLine; on: boolean; onToggle: (itemId: string) => void }) {
  const p = usePalette();
  if (!line.optional || !line.itemId) {
    return (
      <View style={{ gap: 2, paddingTop: 6 }}>
        <Body>{line.text}</Body>
        {line.detail ? <Small>{line.detail}</Small> : null}
      </View>
    );
  }
  const itemId = line.itemId;
  return (
    <View style={{ gap: 4, paddingTop: 8 }}>
      <Body>{line.text}</Body>
      {line.detail ? <Small>{line.detail}</Small> : null}
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: on }}
        accessibilityLabel={line.optional.toggleLabel}
        onPress={() => onToggle(itemId)}
        style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start', paddingVertical: 8 }}
      >
        <View
          style={{
            width: 22,
            height: 22,
            borderRadius: 6,
            borderWidth: 1.5,
            borderColor: on ? p.accent : p.line,
            backgroundColor: on ? p.accent : 'transparent',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {on ? <Text style={{ color: p.accentInk, fontSize: 14, fontWeight: '700' }}>✓</Text> : null}
        </View>
        <Text style={{ flex: 1, color: p.ink, fontSize: 15 }}>{line.optional.toggleLabel}</Text>
      </Pressable>
    </View>
  );
}

function SummaryCard({ confirmation: c, isMock }: { confirmation: Confirmation; isMock: boolean }) {
  const p = usePalette();
  const label = (text: string) => (
    <Text style={{ fontSize: 12, fontWeight: '700', letterSpacing: 0.5, color: p.muted, textTransform: 'uppercase' }}>{text}</Text>
  );
  return (
    <Card style={{ gap: 14, paddingVertical: 18 }}>
      {c.contact ? (
        <View style={{ gap: 4 }}>
          {label(c.contact.label)}
          <Text style={{ fontSize: 24, fontWeight: '700', color: p.ink }}>{c.contact.name}</Text>
          {c.contact.line ? <Body>{c.contact.line}</Body> : null}
          {c.contact.similarTo.length > 0 ? (
            <Small>
              Similar to {c.contact.similarTo.join(', ')} in your contacts. Kept separate until you confirm who this is.
            </Small>
          ) : null}
        </View>
      ) : (
        <View style={{ gap: 4 }}>
          {label('From your note')}
          <Body>{c.summary}</Body>
        </View>
      )}
      {c.contact && c.context ? (
        <View style={{ gap: 4 }}>
          {label('Context')}
          <Body>{c.context}</Body>
        </View>
      ) : null}
      {c.followUps.length > 0 ? (
        <View style={{ gap: 4 }}>
          {label('Follow-up')}
          {c.followUps.map((f) => (
            <Body key={f}>{f}</Body>
          ))}
        </View>
      ) : null}
      {c.others.length > 0 ? (
        <View style={{ gap: 4 }}>
          {label('Also in your note')}
          <Body>{c.others.join(', ')}</Body>
        </View>
      ) : null}
      {c.missing ? (
        <View style={{ gap: 4 }}>
          {label('Still missing')}
          <Body muted>{c.missing}</Body>
        </View>
      ) : null}
      {isMock ? <Small>Made without a live AI model (mock), for testing only.</Small> : null}
    </Card>
  );
}

function Bullets({ items }: { items: string[] }) {
  return (
    <View style={{ gap: 6 }}>
      {items.map((item) => (
        <View key={item} style={{ flexDirection: 'row', gap: 8 }}>
          <Body>•</Body>
          <Body style={{ flex: 1 }}>{item}</Body>
        </View>
      ))}
    </View>
  );
}

function Disclosure({ label, children, initiallyOpen = false }: { label: string; children: ReactNode; initiallyOpen?: boolean }) {
  const p = usePalette();
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <View style={{ gap: 8 }}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)} style={{ paddingVertical: 6 }}>
        <Text style={{ color: p.accent, fontSize: 15, fontWeight: '600' }}>
          {open ? '▾' : '▸'} {label}
        </Text>
      </Pressable>
      {open ? children : null}
    </View>
  );
}

function SourceLinks({ urls }: { urls: string[] }) {
  const p = usePalette();
  if (urls.length === 0) return null;
  return (
    <Disclosure label="See sources">
      {urls.map((url) => (
        <Text key={url} style={{ color: p.accent, fontSize: 13 }} onPress={() => void Linking.openURL(url)}>
          {url}
        </Text>
      ))}
    </Disclosure>
  );
}

function ResearchFound({ found }: { found: NonNullable<Confirmation['researchFound']> }) {
  const p = usePalette();
  const count = found.facts.length + found.readings.length + found.profiles.length + (found.confirmedAs ? 1 : 0);
  const allSources = [...new Set([...found.facts.flatMap((f) => f.sources), ...found.readings.flatMap((r) => r.sources)])];
  return (
    <Card>
      <Disclosure label={`Research found (${count})`} initiallyOpen>
        <View style={{ gap: 10 }}>
          {found.confirmedAs ? <Body>Confirmed role: {found.confirmedAs}</Body> : null}
          {found.profiles.map((profile) => (
            <Text key={profile.url} style={{ color: p.accent, fontSize: 15 }} onPress={() => void Linking.openURL(profile.url)}>
              {profile.label}
            </Text>
          ))}
          {found.facts.map((fact) => (
            <Body key={fact.text}>{fact.text}</Body>
          ))}
          {found.readings.map((reading) => (
            <View key={reading.text} style={{ gap: 4 }}>
              <Pill label={reading.label} tone={reading.label === 'Inference' ? 'warn' : 'plain'} />
              <Body>{reading.text}</Body>
              {reading.basis ? <Small>{reading.label === 'Inference' ? 'Based on' : 'Why'}: {reading.basis}</Small> : null}
            </View>
          ))}
          <SourceLinks urls={allSources} />
          <Small>Saved only when you confirm.</Small>
        </View>
      </Disclosure>
    </Card>
  );
}

function EditChoice({
  onEdit,
  onDiscard,
  onReanalyse,
  isDocument,
  busy,
}: {
  onEdit: () => void;
  onDiscard: () => void;
  onReanalyse: () => void;
  isDocument: boolean;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  if (!open) return <Button label="Edit" variant="quiet" onPress={() => setOpen(true)} />;
  return (
    <Card style={{ gap: 6 }}>
      <Button label={isDocument ? 'Edit the capture' : 'Edit my note'} variant="secondary" onPress={onEdit} />
      {/* Reading the same file again, without touching the file. */}
      <Button label={isDocument ? 'Read this document again' : 'Read this note again'} variant="secondary" onPress={onReanalyse} />
      {confirmDiscard ? (
        <>
          <Body>Discard this capture? Nothing from it is saved; your note stays stored privately.</Body>
          <Button label="Discard capture" variant="danger" busy={busy} onPress={onDiscard} />
        </>
      ) : (
        <Button label="Discard this capture" variant="quiet" onPress={() => setConfirmDiscard(true)} />
      )}
      <Button label="Cancel" variant="quiet" onPress={() => { setOpen(false); setConfirmDiscard(false); }} />
    </Card>
  );
}

/** Closed by default: the individual underlying records, for advanced review. */
function TechnicalDetails({ data, included }: { data: ProposalView; included: Set<string> }) {
  const changes = data.groups.flatMap((g) => g.changes);
  return (
    <Disclosure label="See technical details">
      <Small>
        Every record behind this capture. Items marked “Included” are what Confirm and save keeps; the rest are not kept.
      </Small>
      {changes.map((change) => (
        <ChangeCard key={change.id} change={change} included={included.has(change.id)} />
      ))}
    </Disclosure>
  );
}

/** A proposal that did not come from a capture: the plain list, read-only here. */
function TechnicalOnly({ data }: { data: ProposalView }) {
  return (
    <Screen>
      <Heading>{data.title}</Heading>
      <Small>{data.sourceLabel} · {data.statusLabel}. Review this one on the web.</Small>
      {data.groups.flatMap((g) => g.changes).map((change) => (
        <ChangeCard key={change.id} change={change} included={false} />
      ))}
    </Screen>
  );
}

function CandidateCard({
  candidate,
  busy,
  disabled,
  onConfirm,
}: {
  candidate: IdentityCandidate;
  busy: boolean;
  disabled: boolean;
  onConfirm: () => void;
}) {
  const p = usePalette();
  const where = [candidate.role, candidate.organization, candidate.location].filter(Boolean).join(' · ');
  return (
    <Card style={{ gap: 6 }}>
      <Body style={{ fontWeight: '600' }}>{candidate.name}</Body>
      {where ? <Body>{where}</Body> : null}
      {candidate.nameOnly ? <Pill label="Only the name matches your note" tone="warn" /> : null}
      <Small>{candidate.explanation}</Small>
      {candidate.matches.length > 0 ? <Small>Matches your note: {candidate.matches.join(', ')}</Small> : null}
      {candidate.conflicts.length > 0 ? <Small style={{ color: p.warnInk }}>Does not match: {candidate.conflicts.join(', ')}</Small> : null}
      <SourceLinks urls={candidate.sources.map((s) => s.url)} />
      <Button label="This is the person" variant={candidate.nameOnly ? 'secondary' : 'primary'} busy={busy} disabled={disabled} onPress={onConfirm} />
    </Card>
  );
}

function ChangeCard({ change, included }: { change: ProposedChange; included: boolean }) {
  return (
    <Card style={{ gap: 4 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        <Small>
          {change.action} · {change.kindLabel}
        </Small>
        {change.saved ? <Pill label="Saved" tone="good" /> : included ? <Pill label="Included" tone="good" /> : <Pill label="Not kept" />}
        {change.fromResearch ? <Pill label="From research" tone="warn" /> : null}
      </View>
      <Body style={{ fontWeight: '600' }}>{change.title}</Body>
      {change.text && change.text !== change.title ? <Small>{change.text}</Small> : null}
      {change.details.map((detail) => (
        <Small key={detail.label}>
          {detail.label}: {detail.value}
        </Small>
      ))}
      {change.needsAttention ? <Small>Needs attention: {change.needsAttention}</Small> : null}
    </Card>
  );
}

/**
 * Before any research: what will identify the person, what never leaves Globa 3,
 * and two explicit confirmations. Optional clues can be removed.
 */
function ResearchPreflightCard({
  preflight,
  busy,
  onStart,
  onCancel,
}: {
  preflight: ResearchPreflight;
  busy: boolean;
  onStart: (clueIds: string[]) => void;
  onCancel: () => void;
}) {
  const p = usePalette();
  const [kept, setKept] = useState<Set<string>>(() => new Set(preflight.clues.map((c) => c.id)));
  const [cost, setCost] = useState(false);
  const [disclosure, setDisclosure] = useState(false);
  const toggle = (id: string) =>
    setKept((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const Check = ({ on, label, onPress, locked }: { on: boolean; label: string; onPress?: () => void; locked?: boolean }) => (
    <Pressable
      onPress={locked ? undefined : onPress}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: on, disabled: !!locked }}
      style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start', paddingVertical: 4 }}
    >
      <View
        style={{
          width: 20,
          height: 20,
          borderRadius: 5,
          borderWidth: 1.5,
          borderColor: on ? p.accent : p.line,
          backgroundColor: on ? p.accent : 'transparent',
          alignItems: 'center',
          justifyContent: 'center',
          opacity: locked ? 0.6 : 1,
        }}
      >
        {on ? <Text style={{ color: p.accentInk, fontSize: 13, fontWeight: '700' }}>✓</Text> : null}
      </View>
      <Text style={{ flex: 1, color: p.ink, fontSize: 15 }}>{label}</Text>
    </Pressable>
  );
  return (
    <Card tone="plain" style={{ backgroundColor: p.ground, gap: 8 }}>
      <Heading>Research {preflight.contactName}?</Heading>

      <Small style={{ fontWeight: '600', color: p.ink }}>What will be used to identify this person</Small>
      {preflight.clues.map((clue) => (
        <Check
          key={clue.id}
          on={kept.has(clue.id)}
          locked={clue.required}
          label={`${clue.label}: ${clue.value}${clue.required ? ' (always used)' : ''}`}
          onPress={() => toggle(clue.id)}
        />
      ))}
      <Small>Tap any optional detail to exclude it from the search.</Small>

      <Small style={{ fontWeight: '600', color: p.ink, marginTop: 4 }}>What will not be sent to public web search</Small>
      {preflight.withheld.map((w) => (
        <Small key={w.label}>• {w.label}{w.inThisCapture && !w.label.startsWith('Anything') ? ' (in this capture, kept private)' : ''}</Small>
      ))}

      <Card tone="warn">
        <Small style={{ color: p.warnInk }}>{preflight.statement}</Small>
      </Card>
      <Check on={cost} label="I understand this uses AI budget." onPress={() => setCost(!cost)} />
      <Check on={disclosure} label="Use only the clues selected above for external search." onPress={() => setDisclosure(!disclosure)} />
      <Button
        label="Find who this is"
        busy={busy}
        disabled={!cost || !disclosure || busy}
        onPress={() => onStart(preflight.clues.filter((c) => !c.required && kept.has(c.id)).map((c) => c.id))}
      />
      <Button label="Cancel" variant="quiet" onPress={onCancel} />
    </Card>
  );
}
