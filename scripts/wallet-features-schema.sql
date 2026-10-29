ALTER TABLE users
  ADD COLUMN IF NOT EXISTS totp_secret TEXT,
  ADD COLUMN IF NOT EXISTS totp_pending_secret TEXT,
  ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS totp_last_counter BIGINT NOT NULL DEFAULT -1;

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS service_type TEXT,
  ADD COLUMN IF NOT EXISTS service_number TEXT,
  ADD COLUMN IF NOT EXISTS provider_reference TEXT,
  ADD COLUMN IF NOT EXISTS target_currency TEXT,
  ADD COLUMN IF NOT EXISTS exchange_rate NUMERIC(20, 8),
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS transactions_idempotency_key_uq
  ON transactions (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS app_sessions (
  token_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMP NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMP NOT NULL,
  revoked_at TIMESTAMP,
  ip_address TEXT,
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS app_sessions_user_active_idx
  ON app_sessions (user_id, revoked_at, expires_at);

CREATE TABLE IF NOT EXISTS security_events (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  detail TEXT,
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS security_events_user_created_idx
  ON security_events (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS savings_vaults (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (currency IN ('USD', 'YER', 'SAR')),
  balance NUMERIC(18, 2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS savings_vaults_user_idx
  ON savings_vaults (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS savings_vault_movements (
  id BIGSERIAL PRIMARY KEY,
  vault_id BIGINT NOT NULL REFERENCES savings_vaults(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('DEPOSIT', 'WITHDRAW')),
  amount NUMERIC(18, 2) NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL CHECK (currency IN ('USD', 'YER', 'SAR')),
  balance_after NUMERIC(18, 2) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS savings_vault_movements_vault_idx
  ON savings_vault_movements (vault_id, created_at DESC);
