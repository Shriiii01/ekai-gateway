import fetch from 'node-fetch';
import { CanonicalRequest, CanonicalResponse } from 'shared/types/index.js';
import { ProviderError, AuthenticationError } from '../../shared/errors/index.js';
import { usageTracker } from '../../infrastructure/utils/usage-tracker.js';
import { AIProvider, ProviderRequest, ProviderResponse, HTTP_STATUS } from '../types/provider.js';
import { logger } from '../../infrastructure/utils/logger.js';

export abstract class BaseProvider implements AIProvider {
  abstract readonly name: string;
  protected abstract readonly baseUrl: string;
  protected abstract readonly apiKey: string | undefined;

  isConfigured(): boolean {
    return !!this.apiKey;
  }

  // Template method pattern: allow providers to customize headers
  protected getHeaders(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json'
    };
  }

  // Provider-specific transformations with proper types
  protected abstract transformRequest(request: CanonicalRequest): ProviderRequest;
  protected abstract transformResponse(response: ProviderResponse): CanonicalResponse;

  // Template method pattern: allow providers to customize endpoint
  protected getChatCompletionEndpoint(): string {
    return '/chat/completions';
  }


  protected async makeAPIRequest<T>(endpoint: string, options: Record<string, unknown> = {}): Promise<T> {
    if (!this.apiKey) {
      throw new AuthenticationError(`${this.name} API key not configured`, { provider: this.name });
    }

    const url = `${this.baseUrl}${endpoint}`;
    const headers = {
      ...this.getHeaders(),
      ...(options.headers as Record<string, string> || {})
    };

    const response = await fetch(url, {
      ...options,
      headers
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new ProviderError(
        this.name,
        errorText || `HTTP ${response.status}`,
        response.status,
        { endpoint, statusText: response.statusText }
      );
    }

    return response.json() as Promise<T>;
  }

  async chatCompletion(request: CanonicalRequest): Promise<CanonicalResponse> {
    const transformedRequest = this.transformRequest(request);
    const response = await this.makeAPIRequest(this.getChatCompletionEndpoint(), {
      method: 'POST',
      body: JSON.stringify(transformedRequest)
    });
    
    const transformedResponse = this.transformResponse(response);
    
    // Track usage
    if (transformedResponse.usage) {
      usageTracker.trackUsage(
        request.model,
        this.name,
        transformedResponse.usage.inputTokens,
        transformedResponse.usage.outputTokens,
        transformedResponse.usage.cacheWriteInputTokens || 0,
        transformedResponse.usage.cacheReadInputTokens || 0,
      );
    }
    
    return transformedResponse;
  }

  async getStreamingResponse(request: CanonicalRequest): Promise<any> {
    const transformedRequest = this.transformRequest(request);
    
    // Set stream: true for streaming requests
    const streamingRequest = { ...transformedRequest, stream: true };
    
    if (!this.apiKey) {
      throw new AuthenticationError(`${this.name} API key not configured`, { provider: this.name });
    }

    const url = `${this.baseUrl}${this.getChatCompletionEndpoint()}`;
    const headers = {
      ...this.getHeaders(),
      'Accept': 'text/event-stream',
      'Cache-Control': 'no-cache'
    };

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(streamingRequest)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new ProviderError(
        this.name,
        errorText || `HTTP ${response.status}`,
        response.status,
        { endpoint: this.getChatCompletionEndpoint(), stream: true, statusText: response.statusText }
      );
    }

    return response;
  }

}
