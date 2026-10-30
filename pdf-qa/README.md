# PDF Q&A — Quick start

1. Copy `.env.example` to `backend/.env` and set `OPENAI_API_KEY` and `ADMIN_TOKEN`.
2. Build and run with docker-compose:

```bash
docker-compose up --build
```

3. Frontend: [http://localhost:5173](http://localhost:5173)
4. Backend docs: [http://localhost:8000/docs](http://localhost:8000/docs)

Security note: never commit your real OpenAI API key into git. Use env vars or secret manager.
