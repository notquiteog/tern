// The evaluation scripts talk to the model without a signed-in person, which
// is exactly the shape of the hole the consent gate exists to close. So they
// do not get an exemption: they get a consent object that refuses to exist on
// a production install.
//
// The scripts are run by hand, against a development database, by whoever is
// working on the prompts. If one is ever started against a real deployment
// this throws before a single message is read.
import { config } from '../config.js';
import type { AiConsent } from './llm.js';

// The account the scripts run as. Nothing in `.eval.ts` reads a mailbox; the
// fixtures are in the files themselves. The capability is still named, and
// still has to be granted, so even in development the switch works.
export function evalConsent(userId = 1): AiConsent {
  if (config.env === 'production') {
    throw new Error('The evaluation scripts do not run on a production install: they would talk to the model outside anybody’s consent.');
  }
  return { userId, capability: 'ai.playground' };
}
