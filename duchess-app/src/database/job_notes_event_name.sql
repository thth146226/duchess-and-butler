-- Run in Supabase SQL Editor
ALTER TABLE job_notes ADD COLUMN IF NOT EXISTS event_name text;
