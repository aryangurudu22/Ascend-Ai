-- Essay Checker history table — run once in Supabase SQL Editor.
-- Service-role backend inserts bypass RLS; policies protect direct client access.

CREATE TABLE IF NOT EXISTS essay_checks (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id) on delete cascade,
  subject text not null,
  question text not null,
  original_answer text not null,
  marks_available int not null,
  grade_band text,
  band_label text,
  estimated_marks int,
  what_did_well jsonb,
  what_is_missing jsonb,
  examiner_feedback text,
  model_paragraph text,
  model_answer text,
  created_at timestamp with time zone default now()
);

ALTER TABLE essay_checks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own essay checks"
ON essay_checks FOR ALL
USING (auth.uid() = user_id);
