import os

# Dev-mode toggle: set TEXT_MODEL_DEV=1 or true in env to avoid downloading
# large transformer weights while developing. In dev mode a lightweight
# rule-based classifier is used.
DEV_MODE = os.environ.get("TEXT_MODEL_DEV", "false").lower() in ("1", "true", "yes")

if DEV_MODE:
    KEYWORDS = {
        "joy": ["happy", "great", "good", "joy", "glad", "pleased"],
        "sad": ["sad", "unhappy", "down", "depressed", "blue"],
        "angry": ["angry", "mad", "furious", "annoyed"],
        "surprise": ["surpris", "wow", "unexpected"],
        "fear": ["scared", "afraid", "fear", "anxious", "nervous"],
        "neutral": []
    }

    def predict(text: str):
        t = (text or "").lower()
        scores = {k: 0 for k in KEYWORDS.keys()}
        for label, kws in KEYWORDS.items():
            for kw in kws:
                if kw in t:
                    scores[label] += 1
        # choose the best label
        best = max(scores.items(), key=lambda x: x[1])
        if best[1] == 0:
            return "neutral", 0.6
        # confidence: base 0.65 + 0.1 per match (capped)
        confidence = min(0.95, 0.65 + 0.1 * best[1])
        return best[0], float(confidence)

else:
    # production mode: use transformers pipeline
    import re
    from transformers import pipeline

    _MODEL_NAME = "j-hartmann/emotion-english-distilroberta-base"
    _classifier = None

    def get_classifier():
        global _classifier
        if _classifier is None:
            # Lazy-initialize once
            _classifier = pipeline("text-classification", model=_MODEL_NAME)
        return _classifier

    def _split_text(text: str, max_len: int = 300):
        # Naive sentence split and chunking for long inputs
        sentences = re.split(r"(?<=[\.!?])\s+|\n+", text.strip())
        chunks, buf = [], ""
        for s in sentences:
            if not s:
                continue
            if len(buf) + len(s) + 1 <= max_len:
                buf = (buf + " " + s).strip()
            else:
                if buf:
                    chunks.append(buf)
                buf = s
        if buf:
            chunks.append(buf)
        return chunks or [text]

    def predict(text: str):
        """Return (label, confidence) for given text.
        For longer/multi-sentence inputs, aggregate scores across chunks for stronger predictions.
        """
        t = (text or "").strip()
        if not t:
            return "neutral", 0.6

        clf = get_classifier()
        chunks = _split_text(t)

        # For single short input, do a single pass
        if len(chunks) == 1 and len(chunks[0]) <= 300:
            res = clf(chunks[0])
            if isinstance(res, list):
                res = res[0]
            return res.get('label'), float(res.get('score', 0.0))

        # Aggregate across chunks using return_all_scores
        all_scores = clf(chunks, return_all_scores=True, truncation=True)
        totals = {}
        for item in all_scores:
            # item is a list of {label, score}
            for cls in item:
                lbl = cls.get('label')
                sc = float(cls.get('score', 0.0))
                totals[lbl] = totals.get(lbl, 0.0) + sc

        if not totals:
            return "neutral", 0.6

        # Normalize and choose best
        total_sum = sum(totals.values()) or 1.0
        best_label, best_score = max(totals.items(), key=lambda x: x[1])
        confidence = best_score / total_sum
        return best_label, float(confidence)

    def predict_with_scores(text: str):
        """Return (best_label, confidence, scores_dict) where scores_dict maps label->probability.
        Useful for multi-emotion visualization and thresholding.
        """
        t = (text or "").strip()
        if not t:
            return "neutral", 0.6, {"neutral": 1.0}

        clf = get_classifier()
        chunks = _split_text(t)
        all_scores = clf(chunks, return_all_scores=True, truncation=True)
        totals = {}
        for item in all_scores:
            for cls in item:
                lbl = cls.get('label')
                sc = float(cls.get('score', 0.0))
                totals[lbl] = totals.get(lbl, 0.0) + sc
        total_sum = sum(totals.values()) or 1.0
        probs = {k: (v / total_sum) for k, v in totals.items()}
        best_label, best_score = max(probs.items(), key=lambda x: x[1])
        return best_label, float(best_score), probs
