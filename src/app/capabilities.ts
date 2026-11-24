import type { Services } from '../ports';

type OptionalServices = Pick<Services, 'ai' | 'qaLogs' | 'signin' | 'place'>;

/** Port availability as state. Read it on demand so the demo can install stand-in services after boot. */
export function capabilities(services?: OptionalServices) {
  return {
    get checklist() { return !!services?.ai.checklist; },
    get phrase() { return !!services?.ai.phrase; },
    get checkAll() { return !!services?.ai.checkAll; },
    get memo() { return !!services?.ai.memo; },
    get issuesList() { return !!services?.ai.issuesList; },
    get addresses() { return !!services?.ai.addresses; },
    get merge() { return !!services?.ai.merge; },
    get layout() { return !!services?.ai.layout; },
    get research() { return !!services?.ai.research; },
    get stop() { return !!services?.ai.stop; },
    get reword() { return !!services?.ai.reword; },
    get sameMeaning() { return !!services?.ai.sameMeaning; },
    get qaLogs() { return !!services?.qaLogs; },
    get signin() { return !!services?.signin; },
    get place() { return !!services?.place; },
  };
}

export type Capabilities = ReturnType<typeof capabilities>;
