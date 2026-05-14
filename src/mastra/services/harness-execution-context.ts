import { AsyncLocalStorage } from 'async_hooks';

export type HarnessExecutionContext = {
  taskId?: string;
  subtaskId?: string;
  agentId?: string;
  threadId?: string;
  runId?: string;
  turnId?: string;
};

const harnessExecutionContext = new AsyncLocalStorage<HarnessExecutionContext>();

export async function runWithHarnessExecutionContext<T>(
  context: HarnessExecutionContext,
  fn: () => Promise<T>,
): Promise<T> {
  return harnessExecutionContext.run(context, fn);
}

export function getHarnessExecutionContext(): HarnessExecutionContext | undefined {
  return harnessExecutionContext.getStore();
}
