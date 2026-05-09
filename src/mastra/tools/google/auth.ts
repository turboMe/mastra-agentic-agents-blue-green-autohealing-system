import { OAuth2Client } from 'google-auth-library'

let cachedAuth: OAuth2Client | null = null

/**
 * Get authenticated OAuth2 client.
 * Uses refresh token from env or DB.
 */
export async function getGoogleAuth(): Promise<OAuth2Client> {
  if (cachedAuth) return cachedAuth

  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN

  if (!clientId || !clientSecret) {
    throw new Error('Google OAuth not configured: missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET')
  }

  if (!refreshToken) {
    throw new Error('Google OAuth not configured: missing GOOGLE_REFRESH_TOKEN. Run OAuth flow first via /api/auth/google')
  }

  const oauth2Client = new OAuth2Client(
    clientId,
    clientSecret,
    process.env.GOOGLE_REDIRECT_URI
  )

  oauth2Client.setCredentials({ refresh_token: refreshToken })

  // Force token refresh to validate
  await oauth2Client.getAccessToken()

  cachedAuth = oauth2Client
  return oauth2Client
}

/**
 * Generate OAuth URL for user to authorize.
 */
export function getGoogleAuthUrl(): string {
  const oauth2Client = new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  )

  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [...GOOGLE_OAUTH_SCOPES]
  })
}

/**
 * Full set of OAuth scopes used across Google tools.
 * Adding a new service here requires re-running the OAuth flow
 * to get a refresh token with the new scopes.
 */
export const GOOGLE_OAUTH_SCOPES = [
  // Calendar (existing)
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
  // Gmail (existing)
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.compose',
  // Sheets (new — Faza 6.1)
  'https://www.googleapis.com/auth/spreadsheets',
  // Slides (new — Faza 6.1)
  'https://www.googleapis.com/auth/presentations',
  // Drive — needed to create files (sheets/slides) and list/move them
  'https://www.googleapis.com/auth/drive.file',
] as const

/**
 * Exchange authorization code for tokens.
 */
export async function exchangeGoogleCode(code: string): Promise<{
  accessToken: string
  refreshToken: string
  expiryDate: number | null
}> {
  const oauth2Client = new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  )

  const { tokens } = await oauth2Client.getToken(code)

  return {
    accessToken: tokens.access_token ?? '',
    refreshToken: tokens.refresh_token ?? '',
    expiryDate: tokens.expiry_date ?? null
  }
}

/**
 * Clear cached auth (for token rotation).
 */
export function clearGoogleAuthCache(): void {
  cachedAuth = null
}
