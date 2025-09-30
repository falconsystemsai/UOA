# Unusual Options Activity Viewer

This is a simple Cloudflare Worker app that fetches and displays unusual options activity from the Benzinga API.

## Deploy

```bash
npm install -g wrangler
wrangler login
wrangler secret put BENZINGA_API_KEY   # paste your API key
wrangler deploy
```

Once deployed, open your Workers.dev subdomain (or your custom domain) to view the app.