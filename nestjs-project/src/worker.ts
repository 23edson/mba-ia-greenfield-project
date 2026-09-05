import { NestFactory } from '@nestjs/core';
import { WorkerAppModule } from './worker/worker-app.module';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerAppModule);
  app.enableShutdownHooks();
  console.log('Video worker is running and listening for jobs...');
}
void bootstrap();
