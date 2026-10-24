// Gemini OpenAI-Compatible Proxy (zero-dependency, Node 18+)
// For Render.com free tier. Env: GEMINI_KEY (required), PORT (auto)
const http = require('http');
const https = require('https');

const GEMINI_KEY = process.env.GEMINI_KEY || '';
const GEMINI_HOST = 'generativelanguage.googleapis.com';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const PORT = process.env.PORT || 3000;

function jsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 50e6) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function geminiRequest(path, payload, stream) {
  const url = `https://${GEMINI_HOST}${path}?key=${encodeURIComponent(GEMINI_KEY)}${stream ? '&alt=sse' : ''}`;
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, res => resolve(res));
    req.on('error', reject);
    req.write(JSON.stringify(payload));
    req.end();
  });
}

function messagesToGemini(body) {
  const messages = body.messages || [];
  const systemText = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
  const contents = messages
    .filter(m => m.role !== 'system')
    .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }] }));
  const payload = { contents };
  if (systemText) payload.systemInstruction = { parts: [{ text: systemText }] };
  const gen = body.stream ? { responseModalities: ['TEXT'] } : undefined;
  if (body.temperature !== undefined) payload.generationConfig = { ...payload.generationConfig, temperature: body.temperature };
  if (body.max_tokens !== undefined) payload.generationConfig = { ...payload.generationConfig, maxOutputTokens: body.max_tokens };
  if (body.top_p !== undefined) payload.generationConfig = { ...payload.generationConfig, topP: body.top_p };
  if (gen) payload.generationConfig = { ...payload.generationConfig, ...gen };
  return payload;
}

function geminiToOpenAI(data, model) {
  const text = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts || [])
    .map(p => p.text || '').join('');
  const finish = data.candidates && data.candidates[0] ? (data.candidates[0].finishReason || 'stop') : 'stop';
  return {
    id: 'chatcmpl-' + Date.now(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: finish.toLowerCase() === 'stop' ? 'stop' : 'length' }],
    usage: data.usageMetadata ? { prompt_tokens: data.usageMetadata.promptTokenCount || 0, completion_tokens: data.usageMetadata.candidatesTokenCount || 0, total_tokens: (data.usageMetadata.promptTokenCount || 0) + (data.usageMetadata.candidatesTokenCount || 0) } : undefined,
  };
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    // GET /v1/models
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      const gres = await geminiRequest('/v1beta/models', {}, false);
      let raw = '';
      for await (const c of gres) raw += c;
      const parsed = JSON.parse(raw);
      const models = { object: 'list', data: (parsed.models || []).filter(m => m.name && !m.name.includes('embedding')).map(m => ({ id: m.name.replace('models/', ''), object: 'model', created: 0, owned_by: 'google' })) };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(models));
    }

    // POST /v1/chat/completions
    if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/v1/chat/completions/')) {
      const body = await jsonBody(req);
      const model = body.model || GEMINI_MODEL;
      const gPayload = messagesToGemini(body);
      const stream = !!body.stream;
      const gres = await geminiRequest(`/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent`, gPayload, stream);
      const ctype = gres.headers['content-type'] || '';
      if (stream && ctype.includes('text/event-stream')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        let buffer = '';
        gres.on('data', chunk => {
          buffer += chunk.toString();
          let idx;
          while ((idx = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, idx).trim(); buffer = buffer.slice(idx + 1);
            if (line.startsWith('data:') && !line.includes('[DONE]')) {
              try {
                const gd = JSON.parse(line.slice(5).trim());
                const text = (gd.candidates && gd.candidates[0] && gd.candidates[0].content && gd.candidates[0].content.parts || []).map(p => p.text || '').join('');
                const delta = { id: 'chatcmpl-' + Date.now(), object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] };
                res.write(`data: ${JSON.stringify(delta)}\n\n`);
              } catch (e) { /* skip malformed */ }
            }
          }
        });
        gres.on('end', () => { res.write('data: [DONE]\n\n'); res.end(); });
        gres.on('error', () => res.end());
        return;
      }
      let raw = '';
      for await (const c of gres) raw += c;
      const gd = JSON.parse(raw);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(geminiToOpenAI(gd, model)));
    }

    // GET /health
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, key: !!GEMINI_KEY }));
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(PORT, () => console.log(`gemini-proxy listening on ${PORT}, key set: ${!!GEMINI_KEY}`));