import { CredentialRef } from './credential-types.js';

export function getCredentialFromRegistry(service: string): CredentialRef | undefined {
  const s = service.toLowerCase();

  if (s === 'telegram') {
    const id = process.env.N8N_CREDENTIAL_TELEGRAM_ID;
    const name = process.env.N8N_CREDENTIAL_TELEGRAM_NAME || 'Telegram Bot';
    if (id) {
      return { service: 'telegram', n8nCredentialType: 'telegramApi', id, name };
    }
  }

  if (s === 'mongo' || s === 'mongodb') {
    const id = process.env.N8N_CREDENTIAL_MONGO_ID;
    const name = process.env.N8N_CREDENTIAL_MONGO_NAME || 'MongoDB';
    if (id) {
      return { service: 'mongo', n8nCredentialType: 'mongoDb', id, name };
    }
  }

  if (s === 'gmail') {
    const id = process.env.N8N_CREDENTIAL_GMAIL_ID;
    const name = process.env.N8N_CREDENTIAL_GMAIL_NAME || 'Gmail OAuth2';
    const credentialType = process.env.N8N_CREDENTIAL_GMAIL_TYPE || 'googleGmailOAuth2Api';
    if (id) {
      return { service: 'gmail', n8nCredentialType: credentialType, id, name };
    }
  }

  // Fallback for generic HTTP auth if needed
  if (s === 'httpheaderauth') {
    const id = process.env.N8N_CREDENTIAL_HTTP_ID;
    if (id) {
      return {
        service: 'httpHeaderAuth',
        n8nCredentialType: 'httpHeaderAuth',
        id,
        name: process.env.N8N_CREDENTIAL_HTTP_NAME || 'HTTP Header Auth',
      };
    }
  }

  return undefined;
}
