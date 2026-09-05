import { Test, TestingModule } from '@nestjs/testing';
import { WorkerAppModule } from './worker-app.module';

describe('WorkerAppModule', () => {
  let module: TestingModule;

  beforeEach(async () => {
    module = await Test.createTestingModule({
      imports: [WorkerAppModule],
    }).compile();
  });

  afterEach(async () => {
    if (module) {
      await module.close();
    }
  });

  it('should compile the worker module successfully', () => {
    expect(module).toBeDefined();
  });
});
