import { control, type Control } from '../control';
import { oauthSignIn, type BrowserSignIn } from './oauth';
import { bedrockSignIn } from './bedrockSignIn';

export function providerSignIn(c: Control = control) {
  switch (c.models.service) {
    case 'gateway':
      return (io: BrowserSignIn) => oauthSignIn(c.gateway, io);
    case 'azure': {
      const authority = `https://login.microsoftonline.com/${c.azure.tenant}/oauth2/v2.0`;
      return (io: BrowserSignIn) => oauthSignIn({
        authorize: `${authority}/authorize`, token: `${authority}/token`, clientId: c.azure.clientId,
        scope: 'https://cognitiveservices.azure.com/.default', prompt: 'select_account', redirectHost: 'localhost',
      }, io);
    }
    case 'bedrock':
      return (io: BrowserSignIn) => bedrockSignIn(c.bedrock, io);
    case 'vertex':
      return (io: BrowserSignIn) => oauthSignIn({
        authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token',
        clientId: c.vertex.clientId, scope: 'https://www.googleapis.com/auth/cloud-platform', prompt: 'select_account',
      }, io);
    default:
      return undefined;
  }
}
