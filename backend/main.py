# ============================================================
# ASCENDAI BACKEND — main.py
# This is the brain of the app. Every request from the 
# frontend comes here first.
# ============================================================

# FastAPI is the framework that runs our backend server
from fastapi import FastAPI

# CORSMiddleware allows our frontend (localhost:3000) to talk
# to our backend (localhost:8000) without being blocked
from fastapi.middleware.cors import CORSMiddleware

# This reads our secret keys from the .env file
from dotenv import load_dotenv

# This lets us access those secret keys inside the code
import os

# This connects us to the Groq AI brain
from groq import Groq

# asynccontextmanager lets us run code on startup and shutdown
from contextlib import asynccontextmanager

# ============================================================
# LOAD SECRET KEYS
# This must happen before anything else — like unlocking 
# the door before you can enter the building
# ============================================================

# Go and read the .env file right now
load_dotenv()

# Pick up each secret key and store it in a variable
GROQ_API_KEY = os.getenv("GROQ_API_KEY")
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY")
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID")
GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET")

# ============================================================
# CONNECT TO GROQ AI
# We create one connection when the app starts and reuse 
# it for every AI request — like keeping a phone line open
# instead of calling and hanging up every time
# ============================================================

# Create the Groq client using our API key from the .env file
# This is the object we use every time we want to ask the AI something
groq_client = Groq(
    api_key=GROQ_API_KEY  # The secret key that proves we are allowed to use Groq
)

# ============================================================
# STARTUP AND SHUTDOWN EVENTS
# Everything before "yield" runs when the app starts
# Everything after "yield" runs when the app shuts down
# ============================================================

@asynccontextmanager
async def lifespan(app: FastAPI):

    # --- STARTUP --- runs once when the server starts
    # Check that the Groq API key was loaded correctly
    if GROQ_API_KEY:
        print("✅ Groq AI connected successfully")
    else:
        print("❌ Groq API key missing — check your .env file")

    # Print a clear confirmation that the server is running
    print("🚀 AscendAI backend is starting up...")
    print("📡 Health check at: http://localhost:8000/")
    print("📚 API docs at:     http://localhost:8000/docs")

    yield  # The app runs here — everything above is startup, below is shutdown

    # --- SHUTDOWN --- runs once when the server stops
    print("🛑 AscendAI backend is shutting down...")

# ============================================================
# CREATE THE FASTAPI APP
# This is like opening the hotel for business — 
# everything runs through this one object
# We attach the lifespan so startup/shutdown events work
# ============================================================

app = FastAPI(
    title="AscendAI API",
    description="Cambridge AS Level AI Study Assistant Backend",
    version="1.0.0",
    lifespan=lifespan   # Attach startup and shutdown events
)

# ============================================================
# CORS SETTINGS
# This tells the browser: "it's okay for the frontend 
# and backend to talk to each other even though they 
# run on different port numbers"
# ============================================================

app.add_middleware(
    CORSMiddleware,

    # Which addresses are allowed to talk to our backend
    # During development we allow localhost:3000 (our Next.js frontend)
    allow_origins=["http://localhost:3001"],

    # Allow the browser to send login credentials (cookies, auth headers)
    allow_credentials=True,

    # Allow all types of requests (GET, POST, PUT, DELETE etc.)
    allow_methods=["*"],

    # Allow all headers to be sent with requests
    allow_headers=["*"],
)

# ============================================================
# HEALTH CHECK ROUTE
# Address: GET http://localhost:8000/
# Purpose: Confirms the backend is alive and running
# Render uses this to monitor the app 24/7
# ============================================================

@app.get("/")
def health_check():
    # This function runs every time someone visits the root address
    # It simply returns a message confirming everything is working
    return {
        "status": "online",           # Backend is running
        "app": "AscendAI API",        # Name of our app
        "version": "1.0.0",           # Current version
        "message": "Backend is alive and ready to receive requests"
    }