import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import { ProblemFilter } from '@jw/mod-platform';
import { AppModule } from './app.module';

export async function createApp(): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter({ trustProxy: process.env.TRUST_PROXY === '1', bodyLimit: 1024 * 1024, maxParamLength: 2048 }),
    { logger: ['error', 'warn'] });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await app.register(cookie as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await app.register(multipart as any, { limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 5 } });
  app.useGlobalFilters(new ProblemFilter());
  // 0.5.0: signed download links live at /files/<token> (Caddy proxies only /files/* here; storage is never exposed)
  // maxParamLength 2048: download tokens are ~400 chars (find-my-way default is 100)
  app.setGlobalPrefix('api', { exclude: [{ path: 'files/:token', method: RequestMethod.GET }] });
  await app.init();
  return app;
}
