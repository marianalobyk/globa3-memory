# Capture quality pass

What "good" means for a captured note, and how each rule is checked. Two halves:
**mobile UX** (how a capture is confirmed) and **data correctness** (what it writes
into memory). Every criterion names the automated check that enforces it, so a
regression fails a suite rather than being noticed on a phone.

Suites: `npm run verify:capture` (records and pipeline), `npm run verify:mobile-api`
(HTTP API and the confirmation the clients render).

---

## Part 1 — Mobile UX acceptance criteria

The app must feel like a quick personal memory assistant, not a CRM or a database
viewer.

### 1.1 Capture confirmation

The default confirmation screen fits the decision in one viewport where possible:

- who the person is;
- what the app understood;
- what is still missing;
- one obvious next action.

By default it never shows raw records, database types, ids, checkboxes, source
rows, affiliations, findings or technical dependencies. Those live behind
**See technical details**, closed by default.

*Checked by:* `verify:mobile-api` §17 — the summary's contact label, role line,
context sentence, "still missing" sentence, and that `save.lines` is three plain
sentences; the records themselves are only in `groups`, which the phone renders
inside the closed disclosure.

### 1.2 Internal member match

For an exact match against an active workspace member:

```
Existing Globa 3 member
Natan Bogin
Founder & CEO, Globa 3
```

Actions: **Save interaction**, **Edit**, **Discard**. Never shown: "New external
contact", "Research this person", public-profile research, or member/entity
language. A role line appears only when memory holds one.

*Checked by:* `verify:mobile-api` §18 (label, role line, `primaryActionLabel`,
`canResearch === false`, no external-contact record, research refused server-side)
and `verify:capture` §10 (no person record, interaction linked to the member).

### 1.3 No reliable public match

> We could not confidently identify this person from public information.

Then: **Save contact without research**, **Add more details and try again**,
**Edit**. Never a bare "Research again".

*Checked by:* `verify:mobile-api` §19 — the search reports `no_reliable_match`,
adds nothing, and the contact is still saveable with only what the note says.

### 1.4 Research preflight

Short list of selected clues; one plain privacy explanation; two unchecked
confirmations; the action stays disabled until both are ticked. The clue list
says "Tap any optional detail to exclude it from the search." A place or event
clue is labelled **Location or event**.

*Checked by:* `verify:mobile-api` §16 — the preflight's clue labels and values,
the withheld list, the verbatim disclosure statement, and refusal without both
confirmations.

### 1.5 Knowledge readback

The first answer reads like a short briefing: the subject, one plain sentence
that leads with a source-backed fact, then four headings in this order:

1. What we know
2. Why it matters to AMV
3. What to watch next
4. Still unconfirmed

Provenance belongs under **See source details**, never in the answer itself. The
briefing is built from saved records only (`subjectBriefing`), so it cannot drift
from memory.

The clients are also allowed to be older or newer than the server, so neither
screen assumes the briefing has the shape it expects: a missing, older or
half-formed briefing falls back to the ordinary grounded answer and its
citations rather than failing. That rule lives in one place per client
(`apps/mobile/src/briefing-view.ts`, `apps/web/src/lib/briefing-view.ts`).

*Checked by:* `verify:capture` §14 — each section comes from approved records,
and a name memory does not hold gets no briefing; `verify:mobile-api` §6 — an
answer with no briefing still carries the answer text and citations the clients
render; `verify:readback-fallback` — the two clients agree on every briefing
shape, and neither screen maps over a value that could be undefined.

### 1.6 Copy

Use: `You met Anna at Cannes`, `New contact`, `Save contact`, `Research this
person`, `Still unknown`, `From your note`, `How we know this`.

Avoid: `entity`, `affiliation`, `recorded as a person`, `relationship status`,
`proposal item`, `supporting records`, raw timestamps, raw database terminology.
Text a person reads says "you", never "the writer".

*Checked by:* `verify:mobile-api` §17 (no "the writer" in what the client renders)
and the label layer (`apps/web/src/lib/labels.ts`), which is the only place a
storage name becomes a word.

### 1.7 Visual QA

Verified at a 375px viewport, and on a real Expo Go iPhone session by the person
testing:

- no important action sits below a long technical section;
- nothing is duplicated;
- text wraps cleanly;
- no developer control obscures a button;
- the floating blue gear is Expo Go's developer button. It is not in this app's
  code and not in a standalone iOS build.

---

## Part 2 — Capture data correctness

A short note must create the right memory structure: no duplicates, no wrong
person types, no hidden schema confusion.

### 2.1 Canonical model

| What | Where it goes |
| --- | --- |
| People and organisations | `entities` |
| Relationship / contact state | `entities.relationship_status` |
| Role at a company | `entity_affiliations` |
| Meeting, call, introduction | `interactions` |
| The original private note | `evidence` |
| A proposed follow-up | `actions` |
| A genuine commercial possibility | `opportunities` |

`external_contacts` and `external_companies` are legacy CRM tables. Capture never
writes to them. *Checked by:* `verify:capture` §11.

### 2.2 Internal member resolution

Active members are resolved before anything external is proposed. An exact match
is a colleague: no external contact, no public research, and an internal
interaction only when the note supports one. A merely similar name stays an
unconfirmed name for review. *Checked by:* `verify:capture` §10.

### 2.3 New versus existing external contact

A new person becomes exactly one canonical `entities` row with
`relationship_status = 'contact'`, shown as "New external contact". An exact name
or an approved alias updates or links the existing record instead of creating a
second one. *Checked by:* `verify:capture` §11 and §13; `verify:mobile-api` §15.

### 2.4 Minimal information, and safe gaps

From `I met Anna Smith today.` only three things are proposed: the private
source, the person as a contact candidate, and a neutral interaction. No company,
role, event, follow-up, opportunity, or finding that merely repeats the
interaction. Unknown fields stay visibly unknown. *Checked by:* `verify:capture` §11.

### 2.5 Richer information

From `I met Anna Smith, Head of Drama at Horizon Studios, at Cannes. She wants to
see New Foundation next week.`: the contact, the organisation, the role
affiliation, the interaction, the project link and the follow-up — and nothing
else. A place is not an event: `Cannes` is context. Only a name that says it is an
event ("Cannes Film Festival", "MIPCOM") becomes an event record.
*Checked by:* `verify:capture` §12.

### 2.6 Idempotency and updates

Re-capturing the same note reuses the same capture and proposes nothing new. A
later note about the same person produces an update or link, never a second
person. *Checked by:* `verify:capture` §13 and §7.

---

## Part 3 — Universal capture (P0)

A capture is classified before it is read. The classification is shown to the
person in plain words ("A daily radar brief with 4 signals and 4 watch dates"),
and it decides which extractor runs: the relationship one, the document one, or
both. Nothing about it is a guess the person cannot check.

### 3.1 What a research document produces

| Record | Rule |
| --- | --- |
| `evidence` | One per document, never one per cited URL. Cited URLs ride as provenance. |
| `research_artifacts` | The document itself, with its date, coverage and cited sources. |
| `signals` | Only decision-relevant items, each with why it matters and, where stated, the decision question and next step. |
| `signal_entities` | Only the subjects a signal actually needs. |
| `entities` | Those subjects, with `relationship_status = 'none'`. A document mention is not a relationship. |
| `actions` | Forward-watch dates, `action_type = 'watch'`, with the stated trigger date. |
| `research_findings` | `gap` for unknown or unconfirmed; `risk` for safeguarding, consent, trauma-informed development, reputational or legal exposure. |
| `opportunities` | An unvalidated hypothesis at `stage = 'idea'`, saved only when the person selects it. |
| nothing | Routine results, exclusions, generic context, and events named only as dates or places. |

### 3.2 The review, in four groups

**Save to memory** (what this changes about what you know) · **Research
recommended** (subjects and reasons; nothing is researched and nothing is saved)
· **Keep as source only** (stays in your document) · **Still unclear** (needs
your judgement: an unvalidated idea, or a name close to one you already have).
Each group says in one sentence why it matters and what happens to it.

*Checked by:* `verify:capture` §15 (records, partial approval, idempotency) and
`verify:mobile-api` §20 (the four groups, the headline, and that no research
run or target is created).

### 3.3 P0 limits

Markdown, plain text and text-readable PDF only. No URL fetching, no DOCX,
spreadsheet, OCR or archive support, no live research from a document, and no
migration: every record above already had a table and a natural key.

---

## Scenario coverage

| # | Scenario | Suite |
| --- | --- | --- |
| 1 | Exact internal member (Natan Bogin) | `verify:capture` §10, `verify:mobile-api` §18 |
| 2 | New minimal contact | `verify:capture` §11 |
| 3 | New rich contact: organisation, role, project, follow-up | `verify:capture` §12 |
| 4 | Exact existing contact | `verify:capture` §13, `verify:mobile-api` §15 |
| 5 | Similar name stays ambiguous | `verify:capture` §10, `verify:mobile-api` §15 |
| 6 | Repeated capture | `verify:capture` §13 |
| 7 | Later update to an existing contact | `verify:capture` §13 |
| 8 | No unsupported Event, Finding or Opportunity | `verify:capture` §11, §12 |
| 9 | Knowledge readback after approval | `verify:capture` §14 |
| 10 | Knowledge readback with no briefing, or an older one | `verify:readback-fallback`, `verify:mobile-api` §6 |
