# VideoHub backend — FastAPI + ffmpeg, deployed to Render.
FROM python:3.11-slim

# ffmpeg (+ ffprobe) are required by the processing pipeline.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Render provides $PORT at runtime; default to 8000 locally.
ENV PORT=8000
# Shell form so $PORT expands at container start.
CMD uvicorn main:app --host 0.0.0.0 --port $PORT
