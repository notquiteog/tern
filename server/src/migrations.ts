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
  {
    id: '20260906_0009_mail_client_features',
    up: `
ALTER TABLE emails ADD COLUMN IF NOT EXISTS list_unsubscribe TEXT;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS list_id TEXT;
CREATE TABLE IF NOT EXISTS muted_threads (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, thread_id)
);
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS forward_of_email_id BIGINT REFERENCES emails(id) ON DELETE SET NULL;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS forward_blob_ids TEXT[] NOT NULL DEFAULT '{}';
`,
  },
  {
    id: '20260906_0010_autocrypt_guard_provisioning',
    up: `
CREATE TABLE IF NOT EXISTS autocrypt_peers (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  last_seen TIMESTAMPTZ,
  autocrypt_timestamp TIMESTAMPTZ,
  public_key TEXT,
  fingerprint TEXT,
  prefer_encrypt TEXT NOT NULL DEFAULT 'nopreference' CHECK (prefer_encrypt IN ('mutual','nopreference')),
  gossip_timestamp TIMESTAMPTZ,
  gossip_key TEXT,
  gossip_fingerprint TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, email)
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS autocrypt_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS autocrypt_prefer TEXT NOT NULL DEFAULT 'nopreference' CHECK (autocrypt_prefer IN ('mutual','nopreference'));
ALTER TABLE review_queue ADD COLUMN IF NOT EXISTS hold_reason TEXT;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS autocrypt_seen BOOLEAN NOT NULL DEFAULT false;
`,
  },
  {
    id: '20260906_0011_security_hardening_vacation',
    up: `
-- A TOTP code is accepted once: the time step of the last accepted code is
-- kept so a code seen by a shoulder-surfer cannot be replayed in its window.
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_last_step BIGINT;
-- Out-of-office auto-reply per mailbox: {enabled, subject, body, start, end, onlyContacts, intervalDays}.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS vacation JSONB NOT NULL DEFAULT '{}'::jsonb;
-- Who already got the auto-reply, so a person writing twice is answered once per interval.
CREATE TABLE IF NOT EXISTS vacation_replies (
  account_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, email)
);
`,
  },
  {
    id: '20260906_0012_passkeys',
    up: `
-- Passkeys (WebAuthn). One row per authenticator; the public key is not a
-- secret, so it is stored as it arrived. A passkey that verified the person
-- (PIN, fingerprint, face) can stand in for the password entirely, exactly
-- as the OpenPGP key can; one that only proved presence is a second factor.
CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  alg INT NOT NULL,
  sign_count BIGINT NOT NULL DEFAULT 0,
  aaguid TEXT,
  transports TEXT[] NOT NULL DEFAULT '{}',
  name TEXT NOT NULL DEFAULT 'Passkey',
  backed_up BOOLEAN NOT NULL DEFAULT false,
  user_verified BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS webauthn_user_idx ON webauthn_credentials(user_id);
-- off: passkeys are only a second factor. passwordless: a verifying passkey
-- is the whole sign-in, like pgp_auth.
ALTER TABLE users ADD COLUMN IF NOT EXISTS passkey_auth TEXT NOT NULL DEFAULT 'second_factor' CHECK (passkey_auth IN ('second_factor','passwordless'));
`,
  },
  {
    id: '20260906_0013_retention_draft_sync',
    up: `
-- Automatic emptying of Trash and Junk, per account, on by default at 30
-- days as Gmail and Proton do. This applies to accounts that already exist:
-- the first run after upgrading destroys mail that has sat in Trash or Junk
-- for longer than a month, on the mail server as well as in the cache. The
-- window is per account and the whole thing can be turned off in
-- Settings -> Mailboxes.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS trash_retention_days INT NOT NULL DEFAULT 30;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS junk_retention_days INT NOT NULL DEFAULT 30;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS retention_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS last_retention_at TIMESTAMPTZ;

-- Drafts are pushed to the mail server's Drafts mailbox so other clients on
-- the same mailbox see them. The ids are the server's copy; a draft whose
-- push failed keeps a null jmap_id and is retried.
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS jmap_id TEXT;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS jmap_blob_id TEXT;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS synced_at TIMESTAMPTZ;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS sync_error TEXT;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS sync_dirty BOOLEAN NOT NULL DEFAULT true;
CREATE INDEX IF NOT EXISTS drafts_sync_idx ON drafts(sync_dirty) WHERE sync_dirty;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS sync_drafts BOOLEAN NOT NULL DEFAULT true;
`,
  },
  {
    id: '20260906_0014_cache_at_rest',
    up: `
-- Encryption at rest for the mail cache (ENCRYPTION.md layer 1). Each user
-- gets a data key, wrapped with the server master key from .env and never
-- stored in the clear. Content columns become ciphertext under it.
ALTER TABLE users ADD COLUMN IF NOT EXISTS dek_wrapped TEXT;

-- The blind search index. A tsvector over plaintext would hold every word of
-- every message in the clear, which is exactly what this is meant to stop,
-- so searchable text becomes a set of HMAC terms instead. Ranking, stemming
-- and phrase search go with it; see docs/SECURITY.md.
ALTER TABLE emails ADD COLUMN IF NOT EXISTS search_terms BYTEA[] NOT NULL DEFAULT '{}';
ALTER TABLE emails ADD COLUMN IF NOT EXISTS address_terms BYTEA[] NOT NULL DEFAULT '{}';
ALTER TABLE emails ADD COLUMN IF NOT EXISTS from_terms BYTEA[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS emails_search_terms_idx ON emails USING GIN (search_terms);
CREATE INDEX IF NOT EXISTS emails_address_terms_idx ON emails USING GIN (address_terms);
CREATE INDEX IF NOT EXISTS emails_from_terms_idx ON emails USING GIN (from_terms);

-- from_email and search_tsv were generated from the plaintext, so they
-- cannot survive it: a generated column over ciphertext is noise, and the
-- tsvector index would leak what the encryption is hiding. Their jobs are
-- taken by from_terms and search_terms.
DROP INDEX IF EXISTS emails_search_idx;
DROP INDEX IF EXISTS emails_from_idx;
ALTER TABLE emails DROP COLUMN IF EXISTS search_tsv;
ALTER TABLE emails DROP COLUMN IF EXISTS from_email;
-- Kept plain and indexed: threading needs it, and a Message-ID is a random
-- token plus a domain the addresses already reveal.
CREATE INDEX IF NOT EXISTS emails_received_only_idx ON emails(received_at DESC);

-- How far the backfill has got, so an upgrade encrypts existing mail in the
-- background instead of locking the table on startup.
ALTER TABLE users ADD COLUMN IF NOT EXISTS cache_encrypted_at TIMESTAMPTZ;
`,
  },
  {
    // 0014 shipped in two halves during development: a database that applied
    // the first half has the keys and the index columns but not the column
    // type changes. Splitting the rest out means either state converges here.
    id: '20260906_0015_cache_at_rest_columns',
    up: `
-- The address and attachment columns were JSONB, which cannot hold
-- ciphertext. They become TEXT carrying sealed JSON. Existing rows convert to
-- their JSON text unchanged and stay readable: an unsealed value has no
-- "k1." prefix, so the vault hands it back as it is until the backfill
-- reaches it.
ALTER TABLE emails ALTER COLUMN from_addr TYPE TEXT USING from_addr::text;
ALTER TABLE emails ALTER COLUMN to_addr   TYPE TEXT USING to_addr::text;
ALTER TABLE emails ALTER COLUMN cc_addr   TYPE TEXT USING cc_addr::text;
ALTER TABLE emails ALTER COLUMN bcc_addr  TYPE TEXT USING bcc_addr::text;
ALTER TABLE emails ALTER COLUMN reply_to  TYPE TEXT USING reply_to::text;
ALTER TABLE emails ALTER COLUMN attachments TYPE TEXT USING attachments::text;
ALTER TABLE emails ALTER COLUMN from_addr SET DEFAULT '[]';
ALTER TABLE emails ALTER COLUMN to_addr   SET DEFAULT '[]';
ALTER TABLE emails ALTER COLUMN cc_addr   SET DEFAULT '[]';
ALTER TABLE emails ALTER COLUMN bcc_addr  SET DEFAULT '[]';
ALTER TABLE emails ALTER COLUMN reply_to  SET DEFAULT '[]';
ALTER TABLE emails ALTER COLUMN attachments SET DEFAULT '[]';

-- Drafts and the outbox hold the same content before it is sent.
ALTER TABLE drafts ALTER COLUMN to_addr  TYPE TEXT USING to_addr::text;
ALTER TABLE drafts ALTER COLUMN cc_addr  TYPE TEXT USING cc_addr::text;
ALTER TABLE drafts ALTER COLUMN bcc_addr TYPE TEXT USING bcc_addr::text;
ALTER TABLE drafts ALTER COLUMN to_addr  SET DEFAULT '[]';
ALTER TABLE drafts ALTER COLUMN cc_addr  SET DEFAULT '[]';
ALTER TABLE drafts ALTER COLUMN bcc_addr SET DEFAULT '[]';

ALTER TABLE emails ADD COLUMN IF NOT EXISTS sealed BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS emails_unsealed_idx ON emails(account_id) WHERE NOT sealed;

-- A scheduled send holds the whole message until it goes out, sometimes for
-- weeks. Same treatment: the payload becomes sealed text.
ALTER TABLE outbox ALTER COLUMN payload TYPE TEXT USING payload::text;

-- Housekeeping used to find the staged uploads a draft or a queued message
-- still needs by looking for their URLs in the body text. Sealed text cannot
-- be searched that way, so the ids are recorded when the row is written and
-- the daily sweep reads them instead of guessing.
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS upload_ids BIGINT[] NOT NULL DEFAULT '{}';
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS inline_upload_ids BIGINT[] NOT NULL DEFAULT '{}';

-- The review queue holds AI-drafted replies and, in its context column, a
-- slice of the message being answered. That is mail content, sealed with the
-- rest.
-- send_log keeps its subject in the clear on purpose: it is looked up by
-- subject, and a random IV per value makes equality impossible.
ALTER TABLE review_queue ALTER COLUMN to_addr TYPE TEXT USING to_addr::text;
ALTER TABLE review_queue ALTER COLUMN to_addr SET DEFAULT '[]';
`,
  },
  {
    // Automatic emptying is on by default for every account, including ones
    // that existed before it was added. An intermediate build of 0013 turned
    // it off for those, so the flag is settled here at the intended default.
    // It runs once; anyone who turns it off afterwards keeps it off.
    id: '20260906_0016_retention_default_on',
    up: `
UPDATE accounts SET retention_enabled = true WHERE NOT retention_enabled;
`,
  },
  {
    // Smart categories. The subject and sender are sealed, so this is worked
    // out as a message is synced and only the answer is stored; NULL means a
    // message from before this migration, which the inbox reads as Primary
    // until a backfill or a resync gets to it.
    id: '20260907_0017_smart_categories',
    up: `
ALTER TABLE emails ADD COLUMN IF NOT EXISTS category TEXT
  CHECK (category IS NULL OR category IN ('primary','transactions','updates','promotions'));
-- The inbox counts every tab on each load, so the lookup is by account and
-- category with the newest first.
CREATE INDEX IF NOT EXISTS emails_category_idx ON emails (account_id, category, received_at DESC);
`,
  },
  {
    // One-line AI summaries shown above a conversation in the list. Derived
    // from mail content, so sealed with the owner's key like everything else.
    // `latest_at` is the timestamp of the newest message the summary was
    // written from: when a reply arrives it no longer matches and the line is
    // regenerated rather than describing a stale conversation.
    id: '20260907_0018_thread_summaries',
    up: `
CREATE TABLE IF NOT EXISTS thread_summaries (
  account_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  latest_at TIMESTAMPTZ NOT NULL,
  model TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, thread_id)
);
`,
  },
  {
    // Consent. Nothing that reads mail for a purpose other than showing it to
    // its owner, and nothing that reaches the model, runs without a row here
    // and the matching install-wide switch in settings.features.
    id: '20260908_0019_capabilities',
    up: `
CREATE TABLE IF NOT EXISTS user_capabilities (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  capability TEXT NOT NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, capability)
);
`,
  },
  {
    // F1, meaning search. The vector lives in its own table rather than on the
    // message: it is derived data with its own lifetime, revoking consent has
    // to be able to drop all of it in one statement, and a message row that is
    // read on every list render should not carry a kilobyte nobody asked for.
    //
    // `vec` is int8, already multiplied by the per-user rotation derived from
    // the data key (services/embeddings.ts). Distances survive the rotation;
    // the axes that would let somebody read it back do not.
    id: '20260908_0020_semantic_index',
    up: `
CREATE TABLE IF NOT EXISTS email_vectors (
  email_id BIGINT PRIMARY KEY REFERENCES emails(id) ON DELETE CASCADE,
  account_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  vec BYTEA NOT NULL,
  dims SMALLINT NOT NULL,
  norm REAL NOT NULL DEFAULT 1,
  model TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_vectors_account_idx ON email_vectors(account_id);
-- Which messages still need one. A partial index keeps the "what is left"
-- query cheap once the backlog is gone.
ALTER TABLE emails ADD COLUMN IF NOT EXISTS embedded BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS emails_unembedded_idx ON emails(account_id, received_at DESC) WHERE NOT embedded;
`,
  },
  {
    // F2, priority ordering. The model is a linear one over the hashed terms
    // that are already in emails.search_terms, so its weights are as opaque as
    // the index they read; they are sealed anyway, because a weight vector is
    // still something learned from one person's mail.
    id: '20260908_0021_triage',
    up: `
CREATE TABLE IF NOT EXISTS triage_models (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  weights TEXT NOT NULL,
  samples INT NOT NULL DEFAULT 0,
  accuracy REAL,
  trained_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 0..100. Plain, like the category: it is a number about a message, not a
-- word from one, and the list sorts by it.
ALTER TABLE emails ADD COLUMN IF NOT EXISTS priority SMALLINT;
CREATE INDEX IF NOT EXISTS emails_priority_idx ON emails(account_id, priority DESC NULLS LAST, received_at DESC);
`,
  },
  {
    // F3, the impersonation guard. The flags are a closed vocabulary, so they
    // are stored as they are and can be filtered on; anything that names a
    // domain or a person is in the sealed detail beside them.
    id: '20260908_0022_guard',
    up: `
ALTER TABLE emails ADD COLUMN IF NOT EXISTS guard_flags TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE emails ADD COLUMN IF NOT EXISTS guard_detail TEXT;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS guard_checked BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS emails_guard_idx ON emails(account_id) WHERE array_length(guard_flags, 1) > 0;
`,
  },
  {
    // F5, the text inside attachments. Sealed like a body, and folded into the
    // same blind index so "the invoice Karen sent" is findable without the
    // words being anywhere in the clear.
    id: '20260908_0023_attachment_text',
    up: `
CREATE TABLE IF NOT EXISTS attachment_text (
  id BIGSERIAL PRIMARY KEY,
  email_id BIGINT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  account_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  part_id TEXT NOT NULL,
  name TEXT,
  content_type TEXT NOT NULL DEFAULT '',
  text TEXT,
  chars INT NOT NULL DEFAULT 0,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (email_id, part_id)
);
CREATE INDEX IF NOT EXISTS attachment_text_account_idx ON attachment_text(account_id);
ALTER TABLE emails ADD COLUMN IF NOT EXISTS attachments_extracted BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS emails_unextracted_idx ON emails(account_id, received_at DESC)
  WHERE has_attachment AND NOT attachments_extracted;
`,
  },
  {
    // F6, commitments. Every human-readable column is sealed; the dates and
    // the state are not, because the list is ordered and counted by them.
    id: '20260908_0024_commitments',
    up: `
CREATE TABLE IF NOT EXISTS commitments (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  email_id BIGINT REFERENCES emails(id) ON DELETE SET NULL,
  thread_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('owed','awaiting')),
  text TEXT NOT NULL,
  counterparty TEXT,
  due_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','dropped')),
  source TEXT NOT NULL DEFAULT 'ai' CHECK (source IN ('ai','manual')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS commitments_open_idx ON commitments(user_id, status, due_at NULLS LAST);
CREATE INDEX IF NOT EXISTS commitments_thread_idx ON commitments(account_id, thread_id);
-- Which conversations have been looked at, so a scan is not repeated for
-- every message of a thread that has not changed.
CREATE TABLE IF NOT EXISTS commitment_scans (
  account_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL,
  latest_at TIMESTAMPTZ NOT NULL,
  scanned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, thread_id)
);
`,
  },
  {
    // F8, the brief. One per person, replaced in place, sealed. It is a cache
    // of a page, not a record of anything, so it holds no history.
    id: '20260908_0025_brief',
    up: `
CREATE TABLE IF NOT EXISTS briefs (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  model TEXT,
  covers_from TIMESTAMPTZ,
  covers_to TIMESTAMPTZ,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  duration_ms INT
);
`,
  },
  {
    // F10, invitations. Times are plain so the list can be ordered and a
    // clash can be found; everything a person would read is sealed.
    id: '20260908_0026_calendar',
    up: `
CREATE TABLE IF NOT EXISTS calendar_events (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  email_id BIGINT REFERENCES emails(id) ON DELETE CASCADE,
  uid TEXT,
  summary TEXT,
  location TEXT,
  organizer TEXT,
  attendees TEXT,
  description TEXT,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  all_day BOOLEAN NOT NULL DEFAULT false,
  method TEXT NOT NULL DEFAULT 'REQUEST',
  sequence INT NOT NULL DEFAULT 0,
  reply TEXT CHECK (reply IS NULL OR reply IN ('accepted','declined','tentative')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS calendar_events_when_idx ON calendar_events(user_id, starts_at);
CREATE UNIQUE INDEX IF NOT EXISTS calendar_events_email_uid_idx ON calendar_events(email_id, uid);
`,
  },
  {
    // F12, importing an archive. The staged file is on disk under the upload
    // directory and is deleted the moment the run ends, whether it worked or
    // not; this row is the progress the browser polls.
    id: '20260908_0027_imports',
    up: `
CREATE TABLE IF NOT EXISTS mail_imports (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  filename TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed','cancelled')),
  total INT NOT NULL DEFAULT 0,
  done INT NOT NULL DEFAULT 0,
  skipped INT NOT NULL DEFAULT 0,
  failed INT NOT NULL DEFAULT 0,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mail_imports_user_idx ON mail_imports(user_id, created_at DESC);
`,
  },
  {
    // A finished AI job holds the prompt it was given. Once it is finished
    // that is a copy of somebody's mail sitting in a queue table for no
    // reason, so the payload is emptied the moment the job leaves 'running'
    // and the row itself now lives hours rather than a month.
    id: '20260908_0028_ai_job_wipe',
    up: `
ALTER TABLE ai_jobs ALTER COLUMN payload SET DEFAULT '{}'::jsonb;
UPDATE ai_jobs SET payload='{}'::jsonb, result=NULL WHERE status IN ('done','failed','skipped');
DELETE FROM ai_jobs WHERE status IN ('done','failed','skipped') AND updated_at < now() - interval '1 day';
`,
  },
  {
    // Two facts about a message that several of the new features want and
    // that no amount of array matching makes cheap: which single term is its
    // sender, and how many people it went to.
    //
    // `from_blind` is the same keyed hash the address index already holds for
    // the full sender address, pulled out into its own column so "how many
    // have I had from this person" is a grouped count rather than an array
    // overlap over the whole mailbox. It is a hash under the owner's key, so
    // it says nothing on its own.
    //
    // `recipient_count` is a number, like size and has_attachment: it says
    // how widely a message was addressed, which is what separates a note to
    // you from a note to two hundred people.
    id: '20260908_0029_message_facts',
    up: `
ALTER TABLE emails ADD COLUMN IF NOT EXISTS from_blind BYTEA;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS recipient_count SMALLINT;
CREATE INDEX IF NOT EXISTS emails_from_blind_idx ON emails(account_id, from_blind, received_at);
-- Contacts are matched against senders on the same hash. The column is
-- filled by the backfill, and on every write from then on.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS email_blind BYTEA;
CREATE INDEX IF NOT EXISTS contacts_email_blind_idx ON contacts(user_id, email_blind);
`,
  },
  {
    // What the receiving mail server made of SPF, DKIM and DMARC. Not
    // content — it is a verdict about the envelope, written by our own MTA —
    // so it is stored as it arrived and the guard can read it without a key.
    id: '20260908_0030_auth_results',
    up: `
ALTER TABLE emails ADD COLUMN IF NOT EXISTS auth_results TEXT;
`,
  },
  {
    // Three columns that were storing content in the clear beside sealed
    // ones. Found by walking the schema rather than by spot-checking, which
    // is the only way this kind of mistake shows up.
    //
    // `emails.auth_results` is the Authentication-Results header, which is
    // not just a verdict: it routinely carries `smtp.mailfrom=ana@corp.example`
    // and `header.d=corp.example`. That is the sender's address, sitting in
    // plaintext next to a `from_addr` that is sealed. It is sealed now, and
    // the existing rows are dropped rather than converted — the guard
    // re-reads them on its next pass, and a value that was written in the
    // clear should not be left to look as though it never was.
    //
    // `calendar_events.uid` is an iCalendar UID. Most are random, but plenty
    // of systems build them out of the event title. It cannot simply be
    // sealed because a unique index depends on it, so it gains a blind
    // companion — the same trick `emails.from_blind` uses — and the readable
    // half is sealed.
    //
    // `mail_imports.filename` is a name the person chose for an export of
    // their own mail, which is not nothing.
    id: '20260908_0031_seal_leftovers',
    up: `
UPDATE emails SET auth_results = NULL WHERE auth_results IS NOT NULL;
UPDATE emails SET guard_checked = false WHERE guard_checked;

ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS uid_blind BYTEA;
DROP INDEX IF EXISTS calendar_events_email_uid_idx;
-- Rows written before this have a plaintext uid and no blind companion;
-- there is no key here to convert them with, and an invitation is cheap to
-- find again, so they go.
DELETE FROM calendar_events WHERE uid_blind IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS calendar_events_email_uid_idx ON calendar_events(email_id, uid_blind);

UPDATE mail_imports SET filename = NULL WHERE filename IS NOT NULL;
`,
  },
  {
    // Two columns and a table, for two features that both needed a way to
    // record "the person told us otherwise".
    //
    // `commitments.settle_after` exists because an owed commitment closes
    // itself as soon as anything of yours lands in the thread, and a
    // reschedule email is a message in the thread. Without a watermark,
    // writing "the quote will be Thursday instead" marks the quote as
    // delivered. Moving the goalposts sets this to now, and settling
    // compares against it rather than against when the item was created;
    // null means it has never moved and `created_at` still governs.
    //
    // `triage_feedback` is the priority model's only source of evidence that
    // did not come from watching. Everything else it learns is inferred from
    // archiving, starring, replying and junking, which cannot express "this
    // one is fine, it just does not belong at the top". A row here is a
    // label the person stated, and it outranks the inferred one.
    id: '20260906_2140_commitment_settle_after_and_triage_feedback',
    up: `
ALTER TABLE commitments ADD COLUMN IF NOT EXISTS settle_after TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS triage_feedback (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email_id BIGINT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  label SMALLINT NOT NULL CHECK (label IN (0, 1)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, email_id)
);
CREATE INDEX IF NOT EXISTS triage_feedback_user_idx ON triage_feedback(user_id);
`,
  },
  {
    // What a reply to a campaign said, so that "they answered" stops being one
    // undifferentiated pile. The label set is small and closed
    // (services/replyIntent.ts); anything a model returns that is not on the
    // list is stored as 'unclear', which routes to a person.
    id: '20260907_0600_reply_intent',
    up: `
ALTER TABLE send_log ADD COLUMN IF NOT EXISTS reply_intent TEXT;
CREATE INDEX IF NOT EXISTS send_log_reply_intent_idx ON send_log(sequence_id, reply_intent) WHERE reply_intent IS NOT NULL;
`,
  },
  {
    // F13, an actual calendar.
    //
    // `calendar_events` (F10) stays exactly what it was: invitations found in
    // mail, keyed to the message they arrived in. It is not touched here and
    // is not the same thing — an invitation is a copy of somebody else's
    // event that happened to be posted to you, and a calendar is a set of
    // collections you sync. The two meet in `services/calendar/index.ts`,
    // where a free/busy question consults both.
    //
    // Four tables:
    //   sources    one connected account (a CalDAV server, Google, Microsoft,
    //              or a subscribed ICS URL) with its credentials
    //   calendars  one collection inside a source
    //   objects    one VEVENT series, with the raw iCalendar kept as the
    //              truth so that a round trip through Tern never silently
    //              drops a property the parser does not model
    //   instances  the expanded occurrences over a rolling window, which is
    //              what makes "who is free on Thursday" one indexed query
    //              rather than a recurrence expansion per row
    //
    // Everything a person would read is sealed with their own key, as
    // everywhere else. Times are plain: the grid is ordered by them, free/busy
    // is computed from them, and an encrypted timestamp could do neither.
    id: '20260907_1200_calendar',
    up: `
CREATE TABLE IF NOT EXISTS calendar_sources (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('caldav','google','microsoft','ics')),
  label TEXT,
  base_url TEXT,
  username TEXT,
  -- Passwords, app passwords and OAuth refresh tokens, under the server key
  -- (accounts.auth_secret_enc uses the same one): the sync worker has to
  -- reach these with nobody signed in.
  secret_enc TEXT,
  token_enc TEXT,
  status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','syncing','auth_error','error')),
  error TEXT,
  sync_token TEXT,
  enabled BOOLEAN NOT NULL DEFAULT true,
  poll_seconds INT NOT NULL DEFAULT 300,
  last_sync_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS calendar_sources_user_idx ON calendar_sources(user_id);

CREATE TABLE IF NOT EXISTS calendars (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_id BIGINT NOT NULL REFERENCES calendar_sources(id) ON DELETE CASCADE,
  remote_id TEXT,
  remote_blind BYTEA NOT NULL,
  name TEXT,
  color TEXT,
  timezone TEXT,
  read_only BOOLEAN NOT NULL DEFAULT false,
  -- Off means it is connected but neither drawn nor counted as busy, which
  -- is what somebody wants for a colleague's calendar they can see.
  selected BOOLEAN NOT NULL DEFAULT true,
  is_default BOOLEAN NOT NULL DEFAULT false,
  sync_token TEXT,
  ctag TEXT,
  -- A push channel, where the provider offers one.
  channel_id TEXT,
  channel_secret TEXT,
  channel_resource TEXT,
  channel_expires_at TIMESTAMPTZ,
  last_sync_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS calendars_source_remote_idx ON calendars(source_id, remote_blind);
CREATE INDEX IF NOT EXISTS calendars_user_idx ON calendars(user_id);
CREATE INDEX IF NOT EXISTS calendars_channel_idx ON calendars(channel_id) WHERE channel_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS calendar_objects (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  calendar_id BIGINT NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
  uid TEXT,
  uid_blind BYTEA NOT NULL,
  remote_id TEXT,
  etag TEXT,
  -- The file as the server holds it. Everything below is derived from this,
  -- so a property Tern does not understand still survives a round trip.
  ical TEXT,
  summary TEXT,
  location TEXT,
  description TEXT,
  organizer TEXT,
  attendees TEXT,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  -- When the series ends, or NULL for one that never does. Lets a sweep find
  -- the events whose expansion needs extending without opening every row.
  range_end TIMESTAMPTZ,
  all_day BOOLEAN NOT NULL DEFAULT false,
  recurring BOOLEAN NOT NULL DEFAULT false,
  transparent BOOLEAN NOT NULL DEFAULT false,
  status TEXT,
  sequence INT NOT NULL DEFAULT 0,
  my_partstat TEXT,
  -- A local edit that has not reached the server yet, and a local delete
  -- that has not either. Both are pushed on the next sync and cleared there,
  -- so an edit made while the network was down is not lost.
  dirty BOOLEAN NOT NULL DEFAULT false,
  deleted BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS calendar_objects_uid_idx ON calendar_objects(calendar_id, uid_blind);
CREATE INDEX IF NOT EXISTS calendar_objects_when_idx ON calendar_objects(user_id, starts_at);
CREATE INDEX IF NOT EXISTS calendar_objects_dirty_idx ON calendar_objects(calendar_id) WHERE dirty OR deleted;
CREATE INDEX IF NOT EXISTS calendar_objects_extend_idx ON calendar_objects(user_id, range_end) WHERE recurring;

CREATE TABLE IF NOT EXISTS calendar_instances (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  calendar_id BIGINT NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
  object_id BIGINT NOT NULL REFERENCES calendar_objects(id) ON DELETE CASCADE,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  all_day BOOLEAN NOT NULL DEFAULT false,
  -- Whether this occurrence blocks the time: OPAQUE, not cancelled, and not
  -- one the person declined. Free/busy reads only these.
  busy BOOLEAN NOT NULL DEFAULT true,
  recurrence_id TIMESTAMPTZ,
  summary TEXT,
  location TEXT
);
CREATE INDEX IF NOT EXISTS calendar_instances_when_idx ON calendar_instances(user_id, starts_at);
CREATE INDEX IF NOT EXISTS calendar_instances_busy_idx ON calendar_instances(user_id, starts_at, ends_at) WHERE busy;
CREATE INDEX IF NOT EXISTS calendar_instances_object_idx ON calendar_instances(object_id);
`,
  },
  {
    // F13, the second half: reminders, and the two columns that make them
    // possible without a second scan of every event.
    //
    // `alarm_minutes` is how long before the start the earliest reminder
    // fires, taken from the event's own VALARM. Only the earliest, because
    // an event with reminders at an hour and at ten minutes wants one
    // notification for the person, not two — and the row that decides "is
    // anything due" has to be one indexed comparison rather than a JSON
    // scan.
    //
    // `notified_at` is on the occurrence rather than the event, because a
    // weekly stand-up needs a reminder every week and one flag on the series
    // would fire once and never again. It is also what makes the sweep safe
    // to run twice.
    id: '20260907_1800_calendar_reminders',
    up: `
ALTER TABLE calendar_objects ADD COLUMN IF NOT EXISTS alarm_minutes INT;
ALTER TABLE calendar_instances ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ;
-- The sweep asks one question: which occurrences that block time are due to
-- start soon and have not been announced. Partial, so it stays small however
-- many events the install holds.
CREATE INDEX IF NOT EXISTS calendar_instances_due_idx
  ON calendar_instances(starts_at)
  WHERE notified_at IS NULL AND busy;
`,
  },
  {
    // Vectors move out of Postgres and into Qdrant.
    //
    // `email_vectors` stays, minus the numbers: it becomes a MANIFEST saying
    // which messages are indexed and under which model. That is what
    // `indexPending` counts and what `invalidateVectorsFrom` marks, both pure
    // bookkeeping that wants to be a SQL statement rather than a conversation
    // with another service — and it keeps the cascade, so deleting a message
    // still drops its manifest row without Qdrant taking part in the
    // transaction.
    //
    // The `vec` and `norm` columns are dropped rather than migrated. Vectors
    // are derived data: there is no way to move them that is cheaper or safer
    // than making them again, and re-embedding is a path the install already
    // has to be good at. Everything is therefore marked unindexed, which the
    // ordinary background pass then rebuilds into Qdrant.
    //
    // That means meaning search is thin until the pass finishes — overnight on
    // a CPU-only box with a large mailbox. `indexPending` stays accurate
    // throughout, so the settings page can say how much is left, and ordinary
    // text search is unaffected the whole time.
    id: '20260909_1400_vector_store_qdrant',
    up: `
ALTER TABLE email_vectors DROP COLUMN IF EXISTS vec;
ALTER TABLE email_vectors DROP COLUMN IF EXISTS norm;
-- Every message goes back in the queue: the vectors that described them are
-- gone from here and not yet in Qdrant. Deliberately not conditional on
-- anything -- an install that had never embedded has nothing to re-do, and one
-- that had needs all of it.
UPDATE emails SET embedded = false WHERE embedded;
`,
  },
  {
    // The assistant's conversations — the first thing in Tern that remembers
    // what was said to a model.
    //
    // ── Why this table exists at all ────────────────────────────────────────
    //
    // Every other AI feature here is single-turn by construction: a prompt is
    // built, an answer comes back, and `ai/session.ts` drops the lot. There is
    // nothing to store because there is nothing that outlives the request. A
    // conversation is the deliberate exception — "make that shorter" is not a
    // sentence that means anything without the turn before it — so the
    // transcript has to be somewhere, and somewhere is here.
    //
    // ── Sealed, like the mail it is about ───────────────────────────────────
    //
    // `content`, `tool_calls`, `proposal` and `refs` are ciphertext under the
    // owner's data key, because a conversation about a mailbox quotes the
    // mailbox: a tool result carries real paragraphs of somebody's mail, and a
    // draft carries a message that has not been sent yet. Storing those in
    // clear beside an `emails` table that is sealed would put the plaintext of
    // a message one join away from the encrypted copy of itself.
    //
    // `role`, `tool_name` and `tool_call_id` are NOT sealed, and that is a
    // decision rather than an oversight. They carry no content — a role is one
    // of three words, a tool name is one of eight known strings, an id is
    // random — and leaving them readable is what lets the transcript be
    // reassembled in the right order and checked for shape without opening
    // every row first.
    id: '20260909_1500_assistant_conversations',
    up: `
CREATE TABLE IF NOT EXISTS ai_conversations (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Sealed. Written from the first thing the person said, not by the model:
  -- a title is worth one row's worth of storage and not a generation.
  title TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- The list is always "mine, most recent first", which is the whole query.
CREATE INDEX IF NOT EXISTS ai_conversations_user_idx ON ai_conversations(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS ai_messages (
  id BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  -- Denormalised from the conversation on purpose: every read is scoped by
  -- user_id in SQL, and a join is one more place for that scope to be
  -- forgotten in a query written in a hurry a year from now.
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','tool')),
  content TEXT,
  tool_calls TEXT,
  tool_call_id TEXT,
  tool_name TEXT,
  proposal TEXT,
  refs TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_messages_conversation_idx ON ai_messages(conversation_id, id);
CREATE INDEX IF NOT EXISTS ai_messages_user_idx ON ai_messages(user_id);
`,
  },
  {
    // Closing three loops the app already opens: a search you cannot keep, a
    // draft you rewrote that taught nothing, and a held send that names its
    // problem without offering the fix.
    id: '20260910_1600_saved_searches_draft_edits_hold_hits',
    up: `
-- A query worth keeping.
--
-- The omnibox already parses a rich operator language into removable chips,
-- and there has never been a way to keep one, so every recurring question is
-- retyped. The query is stored as the text somebody typed rather than as
-- parsed fields, deliberately: \`parseSearch\` is the single definition of what
-- an operator means, and a saved search that stored its own interpretation
-- would drift away from the search box the first time that parser learned
-- something new.
--
-- Sealed, because a query is a statement about what somebody is looking for
-- and "invoice from the solicitor" is as revealing as the mail it finds.
CREATE TABLE IF NOT EXISTS saved_searches (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  query TEXT NOT NULL,
  position INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS saved_searches_user_idx ON saved_searches(user_id, position, id);

-- What the model wrote, beside what was actually sent.
--
-- Priority ordering learns from what somebody archives, stars, replies to and
-- junks — honest signals, things they did rather than things they were asked.
-- The same argument applies to the signal this table exists for: an AI draft
-- that was edited before it went out is a person saying precisely what was
-- wrong with the output, in the most specific form there is, and until now it
-- was discarded on send.
--
-- Both texts are sealed: they are the person's own outgoing mail. Rows exist
-- only while there are too few to draw a conclusion from — the suggestion pass
-- clears them once it has offered its sentence — and turning the writing help
-- capability off deletes them with everything else it made.
CREATE TABLE IF NOT EXISTS ai_draft_edits (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id BIGINT REFERENCES accounts(id) ON DELETE CASCADE,
  -- 'compose' | 'reply' | 'rewrite': what the model was asked for. A reply
  -- being shortened and a fresh draft being rewritten are different habits.
  mode TEXT NOT NULL DEFAULT 'compose',
  generated TEXT NOT NULL,
  sent TEXT NOT NULL,
  -- How much of it survived, 0 to 1, computed once on write so the pass that
  -- looks for a pattern does not have to diff every row to find the
  -- interesting ones. An untouched draft is not evidence of anything.
  kept REAL NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_draft_edits_user_idx ON ai_draft_edits(user_id, created_at DESC);

-- Why a send was held, in a form something can act on.
--
-- \`hold_reason\` is prose for a person to read. These are the same findings as
-- structured hits, so the review queue can offer the correction rather than
-- only the complaint: an unfilled merge field has a real value sitting on the
-- contact record, and a bracketed placeholder is a line to delete. Sealed,
-- because a hit carries a sample of the message it was found in.
ALTER TABLE review_queue ADD COLUMN IF NOT EXISTS hold_hits TEXT;
`,
  },
  {
    // What a reply said, made into something a person can work through; and
    // the two filters an audience is actually described with.
    id: '20260910_1730_reply_intents_surfaced',
    up: `
-- A reply that has been dealt with.
--
-- \`reply_intent\` has been written onto every answered send since the
-- classifier shipped and nothing has ever read it, so there was no need for
-- this column. A Replies tab is a queue rather than a report — "three
-- interested" means three people to write to, and the count has to be able to
-- go down — and without somewhere to record that a reply has been handled the
-- same three sit at the top of the list for ever.
--
-- Deliberately not a status enum. Whether a reply was answered, forwarded or
-- simply read and dismissed is not a distinction the tab can act on, and every
-- extra state is one more thing for a route to get wrong.
ALTER TABLE send_log ADD COLUMN IF NOT EXISTS reply_handled_at TIMESTAMPTZ;

-- The index the tab reads on. The existing reply_intent index is keyed on
-- sequence_id, which answers "what did this campaign get"; a person's Replies
-- across every campaign, newest first, is a different question and the one
-- Home and the brief both ask.
CREATE INDEX IF NOT EXISTS send_log_reply_open_idx
  ON send_log(user_id, replied_at DESC)
  WHERE reply_intent IS NOT NULL AND reply_handled_at IS NULL;

-- Why a campaign stopped.
--
-- A campaign paused for a hole in its brief says so today in one place: the
-- \`error\` column of whichever enrollment happened to trip it, on a table
-- nobody opens until they have already noticed the sends stopped. The card,
-- Home and the toast all want the same sentence, so it belongs on the
-- sequence rather than on one of its enrollments.
--
-- Cleared on resume, so a stale reason can never explain a running campaign.
ALTER TABLE sequences ADD COLUMN IF NOT EXISTS pause_reason TEXT;
ALTER TABLE sequences ADD COLUMN IF NOT EXISTS paused_at TIMESTAMPTZ;

-- Notes and custom fields, findable.
--
-- The search vector covered the five columns a contact form has and not the
-- two places everything specific about somebody is actually written down: the
-- notes field and whatever the CSV import put in \`fields\`. "Sage" typed into
-- a custom column was invisible to the search box that sits above it, which
-- reads as the search being broken rather than as a design decision.
--
-- \`fields::text\` rather than its values alone: a subquery is not allowed in a
-- generated column, the cast is immutable, and having the key names searchable
-- too is worth having — "renewal" finds everybody with a renewal_date whether
-- or not they remember what they put in it.
--
-- Dropping and re-adding is the only way to change a generated column. It
-- rewrites the table, which at contact-list sizes is a table scan and not a
-- migration to be afraid of.
ALTER TABLE contacts DROP COLUMN IF EXISTS search_tsv;
ALTER TABLE contacts ADD COLUMN search_tsv TSVECTOR GENERATED ALWAYS AS (
  to_tsvector('simple',
    coalesce(email,'') || ' ' || coalesce(first_name,'') || ' ' || coalesce(last_name,'') || ' ' ||
    coalesce(company,'') || ' ' || coalesce(title,'') || ' ' || coalesce(notes,'') || ' ' ||
    coalesce(fields::text,''))
) STORED;
CREATE INDEX IF NOT EXISTS contacts_search_idx ON contacts USING GIN (search_tsv);
`,
  },
  {
    // The three things that should happen while a campaign runs and currently
    // do not: a ramp on a new mailbox, a send held for the recipient's own
    // morning, and a campaign that stops itself when the replies turn bad.
    id: '20260910_1900_warmup_local_windows_valves',
    up: `
-- The ramp the README describes, made into something the scheduler enforces.
--
-- The advice has always been to start a new mailbox at 20 to 30 a day and
-- build up. It was a paragraph of documentation next to a \`daily_cap\` field
-- that did exactly one thing, so following the advice meant somebody
-- remembering to raise the number by hand every morning for a fortnight, and
-- nobody does that.
--
-- Expressed as a start, a step and a date rather than as a schedule table:
-- the effective cap is \`start + step × days elapsed\`, clamped to the real
-- \`daily_cap\`, which needs no rows, cannot drift, and answers "what is the
-- cap today" with arithmetic instead of a lookup. Reaching the ceiling is
-- therefore self-limiting — there is nothing to turn off when it gets there.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS warmup_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS warmup_started_at TIMESTAMPTZ;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS warmup_start_cap INT NOT NULL DEFAULT 20;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS warmup_step INT NOT NULL DEFAULT 5;

-- Send in the recipient's morning, not in yours.
--
-- \`contacts.timezone\` has existed since the first schema and drives exactly
-- one thing: whether the greeting merge field says morning or afternoon. The
-- account's send window is the sender's working hours, so a campaign run from
-- London lands in California at two in the morning — technically inside the
-- window it was told about, and nowhere near the window it was meant for.
--
-- Per sequence rather than per account, because it is a property of the
-- campaign: a follow-up to people you already know can go whenever the window
-- is open, and a cold first touch across eight timezones cannot.
ALTER TABLE sequences ADD COLUMN IF NOT EXISTS contact_local_window BOOLEAN NOT NULL DEFAULT false;

-- The valves that make "send automatically" defensible.
--
-- Auto mode sends what a model wrote without anybody reading it. The argument
-- for offering that at all is that the guard checks every draft — but the
-- guard reads one message and cannot see the thing that actually signals a
-- campaign going wrong, which is the shape of what comes back: addresses that
-- do not exist, and people leaving in numbers.
--
-- Both thresholds are per campaign and both can be turned off by setting them
-- to zero. The bounce rate carries a minimum sample with it in code, because
-- one bounce out of the first two sends is 50% and means nothing.
ALTER TABLE sequences ADD COLUMN IF NOT EXISTS pause_on_bounce_pct INT NOT NULL DEFAULT 8;
ALTER TABLE sequences ADD COLUMN IF NOT EXISTS pause_on_unsubscribes INT NOT NULL DEFAULT 5;
`,
  },
  {
    // Why somebody left, asked once and never insisted on.
    id: '20260910_2000_unsub_reason',
    up: `
-- The unsubscribe page takes one click and says thank you. That click is the
-- only moment anybody who is leaving will ever tell you why, and the page has
-- never asked — so "too many emails" and "I never signed up for this" are the
-- same event in the database, although one is a pacing problem and the other
-- is a consent problem and they want opposite fixes.
--
-- On the enrollment rather than on the suppression, because the interesting
-- question is per campaign — "this brief loses people on step three" — and an
-- enrollment is the only row that already knows both the person and the
-- campaign. A contact who was on three campaigns records it against all three,
-- which is honest: they did not say which one it was about.
--
-- Nullable and staying that way. It is asked after the unsubscribe is already
-- done, on a page the person has no reason to still be reading, so most rows
-- will never have one and the feature has to be useful at a low answer rate.
ALTER TABLE enrollments ADD COLUMN IF NOT EXISTS unsub_reason TEXT;
`,
  },
  {
    // `email_vectors.model` becomes the whole embedder identity.
    //
    // It held a model name, and a name is not what decides whether two vectors
    // can be compared. `all-minilm` served by the Ollama next door and
    // `all-minilm` reached through an OpenAI-compatible gateway are different
    // embedders sharing a string — different builds, different pooling,
    // sometimes different normalisation — and the same is true of one name on
    // two hosts, or of `embedProvider: 'same'` when the language model's
    // address moves out from under it.
    //
    // Because the name was the scope, changing only the provider or the URL
    // invalidated nothing: the manifest still matched, the collection name was
    // unchanged, and meaning search went on scoring vectors from the old
    // endpoint against needles from the new one. That is the failure mode this
    // whole subsystem is arranged to avoid, arrived at through the one door
    // nobody had shut.
    //
    // The column now carries `provider|host|model`. Existing rows hold bare
    // names that will never match an identity, so every message goes back in
    // the queue — vectors are derived data and re-embedding is a path this
    // install already has to be good at. The superseded collections are swept
    // by `dropCollectionsNotFrom` on the next index pass, which recognises
    // them precisely because their names no longer match.
    id: '20260910_2100_embed_identity',
    up: `
UPDATE emails SET embedded = false WHERE embedded;
`,
  },
  {
    // "Write the rest like this one."
    //
    // The campaign modal shows three drafts and offers only "try again", which
    // rolls the same dice at the same prompt. Letting somebody edit one until
    // it is right and mark it as the example puts a concrete sample of the
    // wanted output into the prompt — the strongest steering a small model
    // responds to, and far stronger than another adjective in the
    // instructions, because an example is unambiguous where "warmer" is not.
    //
    // On the step rather than on the campaign: each step is a different email
    // with a different job, and the follow-up that should sound like the
    // exemplar is the follow-up, not the first touch.
    id: '20260910_2200_step_exemplar',
    up: `
ALTER TABLE sequence_steps ADD COLUMN IF NOT EXISTS ai_exemplar TEXT NOT NULL DEFAULT '';
`,
  },
  {
    // A responder that answers one campaign's replies, and a contact filter
    // worth keeping.
    id: '20260910_2300_scoped_responders_segments',
    up: `
-- Answer only the replies to one campaign.
--
-- Every piece of this existed: responders match on conditions and answer in
-- draft mode, campaign replies are classified, and a brief is a block of text
-- a model can be handed. What was missing was the scoping — a responder either
-- answered everything that matched its conditions or nothing, so "reply to the
-- questions this campaign gets, from its brief" could not be expressed without
-- also answering every other question in the mailbox.
--
-- Null means what it has always meant: not scoped to a campaign.
ALTER TABLE responders ADD COLUMN IF NOT EXISTS sequence_id BIGINT REFERENCES sequences(id) ON DELETE SET NULL;
-- And optionally only replies the classifier gave a particular label. The
-- combination the feature exists for is (sequence, 'question').
ALTER TABLE responders ADD COLUMN IF NOT EXISTS reply_intent TEXT;

-- A contact filter worth keeping.
--
-- Mail has kept saved searches in the sidebar since they shipped. Contacts
-- grew the same query-string filters — tags, custom fields, quiet days, what
-- they last replied — and no way to keep one, so the audience somebody works
-- out on a Tuesday is retyped on the Thursday.
--
-- The same table as saved searches rather than a second one: it is the same
-- idea, the same storage and the same sidebar behaviour, and a \`kind\` column
-- is cheaper than a parallel table that would need its own routes to stay in
-- step. Existing rows are mail searches, which is what they have always been.
ALTER TABLE saved_searches ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'mail';
`,
  },
  {
    // Contact notes, findable by meaning rather than by word.
    //
    // The search vector now covers notes and custom fields, so "Sage" finds
    // the people whose plan is Sage. It cannot find "people who mentioned
    // month-end pain", because nobody wrote that phrase — they wrote "always
    // chasing invoices in the last week of the month". That is the gap meaning
    // search exists for, and contacts were the one place it was never pointed.
    //
    // The same manifest shape as `email_vectors`: which contacts are indexed
    // and under which embedder identity, with the vectors in Qdrant. `model`
    // carries the whole identity for the reason it does there — provider, host
    // and model together decide whether two vectors are comparable.
    id: '20260910_2400_contact_vectors',
    up: `
CREATE TABLE IF NOT EXISTS contact_vectors (
  contact_id BIGINT PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dims INT NOT NULL,
  model TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contact_vectors_user_idx ON contact_vectors(user_id, model);

-- Which contacts still need embedding, the same flag emails carry.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS embedded BOOLEAN NOT NULL DEFAULT false;

-- A note that changes has to be indexed again, so the flag is cleared whenever
-- the text behind it moves. A trigger rather than a sweep: the write is the
-- only moment that reliably knows something changed, and a nightly diff of
-- every contact's notes would be both slower and wrong for a day.
CREATE OR REPLACE FUNCTION tern_contact_reembed() RETURNS trigger AS $fn$
BEGIN
  IF NEW.notes IS DISTINCT FROM OLD.notes OR NEW.fields IS DISTINCT FROM OLD.fields
     OR NEW.company IS DISTINCT FROM OLD.company OR NEW.title IS DISTINCT FROM OLD.title THEN
    NEW.embedded := false;
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS contacts_reembed ON contacts;
CREATE TRIGGER contacts_reembed BEFORE UPDATE ON contacts
  FOR EACH ROW EXECUTE FUNCTION tern_contact_reembed();
`,
  },
];
