import type { NextFunction, Request, Response } from 'express';
import { ApiError, invalidRequest } from '../errors';
import { log } from '../logger';

/** Maps every failure onto the single error shape the API contract defines. */
export function errorMiddleware(
  error: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) {
    next(error);
    return;
  }

  if (error instanceof ApiError) {
    res.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }

  // Malformed percent-encoding in a path parameter.
  if (error instanceof URIError) {
    const apiError = invalidRequest('Malformed request path');
    res.status(apiError.status).json({ error: { code: apiError.code, message: apiError.message } });
    return;
  }

  const details = error as { type?: string; code?: string; status?: number } | null;

  // body-parser failures: invalid JSON, oversized payload.
  if (details?.type === 'entity.parse.failed' || (error instanceof SyntaxError && 'body' in (error as object))) {
    const apiError = invalidRequest('Request body is not valid JSON');
    res.status(apiError.status).json({ error: { code: apiError.code, message: apiError.message } });
    return;
  }
  if (details?.type === 'entity.too.large') {
    const apiError = invalidRequest('Request body is too large');
    res.status(apiError.status).json({ error: { code: apiError.code, message: apiError.message } });
    return;
  }

  // A malformed UUID reaching PostgreSQL is a client error, not a server fault.
  if (details?.code === '22P02' || details?.code === '22007') {
    const apiError = invalidRequest('One of the provided identifiers or timestamps is malformed');
    res.status(apiError.status).json({ error: { code: apiError.code, message: apiError.message } });
    return;
  }

  log('error', 'unhandled request failure', {
    method: req.method,
    path: req.originalUrl,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });

  res.status(500).json({
    error: { code: 'internal_error', message: 'An unexpected error occurred' },
  });
}

export function notFoundMiddleware(req: Request, res: Response): void {
  res.status(404).json({
    error: { code: 'not_found', message: `Route ${req.method} ${req.path} does not exist` },
  });
}

type AsyncHandler = (req: Request, res: Response) => Promise<void>;

/** Forwards rejected promises to the error middleware on every Express version. */
export function handle(fn: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };
}
