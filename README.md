# intelligent-emotion-system

Minimal FastAPI demo for emotion-aware interactions.

Quick start (Windows Git Bash):

1. Create a virtual environment and activate it:

```bash
python -m venv .venv
source .venv/Scripts/activate
```

2. Install backend dependencies:

```bash
pip install -r backend/requirements.txt
```

3. Copy `.env.example` to `.env` and fill in `MONGO_URI`.

4. Run the API server:

```bash
uvicorn backend.main:app --reload --port 8000
```

5. Open `frontend/index.html` in your browser and use the demo.

Notes:

- The current demo uses a transformer-based text-emotion model and MongoDB logging.
- The first model call will download weights (internet required).
- Keep `.env` out of version control.

Dev-mode (fast iteration)

- To avoid downloading large transformer weights during development, set
  `TEXT_MODEL_DEV=true` in your `.env`. This enables a lightweight
  rule-based predictor that returns an emotion label and a confidence.
- Example `.env` lines:

```
MONGO_URI=mongodb://localhost:27017
TEXT_MODEL_DEV=true
```

Working directory

- Run commands from the project root (`D:/.../Project`) — not inside `backend/`.
  Example:

```
cd "D:/Shaafea Content/Shaafea University Content/5th semester/DB/Project"
uvicorn backend.main:app --reload --port 8000
```

# intelligent-emotion-system

Speech endpoint

- The API exposes `POST /predict-speech` which accepts a form upload field named `audio`.
- Example curl (file `test.wav`):

```
curl -X POST "http://127.0.0.1:8000/predict-speech" \
  -F "user_id=U001" \
  -F "audio=@test.wav;type=audio/wav"
```

The endpoint will return JSON: `{ "emotion": "...", "confidence": 0.9, "transcript": "...", "duration": 1.23 }`.

Notes:

- For now the endpoint creates a short placeholder transcript and reuses the text emotion pipeline to detect emotion. In dev mode (`TEXT_MODEL_DEV=true`) this runs instantly.
- The API logs speech inputs to the `emotion_logs` collection in MongoDB (it stores transcript and metadata but not the raw audio file).

Whisper transcription (optional)

- To enable real speech transcription, the server uses Whisper. This requires the `whisper` package (added to `backend/requirements.txt`) and `ffmpeg` available on your system.
- If you want to use real transcription, remove or unset `TEXT_MODEL_DEV` in `.env` and ensure `ffmpeg` is installed. Example install on Windows: use `choco install ffmpeg` or download a static build. On Linux/macOS use your package manager.

Env configuration for speech model size:

- `SPEECH_MODEL_SIZE` (default `small`) controls the Whisper model size (`tiny`, `base`, `small`, `medium`, `large`). Smaller models are faster but less accurate.
