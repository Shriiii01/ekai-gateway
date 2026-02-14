import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      clientIp?: string;
    }
  }
}

export function requestContext(req: Request, res: Response, next: NextFunction): void {
  req.requestId = randomUUID();
  // Determine client IP considering proxies
  const xff = (req.headers['x-forwarded-for'] || '') as string;
  // x-forwarded-for may be a comma-separated list, take the first non-empty
  const forwarded = xff.split(',').map(s => s.trim()).filter(Boolean)[0];
  const remote = (req.socket && (req.socket as any).remoteAddress) || (req as any).ip || undefined;
  req.clientIp = forwarded || remote;
  res.setHeader('X-Request-ID', req.requestId);
  if (req.clientIp) {
    res.setHeader('X-Client-IP', req.clientIp);
  }
  next();
}
