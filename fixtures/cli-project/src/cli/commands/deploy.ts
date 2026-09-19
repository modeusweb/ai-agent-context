import { loadConfig } from '../config/loader.ts';

export async function runDeploy(environment: string, dryRun: boolean): Promise<void> {
  const config = await loadConfig(environment);
  console.log(`deploying to ${environment} (dry run: ${dryRun})`);
  console.log(config);
}
