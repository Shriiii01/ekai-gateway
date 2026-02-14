import type { Response } from 'express';
import { OPENROUTER_API_KEY } from './config.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

/**
 * Proxy a chat completions request to OpenRouter.
 * Handles both streaming (SSE) and non-streaming responses.
 */
export async function proxyToOpenRouter(body: any, res: Response): Promise<void> {
  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://ekailabs.xyz',
      'X-Title': 'Ekai Gateway',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok || !body.stream) {
    // Non-streaming: forward status + JSON body
    const data = await response.text();
    res.status(response.status).set('Content-Type', 'application/json').send(data);
    return;
  }

  // Streaming: pipe SSE chunks
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  const reader = response.body?.getReader();
  if (!reader) {
    res.end();
    return;
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } catch (err: any) {
    console.error(`[proxy] stream error: ${err.message}`);
  } finally {
    res.end();
  }
}
