-- Online Exam platform: database schema (PostgreSQL 14+).
-- Safe to run on every start: everything is "IF NOT EXISTS".

CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,            -- stored lower-case
  password_hash text NOT NULL,
  name          text NOT NULL,
  role          text NOT NULL CHECK (role IN ('student', 'teacher', 'admin')),
  student_no    text,
  school        text,
  teacher_until timestamptz,                     -- unlimited publishing until this time
  credits       integer NOT NULL DEFAULT 0,      -- 1 credit = publish 1 exam
  disabled      boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settings (
  key   text PRIMARY KEY,
  value jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS access_codes (
  code       text PRIMARY KEY,
  kind       text NOT NULL CHECK (kind IN ('days', 'credits')),
  amount     integer NOT NULL CHECK (amount > 0),
  max_uses   integer NOT NULL DEFAULT 1,
  uses       integer NOT NULL DEFAULT 0,
  expires_at timestamptz,
  note       text,
  active     boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS code_redemptions (
  code    text NOT NULL REFERENCES access_codes(code) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (code, user_id)
);

CREATE TABLE IF NOT EXISTS credit_requests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL DEFAULT 'credits' CHECK (kind IN ('credits', 'access')),
  credits     integer NOT NULL DEFAULT 0,
  reference   text,
  message     text,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  handled_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  handled_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Every change to a teacher's credits or access, for auditing
CREATE TABLE IF NOT EXISTS credit_ledger (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credits    integer NOT NULL DEFAULT 0,
  days       integer NOT NULL DEFAULT 0,
  reason     text NOT NULL,
  at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS classes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       text NOT NULL,
  section    text,
  join_code  text NOT NULL UNIQUE,
  archived   boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS enrollments (
  class_id   uuid NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (class_id, student_id)
);

CREATE TABLE IF NOT EXISTS images (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mime       text NOT NULL,
  bytes      integer NOT NULL,
  data       bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS questions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code       text NOT NULL,                       -- the teacher's own ID, e.g. EEE150-001
  type       text NOT NULL CHECK (type IN ('MC', 'TF', 'FIB', 'ESSAY')),
  text       text NOT NULL,
  choices    jsonb NOT NULL DEFAULT '[]',
  answer     text NOT NULL DEFAULT '',
  points     double precision NOT NULL DEFAULT 1,
  topic      text NOT NULL DEFAULT '',
  image_id   uuid REFERENCES images(id) ON DELETE SET NULL,
  image_url  text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (teacher_id, code)
);

CREATE TABLE IF NOT EXISTS exams (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  class_id         uuid NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  title            text NOT NULL,
  instructions     text NOT NULL DEFAULT '',
  question_ids     jsonb NOT NULL DEFAULT '[]',
  start_at         timestamptz,
  end_at           timestamptz,
  time_limit_min   double precision NOT NULL DEFAULT 0,
  shuffle_q        boolean NOT NULL DEFAULT true,
  shuffle_c        boolean NOT NULL DEFAULT true,
  show_score       boolean NOT NULL DEFAULT true,
  display_mode     text NOT NULL DEFAULT 'ALL',
  allow_back       boolean NOT NULL DEFAULT true,
  question_seconds integer NOT NULL DEFAULT 0,
  pick_count       integer NOT NULL DEFAULT 0,
  topic_counts     jsonb NOT NULL DEFAULT '[]',
  face_mode        text NOT NULL DEFAULT 'OFF',
  camera_preview   boolean NOT NULL DEFAULT true,
  allowed_devices  text NOT NULL DEFAULT 'COMPUTER',
  password         text,
  options          jsonb NOT NULL DEFAULT '{}',
  published        boolean NOT NULL DEFAULT false,
  published_at     timestamptz,
  credit_spent     boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS attempts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_id         uuid NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  student_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status          text NOT NULL,
  started_at      timestamptz NOT NULL DEFAULT now(),
  deadline        timestamptz,
  submitted_at    timestamptz,
  score           double precision,
  max_score       double precision,
  percent         double precision,
  pending_essays  integer,
  late            boolean NOT NULL DEFAULT false,
  void_reason     text,
  voided_at       timestamptz,
  allow_retake    boolean NOT NULL DEFAULT false,
  is_retake       boolean NOT NULL DEFAULT false,
  user_agent      text,
  device          text,
  warnings        integer NOT NULL DEFAULT 0,
  last_seen       timestamptz,
  disconnected_at timestamptz,
  reconnects      integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS attempts_exam_student ON attempts (exam_id, student_id, started_at);

CREATE TABLE IF NOT EXISTS responses (
  attempt_id     uuid NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  question_id    uuid NOT NULL,
  position       integer NOT NULL DEFAULT 0,
  type           text NOT NULL,
  question_text  text NOT NULL,
  student_answer text NOT NULL DEFAULT '',
  correct_answer text NOT NULL DEFAULT '',
  is_correct     boolean,
  points_earned  double precision,
  max_points     double precision NOT NULL,
  PRIMARY KEY (attempt_id, question_id)
);

CREATE TABLE IF NOT EXISTS locked_answers (
  attempt_id  uuid NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  question_id uuid NOT NULL,
  answer      text NOT NULL DEFAULT '',
  at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (attempt_id, question_id)
);

CREATE TABLE IF NOT EXISTS violations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id uuid NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  event      text NOT NULL,
  detail     text NOT NULL DEFAULT '',
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS violations_attempt ON violations (attempt_id, at);

-- Question bank folders (nested). Deleting a folder moves its questions and subfolders up to the parent.
CREATE TABLE IF NOT EXISTS question_folders (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id  uuid REFERENCES question_folders(id) ON DELETE CASCADE,
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE questions ADD COLUMN IF NOT EXISTS folder_id uuid REFERENCES question_folders(id) ON DELETE SET NULL;

-- Profile pictures (small square JPEGs)
CREATE TABLE IF NOT EXISTS avatars (
  user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  mime       text NOT NULL,
  data       bytea NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Payments: which method the teacher used, the amount, a receipt picture, and the PayPal order (paid automatically).
ALTER TABLE credit_requests ADD COLUMN IF NOT EXISTS method text;
ALTER TABLE credit_requests ADD COLUMN IF NOT EXISTS amount numeric(12,2);
ALTER TABLE credit_requests ADD COLUMN IF NOT EXISTS currency text;
ALTER TABLE credit_requests ADD COLUMN IF NOT EXISTS proof_image_id uuid REFERENCES images(id) ON DELETE SET NULL;
ALTER TABLE credit_requests ADD COLUMN IF NOT EXISTS paypal_order_id text;
CREATE UNIQUE INDEX IF NOT EXISTS credit_requests_paypal_order ON credit_requests (paypal_order_id);

-- Small still pictures taken when the camera flags something (proof for the teacher). No video is kept.
CREATE TABLE IF NOT EXISTS attempt_snapshots (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id uuid NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  event      text NOT NULL,
  mime       text NOT NULL,
  bytes      integer NOT NULL,
  data       bytea NOT NULL,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS attempt_snapshots_attempt ON attempt_snapshots (attempt_id, at);

-- Tab/window switch warnings used in this attempt (the exam's focusWarnings option sets how many are allowed).
ALTER TABLE attempts ADD COLUMN IF NOT EXISTS focus_warnings integer NOT NULL DEFAULT 0;
