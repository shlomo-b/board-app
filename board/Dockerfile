FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .

# hadolint ignore=DL3008
RUN apt-get update -y \
    && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends \
        gcc \
        g++ \
        pkg-config \
        libxml2-dev \
        libxslt1-dev \
        libxmlsec1-dev \
        libxmlsec1-openssl \
    && pip install --no-cache-dir -r requirements.txt \
    && rm -rf /var/lib/apt/lists/*

COPY app ./app
COPY static ./static

RUN adduser --disabled-password --gecos "" appuser --uid 1000 \
    && chown -R appuser:appuser /app

USER appuser

EXPOSE 8093

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8093"]
