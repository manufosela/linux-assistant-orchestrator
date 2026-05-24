"""
Tiny HTTP wrapper around Microsoft Markitdown.

Endpoints:
  GET  /health         -> {"status": "ok"}
  POST /convert        -> multipart with 'file' field; returns {"text", "title"}

Designed to run as a docker sidecar inside the LUIS network. No auth — only
reachable via the docker internal network (do not map the port to the host
unless you add auth).
"""

import logging
import os
import tempfile
import traceback

from flask import Flask, jsonify, request
from markitdown import MarkItDown
from PIL import Image
import pytesseract

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("markitdown-server")

app = Flask(__name__)
md = MarkItDown()

# Images: markitdown 0.0.1a3 requires a vision LLM to OCR images (no local
# tesseract integration). We have tesseract installed for spa+eng, so for
# images we bypass markitdown and call tesseract directly via pytesseract.
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tiff", ".tif"}
OCR_LANGS = "spa+eng"


@app.get("/health")
def health():
    return jsonify({"status": "ok"})


@app.post("/convert")
def convert():
    if "file" not in request.files:
        return jsonify({"error": "no file provided (use multipart 'file' field)"}), 400

    f = request.files["file"]
    if not f.filename:
        return jsonify({"error": "uploaded file has no name"}), 400

    suffix = os.path.splitext(f.filename)[1].lower()
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            f.save(tmp.name)
            tmp_path = tmp.name

        log.info("converting %s (%s)", f.filename, suffix)

        if suffix in IMAGE_EXTS:
            # Direct tesseract OCR — markitdown's image handling needs a vision LLM.
            try:
                with Image.open(tmp_path) as img:
                    text = pytesseract.image_to_string(img, lang=OCR_LANGS)
            except pytesseract.TesseractError as exc:
                log.warning("tesseract failed on %s: %s", f.filename, exc)
                text = ""
            return jsonify({
                "text": text or "",
                "title": None,
                "filename": f.filename,
                "engine": "pytesseract",
            })

        # All other formats: markitdown
        result = md.convert(tmp_path)
        return jsonify({
            "text": result.text_content or "",
            "title": getattr(result, "title", None),
            "filename": f.filename,
            "engine": "markitdown",
        })
    except Exception as exc:  # noqa: BLE001 - we want to report any failure
        log.error("conversion failed for %s: %s\n%s", f.filename, exc, traceback.format_exc())
        return jsonify({"error": str(exc), "type": type(exc).__name__}), 500
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.unlink(tmp_path)


if __name__ == "__main__":
    # Sidecar only — bind to all interfaces inside the container, listen on 5001.
    app.run(host="0.0.0.0", port=5001, debug=False)
