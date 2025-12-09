import os
# Load environment variables from .env so OPENAI_API_KEY and others are available
try:
    from dotenv import load_dotenv
    load_dotenv()
except Exception:
    pass
from datetime import datetime
from fastapi import FastAPI, HTTPException, UploadFile, File, Form
from pydantic import BaseModel
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
import tempfile
try:
    import soundfile as sf  # optional; used only for duration if available
except Exception:
    sf = None
from datetime import timedelta

import logging
from .text_model import predict, predict_with_scores
from .mongo_setup import emotion_logs, ping_db, user_memory, users
from .speech_model import transcribe

app = FastAPI(title="Intelligent Emotion System")
logger = logging.getLogger("emotion-app")
logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class TextRequest(BaseModel):
    user_id: str | None = None
    text: str
    client_time: str | None = None

@app.get("/health")
async def health():
    ok = ping_db()
    return {"status": "ok" if ok else "db-unreachable"}


@app.get("/")
async def root():
    # redirect root to docs for convenience
    return RedirectResponse(url="/docs")


@app.on_event("startup")
def ensure_indexes():
    try:
        emotion_logs.create_index([("user_id", 1), ("timestamp", -1)])
        user_memory.create_index([("user_id", 1), ("created_at", -1)])
        users.create_index([("user_id", 1)], unique=True)
    except Exception:
        # non-fatal
        pass

@app.post("/predict-text")
async def predict_text(req: TextRequest, all_scores: bool = False):
    if not req.text:
        raise HTTPException(status_code=400, detail="text required")
    if all_scores:
        label, confidence, scores = predict_with_scores(req.text)
    else:
        label, confidence = predict(req.text)

    # Log to MongoDB (best-effort)
    try:
        log = {
            "user_id": req.user_id,
            "message": req.text,
            "detected_emotion": label,
            "confidence": float(confidence),
            "timestamp": datetime.utcnow(),
            # optional client-provided local time (ISO8601)
            "client_time": req.client_time
        }
        emotion_logs.insert_one(log)
    except Exception:
        pass

    out = {"emotion": label, "confidence": float(confidence), "user_id": req.user_id}
    if all_scores:
        out["scores"] = scores
        # include top-2 emotions for richer UI, if available
        top2 = sorted(scores.items(), key=lambda x: x[1], reverse=True)[:2]
        out["top"] = top2
    return out


@app.post("/predict-speech")
async def predict_speech(
    user_id: str | None = Form(None),
    client_time: str | None = Form(None),
    audio: UploadFile = File(...)
):
    """Accept an uploaded audio file, transcribe with Whisper (OpenAI if available; local fallback),
    predict emotion using text pipeline, and log to MongoDB. Clean, byte-based handling.
    """
    try:
        # Read raw bytes once
        audio_bytes = await audio.read()
        if not audio_bytes:
            raise HTTPException(status_code=400, detail="empty audio upload")

        filename = audio.filename or "recording"
        content_type = (audio.content_type or "").lower()
        logger.info(f"/predict-speech received file name={filename} content_type={content_type} size={len(audio_bytes)}")

        # Duration (best-effort) via soundfile on bytes
        duration = None
        if sf is not None:
            try:
                # soundfile requires a path or file-like; use NamedTemporaryFile only for duration probe
                with tempfile.NamedTemporaryFile(delete=True, suffix=".bin") as tmp:
                    tmp.write(audio_bytes)
                    tmp.flush()
                    info = sf.info(tmp.name)
                    duration = float(info.frames) / float(info.samplerate) if info.samplerate else None
            except Exception:
                duration = None

        # Transcription path: prefer OpenAI Whisper API if OPENAI_API_KEY is set; else local whisper
        transcript = ""
        used_fallback = False

        try:
            api_key = os.environ.get("OPENAI_API_KEY")
            if api_key:
                try:
                    from openai import OpenAI
                    client = OpenAI(api_key=api_key)
                    # Build a file-like tuple: (filename, bytes)
                    resp = client.audio.transcriptions.create(
                        model="whisper-1",
                        file=(filename, audio_bytes)
                    )
                    transcript = (getattr(resp, "text", None) or "").strip()
                except Exception as e_api:
                    logger.warning(f"OpenAI Whisper API transcription failed: {e_api}")
            if not transcript:
                # Local whisper fallback using our speech_model.transcribe which expects a path; write temp wav via ffmpeg for robustness
                import subprocess
                with tempfile.NamedTemporaryFile(delete=False, suffix=".webm") as tmp_in:
                    tmp_in.write(audio_bytes)
                    tmp_in_path = tmp_in.name
                try:
                    conv_path = tmp_in_path + ".wav"
                    subprocess.run([
                        'ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin',
                        '-y', '-i', tmp_in_path, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', conv_path
                    ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    transcript_text = transcribe(conv_path)
                    transcript = (transcript_text or "").strip()
                    used_fallback = True
                finally:
                    try:
                        os.path.exists(tmp_in_path) and os.remove(tmp_in_path)
                        os.path.exists(conv_path) and os.remove(conv_path)
                    except Exception:
                        pass
        except Exception as e_trans:
            logger.error(f"Transcription pipeline failed: {e_trans}")

        # Cleanup and normalize transcript
        t = ' '.join((transcript or '').split())
        fillers = ["uh", "umm", "um", "er", "ah", "like", "you know"]
        for f in fillers:
            t = t.replace(f + ' ', ' ').replace(' ' + f + ' ', ' ').replace(' ' + f, ' ')
        transcript = t.strip()

        if not transcript:
            raise HTTPException(status_code=422, detail="transcription empty; please try again with clearer audio")

        # Emotion prediction
        try:
            label, confidence, scores = predict_with_scores(transcript)
        except Exception:
            label, confidence = predict(transcript)
            scores = None

        # Log to MongoDB
        try:
            log = {
                "user_id": user_id,
                "input_type": "speech",
                "message": transcript,
                "input_content": transcript,
                "detected_emotion": label,
                "confidence": float(confidence),
                "metadata": {"filename": filename, "duration": duration, "content_type": content_type},
                "timestamp": datetime.utcnow(),
                "client_time": client_time
            }
            emotion_logs.insert_one(log)
            logger.info(f"Logged speech interaction user_id={user_id} emotion={label} confidence={confidence}")
        except Exception:
            pass

        out = {
            "emotion": label,
            "confidence": float(confidence),
            "transcript": transcript,
            "duration": duration,
            "user_id": user_id
        }
        if scores:
            top2 = sorted(scores.items(), key=lambda x: x[1], reverse=True)[:2]
            out["scores"] = scores
            out["top"] = top2
        out["_diag"] = {
            "file": filename,
            "content_type": content_type,
            "duration": duration,
            "used_fallback": used_fallback
        }
        return out
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"/predict-speech error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/respond")
async def respond(user_id: str | None = None):
    """Generate a simple adaptive response based on recent emotion history for `user_id`.
    Returns { response, reason, stats }
    """
    if not user_id:
        raise HTTPException(status_code=400, detail="user_id required")

    # Fetch recent emotion logs
    docs = list(emotion_logs.find({"user_id": user_id}).sort("timestamp", -1).limit(30))
    if not docs:
        return {"response": "Hello — how are you feeling today?", "reason": "no-history", "stats": {}}

    # Map emotions to polarity
    positive = set(["joy", "love", "gratitude", "relief", "optimism"]) 
    negative = set(["sadness", "anger", "fear", "disgust", "frustration", "boredom", "stress", "stressed"])

    counts = {"positive": 0.0, "negative": 0.0, "neutral": 0.0}
    # Weight contributions by model confidence to reduce noise
    for d in docs:
        e = (d.get('detected_emotion') or '').lower()
        c = float(d.get('confidence') or 0.5)
        w = max(0.2, min(c, 1.0))  # clamp weight
        if e in positive:
            counts['positive'] += w
        elif e in negative:
            counts['negative'] += w
        else:
            counts['neutral'] += w

    total = counts['positive'] + counts['negative'] + counts['neutral']
    pos_pct = counts['positive'] / total if total else 0
    neg_pct = counts['negative'] / total if total else 0

    # Rule-based reply with mixed-emotion awareness
    if neg_pct >= 0.6:
        response = "I notice you've been feeling down recently. I'm here to listen — would you like to talk about what's bothering you?"
        reason = "mostly-negative-history"
    elif pos_pct >= 0.6:
        response = "You seem to be doing well! Keep it up — anything you'd like to build on today?"
        reason = "mostly-positive-history"
    else:
        # Mixed or neutral; use last emotion to personalize
        last = (docs[0].get('detected_emotion') or '').lower()
        if last in positive:
            response = "You sounded happier recently — glad to hear that! Want suggestions to keep the momentum?"
            reason = "recent-positive"
        elif last in negative:
            response = "I'm sorry you're having a tough time. Would you like a breathing exercise or some resources?"
            reason = "recent-negative"
        else:
            # If recent logs show balanced mix, suggest grounding or journaling
            if abs(pos_pct - neg_pct) <= 0.2 and (pos_pct + neg_pct) >= 0.4:
                response = "Your emotions seem mixed lately. Would a short grounding exercise or a quick journal help organize thoughts?"
                reason = "mixed"
            else:
                response = "How are you feeling today? I can help track and remember important things for you."
                reason = "neutral"

    stats = {"counts": counts, "total": total, "pos_pct": pos_pct, "neg_pct": neg_pct}

    # Optionally store a memory if high importance (example: if mostly negative, suggest storing a memory)
    if neg_pct >= 0.8:
        try:
            user_memory.insert_one({
                "user_id": user_id,
                "memory_type": "mood_alert",
                "memory_content": "User shows sustained negative emotions",
                "importance": "high",
                "created_at": datetime.utcnow()
            })
        except Exception:
            pass

    return {"response": response, "reason": reason, "stats": stats}


class UserIn(BaseModel):
    user_id: str
    name: str | None = None
    interaction_style: str | None = None
    preferences: list | None = None


@app.post("/users")
async def create_user(u: UserIn):
    """Create or update a user document in `users` collection."""
    doc = {
        "user_id": u.user_id,
        "name": u.name,
        "interaction_style": u.interaction_style,
        "preferences": u.preferences or []
    }
    try:
        users.replace_one({"user_id": u.user_id}, doc, upsert=True)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"ok": True, "user_id": u.user_id}


class MemoryIn(BaseModel):
    user_id: str
    memory_type: str
    memory_content: str
    importance: str | None = "normal"


@app.post("/memory")
async def create_memory(m: MemoryIn):
    rec = {
        "user_id": m.user_id,
        "memory_type": m.memory_type,
        "memory_content": m.memory_content,
        "importance": m.importance or "normal",
        "created_at": datetime.utcnow()
    }
    try:
        user_memory.insert_one(rec)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"ok": True, "mem_id": str(rec.get('_id', ''))}


@app.get("/memory")
async def list_memory(user_id: str, limit: int = 20):
    """Return recent memory entries for a given user_id."""
    try:
        docs = list(user_memory.find({"user_id": user_id}).sort("created_at", -1).limit(limit))
        out = []
        for d in docs:
            out.append({
                "user_id": d.get('user_id'),
                "memory_type": d.get('memory_type'),
                "memory_content": d.get('memory_content'),
                "importance": d.get('importance'),
                "created_at": d.get('created_at')
            })
        return out
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get('/users/{user_id}')
async def get_user(user_id: str):
    u = users.find_one({"user_id": user_id})
    if not u:
        raise HTTPException(status_code=404, detail="user not found")
    u.pop('_id', None)
    return u

@app.get("/history")
async def history(
    user_id: str,
    limit: int = 20,
    since: str | None = None,
    page: int = 1,
    page_size: int | None = None
):
    """Paginated history of emotion logs.
    Params:
    - user_id: target user
    - since: ISO timestamp to filter logs newer than given time
    - limit: deprecated; use page_size instead (kept for compatibility)
    - page: page number starting at 1
    - page_size: items per page (defaults to `limit` if provided, else 20)
    """
    q = {"user_id": user_id}
    if since:
        try:
            dt = datetime.fromisoformat(since)
            q["timestamp"] = {"$gte": dt}
        except Exception:
            pass

    ps = page_size or limit or 20
    p = max(1, page)
    skip = (p - 1) * ps

    cursor = emotion_logs.find(q).sort("timestamp", -1).skip(skip).limit(ps)
    docs = list(cursor)

    out = []
    for d in docs:
        out.append({
            "user_id": d.get('user_id'),
            "message": d.get('message') or d.get('input_content'),
            "detected_emotion": d.get('detected_emotion'),
            "confidence": d.get('confidence'),
            "timestamp": d.get('timestamp'),
            "client_time": d.get('client_time')
        })

    return {"page": p, "page_size": ps, "items": out}


@app.get("/insights/summary")
async def insights_summary(user_id: str, window_days: int = 30):
    """Return basic insights: counts per emotion, totals, and positive/negative/neutral mix."""
    try:
        since = datetime.utcnow() - timedelta(days=max(1, window_days))
        q = {"user_id": user_id, "timestamp": {"$gte": since}}
        docs = list(emotion_logs.find(q).sort("timestamp", -1).limit(1000))
        counts = {}
        for d in docs:
            e = (d.get('detected_emotion') or '').lower() or 'unknown'
            counts[e] = counts.get(e, 0) + 1

        total = sum(counts.values())
        top_emotion = None
        if counts:
            top_emotion = max(counts.items(), key=lambda x: x[1])[0]

        positive = set(["joy", "love", "gratitude", "relief", "optimism", "happy"])
        negative = set(["sadness", "anger", "fear", "disgust", "frustration", "boredom", "stress", "stressed", "sad", "angry"])
        mix_counts = {"positive": 0, "negative": 0, "neutral": 0}
        for e, c in counts.items():
            if e in positive:
                mix_counts["positive"] += c
            elif e in negative:
                mix_counts["negative"] += c
            else:
                mix_counts["neutral"] += c
        mix = {k: (v / total if total else 0) for k, v in mix_counts.items()}

        return {"total": total, "top_emotion": top_emotion, "counts": counts, "mix": mix, "window_days": window_days}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == '__main__':
    import uvicorn
    port = int(os.environ.get('PORT', 8000))
    uvicorn.run(app, host='0.0.0.0', port=port)
