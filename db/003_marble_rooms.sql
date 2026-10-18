ALTER TABLE tours ADD COLUMN IF NOT EXISTS engine text NOT NULL DEFAULT 'gsplat' CHECK (engine IN ('gsplat','marble'));
-- Marble tours are delivered as per-room assets, not a downloadable archive.
ALTER TABLE tours DROP CONSTRAINT IF EXISTS tours_check;
ALTER TABLE tours ADD CONSTRAINT tours_check CHECK (status <> 'pagado' OR (paid_at IS NOT NULL AND (archive_path IS NOT NULL OR engine = 'marble')));

CREATE TABLE IF NOT EXISTS tour_rooms (
  id uuid PRIMARY KEY,
  tour_id uuid NOT NULL REFERENCES tours(id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 19),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','generating','finalizing','completed','failed')),
  operation_id text,
  world_id text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 2),
  splat_path text,
  splat_mobile_path text,
  pano_path text,
  thumb_path text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tour_id, ordinal)
);

ALTER TABLE tour_images ADD COLUMN IF NOT EXISTS room_id uuid REFERENCES tour_rooms(id) ON DELETE CASCADE;
ALTER TABLE tour_images ADD COLUMN IF NOT EXISTS azimuth real CHECK (azimuth BETWEEN 0 AND 360);
CREATE INDEX IF NOT EXISTS tour_images_room ON tour_images(room_id) WHERE room_id IS NOT NULL;
