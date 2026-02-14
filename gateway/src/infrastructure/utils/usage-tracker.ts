import { pricingLoader, CostCalculation } from './pricing-loader.js';
import { dbQueries, type UsageRecord } from '../db/queries.js';
import { ModelUtils } from './model-utils.js';
import { logger } from './logger.js';
/**
 * Usage summary interface for consistent return types
 */
export interface UsageSummary {
  totalRequests: number;
  totalCost: number;
  totalTokens: number;
  costByProvider: Record<string, number>;
  costByModel: Record<string, number>;
  records: UsageRecord[];
}

/**
 * UsageTracker class for tracking AI model usage, costs, and analytics
 * All data is persisted to SQLite database for reliability and persistence
 */
export class UsageTracker {
  private static readonly MAX_RECORDS_EXPORT = 100;
  private static readonly HOURS_IN_DAY = 24;

  constructor() {
    // Ensure pricing is loaded when UsageTracker is instantiated
    pricingLoader.loadAllPricing();
  }

  /**
   * Track a chat completion request and calculate costs
   * @param model - The AI model name
   * @param provider - The provider (openai, anthropic, openrouter)
   * @param inputTokens - Number of input tokens
   * @param outputTokens - Number of output tokens
   * @param cacheWriteTokens - Number of cache write tokens
   * @param cacheReadTokens - Number of cache read tokens
   * @param x402PaymentAmount - Actual payment amount for x402 requests (overrides YAML pricing)
   * @returns Cost calculation or null if pricing not found
   */
  trackUsage(
    model: string,
    provider: string,
    inputTokens: number,
    outputTokens: number,
    cacheWriteTokens: number = 0,
    cacheReadTokens: number = 0,
    x402PaymentAmount?: string
  ): CostCalculation | null {
    // Input validation
    if (!model?.trim() || !provider?.trim()) {
      throw new Error('Model and provider are required');
    }

    if (inputTokens < 0 || outputTokens < 0 || cacheWriteTokens < 0 || cacheReadTokens < 0 ||
        !Number.isInteger(inputTokens) || !Number.isInteger(outputTokens) ||
        !Number.isInteger(cacheWriteTokens) || !Number.isInteger(cacheReadTokens)) {
      throw new Error('Token counts must be non-negative integers');
    }

    const now = new Date();
    
    const pricing = pricingLoader.getModelPricing(provider, model);

    // For x402 payments, use actual payment amount instead of YAML pricing
    let costCalculation: CostCalculation | null;
    
    const paymentMethod = x402PaymentAmount ? 'x402' : 'api_key';

    if (x402PaymentAmount) {
      // Parse the actual payment amount from x402
      const totalCost = parseFloat(x402PaymentAmount);
      
      if (isNaN(totalCost)) {
        logger.warn('Invalid x402 payment amount, falling back to YAML pricing', {
          x402PaymentAmount,
          model,
          provider,
          module: 'usage-tracker'
        });
        costCalculation = pricingLoader.calculateCost(provider, model, inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens);
      } else {
        // Use actual payment amount - distribute proportionally across token types
        costCalculation = {
          inputCost: 0,
          cacheWriteCost: 0,
          cacheReadCost: 0,
          outputCost: 0,
          totalCost,
          currency: 'USD', // x402 amounts are in USD
          unit: 'request' // x402 charges per request
        };
        
        logger.debug('Using x402 actual payment amount for cost tracking', {
          model,
          provider,
          x402Amount: totalCost,
          module: 'usage-tracker'
        });
      }
    } else {
      // Calculate cost using the pricing system from YAML
      costCalculation = pricingLoader.calculateCost(provider, model, inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens);
    }

    if (costCalculation) {
      // Generate unique request ID
      const requestId = this.generateRequestId(provider, model, now);
      
      // Save to database
      try {
        dbQueries.insertUsageRecord({
          request_id: requestId,
          provider: provider.toLowerCase(),
          model,
          timestamp: now.toISOString(),
          input_tokens: inputTokens,
          cache_write_input_tokens: cacheWriteTokens,
          cache_read_input_tokens: cacheReadTokens,
          output_tokens: outputTokens,
          total_tokens: inputTokens + cacheWriteTokens + cacheReadTokens + outputTokens,
          input_cost: costCalculation.inputCost,
          cache_write_cost: costCalculation.cacheWriteCost,
          cache_read_cost: costCalculation.cacheReadCost,
          output_cost: costCalculation.outputCost,
          total_cost: costCalculation.totalCost,
          currency: costCalculation.currency,
          payment_method: paymentMethod
        });

        logger.info('Usage tracked', {
          requestId,
          model,
          provider,
          cost: costCalculation.totalCost.toFixed(6),
          inputTokens,
          outputTokens,
          module: 'usage-tracker'
        });

      } catch (error) {
        logger.error('Failed to save usage record', error, { operation: 'usage_tracking', module: 'usage-tracker' });
        throw error instanceof Error ? error : new Error(String(error));
      }
    } else {
      logger.warn('No pricing data found', { model, provider, operation: 'usage_tracking', module: 'usage-tracker' });
    }

    return costCalculation;
  }

  /**
   * Get comprehensive usage summary from database
   * @param startDate - Start date for filtering (ISO string)
   * @param endDate - End date for filtering (ISO string)
   * @param recordLimit - Maximum number of recent records to include (default: 100)
   * @returns Usage summary with totals, breakdowns, and recent records
   */
  getUsageFromDatabase(startDate: string, endDate: string, recordLimit: number = UsageTracker.MAX_RECORDS_EXPORT): UsageSummary {
    try {
      return {
        totalRequests: dbQueries.getTotalRequests(startDate, endDate),
        totalCost: Number(dbQueries.getTotalCost(startDate, endDate).toFixed(6)),
        totalTokens: dbQueries.getTotalTokens(startDate, endDate),
        costByProvider: dbQueries.getCostByProvider(startDate, endDate),
        costByModel: dbQueries.getCostByModel(startDate, endDate),
        records: dbQueries.getAllUsageRecords(recordLimit, startDate, endDate)
      };
    } catch (error) {
      logger.error('Failed to get usage data', error, { operation: 'usage_retrieval', module: 'usage-tracker' });
      // Return empty summary rather than circular reference
      return {
        totalRequests: 0,
        totalCost: 0,
        totalTokens: 0,
        costByProvider: {},
        costByModel: {},
        records: []
      };
    }
  }

  /**
   * Export usage records for a date range
   */
  getUsageRecords(startDate: string, endDate: string): UsageRecord[] {
    return dbQueries.getUsageRecordsByDateRange(startDate, endDate);
  }

  /**
   * Convert usage records to CSV text
   */
  toCsv(records: UsageRecord[]): string {
    const headers = [
      'request_id',
      'provider',
      'model',
      'timestamp',
      'input_tokens',
      'cache_write_input_tokens',
      'cache_read_input_tokens',
      'output_tokens',
      'total_tokens',
      'input_cost_usd',
      'cache_write_cost_usd',
      'cache_read_cost_usd',
      'output_cost_usd',
      'total_cost_usd'
    ];

    const escape = (value: string | number): string => {
      const str = String(value ?? '');
      const needsQuotes = str.includes(',') || str.includes('"') || str.includes('\n');
      if (!needsQuotes) return str;
      return `"${str.replace(/"/g, '""')}"`;
    };

    const rows = records.map(record => [
      record.request_id,
      record.provider,
      record.model,
      record.timestamp,
      record.input_tokens,
      record.cache_write_input_tokens,
      record.cache_read_input_tokens,
      record.output_tokens,
      record.total_tokens,
      record.input_cost,
      record.cache_write_cost,
      record.cache_read_cost,
      record.output_cost,
      record.total_cost
    ].map(escape).join(','));

    return [headers.join(','), ...rows].join('\n');
  }

  /**
   * Get cost breakdown by provider
   * @param startDate - Start date for filtering (ISO string)
   * @param endDate - End date for filtering (ISO string)
   * @returns Record mapping provider names to total costs
   */
  getCostByProvider(startDate: string, endDate: string): Record<string, number> {
    try {
      return dbQueries.getCostByProvider(startDate, endDate);
    } catch (error) {
      logger.error('Failed to get cost by provider', error, { operation: 'usage_retrieval', module: 'usage-tracker' });
      return {};
    }
  }

  /**
   * Get cost breakdown by model type (e.g., "gpt-4" from "gpt-4o")
   * @param startDate - Start date for filtering (ISO string)
   * @param endDate - End date for filtering (ISO string)
   * @returns Record mapping model types to total costs
   */
  getCostByModelType(startDate: string, endDate: string): Record<string, number> {
    try {
      const costByModel = dbQueries.getCostByModel(startDate, endDate);
      const costByModelType: Record<string, number> = {};
      
      Object.entries(costByModel).forEach(([model, cost]) => {
        const modelType = this.extractModelType(model);
        costByModelType[modelType] = (costByModelType[modelType] || 0) + cost;
      });

      return costByModelType;
    } catch (error) {
      logger.error('Failed to get cost by model type', error, { operation: 'usage_retrieval', module: 'usage-tracker' });
      return {};
    }
  }

  /**
   * Get hourly cost breakdown for the last 24 hours
   * @returns Record mapping ISO hour strings to costs
   */
  getHourlyCostBreakdown(): Record<string, number> {
    try {
      const hourlyCosts: Record<string, number> = {};
      const now = new Date();
      const oneDayAgo = new Date(now.getTime() - UsageTracker.HOURS_IN_DAY * 60 * 60 * 1000);

      // Use date range query for better performance
      const records = dbQueries.getUsageRecordsByDateRange(
        oneDayAgo.toISOString(), 
        now.toISOString()
      );
      
      records.forEach(record => {
        const hourKey = new Date(record.timestamp).toISOString().slice(0, 13) + ':00:00Z';
        hourlyCosts[hourKey] = (hourlyCosts[hourKey] || 0) + record.total_cost;
      });

      return hourlyCosts;
    } catch (error) {
      logger.error('Failed to get hourly cost breakdown', error, { operation: 'usage_retrieval', module: 'usage-tracker' });
      return {};
    }
  }

  /**
   * Reset all usage data (clears database)
   * @returns Promise that resolves when reset is complete
   */
  async reset(): Promise<void> {
    try {
      // Note: This would require implementing clearAllUsageRecords in dbQueries
      // For now, just log that it's not implemented
      logger.warn('Usage reset not implemented', { operation: 'usage_reset', module: 'usage-tracker' });
    } catch (error) {
      logger.error('Failed to reset usage tracker', error, { operation: 'usage_reset', module: 'usage-tracker' });
      throw error instanceof Error ? error : new Error(String(error));
    }
  }


  /**
   * Get pricing information for all available models
   * @returns Pricing summary from the pricing loader
   */
  getPricingInfo() {
    return pricingLoader.getPricingSummary();
  }

  /**
   * Search for models by name or description
   * @param query - Search query string
   * @returns Array of matching models
   */
  searchModels(query: string) {
    if (!query?.trim()) {
      throw new Error('Search query is required');
    }
    return pricingLoader.searchModels(query.trim());
  }


  /**
   * Generate a unique request ID
   * @private
   */
  private generateRequestId(provider: string, model: string, timestamp: Date): string {
    const randomSuffix = Math.random().toString(36).substring(2, 11);
    return `${provider}-${model}-${timestamp.getTime()}-${randomSuffix}`;
  }

  /**
   * Extract model type from full model name
   * @private
   */
  private extractModelType(model: string): string {
    const parts = model.split('-');
    if (parts.length >= 2) {
      return `${parts[0]}-${parts[1]}`;
    }
    return model; // fallback to full name if parsing fails
  }
}

// Export singleton instance
export const usageTracker = new UsageTracker();
