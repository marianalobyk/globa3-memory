# Seeded run prompts

These files are copied verbatim from
`main_briefs_renaming_patch_PURE_SAFE_2026-06-25.zip` and are the source of the
seeded `prompt_versions.body` for the three initial formats.

They are kept here, in the repository, so seeding is reproducible without the
original archive, and so a prompt change is a reviewable diff.

| File | Format key |
| --- | --- |
| `run_prompts/run_amv_daily_briefing.md` | `amv_daily` |
| `run_prompts/run_amv_creative_radar.md` | `amv_creative_radar` |
| `run_prompts/run_globa3_creative_radar.md` | `globa3_creative_radar` |

`briefs/creative_radar/*.md` are the desk files the Globa 3 Creative Radar run
prompt lists as required source-preflight files. They are attached to that
format's prompt version and injected as reference material.

Two things to know about how these are used:

1. **Placeholders stay intact.** The `[VAR] = ...` assignments in these files are
   example values. At run time every one is overwritten with a value computed by
   the orchestrator, and an authoritative metadata block is prepended. Nothing in
   these files is used as a live date or a live watch item.

2. **`n8n` mentions are historical.** Where these prompts say n8n validates or
   injects run metadata, that automation was never implemented. The Next.js
   server and the worker perform that role in this application.
