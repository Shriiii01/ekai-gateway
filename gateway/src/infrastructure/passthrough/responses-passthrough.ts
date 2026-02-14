import { Response as ExpressResponse } from 'express';

export interface ResponsesAuthConfig {
  envVar: string;
  header: string;
  scheme?: string;
  template?: string;
}

export interface ResponsesPassthroughConfig {
  provider: string;
  baseUrl: string;
  auth?: ResponsesAuthConfig;
  staticHeaders?: Record<string, string>;
  supportedClientFormats: string[];
}

export interface ResponsesPassthrough {
  handleDirectRequest(request: any, res: ExpressResponse): Promise<void>;
}
