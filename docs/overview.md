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
- **Question bank**: types MC, TF, FIB (accepted answers separated by `|`; numbers as a range `122.1-122.9 V`,
  `122.5 ± 0.4` or `122.5 ± 1%`), ESSAY; points; topic; **symbol buttons** (± Ω ° μ π √ ² …) in the question editor; pictures
  (upload ≤ 2 MB, or a link incl. Google Drive/Dropbox); **folders and subfolders**; CSV import/export with a
  built-in format guide and sample file; IDs (re-import with the same ID updates the question).
- **Exam editor**: class, title, instructions, open/close time, time limit, password; random set per student
  (**N of the selected**, or **per topic**, or **per question type**, e.g. 10 MC + 5 TF); optional **Points** override for
  the exam (same points for all, or per type, or per topic; the bank isn't changed) so random sets have equal totals;
  shuffle questions/choices;
  show score; all on one page or **one at a time** (optional no going back, time per question); allowed devices
  (computer / computer or tablet / any); camera (off / at start / throughout) with preview; advanced settings
  (below). **Preview** (try it as a student, check answers against the key, problems flagged, Edit links),
  **Copy link**, Duplicate, Delete.
- **Exams list**: Results / Edit / Copy link / Preview; scrollable; **Archive**, "Archive closed exams (N)",
  Archived list with Restore (archiving an exam tidies the teacher's list and deletes its camera snapshots; results stay).
- **Fill-in-the-blank checks**: close spellings ("Feranti"), numbers just outside the range and a different unit
  ("kV" for "V") are flagged as **to check** in Results (the number decides correct/wrong; spellings stay wrong) with a
  one-click **Give full points**. Notes are for the teacher only.
- **Exam editor → "Internet where students take the exam"**: Good or unstable (online, keep going offline; default),
  No internet or very weak (offline exam), Strict (void after the reconnect window). Results → Offline copies →
  **Exam-day sheet** prints the password, the steps for the room and an attendance list with a receipt-code column.
- **Offline exams** (exam editor → "No internet, or very weak"; needs an exam password of 8+ letters/numbers, "Make a
  strong password" gives e.g. `K7M-Q2X-9PD`): students open the exam link with internet before and click **Download
  for offline** (their own question set, uploaded pictures inside; external pictures and the camera checker are kept
  by the offline helper `public/sw.js`; no answer key). The copy is AES-GCM encrypted with the password
  (`src/offline.js`, PBKDF2 150k); the password is given in the room. On exam day the same link (or `/offline`, "Exams
  downloaded on this device") opens without internet; tab/window/camera rules, reconnect rules, snapshots and the timer
  run on the device (`localApi` in `public/exam/app.js`). Finishing shows a **receipt code** (HMAC of the answers with a
  key from the copy); the answers are sent when online (`offlineSubmit`, or the teacher uploads the student's answer
  file in Results → Offline copies) and graded with the questions fixed at download (`fixed_question_ids`). Results:
  **Offline copies** panel (downloaded / received / not downloaded / must download again after a password change),
  "Offline" tag, receipt code, and **⚠ Check** notes (receipt mismatch, device clock, started before opening, finished
  after time, arrived late, two attempts). The receipt written on the attendance sheet is what proves the answers were
  not changed later (a very technical student could re-make a matching code, but not the one on paper).
  A device that downloaded the exam always uses its downloaded copy (even with internet), so one device can't have an
  online and an offline attempt. Opening My Exams (`/student`) without internet shows `/offline`. A void that could not
  be sent (online exam, internet off) is kept in the browser and sent the next time the exam page opens. Results show an
  attempt whose time (and late-sending window) ran out as "Time ran out (not submitted)".
- **QR hand-in** (offline exams): the finished screen shows **Hand in with a QR code**: the answers in one or more QR
  codes (about 280 characters each, changing every 2.5 s; format in `src/routes/collect.js`, drawn with
  `public/vendor/qrcode.js`). The teacher scans them at `/collect?exam=ID` (Results → Offline copies → Scan answers), or a
  helper at a **collector link** (`/collect?t=TOKEN`, Helper links: this exam only, no scores, 4 h–3 days, can be turned
  off). The scanner (phone camera; BarcodeDetector or `public/vendor/jsqr.js`) keeps scans when the phone is offline and
  sends them later. The receipt is checked as for any offline hand-in; the same answers arriving twice count once.
- **Help this student** (Results → Answers, for an attempt not submitted): extra time / **Let them continue** after a
  void or a crash (same questions, the server's saved answers come back; the student reopens within 30 min,
  `resume_until`), **Submit these answers** (the draft saved on the server), **Upload an answer file** (the student's
  "Save a copy of my answers" file from the offline screen), **Count as on time**. Each is logged in the events.
  Unexpected errors on the exam page are reported (PAGE_ERROR, "⚠ Page problem" in Results).
- **Results**: search, status filter, sort (name, started, finished, time taken, score), notes (void reason, camera
  and tab warnings, reconnects, device), answers per student with grading (essays), events log, **camera
  snapshots**, Allow retake, Not started list, CSV downloads (results and all answers).

- **Teacher's manual** at `/manual` (linked in the teacher menu): step-by-step guide with annotated screenshots
  (`public/manual/`; screenshots are generated from a demo site, so re-capture them when screens change). The same
  manual as an e-book: `public/manual/exam-wizard-teachers-manual.pdf` (cover, contents with page numbers, bookmarks; built
  from the page with Chromium's PDF printing; rebuild it when the page changes).

### Exam integrity (exam screen, `public/exam/`)
- **Leaving the exam** (tab switch, minimize, Alt+Tab, clicking another app): voids at once, or after
  **Tab/window warnings** (per exam, default 0). One warning per time away; staying away > 1 minute voids.
- **Second monitor** (`screen.isExtended`): blocked before start, voids during the exam.
- **Reload / closed page**: reconnect window (default 60 s, max 3 times); the timer keeps running.
- **Unstable internet** (per exam, on by default: "If the internet drops: keep going"): the open exam page keeps
  running and checking without internet; answers are kept on the device (and as a draft on the server whenever there
  is a connection, "✓ Saved"); the page has a token so the server can tell "internet dropped" (logged as OFFLINE,
  `offline_ms`) from "page closed" (reconnect rules). Finished while offline: "Your exam is finished… keep this page
  open", sent automatically when the internet is back; on time if finished before the deadline and sent within
  `offlineSubmitMinutes` (default 60), shown as "Sent after the internet came back" (`sent_late`). The old rule
  (void after the reconnect window) is still a choice.
- **Copy/paste/right-click** blocked (option). Answer keys never reach the browser; grading, time limits and locked
  answers are checked on the server.
- **Devices**: hardware check that "desktop site" mode can't hide: main pointer is touch and can't hover → phone
  (screen short side < 520) or tablet. Checked on real Brave and Chrome on Android. `/device-check.html` shows
  what a device reports.
- **Camera** (MediaPipe in the browser; nothing is streamed or recorded): face present, camera covered, more than
  one person, **phone visible**; a lowered head (writing) counts as present. **Camera grace** (seconds a problem must
  last, default 3) and **Camera warnings** (default 1) per exam. A small **snapshot** (≈5–15 KB JPEG, max 10 per
  attempt) is saved when the camera flags something. Optional **random snapshots** (per exam, default 6 per hour when
  turned on; one at a random moment in each part of the hour; 240 px grayscale ≈3–5 KB; the server refuses more
  than the hourly number). Students are told on the rules screen. Rules screen reminds students to keep calculators
  flat (a calculator held up can look like a phone).
- **Snapshot storage and deletion** (`src/snapshots.js`): picture files on the server disk (`SNAPSHOT_DIR`, default
  `~/exam-wizard/snapshots`, outside the app folder), one database row each (picture in the row only if the disk
  fails). Deleted permanently when the exam or its class is archived (the teacher is warned with the count), and
  30 days after the exam closes; clean-up runs at most twice a day when a teacher opens the exam list (never wakes
  the database by itself) and also removes files of deleted exams/students.
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
- **Backups** (`src/backup.js`): nightly at about 2 AM (site time zone), JSON-lines gzip in `~/exam-wizard/backups`
  (`BACKUP_DIR`), newest 14 kept; Admin → Site settings lists them (Download, Make a backup now; site owner only).
  Restore into an empty database: `DATABASE_URL=… node deploy/restore-backup.js FILE`.
- **Updates never interrupt an exam**: `deploy/remote-deploy.sh` asks the app (`/deploy-check`, local only) first and
  waits (up to 80 min) while students are taking an exam; Admin → Site settings → **Pause site updates** (exam week)
  stops deploys until it is turned off (then re-run the deploy in GitHub Actions).
- Load test (150 students at once): sign-in is the heaviest step (bcrypt); exam actions are light.

## Decisions and why
- Students never see correct answers (only the total score, if allowed): keys stay on the server.
- No audio monitoring (can't tell who is talking; false alarms in labs; privacy). No video recording; only small
  snapshots when flagged, disclosed on the rules screen (Philippine Data Privacy Act).
- Archiving an exam doesn't change what students see; archiving a class hides it from them. Both delete the camera
  snapshots (to save space and keep personal data no longer than needed).
- Sign-up has no captcha yet (being observed); plan if bots appear: per-network sign-up limit + hidden honeypot,
  then Cloudflare Turnstile.

## Open ideas (not built)
- Talking detection for take-home exams (optional, off by default).
- Faster phone checks (every 0.5 s) on fast computers.
- Picking per topic **and** per type together.
- Nightly database backups to S3 / server; moving the database to the server after a memory upgrade.
- Sign-up protection (above); sending scores back to Google Classroom.
