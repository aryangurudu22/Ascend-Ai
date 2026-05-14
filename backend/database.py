# ============================================================
# ASCENDAI BACKEND — database.py
# This file has one job — create the Supabase client
# Every other file in the backend imports from here
# Think of it as the key to our filing cabinet
# ============================================================

# os lets us read secret keys from the .env file
import os

# load_dotenv reads the .env file and loads all our secret keys
from dotenv import load_dotenv

# create_client is the function that creates our Supabase connection
from supabase import create_client, Client

# ============================================================
# LOAD SECRET KEYS
# Must happen before we try to connect to anything
# ============================================================

load_dotenv()

# Read the Supabase URL from the .env file
# This is the address of our database
SUPABASE_URL = os.getenv("SUPABASE_URL")

# Read the service role key from the .env file
# This is the master key — gives full access to the database
# We use this on the backend only — never exposed to the frontend
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

# ============================================================
# CREATE THE SUPABASE CLIENT
# This is the object every other file uses to talk to the database
# We create it once here and import it wherever we need it
# ============================================================

# Check that both values were actually loaded from .env
# If either is missing the app will fail immediately with a clear message
if not SUPABASE_URL:
    raise ValueError("SUPABASE_URL is missing from your .env file")

if not SUPABASE_SERVICE_ROLE_KEY:
    raise ValueError("SUPABASE_SERVICE_ROLE_KEY is missing from your .env file")

# Create the Supabase client using the URL and master key
# This opens a permanent connection to our database
supabase: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

# Print a confirmation so we know it worked when the server starts.
# Uses ASCII "[OK]" instead of an emoji because Windows' default
# console codec (cp1252) cannot encode many Unicode glyphs and would
# crash uvicorn on startup with a UnicodeEncodeError.
print("[OK] Supabase client created successfully")