# Backend deployment

Run `drizzle/0000_production_schema.sql` in Supabase, create the `nerdding-media` Storage bucket, then configure the variables in `.env.production.example`.

Deploy this repository independently with:

```bash
npm install
npm run build
npm run start
```

Set `FRONTEND_ORIGIN` to the deployed frontend URL. The frontend should use the resulting API URL as `NEXT_PUBLIC_API_URL`.

## OAuth

This backend uses Supabase Auth for Google and GitHub OAuth. Configure the provider client IDs and secrets in Supabase Dashboard → Authentication → Providers. Do not put provider secrets in the frontend or commit them to this repository.

Provider callback URL:

```text
https://duxmvbayjihduinxxdqj.supabase.co/auth/v1/callback
```

Add these application redirect URLs in Supabase Authentication → URL Configuration:

```text
https://thepeoplesrepellentparty.in/auth/callback
https://api.thepeoplesrepellentparty.in/api/v1/auth/oauth/callback
http://localhost:3000/auth/callback
http://localhost:4000/api/v1/auth/oauth/callback
```

The backend environment needs `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `BACKEND_ORIGIN`, `FRONTEND_ORIGIN`, `DATABASE_URL`, and `AUTH_SECRET`. The service-role key, database URL, and auth secret are server-only.

## Pre-launch legal setup

The frontend provides `/privacy`, `/terms`, `/community-guidelines`, and `/cookies`. Replace the placeholder legal contact addresses in the frontend with the operating entity's real details, then have counsel review age eligibility, governing law, data retention/deletion, fundraising disclaimers, and processor/DPA disclosures.
