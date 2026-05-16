-- Syllabus topic tracker — run once in Supabase SQL Editor.

CREATE TABLE IF NOT EXISTS syllabus_topics (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  subject text NOT NULL,
  topic_name text NOT NULL,
  chapter text,
  is_covered boolean DEFAULT false,
  is_global boolean DEFAULT false,
  covered_at timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_syllabus_topics_user_subject
  ON syllabus_topics (user_id, subject);

CREATE INDEX IF NOT EXISTS idx_syllabus_topics_global_subject
  ON syllabus_topics (subject)
  WHERE is_global = true;

ALTER TABLE syllabus_topics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own syllabus topics"
ON syllabus_topics FOR ALL
USING (auth.uid() = user_id);
