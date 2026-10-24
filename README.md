# Gemini OpenAI-Compatible Proxy
Zero-dependency Node.js reverse proxy exposing Gemini API as OpenAI-compatible `/v1/chat/completions`.

## Deploy

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/YOUR_USERNAME/gemini-proxy)

Or via Render Dashboard: New + → Web Service → connect repo.

Set environment variable:
- `GEMINI_KEY` (required): your Gemini API key
- `GEMINI_MODEL` (optional, default `gemini-2.5-flash`)

Then use base URL `https://your-service.onrender.com/v1` as OpenAI-compatible endpoint.