FROM python:3.12-slim

# System deps:
#   - ffmpeg + libsndfile1: audio (markitdown audio backend)
#   - tesseract-ocr + tesseract-ocr-spa + tesseract-ocr-eng: image OCR
#   - poppler-utils: PDF rendering for image extraction inside PDFs
#   - libmagic1: file type detection
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      libsndfile1 \
      tesseract-ocr \
      tesseract-ocr-spa \
      tesseract-ocr-eng \
      poppler-utils \
      libmagic1 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY server.py .

EXPOSE 5001

# Lightweight HTTP server. No auth — sidecar reachable only inside the docker
# network (no port mapped to the host). If you ever expose it, add auth first.
CMD ["python", "server.py"]
