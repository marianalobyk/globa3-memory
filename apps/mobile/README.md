# Globa 3 — iOS app

The primary client: capture something important in under 30 seconds after a
meeting, review what Globa 3 proposes to remember, approve it.

React Native + Expo (SDK 57), expo-router. The app is a thin client of the
Globa 3 server API. It holds **no** Supabase key, database URL or model key and
contains no business rules: grouping, naming, entity matching, approval and
saving all happen on the server, and the app renders what the server returns.

## Screens

| Screen | File | What it does |
| --- | --- | --- |
| Sign in | `src/sign-in.tsx` | Email and password go to the server (`POST /api/mobile/session`), which checks them with Supabase Auth (or local dev auth). The app keeps only the returned session token, in the iOS Keychain. |
| Today | `app/(tabs)/index.tsx` | One dominant *Add anything…* action, the count awaiting approval, what is being analysed, recently saved records, a simple *Ask memory* box. |
| Capture | `app/(tabs)/capture.tsx` | A large standard text field (works with iOS keyboard dictation), a pasted link goes in the same field, *Attach a file* (PDF, Markdown, text) through the private upload flow. No record-type selector. |
| Processing | `app/capture/[id].tsx` | Received → Analysing → Matching existing memory → Proposal ready, or stopped with *Retry* / *Edit the capture*. No job ids or technical errors. |
| Review | `app/(tabs)/review.tsx`, `app/proposal/[id].tsx` | The captured source; who and what the note mentions with *Already in memory* / *New* / *Possible match — not merged*; changes grouped as *Stated in the source*, *Our reading, not stated directly*, *Suggested follow-ups*, *Still unknown*; *Approve all*, *Approve selected* (changes a selection depends on are named and included), *Reject*, *Edit the capture*; optional *Research this person / company / project* behind a separate confirmation that states AI budget and external sources. |
| Saved | `app/saved/[id].tsx` | Exactly the records saved, as read back from the database, each opening a Knowledge search. |
| Knowledge | `app/(tabs)/knowledge.tsx` | Ask a question about saved memory; supporting records listed with the answer; an answer with no supporting record says so. |

## Server endpoints it uses

| Endpoint | Purpose |
| --- | --- |
| `POST/GET/DELETE /api/mobile/session`, `POST /api/mobile/session/refresh` | Sign in, who am I, sign out (revokes at Supabase), token refresh. |
| `GET /api/mobile/today` | Home screen data. |
| `POST /api/captures` (multipart), `GET /api/captures/:id`, `POST /api/captures/:id/retry` | Capture, processing state, retry. |
| `GET /api/mobile/review`, `GET/POST /api/mobile/proposals/:id` | Review list, compact proposal, approve (selected or all) / reject. |
| `POST /api/research/requests` | Explicit research; refused without `acknowledgeCost: true`. |
| `POST /api/ask` | Ask memory. |

Every request carries `Authorization: Bearer <token>`; the server verifies it on
every request, applies workspace membership and RLS, and never trusts a
workspace id from the client (`x-g3-workspace` is only matched against the
user's memberships).

## Run it

```bash
cp apps/mobile/.env.example apps/mobile/.env.local   # set EXPO_PUBLIC_API_URL
npm run dev                                          # the server, in another terminal
npm run worker                                       # the analysis worker
npm run mobile                                       # Expo dev server
```

- **iOS Simulator** needs Xcode (not installed on the machine this was built
  on). With Xcode: press `i` in the Expo terminal.
- **A real iPhone via Expo Go**: set `EXPO_PUBLIC_API_URL` to this Mac's LAN
  address (`http://192.168.x.x:3000`), start the server with
  `--hostname 0.0.0.0`, scan the QR code. Expo Go supports every module this app
  uses (expo-router, expo-secure-store, expo-document-picker).
- **Web preview** (layout checks only): `npx expo start --web`, and add the
  preview origin to the server's `G3_CLIENT_ORIGINS`. On web the session lives
  in memory only.

`npm run mobile:export:ios` produces the production JavaScript bundle.

## Before TestFlight / App Store

Not done yet, in rough order:

1. **A deployed HTTPS server** for `EXPO_PUBLIC_API_URL` (the app refuses nothing
   over plain HTTP today; App Transport Security will, outside development).
2. **Apple Developer account, bundle id and signing.** `app.json` uses
   `com.globa3.workspace` as a placeholder. Build with EAS (`eas build -p ios`)
   or `npx expo prebuild` + Xcode.
3. **App icon and splash** — the Expo template placeholders are still in
   `assets/`.
4. **Supabase Auth on the server** for real accounts (local dev auth is refused
   in production builds of the server).
5. **Privacy**: App Store privacy labels (the app sends notes and files the user
   enters to the organisation's server), a privacy policy URL, and account
   deletion handling if accounts can be created.
6. **Run on a device**: the screens have been exercised through Expo's web
   renderer and the API end to end, but not yet on iOS itself — keyboard
   avoidance, dictation, the document picker and Keychain need a device pass.
7. **Accessibility pass** with VoiceOver and large Dynamic Type sizes.
8. **Offline capture queue** (a note typed without signal is currently refused
   with a clear message, not queued).

## Voice: v2 extension path (not built)

v1 has **no** recording, requests **no** microphone permission, and sends **no**
audio anywhere. iOS keyboard dictation works in the capture field because it is
a standard text input; the transcription there is Apple's, on the device's
keyboard, and arrives as ordinary text.

A v2 voice capture would add, without changing the capture pipeline:

1. **Tap microphone** on Capture → request microphone permission with a clear
   `NSMicrophoneUsageDescription` (`expo-audio`, config plugin in `app.json`).
2. **Record** locally to a file (AAC/M4A), with a visible timer and a hard
   length limit; nothing is uploaded while recording.
3. **Upload the audio** as a private file through the existing capture upload
   (`POST /api/captures` multipart), stored like any attachment, with a new
   capture kind `audio` (a small migration widening `captures.kind`).
4. **Server-side transcription** as a new first stage of the capture run
   (`transcribe` before `load`), using the server's model credentials only; the
   transcript is stored on the capture, never trusted as knowledge.
5. **Review the transcript before analysis**: the run pauses in a
   `needs_transcript_review` state; the app shows the transcript, the person
   edits and confirms it, and only then do `extract → resolve → propose` run on
   the confirmed text. The audio stays the untrusted source of record.

Until all five exist and are tested, the product must not claim voice capture.
