# Exam Wizard: notes for Claude

Online exam website: teachers build question banks and exams; students join classes and take exams with
integrity checks (tab/window switching, second monitor, camera with phone detection, device checks).
Live at the owner's domain on their own Ubuntu server (shared with other sites, behind nginx), database on Neon (PostgreSQL).

## Writing quiz questions
When asked to write quiz/exam questions, output a CSV in the format in
[`docs/question-format.md`](docs/question-format.md) (columns `QuestionID,Type,Question,Choices,Answer,Points,Topic,Folder`,
choices separated by ` | `, MC answer = letter, quote fields with commas, UTF-8). Follow its "When an AI writes a quiz" rules:
balanced answer letters, worked-out calculations, IDs with a course prefix, Topic per sub-topic, one Folder for the set.
Before handing it over, check that it parses (e.g. with `parseCsv` from `src/util.js` and `core.mcCorrectIndex`).

## Code
- Node 22, Express 5, `pg`; PGlite (optional dependency) for local runs and tests when `DATABASE_URL` is empty.
- `server.js` (pages, API mounting), `src/routes/{auth,admin,teacher,student,attempt}.js`, `src/exam-core.js` (grading,
  random sets, options), `src/schema.sql` (migrations run at every start: `CREATE … IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`),
  `public/` (pages; `public/exam/` is the exam screen, `public/exam/camera.js` the camera checks), `deploy/` (server scripts).
- With PGlite, never call `db.query` inside `db.tx(...)`: use the transaction's `t.query` (otherwise it deadlocks).
- Settings are cached in memory (`src/settings.js`); page views must not wake the database (Neon free compute hours).
- Text for users is plain and friendly; the site owner is a teacher, not a developer.

## Test and deploy
- `npm test` runs the whole site in Chromium (`test/run.js`). Also run it against PostgreSQL:
  `TEST_DATABASE_URL=postgres://… npm test` with an empty database. Both must print `ALL PASSED`.
- Pushing to `main` deploys: GitHub Actions (`.github/workflows/deploy.yml`) runs the tests, copies the files to the
  server and restarts the `exam-wizard` service; a version that doesn't start is rolled back automatically.
  So only push to `main` after both test runs pass. Secrets live in GitHub Secrets and in `~/exam-wizard/.env`
  on the server: never commit or ask for them in chat.
