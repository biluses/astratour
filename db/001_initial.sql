CREATE TABLE IF NOT EXISTS app_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  google_sub text NOT NULL UNIQUE,
  email text NOT NULL,
  name text,
  image text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tours (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  status text NOT NULL DEFAULT 'borrador'
    CHECK (status IN ('borrador','procesando','pendiente_de_pago','pagado','error')),
  simulated boolean NOT NULL DEFAULT true,
  amount_cents integer NOT NULL DEFAULT 1900 CHECK (amount_cents = 1900),
  currency text NOT NULL DEFAULT 'eur' CHECK (currency = 'eur'),
  archive_path text,
  generation_token uuid,
  processing_started_at timestamptz,
  checkout_key uuid NOT NULL DEFAULT gen_random_uuid(),
  stripe_session_id text UNIQUE,
  payment_intent_id text,
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'pagado' OR (paid_at IS NOT NULL AND archive_path IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS tours_owner_created ON tours (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS tour_images (
  id uuid PRIMARY KEY,
  tour_id uuid NOT NULL REFERENCES tours(id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 11),
  original_name text NOT NULL CHECK (length(original_name) <= 150),
  content_type text NOT NULL CHECK (content_type IN ('image/jpeg','image/png')),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 10485760),
  source_path text NOT NULL UNIQUE,
  source_uploaded boolean NOT NULL DEFAULT false,
  preview_path text,
  asset_path text,
  UNIQUE (tour_id, ordinal)
);

CREATE TABLE IF NOT EXISTS stripe_events (
  event_id text PRIMARY KEY,
  processed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_rate_limits (
  key text PRIMARY KEY,
  hits integer NOT NULL DEFAULT 1,
  expires_at timestamptz NOT NULL
);
