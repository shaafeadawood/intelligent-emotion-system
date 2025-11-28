import os
from pymongo import MongoClient

# Try to load .env if python-dotenv is available (non-fatal)
try:
    from dotenv import load_dotenv
    load_dotenv()
except Exception:
    pass

# Prefer MONGO_URI from env; fall back to localhost for ease of development
MONGO_URI = os.environ.get("MONGO_URI", "mongodb://localhost:27017")

client = MongoClient(MONGO_URI)

db = client['emotion_db']
emotion_logs = db['emotion_logs']
users = db['users']
user_memory = db['user_memory']

def ping_db():
    try:
        client.admin.command('ping')
        return True
    except Exception:
        return False
