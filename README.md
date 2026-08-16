# Nerdding backend

Standalone Express + TypeScript API for Nerdding.

## Local development

```bash
npm install
copy .env.example .env
npm run dev
```

Run `drizzle/0000_production_schema.sql` in Supabase before production launch. Configure `DATABASE_URL`, `AUTH_SECRET`, `FRONTEND_ORIGIN`, and Supabase Storage variables.

## Deploy to Render, Railway, Fly.io, or Docker

Build command: `npm run build`

Start command: `npm run start`

Health check: `/health`

Production mode refuses to start without a database and a non-default auth secret.

API smoke test, with the server running locally:

```bash
npm run test:e2e
```
