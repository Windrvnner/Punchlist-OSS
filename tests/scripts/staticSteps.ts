// The commands `npm run check:static` runs, in order, with each `npm run <script>` step expanded to its own commands.
import { readFileSync } from 'node:fs';

export function staticCommands(name = 'check:static'): string[] {
  const { scripts } = JSON.parse(readFileSync('package.json', 'utf8'));
  return scripts[name].split(' && ').flatMap((command: string) => {
    const nested = /^npm run (\S+)$/.exec(command);
    return nested ? staticCommands(nested[1]) : [command];
  });
}
