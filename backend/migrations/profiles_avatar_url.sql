-- Add avatar_url column for profile photo uploads (run in Supabase SQL Editor)
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS avatar_url text;
