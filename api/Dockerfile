FROM python:3.9-slim

WORKDIR /app

# Install uv
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# Install dependencies using uv
COPY api/pyproject.toml .
RUN uv venv && uv pip install -r pyproject.toml

# Copy the application code
COPY api/api.py .
COPY api/models.py .
COPY api/utils.py .
COPY api/families.py .
COPY api/routers/ ./routers/

# Expose the port the API will run on
EXPOSE 3000

# Hit the static index route (no DB dependency) with the system Python,
# since the slim image ships neither curl nor wget.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:3000/', timeout=3)"]

# Run the API with Uvicorn using uv's venv
CMD [".venv/bin/uvicorn", "api:app", "--host", "0.0.0.0", "--port", "3000"]
