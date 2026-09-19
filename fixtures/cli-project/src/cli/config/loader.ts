import { readFile } from 'node:fs/promises';

export interface DeployConfig {
  environment: string;
  region: string;
}

export async function loadConfig(environment: string): Promise<DeployConfig> {
  const contents = await readFile(`config/${environment}.json`, 'utf8');
  return { environment, region: JSON.parse(contents).region ?? 'us-east-1' };
}
