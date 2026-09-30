# Globa 3: Client Setup and Daily Use

This guide starts a private copy of the Globa 3 application on your computer.
It does not publish the application to the internet.

## Before you begin

You need:

- A Mac or Windows computer with an internet connection.
- The Globa 3 project folder supplied by your administrator.
- A separate, secure copy of the configuration file `.env.local`.
- Your Globa 3 sign-in details.

Do not email, upload or share `.env.local`. It contains private service access
details. Do not change its values unless your administrator asks you to.

## 1. Install Node.js

1. Go to [nodejs.org](https://nodejs.org/).
2. Download and install the **Node.js 22 LTS** version.
3. Close and reopen Terminal on Mac, or PowerShell on Windows.
4. Check that it worked:

```bash
node -v
```

The result should begin with `v22`.

## 2. Prepare the project

1. Unzip the supplied project folder somewhere easy to find, for example your
   Desktop.
2. Open Terminal or PowerShell inside that folder.
3. Run the following once. Replace the path with the location of your project.

**Mac**

```bash
cd "/path/to/Web App"
npm install
```

**Windows PowerShell**

```powershell
cd "C:\path\to\Web App"
npm install
```

The first installation can take several minutes. Leave the window open until it
finishes.

## 3. Add the private configuration

Your administrator should supply `.env.local` through a password manager or
another secure channel. Put it in the top level of the project folder, beside
`package.json`.

If you were supplied values rather than a file, first create the file from the
template:

**Mac**

```bash
cp .env.example .env.local
```

**Windows PowerShell**

```powershell
Copy-Item .env.example .env.local
```

Then have your administrator configure it. A live workspace normally needs:

- `DATABASE_URL`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_STORAGE_BUCKET=workspace-files`
- `OPENAI_API_KEY`

Without `OPENAI_API_KEY`, the app uses clearly marked synthetic demo output
instead of real analysis.

**Important:** On an already configured Globa 3 workspace, do not run
`npm run db:migrate`, `npm run db:seed` or `npm run db:reset`. Those are
administrator/development commands, not client setup steps.

## 4. Start Globa 3

Open **two** Terminal/PowerShell windows in the project folder.

In the first window, start the background worker:

```bash
npm run worker
```

Keep it running. It analyses captures and prepares review proposals.

In the second window, start the web application:

```bash
npm run dev
```

When it reports that it is ready, open this address in your browser:

```text
http://localhost:3000
```

Sign in with the account supplied by your administrator.

## Daily workflow

1. Open **Capture**.
2. Paste a meeting note, email summary or research note, or choose **Attach**
   to add a file.
3. Select **Capture**. The original material stays private as a source.
4. Wait for the analysis to finish, then open **Review**.
5. Check the proposed people, companies, projects, facts, dates, connections
   and follow-ups. Remove anything that should not enter the workspace.
6. Select **Approve and save** only for records you want to keep.
7. Open **Knowledge** and ask questions about approved records. Knowledge does
   not search the internet and does not treat unapproved review items as saved.

For example:

```text
What do we know about AMANAR Development Lab, and what date should we watch next?
```

## Stopping the app

When finished, select each Terminal/PowerShell window and press:

```text
Ctrl + C
```

The next time you use Globa 3, repeat only the two commands in **Start Globa 3**.
You do not need to run `npm install` again unless the administrator sends an
updated project version.

## Common issues

| What you see | What to do |
| --- | --- |
| `node: command not found` | Install Node.js 22 LTS, then close and reopen Terminal/PowerShell. |
| `address already in use :3000` | The web app is already running. Open `http://localhost:3000`, or stop the older web server with `Ctrl + C` before running `npm run dev` again. |
| A capture remains on “Analysing” | Check that the window running `npm run worker` is still open and shows no error. |
| “Storage upload failed: Bucket not found” | Ask the administrator to create/configure the private Supabase bucket named `workspace-files`. |
| The app labels output as synthetic or mock | The OpenAI key is missing or not available to the app. Ask the administrator to check `.env.local`. |
| Sign-in does not work | Confirm that you received the correct Globa 3 account and that the configuration file has not been changed. |

## Local demo database: administrators only

The project can also run with an isolated demo database. This is useful for a
training environment, but it is not how a client should access the live
workspace. Ask an administrator before using it.

```bash
npm run db:local
```

In a second window:

```bash
npm run db:migrate && npm run db:seed && npm run worker
```

In a third window:

```bash
npm run dev
```
