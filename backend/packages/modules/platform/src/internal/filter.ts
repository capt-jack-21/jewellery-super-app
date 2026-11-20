import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';

interface Hdr { header(k: string, v: string): Hdr; send(b: unknown): void }

/** RFC 9457 problem+json for every error. */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly log = new Logger('Problem');
  catch(e: unknown, host: ArgumentsHost) {
    const reply = host.switchToHttp().getResponse<{ status(n: number): Hdr; sent?: boolean }>();
    let status = 500; let body: Record<string, unknown> = { type: 'about:blank', title: 'Internal Server Error', status: 500, code: 'internal' };
    if (e instanceof HttpException) {
      status = e.getStatus();
      const r = e.getResponse();
      body = typeof r === 'object' && r !== null && 'code' in r ? { status, ...(r as object) }
        : { type: 'about:blank', title: e.message, status, code: status === 404 ? 'not_found' : status === 400 ? 'bad_request' : 'error',
            ...(typeof r === 'object' && r && 'message' in r ? { detail: String((r as { message: unknown }).message) } : {}) };
    } else if ((e as { statusCode?: number })?.statusCode && (e as { statusCode: number }).statusCode < 500) {
      status = (e as { statusCode: number }).statusCode;                 // fastify errors (body too large, bad JSON …)
      body = { type: 'about:blank', title: (e as Error).message, status, code: status === 413 ? 'too_large' : 'bad_request' };
    } else this.log.error(e);
    if (reply.sent) return;
    const r = reply.status(status);
    const wait = (e as { retryAfter?: unknown })?.retryAfter;
    if (status === 429) r.header('retry-after', String(typeof wait === 'number' && wait > 0 ? Math.ceil(wait) : 60));
    if (status === 429) body = { ...body, code: 'rate_limited' };
    r.header('content-type', 'application/problem+json').send(body);
  }
}
