# Python template. Your app is app/main.py with a FastAPI/Flask/any app on port 8080.
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE 8080
# FastAPI example. For Flask use: CMD ["gunicorn", "-b", "0.0.0.0:8080", "app.main:app"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
