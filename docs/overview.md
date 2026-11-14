# Exam Wizard: project overview

Everything a new contributor (or a new Claude session) needs to know about this project: what it does, how it's
built, the decisions behind it and what is still open. Short project notes are in [`CLAUDE.md`](../CLAUDE.md); the
question CSV format is in [`question-format.md`](question-format.md); hosting steps are in the [README](../README.md).

## Purpose and people
A website for online quizzes and exams at a Philippine university (engineering courses such as power system
analysis, electromagnetics, distribution). It replaced an earlier Google Sheets + Apps Script version (same rules,
same CSV columns). The owner is a teacher and also the site admin; there are other teachers and up to about 1000
students. Time zone Asia/Manila. Students often use phones for everything except the exams themselves.

- **Students** (free): sign up, join classes with a code or a join link, see every exam from all classes in one
  list (*Open now, Upcoming, Completed, Expired*), take exams, see their score if the teacher allows.
- **Teachers**: classes, question bank, exams, results. Publishing an exam needs **days of access** (access code)
  or **credits** (1 credit = first publish of 1 exam; editing/re-publishing is free). New teachers get **5 free
  credits** (Site settings).
- **Admins**: access codes, requests, teachers and students (reset password, disable, delete), other admins,
  site settings. The `ADMIN_EMAIL` account is the **site owner** (other admins can't remove, disable or reset it).

## Features (as of November 2026)

### Teachers
- **Classes**: 6-character join code, **Copy join link** (`/join/CODE`, signs in or signs up, then joins), student
  list with profile pictures, archive/restore (an archived class is hidden from students).
- **Question bank**: types MC, TF, FIB (accepted answers separated by `|`), ESSAY; points; topic; pictures
  (upload ≤ 2 MB, or a link incl. Google Drive/Dropbox); **folders and subfolders**; CSV import/export with a
  built-in format guide and sample file; IDs (re-import with the same ID updates the question).
- **Exam editor**: class, title, instructions, open/close time, time limit, password; random set per student
  (**N of the selected**, or **per topic**, or **per question type**, e.g. 10 MC + 5 TF); shuffle questions/choices;
  show score; all on one page or **one at a time** (optional no going back, time per question); allowed devices
  (computer / computer or tablet / any); camera (off / at start / throughout) with preview; advanced settings
  (below). **Preview** (try it as a student, check answers against the key, problems flagged, Edit links),
  **Copy link**, Duplicate, Delete.
- **Exams list**: Results / Edit / Copy link / Preview; scrollable; **Archive**, "Archive closed exams (N)",
  Archived list with Restore (archiving an exam only tidies the teacher's list).
- **Results**: search, status filter, sort (name, started, finished, time taken, score), notes (void reason, camera
  and tab warnings, reconnects, device), answers per student with grading (essays), events log, **camera
  snapshots**, Allow retake, Not started list, CSV downloads (results and all answers).

### Exam integrity (exam screen, `public/exam/`)
- **Leaving the exam** (tab switch, minimize, Alt+Tab, clicking another app): voids at once, or after
  **Tab/window warnings** (per exam, default 0). One warning per time away; staying away > 1 minute voids.
- **Second monitor** (`screen.isExtended`): blocked before start, voids during the exam.
- **Reload / lost connection**: reconnect window (default 60 s, max 3 times); the timer keeps running.
- **Copy/paste/right-click** blocked (option). Answer keys never reach the browser; grading, time limits and locked
  answers are checked on the server.
- **Devices**: hardware check that "desktop site" mode can't hide: main pointer is touch and can't hover → phone
  (screen short side < 520) or tablet. Checked on real Brave and Chrome on Android. `/device-check.html` shows
  what a device reports.
- **Camera** (MediaPipe in the browser; nothing is streamed or recorded): face present, camera covered, more than
  one person, **phone visible**; a lowered head (writing) counts as present. **Camera grace** (seconds a problem must
  last, default 3) and **Camera warnings** (default 1) per exam. A small **snapshot** (≈5–15 KB JPEG, max 10 per
  attempt) is saved when the camera flags something. Rules screen reminds students to keep calculators flat
  (a calculator held up can look like a phone).
- Students are **not told** the bank size or that sets are random; they only see their own question count.

### Accounts
- Sign-in with Enter; signed-in visitors go straight to their page. Profile (name, student number, school,
  picture cropped to ~10–30 KB, password).
- **Password help**: admin reset gives a temporary code that works in any letter case or with a trailing space,
  clears the sign-in lock, and forces a new password; **Forgot password?** emails a one-time 1-hour link (when SMTP
  is set up; Gmail app password).

### Payments (built, currently hidden)
- Site settings switch "Show payment options to teachers" (off). When on: credit packages, bank transfer, PayPal
  (PayPal.me link, or automatic PayPal checkout with API keys), GCash/other, QR codes instead of account numbers,
  receipt pictures. When off, teachers see **Request an access code**, approved in Admin → Credit requests.

## How it's built
- Node 22, Express 5, `pg`; PGlite for local runs/tests. No front-end build step: plain HTML/CSS/JS in `public/`
  (`assets/common.js` has `App.api`, dialogs, toasts, top bar).
- Main files: `server.js`, `src/db.js`, `src/schema.sql`, `src/auth.js`, `src/settings.js` (cached in memory),
  `src/exam-core.js` (exam options, grading, random sets, devices), `src/mailer.js`, `src/paypal.js`,
  `src/routes/{auth,admin,teacher,student,attempt}.js`, `public/exam/{app,camera}.js`, `public/exam/preview.*`.
- Exam options live in the exam's `options` JSON (`examOptions()` in `exam-core.js` sanitizes them): reconnect,
  focus grace, tab/window warnings, camera grace/warnings, phone/head detection, snapshots, type picks, etc.
- Security: hashed session tokens in HttpOnly cookies, bcrypt, `X-Requested-With: fetch` on API calls (CSRF),
  sign-in throttle, security headers, uploads checked for type and size.

## Hosting, cost and limits
- Own Ubuntu server (AWS, Singapore, ~1 GB RAM with swap) shared with other websites behind nginx; app runs as the
  `exam-wizard` systemd service on 127.0.0.1 with its own Node.js; HTTPS by certbot; deployed by GitHub Actions on
  every push to `main` (tests first, rollback if it doesn't start). Set-up scripts in `deploy/`.
- Database: Neon free plan (Singapore), max compute capped at 0.5 CU. Watch **Usage → Compute** (100 CU-hours a
  month); page views and idle tabs no longer wake the database. For 1000 students, Neon's paid plan or moving
  PostgreSQL onto a bigger (2 GB) server are the next steps.
- Load test (150 students at once): sign-in is the heaviest step (bcrypt); exam actions are light.

## Decisions and why
- Students never see correct answers (only the total score, if allowed): keys stay on the server.
- No audio monitoring (can't tell who is talking; false alarms in labs; privacy). No video recording; only small
  snapshots when flagged, disclosed on the rules screen (Philippine Data Privacy Act).
- Archiving an exam doesn't change what students see; archiving a class hides it from them.
- Sign-up has no captcha yet (being observed); plan if bots appear: per-network sign-up limit + hidden honeypot,
  then Cloudflare Turnstile.

## Open ideas (not built)
- Talking detection for take-home exams (optional, off by default).
- Faster phone checks (every 0.5 s) on fast computers.
- Picking per topic **and** per type together.
- Nightly database backups to S3 / server; moving the database to the server after a memory upgrade.
- Sign-up protection (above); sending scores back to Google Classroom.
