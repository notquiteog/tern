// Schema as ordered, idempotent steps. Add new entries at the end; never edit
// one that has shipped. Each step runs inside its own transaction.
export interface Migration { id: string; up: string }

export const migrations: Migration[] = [
  {
    id: '20260905_0001_baseline',
    up: `
CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
  totp_secret TEXT,
  totp_enabled BOOLEAN NOT NULL DEFAULT false,
  recovery_codes TEXT[] NOT NULL DEFAULT '{}',
  prefs JSONB NOT NULL DEFAULT '{}'::jsonb,
  disabled BOOLEAN NOT NULL DEFAULT false,
  password_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS accounts (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('fastmail','stalwart','jmap')),
  session_url TEXT NOT NULL,
  auth_type TEXT NOT NULL CHECK (auth_type IN ('bearer','basic')),
  auth_user TEXT,
  auth_secret_enc TEXT NOT NULL,
  pin_origin BOOLEAN NOT NULL DEFAULT false,
  smtp JSONB,
  send_via TEXT NOT NULL DEFAULT 'jmap' CHECK (send_via IN ('jmap','smtp')),
  signature_html TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '#4f6df5',
  jmap_account_id TEXT,
  api_url TEXT,
  upload_url TEXT,
  download_url TEXT,
  event_source_url TEXT,
  capabilities JSONB NOT NULL DEFAULT '{}'::jsonb,
  identity_id TEXT,
  mailbox_state TEXT,
  email_state TEXT,
  sync_status TEXT NOT NULL DEFAULT 'idle',
  sync_error TEXT,
  last_sync_at TIMESTAMPTZ,
  initial_sync_done BOOLEAN NOT NULL DEFAULT false,
  sync_limit INT NOT NULL DEFAULT 3000,
  daily_cap INT NOT NULL DEFAULT 40,
  jitter_enabled BOOLEAN NOT NULL DEFAULT true,
  jitter_min_s INT NOT NULL DEFAULT 45,
  jitter_max_s INT NOT NULL DEFAULT 240,
  send_window JSONB NOT NULL DEFAULT '{"start":9,"end":17,"days":[1,2,3,4,5],"tz":"UTC"}'::jsonb,
  next_send_at TIMESTAMPTZ,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, email)
);

CREATE TABLE IF NOT EXISTS mailboxes (
  id BIGSERIAL PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  jmap_id TEXT NOT NULL,
  name TEXT NOT NULL,
  parent_id TEXT,
  role TEXT,
  sort_order INT NOT NULL DEFAULT 0,
  total_emails INT NOT NULL DEFAULT 0,
  unread_emails INT NOT NULL DEFAULT 0,
  total_threads INT NOT NULL DEFAULT 0,
  unread_threads INT NOT NULL DEFAULT 0,
  color TEXT,
  UNIQUE (account_id, jmap_id)
);

CREATE TABLE IF NOT EXISTS emails (
  id BIGSERIAL PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  jmap_id TEXT NOT NULL,
  blob_id TEXT,
  thread_id TEXT NOT NULL,
  mailbox_ids TEXT[] NOT NULL DEFAULT '{}',
  keywords TEXT[] NOT NULL DEFAULT '{}',
  size INT NOT NULL DEFAULT 0,
  received_at TIMESTAMPTZ NOT NULL,
  sent_at TIMESTAMPTZ,
  message_id TEXT[] NOT NULL DEFAULT '{}',
  in_reply_to TEXT[] NOT NULL DEFAULT '{}',
  references_ids TEXT[] NOT NULL DEFAULT '{}',
  from_addr JSONB NOT NULL DEFAULT '[]'::jsonb,
  to_addr JSONB NOT NULL DEFAULT '[]'::jsonb,
  cc_addr JSONB NOT NULL DEFAULT '[]'::jsonb,
  bcc_addr JSONB NOT NULL DEFAULT '[]'::jsonb,
  reply_to JSONB NOT NULL DEFAULT '[]'::jsonb,
  subject TEXT NOT NULL DEFAULT '',
  preview TEXT NOT NULL DEFAULT '',
  has_attachment BOOLEAN NOT NULL DEFAULT false,
  body_text TEXT,
  body_html TEXT,
  attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
  auto_submitted TEXT,
  from_email TEXT GENERATED ALWAYS AS (lower(from_addr->0->>'email')) STORED,
  is_unread BOOLEAN GENERATED ALWAYS AS (NOT ('$seen' = ANY(keywords))) STORED,
  is_flagged BOOLEAN GENERATED ALWAYS AS ('$flagged' = ANY(keywords)) STORED,
  is_draft BOOLEAN GENERATED ALWAYS AS ('$draft' = ANY(keywords)) STORED,
  search_tsv TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(subject, '')), 'A') ||
    setweight(to_tsvector('simple', left(coalesce(body_text, preview, ''), 200000)), 'B')
  ) STORED,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, jmap_id)
);
CREATE INDEX IF NOT EXISTS emails_thread_idx ON emails(account_id, thread_id);
CREATE INDEX IF NOT EXISTS emails_received_idx ON emails(account_id, received_at DESC);
CREATE INDEX IF NOT EXISTS emails_mailboxes_idx ON emails USING GIN (mailbox_ids);
CREATE INDEX IF NOT EXISTS emails_search_idx ON emails USING GIN (search_tsv);
CREATE INDEX IF NOT EXISTS emails_from_idx ON emails(account_id, from_email);
CREATE INDEX IF NOT EXISTS emails_message_id_idx ON emails USING GIN (message_id);
CREATE INDEX IF NOT EXISTS emails_in_reply_to_idx ON emails USING GIN (in_reply_to);
CREATE INDEX IF NOT EXISTS emails_references_idx ON emails USING GIN (references_ids);

CREATE TABLE IF NOT EXISTS contacts (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  company TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  website TEXT NOT NULL DEFAULT '',
  fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  tags TEXT[] NOT NULL DEFAULT '{}',
  notes TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'manual',
  consent_source TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','unsubscribed','bounced','replied','do_not_contact')),
  timezone TEXT,
  last_contacted_at TIMESTAMPTZ,
  last_replied_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  search_tsv TSVECTOR GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce(email,'') || ' ' || coalesce(first_name,'') || ' ' || coalesce(last_name,'') || ' ' || coalesce(company,'') || ' ' || coalesce(title,''))
  ) STORED,
  UNIQUE (user_id, email)
);
CREATE INDEX IF NOT EXISTS contacts_search_idx ON contacts USING GIN (search_tsv);
CREATE INDEX IF NOT EXISTS contacts_tags_idx ON contacts USING GIN (tags);

CREATE TABLE IF NOT EXISTS suppressions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('unsubscribe','bounce','complaint','manual','reply_stop','import')),
  source TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, email)
);

CREATE TABLE IF NOT EXISTS templates (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  body_html TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'outreach',
  ai_brief TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sequences (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id BIGINT REFERENCES accounts(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','archived')),
  stop_on_reply BOOLEAN NOT NULL DEFAULT true,
  ai_mode TEXT NOT NULL DEFAULT 'review' CHECK (ai_mode IN ('off','review','auto')),
  unsubscribe_footer BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sequence_steps (
  id BIGSERIAL PRIMARY KEY,
  sequence_id BIGINT NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  position INT NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'email' CHECK (kind IN ('email','wait')),
  template_id BIGINT REFERENCES templates(id) ON DELETE SET NULL,
  subject TEXT NOT NULL DEFAULT '',
  body_html TEXT NOT NULL DEFAULT '',
  wait_days INT NOT NULL DEFAULT 0,
  wait_hours INT NOT NULL DEFAULT 0,
  ai_personalize BOOLEAN NOT NULL DEFAULT false,
  ai_instructions TEXT NOT NULL DEFAULT '',
  reply_in_thread BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sequence_steps_seq_idx ON sequence_steps(sequence_id, position);

CREATE TABLE IF NOT EXISTS enrollments (
  id BIGSERIAL PRIMARY KEY,
  sequence_id BIGINT NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  contact_id BIGINT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  account_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','waiting_review','paused','finished','replied','bounced','unsubscribed','error')),
  current_step INT NOT NULL DEFAULT 0,
  next_run_at TIMESTAMPTZ,
  thread_id TEXT,
  last_message_id TEXT,
  last_subject TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  UNIQUE (sequence_id, contact_id)
);
CREATE INDEX IF NOT EXISTS enrollments_due_idx ON enrollments(status, next_run_at);

CREATE TABLE IF NOT EXISTS send_log (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id BIGINT REFERENCES contacts(id) ON DELETE SET NULL,
  sequence_id BIGINT REFERENCES sequences(id) ON DELETE SET NULL,
  step_id BIGINT REFERENCES sequence_steps(id) ON DELETE SET NULL,
  enrollment_id BIGINT REFERENCES enrollments(id) ON DELETE SET NULL,
  message_id TEXT,
  jmap_email_id TEXT,
  thread_id TEXT,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'compose' CHECK (kind IN ('sequence','compose','reply','forward','scheduled')),
  status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','failed')),
  error TEXT,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  replied_at TIMESTAMPTZ,
  bounced_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS send_log_account_day_idx ON send_log(account_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS send_log_message_id_idx ON send_log(message_id);
CREATE INDEX IF NOT EXISTS send_log_contact_idx ON send_log(contact_id);

CREATE TABLE IF NOT EXISTS review_queue (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  enrollment_id BIGINT NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  account_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id BIGINT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  step_id BIGINT REFERENCES sequence_steps(id) ON DELETE SET NULL,
  subject TEXT NOT NULL DEFAULT '',
  body_html TEXT NOT NULL DEFAULT '',
  ai_model TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS review_queue_pending_idx ON review_queue(user_id, status);

CREATE TABLE IF NOT EXISTS rules (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id BIGINT REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  match TEXT NOT NULL DEFAULT 'all' CHECK (match IN ('all','any')),
  conditions JSONB NOT NULL DEFAULT '[]'::jsonb,
  actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  position INT NOT NULL DEFAULT 0,
  hits INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS snoozes (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL,
  until_at TIMESTAMPTZ NOT NULL,
  restored BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, thread_id)
);

CREATE TABLE IF NOT EXISTS outbox (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  payload JSONB NOT NULL,
  send_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','sending','sent','failed','cancelled')),
  error TEXT,
  attempts INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS outbox_due_idx ON outbox(status, send_at);

CREATE TABLE IF NOT EXISTS drafts (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id BIGINT REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'new' CHECK (kind IN ('new','reply','reply_all','forward')),
  reply_to_email_id BIGINT REFERENCES emails(id) ON DELETE SET NULL,
  thread_id TEXT,
  to_addr JSONB NOT NULL DEFAULT '[]'::jsonb,
  cc_addr JSONB NOT NULL DEFAULT '[]'::jsonb,
  bcc_addr JSONB NOT NULL DEFAULT '[]'::jsonb,
  subject TEXT NOT NULL DEFAULT '',
  body_html TEXT NOT NULL DEFAULT '',
  attachment_ids BIGINT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS uploads (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size INT NOT NULL,
  data BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS contact_threads (
  contact_id BIGINT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  account_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (contact_id, account_id, thread_id)
);
CREATE INDEX IF NOT EXISTS contact_threads_thread_idx ON contact_threads(account_id, thread_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`,
  },
  {
    id: '20260905_0002_responders_invites_voice',
    up: `
CREATE TABLE IF NOT EXISTS responders (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id BIGINT REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  mode TEXT NOT NULL DEFAULT 'draft' CHECK (mode IN ('draft','review','send')),
  match TEXT NOT NULL DEFAULT 'all' CHECK (match IN ('all','any')),
  conditions JSONB NOT NULL DEFAULT '[]'::jsonb,
  only_contacts BOOLEAN NOT NULL DEFAULT false,
  skip_lists BOOLEAN NOT NULL DEFAULT true,
  instructions TEXT NOT NULL DEFAULT '',
  tone TEXT NOT NULL DEFAULT 'friendly',
  length TEXT NOT NULL DEFAULT 'medium',
  reply_all BOOLEAN NOT NULL DEFAULT false,
  humanize BOOLEAN NOT NULL DEFAULT true,
  daily_cap INT NOT NULL DEFAULT 20,
  cooldown_hours INT NOT NULL DEFAULT 24,
  position INT NOT NULL DEFAULT 0,
  hits INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_jobs (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed','skipped')),
  attempts INT NOT NULL DEFAULT 0,
  error TEXT,
  result TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_jobs_pending_idx ON ai_jobs(status, created_at);

CREATE TABLE IF NOT EXISTS invites (
  id BIGSERIAL PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
  note TEXT NOT NULL DEFAULT '',
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE review_queue ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'sequence';
ALTER TABLE review_queue ADD COLUMN IF NOT EXISTS responder_id BIGINT REFERENCES responders(id) ON DELETE CASCADE;
ALTER TABLE review_queue ADD COLUMN IF NOT EXISTS reply_to_email_id BIGINT REFERENCES emails(id) ON DELETE CASCADE;
ALTER TABLE review_queue ADD COLUMN IF NOT EXISTS thread_id TEXT;
ALTER TABLE review_queue ADD COLUMN IF NOT EXISTS to_addr JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE review_queue ADD COLUMN IF NOT EXISTS context TEXT NOT NULL DEFAULT '';
ALTER TABLE review_queue ALTER COLUMN enrollment_id DROP NOT NULL;
ALTER TABLE review_queue ALTER COLUMN contact_id DROP NOT NULL;

ALTER TABLE drafts ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'user';
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS responder_id BIGINT REFERENCES responders(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS drafts_thread_idx ON drafts(account_id, thread_id);

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS voice TEXT NOT NULL DEFAULT '';

ALTER TABLE send_log ADD COLUMN IF NOT EXISTS responder_id BIGINT REFERENCES responders(id) ON DELETE SET NULL;
ALTER TABLE send_log DROP CONSTRAINT IF EXISTS send_log_kind_check;
ALTER TABLE send_log ADD CONSTRAINT send_log_kind_check CHECK (kind IN ('sequence','compose','reply','forward','scheduled','auto_reply'));
`,
  },
  {
    id: '20260905_0003_template_options',
    up: `
ALTER TABLE templates ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
ALTER TABLE templates ADD COLUMN IF NOT EXISTS include_signature BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS starred BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS library_key TEXT;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS use_count INT NOT NULL DEFAULT 0;
ALTER TABLE send_log ADD COLUMN IF NOT EXISTS template_id BIGINT REFERENCES templates(id) ON DELETE SET NULL;
`,
  },
  {
    id: '20260905_0004_avatars',
    up: `
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar BYTEA;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_type TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_updated_at TIMESTAMPTZ;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS avatar BYTEA;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS avatar_type TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS avatar_updated_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS contacts_email_lower_idx ON contacts (user_id, lower(email));
`,
  },
  {
    id: '20260905_0005_brands',
    up: `
CREATE TABLE IF NOT EXISTS brands (
  domain TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  svg TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#ffffff',
  bg TEXT NOT NULL DEFAULT '#4f6df5',
  initials TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id) ON DELETE SET NULL
);
`,
  },
  {
    id: '20260905_0006_brand_bimi_options',
    up: `
ALTER TABLE brands ADD COLUMN IF NOT EXISTS vmc_url TEXT NOT NULL DEFAULT '';
ALTER TABLE brands ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'upload';
ALTER TABLE brands ADD COLUMN IF NOT EXISTS report JSONB NOT NULL DEFAULT '{}'::jsonb;
`,
  },
  {
    id: '20260906_0007_openpgp',
    up: `
ALTER TABLE users ADD COLUMN IF NOT EXISTS pgp_public_key TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pgp_fingerprint TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pgp_private_key_enc TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pgp_auth TEXT NOT NULL DEFAULT 'off' CHECK (pgp_auth IN ('off','second_factor','passwordless'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS pgp_updated_at TIMESTAMPTZ;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS pgp_public_key TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS pgp_fingerprint TEXT;
CREATE TABLE IF NOT EXISTS pgp_keys (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  public_key TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, email)
);
ALTER TABLE sequences ADD COLUMN IF NOT EXISTS encrypt_pgp BOOLEAN NOT NULL DEFAULT false;
`,
  },
  {
    id: '20260906_0008_push_and_burners',
    up: `
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  failures INT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON push_subscriptions(user_id);
CREATE TABLE IF NOT EXISTS burner_addresses (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  account_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  address TEXT NOT NULL UNIQUE,
  local_part TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`,
  },
];
