import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import queueConfig from './queue.config';

describe('QueueConfig', () => {
  let moduleRef: TestingModule;

  beforeEach(() => {
    process.env.REDIS_HOST = 'redis-host';
    process.env.REDIS_PORT = '6380';
    process.env.REDIS_PASSWORD = 'supersecret';
  });

  afterEach(() => {
    delete process.env.REDIS_HOST;
    delete process.env.REDIS_PORT;
    delete process.env.REDIS_PASSWORD;
  });

  it('should return loaded configuration', async () => {
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ load: [queueConfig] })],
    }).compile();

    const configResult = queueConfig();

    expect(configResult).toEqual({
      host: 'redis-host',
      port: 6380,
      password: 'supersecret',
    });
  });

  it('should use default values if env variables are not provided', () => {
    delete process.env.REDIS_HOST;
    delete process.env.REDIS_PORT;
    delete process.env.REDIS_PASSWORD;

    const configResult = queueConfig();

    expect(configResult.host).toBe('localhost');
    expect(configResult.port).toBe(6379);
    expect(configResult.password).toBeUndefined();
  });
});
