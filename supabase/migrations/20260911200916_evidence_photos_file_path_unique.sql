ALTER TABLE public.evidence_photos
ADD CONSTRAINT evidence_photos_file_path_unique
UNIQUE (file_path);
