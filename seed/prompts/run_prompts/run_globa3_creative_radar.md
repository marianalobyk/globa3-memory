Run the Globa 3 Creative Radar for `[RUN_DATE]`.

Treat this as a full standard daily Creative Radar run.

CLIENT PRODUCT LOCK — DO NOT DRIFT

Official briefing name: Globa 3 Creative Radar — Talent, Projects, Artists & IP.
This is a creative-intelligence, talent-discovery, project-scouting, and IP radar for Globa 3. It is not a celebrity-news roundup, not generic entertainment news, not a streaming guide, not an institutional bulletin, and not a funding tracker.

Working cadence for this package: daily standard Creative Radar run, with rolling 7-day context and forward 30-day watch. This preserves the current operating workflow while retaining the original client product definition.

The radar must answer:
- Who is emerging?
- What project matters?
- What story world is forming?
- What talent, creator, producer, filmmaker, athlete, artist, or IP should Globa 3 track?
- What regional project has received credible validation?
- What could become a Studios, Advisory, Ventures, AMV, AFC, Unseen Arabia, newsletter, talent-database, relationship-map, or project-scouting signal?

Priority geographies:
1. Gulf: UAE, Saudi Arabia, Qatar, Bahrain, Kuwait, Oman.
2. Africa: Nigeria, Egypt, Kenya, South Africa, Morocco, Ghana, Senegal, Côte d’Ivoire, Rwanda, Ethiopia, Tanzania, and wider continent.
3. Diaspora projects connected to Gulf or Africa.
4. Hollywood / Europe / global only when directly tied to Gulf / Africa talent, IP, financing, festival validation, production opportunity, platform distribution, or Globa 3 relationship value.

Every elevated item must answer:
1. What happened?
2. Why does it matter creatively / strategically?
3. What is the Globa 3 relevance?
4. What is the proportionate possible action?
5. What is the source quality and external-use status?

Do not include:
- generic celebrity news;
- gossip;
- reviews without strategic relevance;
- generic Hollywood announcements with no Gulf / Africa / diaspora tie;
- festival selections with no regional or Globa 3 relevance;
- projects with no possible Globa 3 angle;
- unverifiable social-media claims;
- institutional items that do not reveal talent, projects, story worlds, creator pathways, producer pathways, IP, or relationship targets.

## Variables

Fill these variables before each run:

[RUN_DATE] = 2026-09-11
[RUN_TIMEZONE] = Europe/Paris / CEST
[COVERAGE_START] = 2026-09-10, 00:00 CEST
[COVERAGE_END] = 2026-09-11, 00:00 CEST
[ROLLING_CONTEXT_START] = 2026-09-04, 00:00 CEST
[ROLLING_CONTEXT_END] = 2026-09-11, 00:00 CEST
[FORWARD_WATCH_START] = 2026-09-11
[FORWARD_WATCH_END] = 2026-10-11
[OUTPUT_FOLDER] = outputs/2026-09-11/

Example for a 25 June run:

[RUN_DATE] = 2026-06-25
[RUN_TIMEZONE] = Europe/Paris / CEST
[COVERAGE_START] = 2026-06-24, 00:00 CEST
[COVERAGE_END] = 2026-06-25, 00:00 CEST
[ROLLING_CONTEXT_START] = 2026-06-18, 00:00 CEST
[ROLLING_CONTEXT_END] = 2026-06-25, 00:00 CEST
[FORWARD_WATCH_START] = 2026-06-25
[FORWARD_WATCH_END] = 2026-07-25
[OUTPUT_FOLDER] = outputs/2026-06-25/

Use the fixed variables above as the source of truth for this run.

Do not recalculate the coverage window from the actual time this prompt is run when [COVERAGE_START] and [COVERAGE_END] are supplied.

If [COVERAGE_START] and [COVERAGE_END] are not supplied, calculate the primary coverage window as the exact run time minus 24 hours through the exact run time, in [RUN_TIMEZONE].

If [ROLLING_CONTEXT_START] and [ROLLING_CONTEXT_END] are not supplied, calculate the rolling context window as the exact run time minus 7 days through the exact run time, in [RUN_TIMEZONE].

If [FORWARD_WATCH_START] and [FORWARD_WATCH_END] are not supplied, calculate the forward watch window as [RUN_DATE] through 30 days after [RUN_DATE].

## Source of Truth

Use the uploaded manual briefing workflow package as the source of truth.

Use these desk files:

briefs/creative_radar/01_brief_creative_radar.md  
briefs/creative_radar/02_item_memory_creative_radar.md  
briefs/creative_radar/03_creative_radar_rules.md  
briefs/creative_radar/04_creative_radar_qa.md

Use the core workflow files from the package, especially:

Run Manifest  
Item Memory  
Repeat Control  
Evidence Index  
Draft Brief  
No-Lead Day Template  
QA / Hostile Review  
Finalize / Memory Update  
Clean Export rules

## Source Preflight — Required Before Search or Drafting

Before starting the run, internally verify file availability and classify files as Selected, Missing, or Ignored.

Selected files for this run:

- core/01_START_RUN_MANIFEST_PROMPT.md
- core/03_REPEAT_CONTROL_PROMPT.md
- core/04_EVIDENCE_INDEX_PROMPT.md
- core/05_DRAFT_BRIEF_PROMPT.md
- core/06_NO_LEAD_DAY_TEMPLATE.md
- core/07_QA_HOSTILE_REVIEW_PROMPT.md
- core/08_FINALIZE_AND_UPDATE_MEMORY_PROMPT.md
- core/09_EXPORT_CLEAN_DELIVERY_PROMPT.md
- briefs/creative_radar/01_brief_creative_radar.md
- briefs/creative_radar/02_item_memory_creative_radar.md
- briefs/creative_radar/03_creative_radar_rules.md
- briefs/creative_radar/04_creative_radar_qa.md
- run_prompts/run_globa3_creative_radar.md

Ignored files for this run:

- all other desk folders;
- all outputs unless explicitly needed for Item Memory comparison;
- Archive.zip or any archive/supporting package;
- Gulf + Africa, Streaming, Sports, Social Content Desk, Studios, Advisory, and Ventures files;
- Unseen Arabia / Properties / Living files;
- previous Claude prompt comparison files;
- screenshots, PDFs, reports, or email exports not explicitly listed as Selected;
- prior examples unless explicitly used only as formatting reference, not as source evidence.

If any required Selected file is missing, state this internally and continue only if the missing file is not essential. If the prompt cannot verify the correct Creative Radar brief/rules/QA/memory files, Final Approval Status must not be PASS — SAFE TO SEND.

Do not fall back to broader Project context, memory, old outputs, examples, unrelated desk files, or client emails to compensate for missing Selected files.

## Critical Product Rule

Creative Radar is the daily creative-intelligence and scouting product for Globa 3.

It must not collapse into:

- a funding tracker;
- an institutional bulletin;
- a grant / lab / deadline monitor;
- a celebrity-news roundup;
- a generic entertainment digest;
- a weekly scouting memo.

Its primary job is to find and organize:

talent;  
projects;  
story worlds;  
filmmakers;  
producers;  
writers;  
actors;  
artists;  
musicians moving into screen / media / IP;  
athletes moving into media / documentary / IP;  
creators moving into formats, platforms, communities, or IP;  
festival-selected projects;  
lab-selected projects;  
funded projects;  
market-selected projects;  
short films;  
documentaries;  
scripted projects;  
animation;  
regional IP;  
diaspora projects;  
women-led stories;  
sports-led stories;  
relationship targets;  
projects to watch;  
newsletter themes.

Institutional, festival, funding, grant, lab, market, and application-window items are useful only when they help identify actual talent, projects, story worlds, creators, producers, filmmakers, artists, athletes, creator pathways, or relationship paths.

A funding-pathway item may support the radar.

It must not replace the radar.

## Task

1. Start with a Run Manifest internally.
2. Search for fresh, rolling, and forward-watch creative signals for the supplied windows.
3. Search specifically for talent, projects, artists, IP, festival selections, market selections, platform announcements, creator signals, athlete-media moves, music-to-screen moves, filmmaker updates, producer updates, lab selections, funding pathways, and institutional creative-economy signals.
4. Build an Evidence Index internally.
5. Apply Repeat Control against Item Memory.
6. Draft the reader-facing Globa 3 Creative Radar.
7. Run Core QA.
8. Run Creative Radar QA.
9. Run Hostile Review.
10. Fix any failures.
11. Run the Talent / Project Coverage Gate.
12. Run the Institutional Overweight Gate.
13. Run the Threshold Consistency Gate.
14. Run the Source Quality Label Gate.
15. Run the Outside-Window Compression Gate.
16. Run the Full-Structure Gate.
17. Run the Final Status Gate.
18. Output only the clean reader-facing Globa 3 Creative Radar in chat.

If file writing is available, save the same clean reader-facing output as:

[OUTPUT_FOLDER]globa3_creative_radar_[RUN_DATE].md

If internal production files are generated, save them separately under:

[OUTPUT_FOLDER]internal/

Do not save internal QA, Evidence Index, Run Manifest, source cards, or Item Memory updates inside the clean output file.

## Coverage Windows

Use this fixed primary coverage window:

Coverage window: [COVERAGE_START] — [COVERAGE_END]

Use this fixed rolling context window:

Rolling context window: [ROLLING_CONTEXT_START] — [ROLLING_CONTEXT_END]

Use this fixed forward watch window:

Forward watch window: [FORWARD_WATCH_START] — [FORWARD_WATCH_END]

The reader-facing output must include all three windows in the header.

Do not output only a date range for the coverage window or rolling context window. Include exact start date, start time, end date, end time, and timezone.

Do not recalculate the fixed windows if the variables are supplied.

## Priority Geography

Gulf, Africa, and diaspora first.

Priority geography includes:

UAE; Saudi Arabia; Qatar; Bahrain; Kuwait; Oman; Nigeria; Egypt; Kenya; South Africa; Morocco; Ghana; Senegal; Côte d’Ivoire; Rwanda; Ethiopia; Tanzania; wider African continent; diaspora projects connected to Gulf or Africa.

Hollywood / Europe / global items are allowed only when directly tied to Gulf, Africa, diaspora talent, IP, financing, festival validation, platform distribution, production opportunity, or Globa 3 relationship value.

## Mandatory Source Lanes

Before drafting, scan at minimum:

Variety; Deadline; The Hollywood Reporter; Screen Daily / Screen International; IndieWire; BroadcastPro ME; C21 Media; TBI Vision; World Screen; Cineuropa where relevant; Film New Europe where relevant; official festival sources; official market sources; official lab / fund / grant sources; official platform / streamer / broadcaster press rooms; official film institute / commission / foundation sources; Music Business Worldwide where music-to-screen or rights-relevant; Billboard where music / artist-to-IP relevant; SportBusiness / SportsPro / Front Office Sports where athlete-media or sports-IP relevant; Gulf / MENA film, culture, and creative-economy sources; African film, music, creator, and creative-economy sources; diaspora creative sources where relevant; UAE, Saudi, Qatar, Egypt, Morocco, South Africa, Nigeria, Kenya, Tanzania, Ghana, Senegal, Yemen / Arab diaspora, and broader Gulf / Africa creative-economy sources.

## Mandatory Talent / Project Scan

Do not stop after one obvious festival, lab, grant, or institutional item.

Before drafting, explicitly search for each of these categories:

Gulf filmmakers; African filmmakers; diaspora filmmakers; producers; writers; directors; actors; short films; feature films; documentaries; series; animation; unscripted projects; sports documentaries; festival-selected Gulf / African / diaspora projects; market-selected Gulf / African / diaspora projects; lab-selected Gulf / African / diaspora projects; funded Gulf / African / diaspora projects; women-led Arab / African stories; sports-led stories; athlete-to-media signals; musician-to-screen signals; artist-to-IP signals; creator-to-platform or creator-to-IP signals; regional story worlds; emerging production companies; film schools / labs / short-film pathways; youth / creator-economy signals; institutional signals only where they reveal talent, project, IP, or relationship pathways.

## Talent / Project First Rule

Creative Radar is talent / project / IP first.

Institutional signals are allowed, but they must not crowd out people and projects.

Every institutional item must answer:

Which creators, producers, filmmakers, projects, story worlds, or relationship pathways does this help identify?

If it does not answer that, classify it as:

Institutional watch-only

or place it in:

Rejected / Not Elevated

## Small Creative Signal Rule

A signal does not need to be huge to matter.

Small signals may be elevated if they reveal:

an emerging filmmaker; a short-film pathway; a lab-selected project; a market-selected producer; a women-led story; a youth creator format; a documentary subject; an athlete-media direction; a music-to-screen path; a diaspora story world; a regional festival validation; a credible relationship target; a project that may later need screener / rights / talent mapping; a newsletter theme grounded in real creative movement.

Do not reject small creative signals merely because they are not major trade headlines.

Reject them only if they fail source, relevance, freshness, or action-value tests.

## Freshness Rules

Every elevated item must be one of:

Type A — Fresh: a specific new event, announcement, selection, award, screening, premiere, funding decision, grant opening, lab selection, commissioning, platform release, trade report, official statement, interview revealing a new project / deal / strategy / relationship, or report inside the coverage window.

Type B — Developing: an ongoing situation with a concrete fresh trigger inside the coverage window. Label Type B items: [Developing]

Rolling-context item: an item from the previous 7 days that is useful for radar context but does not qualify as fresh today. Label clearly: Rolling context — not Fresh Today

Outside-window item: an item older than the rolling context window. Label clearly: Outside rolling window — no new update today

Do not present older festival, market, grant, institutional, or project news as fresh unless there is a same-window update.

Do not use continued, remained, maintained, ongoing, still active, public as of, confirmed as of, recently, this week, or latest coverage unless a specific fresh dated trigger is named.

## Section 1 Freshness Rule

Section 1 — Priority Creative Signals Today is the strictest section.

Only include same-window fresh items.

If there are no qualifying fresh items, write exactly:

No priority creative signal cleared the threshold today.

Do not move rolling context into Section 1.

Do not move institutional background into Section 1.

Do not pad Section 1 to avoid a thin day.

A thin Section 1 is acceptable.

A missing full radar is not acceptable.

## No-Priority-Signal Rule

A no-priority-signal day is not a no-radar day.

Even if Section 1 has zero fresh daily items, complete the full Creative Radar using rolling 7-day talent and project context, forward 30-day festival / market / lab / premiere / deadline watch, relationship targets, projects to watch, newsletter themes, and rejected / not elevated discipline.

Do not output only a short No-Lead Day report unless all source lanes are unavailable or no usable creative / talent / project / institutional / relationship signals exist after the mandatory scan.

The abbreviated structure below is forbidden for a standard run:

Fresh Creative Radar Signals  
Rolling Context  
Not Elevated

## Rolling Context Rule

Rolling context may appear in:

Talent & Relationship Radar; Projects & Story Worlds to Watch; Institutional / Festival / Funding Signals; Athlete / Artist / Creator-to-IP Watch; Top Creative Signals This Week; Relationship Targets; Projects to Watch; Possible Newsletter Themes.

Every rolling item must be labeled:

Rolling context — not Fresh Today

If no new update today, add:

No new update today.

Do not let rolling context dominate more than half of the reader-facing brief unless the run is explicitly weekly / recap.

## Forward Watch Rule

Items outside the rolling 7-day window may appear only if:

- they have an upcoming deadline / event inside the forward 30-day window;
- they are necessary background to understand a fresh daily item;
- they are included in Rejected / Not Elevated as a reason not to elevate;
- they are explicitly labeled as outside rolling window.

## Outside-Window Compression Rule

Outside-window items must be used sparingly.

They may appear when they add real talent, project, IP, relationship, or newsletter value.

Do not let older Cannes / May / festival-context projects dominate the brief.

If an outside-window project appears in both Projects & Story Worlds to Watch and Projects to Watch, each placement must have a different operational function.

If the second placement does not add distinct action value, remove or compress it.

Every outside-window item must include:

Freshness status: Outside rolling window — no new update today

Do not make outside-window projects sound fresh.

## Classification Labels

Every elevated item must include one classification label.

Allowed classification labels:

Emerging talent; Established talent with new signal; Project scouting; Story world / IP; Artist-to-IP; Athlete-to-IP; Creator-to-IP; Sports-led story; Women-led story; Youth / creator-economy signal; Institutional proof point; Festival validation; Market validation; Platform validation; Funding pathway; Relationship target; Watch-only; Rolling context; Outside rolling window.

Use the label that best fits the item.

Do not overuse Institutional proof point.

Do not use Artist-to-IP, Athlete-to-IP, or Creator-to-IP unless there is real movement into media, documentary, screen, podcast, branded content, platform, rights, or IP.

## Globa 3 Relevance

Every elevated item must include a Globa 3 relevance line.

Allowed relevance destinations:

Studios; Advisory; Ventures; AFC; AMV; Unseen Arabia; Newsletter; Relationship Map; Talent Database; No immediate action but track; Not material.

Use this exact format:

Globa 3 relevance: [destination(s)] — [specific explanation]

Do not imply Globa 3 attendance, mandate, relationship, access, partnership, involvement, production attachment, or endorsement unless confirmed.

Use Relationship Map only when the item has a plausible, source-grounded relationship reason.

Use Newsletter only when the item is externally safe or can be made externally safe after source refresh.

Use No immediate action but track when relevance is real but action is not justified.

If the item has no plausible Globa 3 angle, exclude it or place it in Rejected / Not Elevated.

## Possible Action Rule

Every elevated item must include one proportionate possible action.

Allowed actions:

Watch; Track; Add to Talent Database; Add to Relationship Map; Request screener when completion / festival / market / sales path is plausible; Monitor award result; Monitor application deadline; Verify eligibility and mechanics directly; Verify operational status; Refresh source before external use; Include in weekly themes; No immediate action.

Do not include contact, pitch, partner, approach, invest, commission, propose, advise, submit, apply, or introduce unless the current status, relationship path, and source confidence are clearly source-controlled.

If verification is needed, action must be Verify or Refresh source before external use.

Do not use vague actions like monitor vaguely, keep an eye on, stay close, or follow up someday.

## External-Use Status Rule

Every elevated item must include:

External-use status: [External-safe / Internal only / Refresh required / Do not use externally]

Use External-safe only when the facts are source-controlled, current, non-speculative, and do not include internal relationship mapping or unsupported analysis.

Use Internal only when the item is useful for Globa 3 but includes relationship mapping, scouting, interpretation, sensitive positioning, or incomplete external proof.

Use Refresh required when source status, availability, official mechanics, application status, release status, project status, or relationship path needs rechecking.

Use Do not use externally when the item is weak, under-sourced, speculative, or internal-only by nature.

Separate external-safe facts from internal-only analysis when needed:

External-safe facts: [facts only]

Internal-only analysis: [relationship / action / Globa 3 interpretation]

Do not leak internal-only relationship mapping into external-facing language.

## Source Quality Rule

Every item must include exactly one primary source-quality label.

Allowed source-quality labels:

Official; Strong Trade; Credible Secondary; Single-source; Weak; Requires verification.

Do not write mixed source-quality labels such as:

Strong Trade / Requires verification  
Official / Credible Secondary / Requires verification  
Strong Trade / Credible Secondary

Instead, use:

Source quality: [one primary label]  
Verification note: [specific caution]

Examples:

Source quality: Strong Trade  
Verification note: Official programme mechanics require direct verification before external use.

Source quality: Official  
Verification note: Eligibility, current mechanics, and public-use wording still require refresh.

Source quality: Credible Secondary  
Verification note: Refresh against trade or official source before external use.

## Institutional Live-Status Hard Rule

Do not describe institutional, fund, lab, grant, incentive, rebate, market, committee, or application status as live, open, active, accepting applications, operational, confirmed live, apply now, or currently available without official current source support.

Do not rewrite expected from Q2, announced, planned, proposed, reported, trade-reported, framework, initiative, discussed, or future cycle as confirmed live, active, open, or operational.

Trade launch coverage may be used as context only, not proof of current operational status.

If operational mechanics are unclear, write:

Operational status requires official confirmation before external use.

## Grant / Fund / Lab Rule

For every grant, fund, lab, accelerator, institute, or market claim, verify:

official source; programme name; jurisdiction / geography; application window; deadline; eligibility; target creators / projects; whether applications are open; whether it is announcement, active application cycle, future cycle, or closed; source; date; checked_at timestamp.

If only trade source confirms the item, mark:

Trade-confirmed; official mechanics require verification.

If official source confirms the mechanics, mark:

Official mechanics verified.

Do not advise outreach or application without official mechanics.

## Festival / Market Validation Rule

A festival, market, lab, grant, award, selection, screening, or platform item can be elevated only if:

- the project / person / company has Gulf, Africa, or diaspora relevance;
- the selection / award / screening / update is inside the coverage window, or there is a same-window fresh update;
- or the item is rolling / forward context and labeled correctly;
- the source is official, trade, festival, market, fund, platform, or credible industry source;
- the item has real Creative Radar relevance: talent, project, IP, relationship mapping, platform validation, funding path, scouting, or story-world value.

Do not elevate a festival item merely because it is interesting.

Do not repeat older Cannes / Berlin / May selections without a new trigger unless clearly labeled rolling / outside-window / forward watch.

## Project / Talent Status Rule

For every project or talent item, verify:

person / project name; role; title; format; country / diaspora connection; current status; source; date; checked_at timestamp.

Do not say a project is shooting, financed, greenlit, acquired, distributed, or attached to a platform unless the source directly supports it.

Do not infer distribution from festival selection alone.

Do not infer production status from festival selection alone.

Do not infer relationship access from public selection alone.

## Review / Criticism Rule

Reviews may support context only when tied to a strategic signal.

Reviews alone are not enough for elevation.

Do not elevate a review-only item as a creative signal.

Do not inflate critical reception into festival validation.

## Festival Awards Overstatement Rule

Do not use swept, dominated, landmark, breakout, historic, unprecedented, major moment, first-ever, definitive, proved, took over, exploded, transformed, or game-changing unless the source directly supports the scale of that claim.

Prefer:

won multiple awards; received festival validation; converted selection into awards; won across several categories; strong festival validation; notable awards showing; significant regional validation.

Unsupported festival overstatement blocks PASS — SAFE TO SEND.

## Relationship Target Rule

Relationship Targets may include people, producers, companies, funds, labs, platforms, festivals, markets, or institutions only if:

- source-controlled identity exists;
- Gulf / Africa / diaspora relevance is real;
- there is a project, platform, market, institution, or talent reason;
- action is proportionate and not overreaching.

Do not include relationship targets if the only basis is fame, soft relevance, or generic regional interest.

If no relationship target clears the threshold, write:

No relationship target cleared the threshold today.

Do not omit the section entirely.

## Projects to Watch Rule

Projects to Watch may include projects inside the coverage or rolling window, or older projects only if there is a clear forward-watch reason.

Every project must include watch reason, action, source quality, and freshness status.

Do not use Projects to Watch as a dumping ground for stale Cannes / May items.

## Rejected / Not Elevated Rule

Rejected / Not Elevated is mandatory.

Keep it concise.

Each rejected item must state:

item; reason rejected; source status; disposition.

Do not list an item as rejected if it is also elevated, actioned, or recommended elsewhere.

If an item appears in Executive Summary as group context but is rejected as standalone item, write:

summary-context only; not enough standalone information to elevate.

## Repeat Control

Apply Item Memory strictly.

Do not repeat older Creative Radar items unless:

- there is a same-window update;
- the item is in the rolling context window and still useful;
- the item becomes newly actionable;
- the item receives a new official / trade confirmation;
- or it is explicitly labeled Outside rolling window — no new update today.

If an item was covered in a previous brief, either exclude it, include only the new trigger, classify as Rolling context / Outside rolling window, or move to Watch / Memory with clear labeling.

## Repeat Compression Rule

Do not repeat the same item across many sections.

Default allowed placements for one major item:

one primary analytical section;  
one operational section;  
one weekly / theme / relationship section.

If the same item appears in more than 3 reader-facing sections, compress it unless internal Repeat Justification is truly necessary.

Do not print Repeat Justification in the reader-facing brief.

If repeated-item sprawl makes the brief feel like a weekly dossier, use:

REJECT — DO NOT SEND

## Threshold Consistency Rule

Do not contradict section counts.

If a section contains 0 items, use a no-threshold-cleared sentence.

If a section contains 1 or 2 items, use:

Fewer than three [section type] cleared the threshold today.

If a section contains 3 items, use:

Three [section type] cleared the threshold today.

If a section contains more than 3 items, use:

[number] [section type] cleared the threshold today.

Never write “Fewer than three” if the section lists three or more items.

If the sentence does not add value, omit it.

## Institution-Heavy Day Language Rule

If same-window fresh signals are mostly grants, labs, funds, application windows, institutional pathways, or producer-development programmes, say so honestly.

Allowed wording:

Today is institution-heavy, but the useful reading is producer-pathway scouting rather than funding news.

or:

The fresh window is institution-heavy; the talent and project value sits mainly in rolling and forward-watch scouting.

Do not write:

Institutional and funding signals do not dominate the radar.

if most fresh items are institutional.

## Required Reader-Facing Structure

Use this exact structure.

Do not rename sections.

Do not collapse sections.

Do not use abbreviated structure.

Globa 3 Creative Radar

[Day, Date]

Priority geography: Gulf, Africa, diaspora  
Coverage window: [COVERAGE_START] — [COVERAGE_END]  
Rolling context window: [ROLLING_CONTEXT_START] — [ROLLING_CONTEXT_END]  
Forward watch window: [FORWARD_WATCH_START] — [FORWARD_WATCH_END]  
Refresh status: [Safe / Internal only / Refresh required]

## Executive Summary

3 to 5 bullets maximum.

Include strongest fresh creative signals if any; strongest talent / project / IP signals; major institutional items only if tied to talent / project / scouting value; major athlete / artist / creator-to-IP moves if any; strongest Globa 3 opportunity signals; and a clear note if Section 1 is thin but rolling / forward scouting remains useful.

Do not let institutional funding items dominate the Executive Summary unless they are the strongest real creative signals and are tied to creators / projects / pathways.

Each Executive Summary bullet should include what happened, why it matters, Globa 3 relevance, and external-use status.

## 1. Priority Creative Signals Today

0 to 3 items on normal days.

Use up to 5 only on exceptional high-signal days.

Only same-window fresh items.

If no item clears the threshold, write exactly:

No priority creative signal cleared the threshold today.

For each item, use:

### [Talent / Project / IP / Signal Name]

Freshness status: Fresh Today / Developing  
Classification:  
What happened:  
Why it matters:  
Globa 3 relevance:  
Possible action:  
Source quality:  
Verification note, if needed:  
External-use status:  
Source:  
External-safe facts, if needed:  
Internal-only analysis, if needed:

## 2. Talent & Relationship Radar

3 to 5 people, teams, entities, or collectives on normal days.

This section must actively surface talent / people / teams unless the scan genuinely finds none.

Use accurate threshold wording based on item count.

Do not replace this section with institutional items only.

For each item, use:

### [Person / Team / Entity]

Freshness status: Fresh Today / Rolling context — not Fresh Today / Forward watch / Outside rolling window — no new update today  
Classification:  
Why they matter:  
Source-controlled signal:  
Globa 3 relevance:  
Possible path:  
Possible action:  
Source quality:  
Verification note, if needed:  
External-use status:  
Source:

## 3. Projects & Story Worlds to Watch

3 to 5 projects on normal days.

This section must include specific projects, titles, formats, story worlds, shorts, features, documentaries, series, or creator-IP concepts.

Use accurate threshold wording based on item count.

For each item, use:

### [Project / Story World]

Freshness status: Fresh Today / Rolling context — not Fresh Today / Forward watch / Outside rolling window — no new update today  
Classification:  
Format:  
What happened / source-controlled signal:  
Story-world or IP value:  
Globa 3 relevance:  
Possible action:  
Source quality:  
Verification note, if needed:  
External-use status:  
Source:

## 4. Institutional / Festival / Funding Signals

2 to 4 items on normal days.

Use this section for labs, grants, markets, festival selections, production funds, film commissions, institutional support, platform-backed initiatives, and broadcaster-backed initiatives.

Every item must connect back to creators, projects, talent pathways, scouting, or relationship mapping.

For each item, use:

### [Institution / Programme / Festival / Market]

Freshness status:  
Classification:  
What happened:  
Talent / project pathway relevance:  
Globa 3 relevance:  
Possible action:  
Source quality:  
Verification note, if needed:  
External-use status:  
Source:  
Official mechanics status: Official mechanics verified / Trade-confirmed; official mechanics require verification / Operational status requires official confirmation before external use

## 5. Athlete / Artist / Creator-to-IP Watch

0 to 3 items.

If none clear the threshold, write:

No athlete / artist / creator-to-IP signal cleared the threshold today.

Use this section only for real movement into media, documentary, screen, podcast, branded content, platform, rights, or IP.

Do not include generic sports results, music releases, exhibitions, social virality, or celebrity posts.

For each item, use:

### [Athlete / Artist / Creator / Signal]

Freshness status:  
Classification: Athlete-to-IP / Artist-to-IP / Creator-to-IP / Sports-led story  
What happened:  
IP / media movement:  
Globa 3 relevance:  
Possible action:  
Source quality:  
Verification note, if needed:  
External-use status:  
Source:

## 6. Top Creative Signals This Week

Rolling 7-day section, updated daily.

Include up to 5 real rolling signals.

If fewer than five real signals exist, write:

Fewer than five source-controlled creative signals cleared the weekly threshold.

For each item, include:

Signal:  
Freshness status: Rolling context — not Fresh Today / Fresh Today / Forward watch  
Why it matters:  
Globa 3 relevance:  
Suggested action:

Do not present rolling-week items as fresh daily items.

## 7. Relationship Targets

3 to 5 names or entities on normal days.

Use accurate threshold wording based on item count.

For each item, include:

Who / what:  
Why they matter:  
Source-controlled reason to map:  
Possible path:  
Action: Watch / Track / Add to Relationship Map / Verify / No immediate action  
Globa 3 relevance:  
Risk note:

Do not imply Globa 3 already has access, rights, relationship, or contact path.

## 8. Projects to Watch

3 to 5 projects on normal days.

Use accurate threshold wording based on item count.

For each item, include:

Project:  
Freshness status:  
Watch reason:  
Possible action:  
Source quality:  
Verification note, if needed:  
External-use status:  
Globa 3 relevance:

Do not duplicate Section 3 unless the action value is different.

## 9. Possible Newsletter Themes

3 to 5 themes.

Every theme must be based on signals inside the brief.

Do not invent themes from general knowledge.

For each theme, include:

Theme:  
Based on:  
Why it matters:  
Possible external-safe framing:  
Internal-only caution, if any:

## 10. Rejected / Not Elevated

3 to 6 items considered but not elevated.

For each item, include:

Item:  
Reason rejected:  
Source status:  
Disposition: Ignore / Watch / Verify later / Keep in memory

Use this section to prove selection discipline.

Do not include full source logs.

Do not include hidden QA reasoning.

## Clean Output Rules

Output only the clean reader-facing Globa 3 Creative Radar in chat.

Do not include Run Manifest, Run Metadata, Evidence Index, source cards, QA notes, Operator notes, Item Memory updates, internal reasoning, prompt explanations, archive instructions, filename instructions, standalone audit-style Sources section, full Sources section, full Source Notes section, source IDs, or duplicate header block near the end.

Concise item-level source references are allowed where useful.

Do not include a full Sources section.

## Final Approval Status

Final Approval Status must be exactly one of:

PASS — SAFE TO SEND  
PASS — INTERNAL ONLY  
PASS — INTERNAL ONLY — REFRESH REQUIRED  
REJECT — DO NOT SEND

The final visible line must be only the status text.

Do not write:

Final Approval Status: PASS — INTERNAL ONLY — REFRESH REQUIRED

Write only:

PASS — INTERNAL ONLY — REFRESH REQUIRED

Nothing may appear after the final status line.

Use PASS — SAFE TO SEND only if fully earned.

Use PASS — INTERNAL ONLY if the radar is useful but any item includes relationship mapping, internal analysis, source uncertainty, project-status uncertainty, external-use uncertainty, rolling-context dominance, or incomplete official mechanics.

Use PASS — INTERNAL ONLY — REFRESH REQUIRED if any current status, application status, project status, operational mechanics, source mechanics, or relationship path requires refresh before external use.

Use REJECT — DO NOT SEND if any hard reject remains unresolved.

## Gates Before Final Output

### Talent / Project Coverage Gate

Before final output, confirm:

- the search did not stop at institutional, grant, lab, or funding items;
- Talent & Relationship Radar was actively searched;
- Projects & Story Worlds was actively searched;
- Athlete / Artist / Creator-to-IP was actively searched;
- Relationship Targets were actively searched;
- Projects to Watch was actively searched;
- Newsletter Themes were grounded in actual items;
- if talent or project sections are thin, they contain accurate threshold statements;
- funding / institutional signals do not dominate unless no talent / project / IP signals cleared after full search;
- the output still uses the full Creative Radar structure.

If any of these fail, return to search or rewrite.

### Institutional Overweight Gate

Before final output, confirm:

- institutional / funding / lab / grant / application-window items do not dominate the radar unless honestly labeled as an institution-heavy day;
- every institutional item is tied to talent, project, creator, scouting, relationship, or pathway relevance;
- institutional mechanics are not overclaimed;
- trade coverage is not used as proof of operational application status;
- the radar still feels like a creative-intelligence product, not an institutional bulletin.

If this fails, rewrite.

### Threshold Consistency Gate

Before final output, confirm:

- no section says “fewer than three” while listing three or more items;
- no section count statement contradicts the actual number of items;
- if a section contains three items, it says “Three…” or omits the count sentence;
- if a section contains more than three items, the number is accurate;
- if a threshold sentence is unnecessary, it is removed.

If this fails, rewrite.

### Source Quality Label Gate

Before final output, confirm:

- every item uses one primary Source quality label only;
- mixed labels such as Strong Trade / Requires verification are removed;
- extra caution appears as Verification note;
- Source quality labels use only the allowed vocabulary.

If this fails, rewrite.

### Outside-Window Compression Gate

Before final output, confirm:

- outside-window items are clearly labeled;
- outside-window items do not dominate the brief;
- older Cannes / May items are not presented as fresh;
- repeated outside-window projects have distinct operational value in each placement;
- repeated outside-window projects are compressed if the second placement does not add value.

If this fails, rewrite.

### Full-Structure Gate

Before final output, confirm:

- all 10 required sections appear;
- section titles match the required structure;
- Section 1 may say no priority signal, but the rest of the radar still exists;
- the output is not collapsed into three sections;
- no full Sources section appears;
- no internal artifacts appear;
- final approval status is the final line only.

If this fails, rewrite.

### Final Status Gate

Before final output, confirm:

- final status is exactly one of the four allowed statuses;
- final status is the final visible line;
- final status has no prefix;
- nothing appears after final status.

If this fails, rewrite.

## Wrong-Product Self-Rejection Rule

If the draft reads like a celebrity-news roundup, generic entertainment digest, institutional bulletin, grant / lab deadline monitor, funding tracker, streaming guide, weekly dossier, or generic newsletter instead of a talent / project / IP-first Creative Radar, reject and rewrite before final output.

If the draft lacks the full 10-section Creative Radar structure, Section 1 freshness discipline, Talent & Relationship Radar, Projects & Story Worlds to Watch, Athlete / Artist / Creator-to-IP Watch, Top Creative Signals This Week, Relationship Targets, Projects to Watch, Possible Newsletter Themes, Rejected / Not Elevated, or final approval status as the final line, reject and rewrite before final output.

If institutional / funding items dominate without clear talent, project, creator, scouting, relationship, or pathway relevance, reject and rewrite before final output.

If examples or older outputs are copied into the final brief as evidence without a same-window, rolling, or forward-watch source basis, reject and rewrite before final output.

## Self-Rejection Rule

If your draft contains any of the following, reject your own draft and rewrite before final output:

old news presented as fresh; outside-window item in Executive Summary without a same-window trigger or forward-watch reason; rolling-context item presented as Fresh Today; Section 1 padded with rolling or institutional context; full radar collapsed into fewer than 10 required sections; Talent & Relationship Radar missing; Projects & Story Worlds to Watch missing; Relationship Targets missing; Projects to Watch missing; Possible Newsletter Themes missing; institutional status overclaim; “open,” “active,” “available,” “accepting applications,” “operational,” or “apply now” without official current source; trade launch coverage used as proof of operational status; project status overclaim; distribution / acquisition / platform attachment inferred from festival selection; speculative Globa 3 relationship mapping presented as fact; internal-only relationship analysis written as external-safe copy; unsupported contact / pitch / partner / approach / invest / commission / advise action; generic celebrity news elevated; review-only item elevated as creative signal; funding / institutional items dominate without talent / project justification; unsupported number; unsupported date; stale source carrying a fresh claim; same item appears both elevated and rejected; standalone Sources section; source cards or audit-style source list; duplicate header block near the end; source quality uses mixed labels; section threshold sentence contradicts item count; final approval status has a prefix; anything after Final Approval Status.

Do not output until these checks pass.

## Final Output Requirement

Return only the final clean reader-facing Globa 3 Creative Radar in chat.

If file writing is available, save the clean Markdown output as:

[OUTPUT_FOLDER]globa3_creative_radar_[RUN_DATE].md

Then provide the same clean reader-facing output as email-safe HTML in chat.

HTML rules:

Use clean email-safe HTML.  
Do not include CSS unless absolutely necessary.  
Do not include JavaScript.  
Do not include markdown syntax.  
Use semantic tags only: h1, h2, h3, p, ul, li, strong, em, table, thead, tbody, tr, th, td, a.  
Convert links into HTML anchor tags.  
Preserve the exact wording and structure of the clean Markdown output.  
Keep final approval status as the final visible line.  
Nothing may appear after final approval status.

Do not explain the process.

Do not mention QA.

Do not mention this prompt.

Do not mention internal files.

Do not include internal artifacts.

Final approval status must be the final line of both the Markdown file and the HTML output.

Nothing may appear after final approval status.
