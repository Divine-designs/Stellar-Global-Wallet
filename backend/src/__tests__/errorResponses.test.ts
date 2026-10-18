import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { errorHandler } from '../middleware/errorHandler';
import { AppError } from '../errors/AppError';

function buildApp() {
  const app = express();
  app.use(express.json({ limit: '1kb' }));

  app.get('/ok', (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  app.get('/bad-request', (_req: Request, _res: Response, next: NextFunction) => {
    next(new AppError('Invalid input', { code: 'BAD_REQUEST', status: 400 }));
  });

  app.get('/unauthorized', (_req: Request, _res: Response, next: NextFunction) => {
    next(new AppError('Unauthorized', { code: 'UNAUTHORIZED', status: 401 }));
  });

  app.get('/rate-limited', (_req: Request, _res: Response, next: NextFunction) => {
    next(
      new AppError('Too many requests', {
        code: 'RATE_LIMITED',
        status: 429,
        retryable: true,
      })
    );
  });

  app.get('/boom', (_req: Request, _res: Response, next: NextFunction) => {
    next(new Error('kaboom'));
  });

  app.use((_req: Request, _res: Response, next: NextFunction) => {
    next(new AppError('Not found', { code: 'NOT_FOUND', status: 404 }));
  });

  app.use(errorHandler);
  return app;
}

function expectEnvelope(body: any) {
  expect(body).toHaveProperty('error');
  expect(typeof body.error.code).toBe('string');
  expect(typeof body.error.message).toBe('string');
  expect(body.error).toHaveProperty('requestId');
  expect(body.error).not.toHaveProperty('stack');
}

describe('consistent error envelope', () => {
  const app = buildApp();

  it('returns 200 for the happy path', async () => {
    const res = await request(app).get('/ok');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('returns 400 with the shared envelope', async () => {
    const res = await request(app).get('/bad-request');
    expect(res.status).toBe(400);
    expectEnvelope(res.body);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('returns 401 with the shared envelope', async () => {
    const res = await request(app).get('/unauthorized');
    expect(res.status).toBe(401);
    expectEnvelope(res.body);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 404 with the shared envelope', async () => {
    const res = await request(app).get('/does-not-exist');
    expect(res.status).toBe(404);
    expectEnvelope(res.body);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('returns 413 with the shared envelope for oversized payloads', async () => {
    const res = await request(app)
      .post('/ok')
      .set('Content-Type', 'application/json')
      .send({ data: 'x'.repeat(4096) });
    expect(res.status).toBe(413);
    expectEnvelope(res.body);
  });

  it('returns 429 with the shared envelope and retryable flag', async () => {
    const res = await request(app).get('/rate-limited');
    expect(res.status).toBe(429);
    expectEnvelope(res.body);
    expect(res.body.error.code).toBe('RATE_LIMITED');
    expect(res.body.error.retryable).toBe(true);
  });

  it('returns 500 with the shared envelope and no stack trace', async () => {
    const res = await request(app).get('/boom');
    expect(res.status).toBe(500);
    expectEnvelope(res.body);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
  });

  it('returns 400 with the shared envelope for malformed JSON', async () => {
    const res = await request(app)
      .post('/ok')
      .set('Content-Type', 'application/json')
      .send('{ not valid json');
    expect(res.status).toBe(400);
    expectEnvelope(res.body);
  });
});
