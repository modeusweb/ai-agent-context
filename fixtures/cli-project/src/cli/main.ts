import { Command } from 'commander';
import { runDeploy } from './commands/deploy.ts';

const program = new Command();

program.name('deploy-tool').description('Deployment helper').version('0.2.0');

program
  .command('deploy')
  .argument('<environment>')
  .option('--dry-run', 'print the plan without applying it')
  .action(async (environment, options) => {
    await runDeploy(environment, options.dryRun === true);
  });

program.parse(process.argv);
