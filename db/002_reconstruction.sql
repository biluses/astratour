ALTER TABLE tours ADD COLUMN IF NOT EXISTS model_path text;
ALTER TABLE tours ADD COLUMN IF NOT EXISTS viewer_settings jsonb;
ALTER TABLE tours ALTER COLUMN simulated SET DEFAULT false;
ALTER TABLE tour_images DROP CONSTRAINT IF EXISTS tour_images_ordinal_check;
ALTER TABLE tour_images ADD CONSTRAINT tour_images_ordinal_check CHECK (ordinal BETWEEN 0 AND 499);

CREATE TABLE IF NOT EXISTS reconstruction_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tour_id uuid NOT NULL UNIQUE REFERENCES tours(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  token uuid,
  worker_id text,
  lease_expires_at timestamptz,
  run_started_at timestamptz,
  progress integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  stage text NOT NULL DEFAULT 'queued',
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS reconstruction_jobs_claim ON reconstruction_jobs(status, lease_expires_at, created_at);
