# Backend deployment

Run `drizzle/0000_production_schema.sql` in Supabase, create the `nerdding-media` Storage bucket, then configure the variables in `.env.example`.

Deploy this repository independently with:

```bash
npm install
npm run build
npm run start
```

Set `FRONTEND_ORIGIN` to the deployed frontend URL. The frontend should use the resulting API URL as `NEXT_PUBLIC_API_URL`.
