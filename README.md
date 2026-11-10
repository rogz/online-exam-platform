# Exam Wizard

A website where **teachers** build and publish exams and **students** take them from one dashboard.

- **Students** sign up for free, join classes with a class code, and see every exam from all their classes in one side panel: *In progress, Open now, Upcoming, Completed, Expired*.
- **Teachers** sign up, then publish exams using an **access code** (free days of access) or **credits** (1 credit = publish 1 exam).
- **You (the admin)** create access codes, approve credit purchases, and manage teachers, students and site settings.

The exam screen brings over everything from the Google Sheets version: tab-switch, Alt+Tab and second-monitor detection, camera face checks (one warning, then void), time limits and windows, a countdown before opening, warnings, reconnecting after a lost connection, one-at-a-time mode with no going back, random question sets (also per topic), pictures, and allowed devices. It adds **exam passwords**.

---

## What each person can do

| Who | Can do |
|---|---|
| **Student** (free) | Sign up · join classes with a code · see all exams in one list · take exams · see scores (if the teacher allows) |
| **Teacher** | Create classes (each gets a 6-character join code) · question bank with **folders and subfolders**, pictures, topics, CSV import/export (optional Folder column, e.g. `EEE 150/Midterm`) · exam editor with every option · publish (needs access or credits) · results with essay grading, retakes, event log, CSV downloads · redeem codes · request credits |
| **Admin** | Add other admins (promote a teacher, or create a new admin account) · create access codes (days or credits, single or shared, with expiry) · approve or reject credit requests · give access directly · reset passwords · disable accounts · site name, time zone, sign-up switches, payment instructions |

**Credits:**
- Publishing an exam the first time costs 1 credit, unless the teacher has days of full access.
- Editing, unpublishing and re-publishing that exam later is free.
- Teachers who pay (e.g. by GCash) submit a request with their reference number. You approve it once you've checked the payment.
- Online card or GCash checkout (e.g. PayMongo) can be added later.

---

## Put it online for free (Render + Neon)

You need free accounts on **GitHub**, **Neon** (database) and **Render** (web hosting).

1. **Database (Neon):** sign up at neon.tech → **Create project** (region: Singapore) → copy the **connection string**. It starts with `postgresql://` and ends with `?sslmode=require`.
2. **Website (Render):** sign up at render.com with GitHub → **New → Blueprint** → choose this repository. Render reads `render.yaml` and asks for:
   - `DATABASE_URL`: the Neon connection string
   - `ADMIN_EMAIL`: your email (this account becomes the admin)
   - `ADMIN_PASSWORD`: your first password (change it after signing in)
3. Click **Apply**. After a few minutes the site is live at `https://online-exam-xxxx.onrender.com`.
4. Sign in with your admin email, go to **Site settings**, and set the site name and payment instructions.

**Free-tier limits to know:**
- **Render (free):** the site goes to sleep after 15 minutes with no visitors. The first visit after that takes about a minute to wake it. **Before an exam, open the site yourself a few minutes early.** For heavy use, Render's paid plan ($7 a month) never sleeps.
- **Neon (free):** 0.5 GB of database space. That holds a lot of questions and results. Pictures are stored in the database too, so keep them small: uploads are already shrunk to 2 MB or less, and typical photos are 100–300 KB.

### Use your own address (e.g. quiz.abnjworks.com)
1. In Render: open the service → **Settings → Custom Domains** → add `quiz.abnjworks.com`.
2. At your domain's DNS provider, add the **CNAME** record Render shows you (Name `quiz` → value `online-exam-xxxx.onrender.com`).
3. Render sets up HTTPS automatically. HTTPS is required for the camera and monitor checks.

---

## Move to your own server later (e.g. AWS)

The same code runs anywhere with Node.js and PostgreSQL. On one server (AWS Lightsail or EC2, Ubuntu):

1. Give the server a fixed IP (**Lightsail: Static IP**, **EC2: Elastic IP**) and point your domain to it with a DNS **A** record.
2. Install Docker, then clone this repository on the server.
3. `cp .env.example .env` and fill in the domain, passwords and admin email.
4. `docker compose up -d`. This starts the website, PostgreSQL, and **Caddy**, which gets a free HTTPS certificate automatically.

**To move your data from Neon:** run `pg_dump` on the Neon database and `psql` into the new one. Ask me for the exact commands when you get there.

---

## Profiles
Everyone (students, teachers, admins) can click their name in the top bar to open **My profile**: profile picture, name, student number, school, and password. Pictures are cropped to a square and shrunk to about 10–30 KB. Teachers see student pictures in class lists and results. Pictures are only shown to signed-in users.

## Admins
The account set as `ADMIN_EMAIL` is the **site owner**. In **Admin → Admins** you can:
- **Add admin:** enter a teacher's email to promote them (they keep their classes and exams), or a new email and name to create an admin account with a temporary password.
- **Remove admin rights:** the person becomes a teacher again.

Safeguards: other admins can't remove, disable or reset the password of the site owner. Only the owner can reset any admin's password. Nobody can remove their own admin rights.

## Run it on your own computer

```bash
npm install
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=pick-a-password npm start
```

Open http://localhost:3000. Without `DATABASE_URL`, the site uses a built-in database stored in the `data/` folder.

## Bringing questions over from the Google Sheets version
In your Sheet, open the **Questions** tab and click **File → Download → Comma-separated values (.csv)**. Then, on the website, go to **Question bank → Import CSV**. The columns are the same: QuestionID, Type, Question, Choices, Answer, Points, Topic, Image. Image links are kept. Uploaded Drive pictures need to be uploaded again in the question editor.

## Tests
`npm test` runs the whole site in a real browser: the admin creates a code; a teacher signs up, builds a class, questions (with a picture and CSV import) and an exam, then publishes; a student joins, takes the exam with a password, and submits; the teacher grades the essay and allows a retake; the retake is voided by a tab switch; and credits are requested, approved and spent. It also covers permission and CSRF checks and the phone layout.
`TEST_DATABASE_URL=postgres://… npm test` runs the same test against a real PostgreSQL server; use an empty database.

## Privacy and security
- Passwords are stored hashed with bcrypt. Sign-in uses secure, HTTP-only cookies and is throttled after repeated failures.
- Every change must come from the site's own pages (CSRF protection).
- Answer keys never reach students' browsers. Grading, time limits, reconnect limits and locked answers are checked on the server.
- Camera checks run in the student's browser; no video is recorded or uploaded.
- Under the Philippine Data Privacy Act you are the **personal information controller** for the names, emails and results stored here. Before opening it to other schools, add a short privacy notice (Site settings is a good place to link it), keep regular database backups (Neon keeps 1 day on the free plan), and only give admin access to people who need it.

## Project layout
```
server.js            web server (Express)
src/db.js            PostgreSQL (or built-in database when DATABASE_URL is empty)
src/schema.sql       tables
src/exam-core.js     exam rules: grading, random sets, devices, integrity events
src/routes/          auth, admin, teacher, student, attempt (the exam engine)
public/              pages: home, student dashboard, teacher console, admin console
public/exam/         the exam screen
test/run.js          end-to-end browser test
render.yaml          free hosting on Render
Dockerfile, docker-compose.yml, .env.example   your own server (AWS etc.)
```
