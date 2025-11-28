import os
# Load .env if available so SPEECH_LANGUAGE etc. persist across sessions
try:
    from dotenv import load_dotenv
    load_dotenv()
except Exception:
    pass

# Lightweight dev-mode: return placeholder transcript when TEXT_MODEL_DEV is set
DEV_MODE = os.environ.get("TEXT_MODEL_DEV", "false").lower() in ("1", "true", "yes")

if DEV_MODE:
    def transcribe(file_path: str):
        # simple placeholder for dev: note filename
        return f"[transcript placeholder for {file_path}]"

else:
    try:
        import whisper
    except Exception:
        whisper = None

    MODEL_SIZE = os.environ.get("SPEECH_MODEL_SIZE", "small")
    SPEECH_LANGUAGE = os.environ.get("SPEECH_LANGUAGE")  # e.g., 'en', 'ur', 'hi'

    _model = None

    def get_model():
        global _model
        if _model is None:
            if whisper is None:
                raise RuntimeError("whisper package not installed; install 'whisper' or enable TEXT_MODEL_DEV")
            _model = whisper.load_model(MODEL_SIZE)
        return _model

    def transcribe(file_path: str):
        model = get_model()
        # Whisper options: set language if provided; improve decoding robustness
        opts = {
            "fp16": False,          # ensure CPU-friendly default
            "verbose": False,
        }
        if SPEECH_LANGUAGE:
            opts["language"] = SPEECH_LANGUAGE
        # Temperature range provides diversity fallback
        opts["temperature"] = [0.0, 0.2, 0.4]
        res = model.transcribe(file_path, **opts)
        return res.get('text', '')
