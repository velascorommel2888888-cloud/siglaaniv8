"""
SiglaAni — Flask Backend
- Accepts captured image + bbox from frontend
- Prioritizes client-side Teachable Machine condition predictions
- Fallback fruit-specific HSV heuristics if no model prediction is supplied
- REQ-14: Persists every capture with a timestamped filename
- REQ-32..37: Generates a Grad-CAM-style saliency overlay (Explainable AI)
              localized to the bbox region. Logged to SQLite for auditability.
- Mobile Reader API: Exposes GET /api/scan/<scan_id> for the mobile viewer app.
"""

import os, sqlite3, base64
from datetime import datetime
import numpy as np
import cv2
from flask import Flask, jsonify, request
from flask_cors import CORS

# ── Paths ────────────────────────────────────────────────────────────────────
BASE_DIR    = os.path.dirname(__file__)
DB_PATH     = os.path.join(BASE_DIR, "siglaani.db")
CAPTURE_DIR = os.path.join(BASE_DIR, "captures")       # REQ-14
XAI_DIR     = os.path.join(BASE_DIR, "xai_overlays")   # REQ-37
os.makedirs(CAPTURE_DIR, exist_ok=True)
os.makedirs(XAI_DIR, exist_ok=True)

USE_TFLITE = False

# ── Validation thresholds ────────────────────────────────────────────────────
MIN_FRUIT_SATURATION_RATIO = 0.10

# REQ-36: suppress XAI overlay below these thresholds
XAI_MIN_CONFIDENCE = 60
XAI_MIN_COVERAGE   = 0.015
XAI_MAX_COVERAGE   = 0.85

app = Flask(__name__)
CORS(app)

@app.after_request
def add_header(response):
    response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    response.headers['Pragma']        = 'no-cache'
    response.headers['Expires']       = '-1'
    return response

# ── Database ──────────────────────────────────────────────────────────────────
def init_db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS scans (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            fruit           TEXT    NOT NULL DEFAULT 'Unknown',
            scientific      TEXT    DEFAULT '',
            condition       TEXT    NOT NULL DEFAULT 'ripe',
            condition_label TEXT    DEFAULT '',
            confidence      REAL    DEFAULT 0,
            rating          INTEGER DEFAULT 3,
            recommendation  TEXT    DEFAULT '',
            temp            REAL    DEFAULT 0,
            thumbnail       TEXT    DEFAULT '',
            scanned_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            capture_filename TEXT   DEFAULT '',
            xai_filename     TEXT   DEFAULT '',
            xai_coverage     REAL   DEFAULT 0,
            xai_explanation  TEXT   DEFAULT '',
            xai_generated    INTEGER DEFAULT 0
        )
    """)
    new_cols = [
        ("capture_filename", "TEXT DEFAULT ''"),
        ("xai_filename",     "TEXT DEFAULT ''"),
        ("xai_coverage",     "REAL DEFAULT 0"),
        ("xai_explanation",  "TEXT DEFAULT ''"),
        ("xai_generated",    "INTEGER DEFAULT 0"),
    ]
    for col, decl in new_cols:
        try:
            conn.execute(f"ALTER TABLE scans ADD COLUMN {col} {decl}")
        except sqlite3.OperationalError:
            pass
    conn.commit()
    conn.close()
    print(f"[SiglaAni] DB ready → {DB_PATH}")

def save_scan(data: dict) -> int:
    conn = sqlite3.connect(DB_PATH, timeout=15)
    try:
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO scans
              (fruit, scientific, condition, condition_label,
               confidence, rating, recommendation, temp, thumbnail,
               capture_filename, xai_filename, xai_coverage,
               xai_explanation, xai_generated)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """, (
            str(data.get("fruit",            "Unknown")),
            str(data.get("scientific",       "")),
            str(data.get("condition",        "ripe")),
            str(data.get("conditionLabel",   "")),
            float(data.get("confidence",     0)),
            int(data.get("rating",           3)),
            str(data.get("recommendation",   "")),
            float(data.get("temp",           0)),
            str(data.get("thumbnail",        "")),
            str(data.get("capture_filename", "")),
            str(data.get("xai_filename",     "")),
            float(data.get("xai_coverage",   0)),
            str(data.get("xai_explanation",  "")),
            int(data.get("xai_generated",    0)),
        ))
        conn.commit()
        new_id = cur.lastrowid
        print(f"[SiglaAni] Saved scan #{new_id} — {data.get('fruit')} / {data.get('condition')}")
        return new_id
    finally:
        conn.close()

def get_history(limit=50):
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            "SELECT * FROM scans ORDER BY scanned_at DESC LIMIT ?", (limit,)
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()

# ── Image helpers ─────────────────────────────────────────────────────────────
def decode_image(b64_string: str):
    if "," in b64_string:
        b64_string = b64_string.split(",", 1)[1]
    img_bytes = base64.b64decode(b64_string)
    arr   = np.frombuffer(img_bytes, dtype=np.uint8)
    frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if frame is None:
        raise ValueError("Failed to decode image")
    return frame

def make_thumbnail(frame, max_px=160) -> str:
    h, w = frame.shape[:2]
    scale = max_px / max(h, w)
    small = cv2.resize(frame, (int(w * scale), int(h * scale)))
    _, buf = cv2.imencode(".jpg", small, [cv2.IMWRITE_JPEG_QUALITY, 72])
    return base64.b64encode(buf).decode()

def save_capture_image(frame) -> str:
    """REQ-14: Save full-resolution capture with a unique timestamped filename."""
    ts       = datetime.now().strftime("%Y%m%d_%H%M%S_") + f"{datetime.now().microsecond // 1000:03d}"
    filename = f"scan_{ts}.jpg"
    filepath = os.path.join(CAPTURE_DIR, filename)
    if not cv2.imwrite(filepath, frame, [cv2.IMWRITE_JPEG_QUALITY, 90]):
        raise IOError(f"cv2.imwrite returned False for {filepath}")
    print(f"[SiglaAni] Saved capture → {filepath}")
    return filename

# ── Fruit metadata ─────────────────────────────────────────────────────────────
CONDITION_LABELS = {
    "ripe":     "Hinog (Ripe)",
    "overripe": "Sobrang Hinog (Overripe)",
    "unripe":   "Hindi Pa Hinog (Unripe)",
    "rotten":   "Bulok (Rotten)",
}

RECOMMENDATIONS = {
    "ripe":     "Ang prutas ay nasa tamang kondisyon para sa pagkain. Maaari na itong kainin ngayon o ilagay sa ref sa loob ng 5–7 araw.",
    "overripe": "Ang prutas ay medyo sobrang hinog na. Angkop pa rin para sa pagluluto o smoothie. Gamitin kaagad sa loob ng 1–2 araw.",
    "unripe":   "Ang prutas ay hindi pa ganap na hinog. Ilagay sa maaliwalas na lugar. Magiging handa ito sa loob ng 2–4 araw.",
    "rotten":   "Ang prutas ay hindi na ligtas kainin. Itapon na ito agad para maiwasan ang kontaminasyon.",
}

COCO_TO_FRUIT = {
    "apple":   ("Apple",  "Malus domestica"),
    "banana":  ("Saging", "Musa acuminata"),
    "orange":  ("Orange", "Citrus sinensis"),
}

def condition_to_rating(condition: str, confidence: int) -> int:
    if condition == "ripe":
        if confidence >= 85: return 5
        if confidence >= 72: return 4
        return 3
    if condition == "overripe":
        return 2 if confidence >= 75 else 3
    if condition == "unripe":
        return 3
    return 1

# ── Cropping & content validation ────────────────────────────────────────────
def get_analysis_region(frame, bbox=None, padding=0.05):
    h, w = frame.shape[:2]

    if bbox and len(bbox) == 4:
        try:
            x, y, bw, bh = [float(v) for v in bbox]
            if bw > 4 and bh > 4:
                pad_x = bw * padding
                pad_y = bh * padding
                x0 = max(0, int(round(x - pad_x)))
                y0 = max(0, int(round(y - pad_y)))
                x1 = min(w, int(round(x + bw + pad_x)))
                y1 = min(h, int(round(y + bh + pad_y)))
                if x1 - x0 > 8 and y1 - y0 > 8:
                    return frame[y0:y1, x0:x1], (x0, y0, x1, y1)
        except (TypeError, ValueError):
            pass

    cy, cx = h // 2, w // 2
    ch, cw = max(1, int(h * 0.40) // 2), max(1, int(w * 0.40) // 2)
    return frame[cy - ch:cy + ch, cx - cw:cx + cw], (cx - cw, cy - ch, cx + cw, cy + ch)

def has_fruit_content(crop) -> bool:
    if crop is None or crop.size == 0:
        return False
    hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
    S, V = hsv[:, :, 1], hsv[:, :, 2]
    fruit_like = ((S > 50) & (V > 45) & (V < 245)).sum()
    ratio = fruit_like / float(S.size)
    print(f"[SiglaAni] Fruit-content ratio: {ratio:.3f}  (min {MIN_FRUIT_SATURATION_RATIO})")
    return ratio >= MIN_FRUIT_SATURATION_RATIO

# ── HSV mask builder (shared by classifier & XAI) ────────────────────────────
def _build_masks(hsv: np.ndarray, fruit_key: str) -> dict:
    H = hsv[:, :, 0].astype(np.int32)
    S = hsv[:, :, 1].astype(np.int32)
    V = hsv[:, :, 2].astype(np.int32)

    if fruit_key == "banana":
        return {
            "ripe":     (H >= 15) & (H <= 40) & (S > 70) & (V > 110),
            "unripe":   (H >= 41) & (H <= 80) & (S > 60) & (V > 100),
            "overripe": (H >= 8)  & (H <= 25) & (S > 40) & (V >= 60) & (V < 160),
            "rotten":   (S < 50)  & (V < 80),
        }
    if fruit_key == "apple":
        return {
            "ripe":     ((H <= 15) | (H >= 155)) & (S > 60) & (V > 90),
            "unripe":   (H >= 30) & (H <= 80) & (S > 60) & (V > 90),
            "overripe": ((H <= 15) | (H >= 155)) & (S > 40) & (V < 120),
            "rotten":   (S < 40)  & (V < 70),
        }
    if fruit_key == "orange":
        return {
            "ripe":     (H >= 8)  & (H <= 25) & (S > 100) & (V > 120),
            "unripe":   (H >= 26) & (H <= 55) & (S > 70)  & (V > 100),
            "overripe": (H >= 8)  & (H <= 22) & (S > 60)  & (V < 140),
            "rotten":   (S < 50)  & (V < 80),
        }
    return {
        "ripe":     (((H >= 0)  & (H <= 15) & (S > 80) & (V > 80)) |
                    ((H >= 20) & (H <= 35) & (S > 80) & (V > 100))),
        "unripe":   (H >= 36) & (H <= 85) & (S > 60) & (V > 80),
        "overripe": (((H >= 10) & (H <= 25) & (S > 40) & (V < 130)) |
                    ((H >= 0)  & (H <= 10) & (S > 30) & (V < 100))),
        "rotten":   (S < 40)  & (V < 80),
    }

# ── Classifier ───────────────────────────────────────────────────────────────
def analyse_crop(crop: np.ndarray, detected_fruit: str = None) -> dict:
    hsv       = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
    fruit_key = (detected_fruit or "").lower().strip()
    masks     = _build_masks(hsv, fruit_key)
    total     = masks["ripe"].size

    scores = {k: float(m.sum()) / total for k, m in masks.items()}

    condition = max(scores, key=scores.get)
    raw_conf  = scores[condition]
    if raw_conf < 0.06:
        condition = "ripe"
        raw_conf  = 0.50

    total_fruit_pixels = sum(scores.values())
    if total_fruit_pixels > 0:
        ratio      = scores[condition] / total_fruit_pixels
        confidence = min(98, round(45 + (ratio * 53)))
    else:
        confidence = 72

    if fruit_key in COCO_TO_FRUIT:
        fruit, sci = COCO_TO_FRUIT[fruit_key]
    else:
        fruit, sci = ("Unknown", "—")

    rating = condition_to_rating(condition, confidence)

    print(f"[SiglaAni] Analyse → fruit={fruit_key!r} "
          f"scores={{{', '.join(f'{k}:{v:.2f}' for k,v in scores.items())}}} "
          f"→ {condition} ({confidence}%)")

    return {
        "fruit":          fruit,
        "scientific":     sci,
        "condition":      condition,
        "conditionLabel": CONDITION_LABELS[condition],
        "confidence":     confidence,
        "rating":         rating,
        "recommendation": RECOMMENDATIONS[condition],
    }

# ── XAI: Grad-CAM-style overlay ──────────────────────────────────────────────
XAI_EXPLANATIONS = {
    ("ripe",     "banana"): "Mga gintong-dilaw na bahagi ang nakita — nasa tamang antas ng pagkahinog.",
    ("ripe",     "apple"):  "Pulang-pulang lugar ang naka-highlight — palatandaan ng hinog na mansanas.",
    ("ripe",     "orange"): "Maliwanag na orange na rehiyon — tamang pagkahinog.",
    ("unripe",   "banana"): "Berdeng bahagi ang nakita — hindi pa ganap na hinog ang saging.",
    ("unripe",   "apple"):  "Berdeng lugar ang naka-highlight — mura pa ang prutas.",
    ("unripe",   "orange"): "Berde-berdeng rehiyon — hindi pa nagiging buong orange.",
    ("overripe", "banana"): "Madilim at brown na batik ang nakita — palatandaan ng sobrang hinog.",
    ("overripe", "apple"):  "Pinanlumang pula at malalambot na bahagi — sobrang hinog na.",
    ("overripe", "orange"): "Madidilim na orange-brown na bahagi — sobrang hinog na ang prutas.",
    ("rotten",   "banana"): "Itim at lubog na lugar ang nakita — bulok na ang bahaging ito.",
    ("rotten",   "apple"):  "Maitim at tuyot na bahagi — palatandaan ng pagkabulok.",
    ("rotten",   "orange"): "Inaamag at madilim na lugar — hindi na ligtas kainin.",
}
XAI_DEFAULTS = {
    "ripe":     "Ang mga naka-highlight na lugar ay nagpapakita ng kulay ng hinog na prutas.",
    "unripe":   "Ang mga naka-highlight na lugar ay nagpapakita na hindi pa ganap na hinog.",
    "overripe": "Ang mga naka-highlight na lugar ay nagpapakita ng pagkalansa o sobrang hinog.",
    "rotten":   "Ang mga naka-highlight na lugar ay nagpapakita ng bulok o sira na bahagi.",
}

def generate_xai_overlay(frame, crop_rect, condition, fruit_key, confidence):
    if confidence < XAI_MIN_CONFIDENCE:
        print(f"[SiglaAni][XAI] Suppressed — low confidence ({confidence}%)")
        return None, None

    x0, y0, x1, y1 = crop_rect
    crop = frame[y0:y1, x0:x1]
    if crop.size == 0:
        return None, None

    hsv   = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
    masks = _build_masks(hsv, fruit_key)
    mask  = masks.get(condition)
    if mask is None:
        return None, None

    coverage = float(mask.sum()) / mask.size
    if coverage < XAI_MIN_COVERAGE or coverage > XAI_MAX_COVERAGE:
        print(f"[SiglaAni][XAI] Suppressed — dispersed activation (coverage={coverage:.3f})")
        return None, None

    heatmap = (mask.astype(np.float32) * 255.0).astype(np.uint8)
    h, w   = heatmap.shape
    k      = max(15, (min(h, w) // 30) | 1)
    heatmap = cv2.GaussianBlur(heatmap, (k, k), 0)

    if condition in ("ripe", "unripe"):
        heatmap_color = cv2.applyColorMap(heatmap, cv2.COLORMAP_JET)
    else:
        heatmap_color = cv2.applyColorMap(heatmap, cv2.COLORMAP_HOT)

    alpha        = (heatmap.astype(np.float32) / 255.0)[..., None]
    alpha        = np.clip(alpha * 0.65, 0, 0.65)
    blended_crop = (crop.astype(np.float32) * (1 - alpha) +
                    heatmap_color.astype(np.float32) * alpha).astype(np.uint8)

    overlay = frame.copy()
    overlay[y0:y1, x0:x1] = blended_crop
    cv2.rectangle(overlay, (x0, y0), (x1, y1), (74, 232, 126), 2)

    ts = datetime.now().strftime("%Y%m%d_%H%M%S_") + f"{datetime.now().microsecond // 1000:03d}"
    overlay_filename = f"xai_{ts}.jpg"
    cv2.imwrite(os.path.join(XAI_DIR, overlay_filename), overlay,
                [cv2.IMWRITE_JPEG_QUALITY, 82])

    _, buf      = cv2.imencode(".jpg", overlay, [cv2.IMWRITE_JPEG_QUALITY, 82])
    overlay_b64 = base64.b64encode(buf).decode()
    explanation = XAI_EXPLANATIONS.get(
        (condition, fruit_key),
        XAI_DEFAULTS.get(condition, "")
    )

    print(f"[SiglaAni][XAI] Generated {overlay_filename} "
          f"(condition={condition}, coverage={coverage:.3f})")

    return overlay_b64, {
        "filename":    overlay_filename,
        "coverage":    round(coverage, 4),
        "explanation": explanation,
    }

def get_cpu_temp() -> float:
    try:
        with open("/sys/class/thermal/thermal_zone0/temp") as f:
            return round(int(f.read()) / 1000, 1)
    except Exception:
        return 0.0

# ── Routes ────────────────────────────────────────────────────────────────────
@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({
        "status": "ok",
        "mode":   "tflite" if USE_TFLITE else "teachable_machine_priority",
        "xai":    "hsv-saliency",
    })

@app.route("/api/scan", methods=["POST"])
def scan():
    body           = request.get_json(silent=True) or {}
    detected_fruit = body.get("hsv_key") or body.get("detected_fruit") or None
    image_b64      = body.get("image") or None
    bbox           = body.get("bbox") or None

    # Teachable Machine prediction passed from React frontend
    model_condition  = body.get("model_condition")
    model_confidence = body.get("model_confidence", 85)

    print(f"[SiglaAni] /api/scan — fruit={detected_fruit!r}, "
          f"model_cond={model_condition!r}, bbox={bbox}, image={'yes' if image_b64 else 'no'}")

    if not detected_fruit and not model_condition:
        return jsonify({
            "error":   "no_fruit_detected",
            "message": "Walang prutas na nakita. Ilagay ang prutas sa harap ng camera bago mag-scan.",
        }), 400

    if image_b64:
        try:
            frame = decode_image(image_b64)
        except Exception as e:
            return jsonify({"error": "decode_failed", "message": f"Image decode failed: {e}"}), 400
    else:
        try:
            cap = cv2.VideoCapture(0)
            for _ in range(5): cap.read()
            ret, frame = cap.read()
            cap.release()
            if not ret:
                return jsonify({"error": "camera_failed", "message": "Camera could not capture."}), 500
        except Exception as e:
            return jsonify({"error": "camera_failed", "message": f"Camera error: {e}"}), 500

    crop, crop_rect = get_analysis_region(frame, bbox)

    # ── PURE TEACHABLE MACHINE PRIORITY ──────────────────────────────────────
    if model_condition:
        condition  = model_condition
        confidence = int(model_confidence)
        fruit_name = body.get("detected_fruit") or "Unknown"
        
        result = {
            "fruit":          fruit_name,
            "scientific":     COCO_TO_FRUIT.get((body.get("hsv_key") or "").lower(), ("Unknown", "—"))[1],
            "condition":      condition,
            "conditionLabel": CONDITION_LABELS.get(condition, condition),
            "confidence":     confidence,
            "rating":         condition_to_rating(condition, confidence),
            "recommendation": RECOMMENDATIONS.get(condition, ""),
        }
    else:
        # Fallback to HSV heuristics only if model prediction is missing
        if not has_fruit_content(crop):
            return jsonify({
                "error":   "background_only",
                "message": "Hindi maliwanag na nakita ang prutas. Ilapit nang konti at i-scan muli.",
            }), 400
        try:
            result = analyse_crop(crop, detected_fruit)
        except Exception as e:
            return jsonify({"error": "analysis_failed", "message": f"Analysis error: {e}"}), 500

    result["temp"]      = get_cpu_temp()
    result["thumbnail"] = make_thumbnail(frame)

    try:
        result["capture_filename"] = save_capture_image(frame)
    except Exception as e:
        print(f"[SiglaAni] Capture save failed: {e}")
        result["capture_filename"] = ""

    fruit_key = (detected_fruit or "").lower().strip()
    try:
        overlay_b64, xai_meta = generate_xai_overlay(
            frame, crop_rect, result["condition"], fruit_key, int(result["confidence"])
        )
    except Exception as e:
        print(f"[SiglaAni] XAI generation crashed: {e}")
        overlay_b64, xai_meta = None, None

    if overlay_b64 and xai_meta:
        result["xai"] = {
            "available":   True,
            "overlay":     overlay_b64,
            "filename":    xai_meta["filename"],
            "coverage":    xai_meta["coverage"],
            "explanation": xai_meta["explanation"],
        }
        result["xai_filename"]    = xai_meta["filename"]
        result["xai_coverage"]    = xai_meta["coverage"]
        result["xai_explanation"] = xai_meta["explanation"]
        result["xai_generated"]   = 1
    else:
        result["xai"] = {
            "available": False,
            "notice":    "Walang available na paliwanag para sa scan na ito.",
        }
        result["xai_filename"]    = ""
        result["xai_coverage"]    = 0
        result["xai_explanation"] = ""
        result["xai_generated"]   = 0

    try:
        result["id"] = save_scan(result)
    except Exception as e:
        print(f"[SiglaAni] WARNING: DB save failed — {e}")
        result["id"] = 0

    return jsonify(result), 200

# ── Mobile Reader Endpoint ───────────────────────────────────────────────────
@app.route("/api/scan/<int:scan_id>", methods=["GET"])
def get_scan_by_id(scan_id):
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute("SELECT * FROM scans WHERE id = ?", (scan_id,)).fetchone()
        if not row:
            return jsonify({"error": "not_found", "message": "Scan result not found"}), 404
        
        data = dict(row)
        return jsonify({
            "scan_id":        data["id"],
            "fruit_type":     data["fruit"],
            "scientific":     data["scientific"],
            "status":         data["condition_label"] or CONDITION_LABELS.get(data["condition"], data["condition"]),
            "confidence":     data["confidence"],
            "rating":         data["rating"],
            "recommendation": data["recommendation"],
            "timestamp":      data["scanned_at"],
            "image_url":      None
        }), 200
    except Exception as e:
        print(f"[SiglaAni] Error fetching scan #{scan_id}: {e}")
        return jsonify({"error": "db_error", "message": str(e)}), 500
    finally:
        conn.close()

@app.route("/api/history", methods=["GET"])
def history():
    limit = int(request.args.get("limit", 50))
    return jsonify(get_history(limit)), 200

@app.route("/api/history/<int:scan_id>", methods=["DELETE"])
def delete(scan_id):
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.execute("DELETE FROM scans WHERE id = ?", (scan_id,))
    conn.commit()
    conn.close()
    return jsonify({"deleted": scan_id}), 200

@app.route("/api/history", methods=["DELETE"])
def clear():
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.execute("DELETE FROM scans")
    conn.commit()
    conn.close()
    return jsonify({"cleared": True}), 200

@app.route('/api/analytics', methods=['GET'])
def get_analytics():
    try:
        conn = sqlite3.connect(DB_PATH)
        c    = conn.cursor()

        c.execute("SELECT COUNT(*) FROM scans")
        total_scans = c.fetchone()[0]
        if total_scans == 0:
            conn.close()
            return jsonify({
                "total_scans": 0, "top_fruit": "N/A",
                "fresh_rate": 0, "breakdown": {}, "xai_coverage_avg": 0,
            })

        c.execute("SELECT fruit, COUNT(*) as count FROM scans "
                  "GROUP BY fruit ORDER BY count DESC LIMIT 1")
        top_fruit_row = c.fetchone()
        top_fruit = top_fruit_row[0].capitalize() if top_fruit_row else "N/A"

        c.execute("SELECT condition, COUNT(*) FROM scans GROUP BY condition")
        breakdown = {row[0]: row[1] for row in c.fetchall()}

        ripe_count = breakdown.get('ripe', 0)
        fresh_rate = round((ripe_count / total_scans) * 100) if total_scans > 0 else 0

        c.execute("SELECT AVG(xai_coverage) FROM scans WHERE xai_generated = 1")
        xai_avg_row = c.fetchone()
        xai_coverage_avg = round((xai_avg_row[0] or 0) * 100, 1)

        conn.close()
        return jsonify({
            "total_scans":      total_scans,
            "top_fruit":        top_fruit,
            "fresh_rate":       fresh_rate,
            "breakdown":        breakdown,
            "xai_coverage_avg": xai_coverage_avg,
        })
    except Exception as e:
        print("Analytics Error:", e)
        return jsonify({"error": str(e)}), 500

# ── Main ──────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    init_db()
    print("[SiglaAni] Mode: Teachable Machine Priority")
    print(f"[SiglaAni] Captures dir → {CAPTURE_DIR}")
    print(f"[SiglaAni] XAI dir      → {XAI_DIR}")
    app.run(host="0.0.0.0", port=5001, debug=True)