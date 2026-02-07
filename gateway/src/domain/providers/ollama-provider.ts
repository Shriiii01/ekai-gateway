import { BaseProvider } from './base-provider.js';
import { CanonicalRequest, CanonicalResponse } from 'shared/types/index.js';
import { getConfig } from '../../infrastructure/config/app-config.js';

interface OllamaRequest {
  model: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string; }>;
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  stop?: string | string[];
}

interface OllamaResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: string; content: string; };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export class OllamaProvider extends BaseProvider {
  readonly name = 'ollama';

  // Ollama exposes an OpenAI-compatible API at /v1
  protected get baseUrl(): string {
    return getConfig().providers.ollama.baseUrl;
  }

  // Ollama doesn't require an API key by default, but we return a
  // dummy value so BaseProvider.isConfigured() stays true when the
  // base URL is set.  Users can optionally supply a real key if they
  // put Ollama behind an auth proxy.
  protected get apiKey(): string | undefined {
    return getConfig().providers.ollama.apiKey || 'ollama';
  }

  /**
   * Ollama is considered configured when the user has explicitly
   * enabled it by setting OLLAMA_BASE_URL (even without an API key).
   */
  isConfigured(): boolean {
    return getConfig().providers.ollama.enabled;
  }

  protected transformRequest(request: CanonicalRequest): OllamaRequest {
    const messages = request.messages.map(msg => ({
      role: msg.role,
      content: msg.content
        .filter(c => c.type === 'text')
        .map(c => c.text)
        .join('')
    }));

    return {
      model: request.model,
      messages,
      max_tokens: request.maxTokens,
      temperature: request.temperature,
      stream: request.stream || false,
      stop: request.stopSequences
    };
  }

  protected transformResponse(response: OllamaResponse): CanonicalResponse {
    const choice = response.choices[0];

    return {
      id: response.id,
      model: response.model,
      created: response.created,
      message: {
        role: 'assistant',
        content: [{
          type: 'text',
          text: choice.message.content
        }]
      },
      finishReason: this.mapFinishReason(choice.finish_reason),
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
        totalTokens: response.usage?.total_tokens ?? 0
      }
    };
  }

  private mapFinishReason(reason: string): 'stop' | 'length' | 'tool_calls' | 'error' {
    switch (reason) {
      case 'stop': return 'stop';
      case 'length': return 'length';
      default: return 'stop';
    }
  }
}
