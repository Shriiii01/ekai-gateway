import { CanonicalRequest, CanonicalResponse } from 'shared/types/index.js';
import { logger } from '../../infrastructure/utils/logger.js';
import { pricingLoader } from '../../infrastructure/utils/pricing-loader.js';
import { ModelUtils } from '../../infrastructure/utils/model-utils.js';
import {
  Provider,
  ProviderRegistry,
  createDefaultProviderRegistry
} from './provider-registry.js';

export class ProviderService {
  constructor(private readonly registry: ProviderRegistry = createDefaultProviderRegistry()) {}

  getAvailableProviders(): Provider[] {
    return this.registry.getAvailableProviders();
  }

  getMostOptimalProvider(modelName: string, requestId?: string): { provider: Provider; error?: never } | { provider?: never; error: { code: string; message: string } } {
    const normalizedModel = ModelUtils.normalizeModelName(modelName);
    const availableProviders = this.getAvailableProviders();

    if (availableProviders.length === 0) {
      logger.warn('No providers configured', { operation: 'provider_selection', requestId, module: 'provider-service' });
      return {
        error: {
          code: 'NO_PROVIDERS_CONFIGURED',
          message: 'No inference providers are configured. Please add your API keys to the .env file.'
        }
      };
    }

    // Check for explicit provider matches first via registry rules
    const preferred = this.registry.findPreferredProvider(modelName, availableProviders);
    if (preferred) {
      return { provider: preferred };
    }

    // Find cheapest available provider that supports this model
    let cheapestProvider: Provider | null = null;
    let lowestCost = Infinity;

    const allPricing = pricingLoader.loadAllPricing();

    for (const providerName of availableProviders) {
      const pricingConfig = allPricing.get(providerName);
      const modelPricing = pricingConfig?.models[normalizedModel];

      if (modelPricing) {
        const totalCost = modelPricing.input + modelPricing.output;
        if (totalCost < lowestCost) {
          lowestCost = totalCost;
          cheapestProvider = providerName;
        }
      }
    }

    if (!cheapestProvider) {
      logger.warn('No providers found for model', { 
        operation: 'provider_selection',
        module: 'provider-service',
        model: normalizedModel,
        availableProviders,
        requestId
      });
      return {
        error: {
          code: 'MODEL_NOT_SUPPORTED',
          message: `Model '${modelName}' is not supported by any available providers. Either try a different model or add more providers to your .env file.`
        }
      };
    }

    return { provider: cheapestProvider };
  }


  async processChatCompletion(
    request: CanonicalRequest,
    providerName: Provider,
    clientType?: 'openai' | 'anthropic',
    originalRequest?: unknown,
    requestId?: string,
  ): Promise<CanonicalResponse> {
    const provider = this.registry.getOrCreateProvider(providerName);

    // Ensure Anthropic models have required suffixes
    if (providerName === Provider.ANTHROPIC) {
      request.model = ModelUtils.ensureAnthropicSuffix(request.model);
    }

    logger.info(`Processing chat completion`, {
      provider: providerName,
      model: request.model,
      streaming: request.stream,
      requestId,
      module: 'provider-service'
    });

    return provider.chatCompletion(request);
  }

  async processStreamingRequest(
    request: CanonicalRequest,
    providerName: Provider,
    clientType?: 'openai' | 'anthropic',
    originalRequest?: unknown,
    requestId?: string,
  ): Promise<any> {
    const provider = this.registry.getOrCreateProvider(providerName);

    // Ensure Anthropic models have required suffixes
    if (providerName === Provider.ANTHROPIC) {
      request.model = ModelUtils.ensureAnthropicSuffix(request.model);
    }

    logger.info(`Processing streaming request`, {
      provider: providerName,
      model: request.model,
      requestId,
      module: 'provider-service'
    });

    return provider.getStreamingResponse(request);
  }
}
