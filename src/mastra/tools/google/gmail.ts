import { google, type gmail_v1 } from 'googleapis'
import type { OAuth2Client } from 'google-auth-library'
import { getGoogleAuth } from './auth'

export class GmailService {
  private gmail: gmail_v1.Gmail

  constructor(authClient: OAuth2Client) {
    this.gmail = google.gmail({ version: 'v1', auth: authClient })
  }

  static async create(): Promise<GmailService> {
    const auth = await getGoogleAuth()
    return new GmailService(auth)
  }

  async searchThreads(query: string, maxResults = 20) {
    const result = await this.gmail.users.threads.list({
      userId: 'me',
      q: query,
      maxResults
    })
    return result.data.threads ?? []
  }

  async getThread(threadId: string) {
    const result = await this.gmail.users.threads.get({
      userId: 'me',
      id: threadId,
      format: 'full'
    })
    return result.data
  }

  /**
   * Parse thread into a simple structure for LLM context.
   */
  async getThreadAsContext(threadId: string): Promise<{
    subject: string
    participants: string[]
    messages: Array<{
      from: string
      to: string
      date: Date
      body: string
    }>
  }> {
    const thread = await this.getThread(threadId)
    const messages = (thread.messages ?? []).map(m => {
      const headers = m.payload?.headers ?? []
      const from = headers.find(h => h.name === 'From')?.value ?? ''
      const to = headers.find(h => h.name === 'To')?.value ?? ''
      const date = new Date(headers.find(h => h.name === 'Date')?.value ?? '')
      const body = this.extractBody(m.payload!)
      return { from, to, date, body }
    })

    const subject = (thread.messages?.[0]?.payload?.headers ?? [])
      .find(h => h.name === 'Subject')?.value ?? ''
    const participants = Array.from(new Set([
      ...messages.map(m => m.from),
      ...messages.map(m => m.to)
    ]))

    return { subject, participants, messages }
  }

  private extractBody(payload: gmail_v1.Schema$MessagePart): string {
    if (payload.body?.data) {
      return Buffer.from(payload.body.data, 'base64').toString('utf-8')
    }
    if (payload.parts) {
      const textPart = payload.parts.find(p => p.mimeType === 'text/plain')
      if (textPart) return this.extractBody(textPart)
    }
    return ''
  }

  /**
   * Create draft reply in Gmail (does NOT send).
   */
  async createDraftReply(opts: {
    threadId: string
    to: string
    subject: string
    body: string
    inReplyTo?: string
    references?: string
  }): Promise<string> {
    const raw = this.buildRfc822({
      to: opts.to,
      subject: opts.subject,
      body: opts.body,
      inReplyTo: opts.inReplyTo,
      references: opts.references
    })

    const result = await this.gmail.users.drafts.create({
      userId: 'me',
      requestBody: {
        message: {
          threadId: opts.threadId,
          raw: Buffer.from(raw).toString('base64url')
        }
      }
    })

    return result.data.id!
  }

  /**
   * Create a new draft (not a reply).
   */
  async createDraft(opts: {
    to: string
    subject: string
    body: string
  }): Promise<string> {
    const raw = this.buildRfc822(opts)

    const result = await this.gmail.users.drafts.create({
      userId: 'me',
      requestBody: {
        message: {
          raw: Buffer.from(raw).toString('base64url')
        }
      }
    })

    return result.data.id!
  }

  /**
   * Update an existing Gmail draft in-place.
   */
  async updateDraft(opts: {
    draftId: string
    to: string
    subject: string
    body: string
    threadId?: string
  }): Promise<string> {
    const raw = this.buildRfc822(opts)

    const result = await this.gmail.users.drafts.update({
      userId: 'me',
      id: opts.draftId,
      requestBody: {
        id: opts.draftId,
        message: {
          ...(opts.threadId ? { threadId: opts.threadId } : {}),
          raw: Buffer.from(raw).toString('base64url')
        }
      }
    })

    return result.data.id ?? opts.draftId
  }

  /**
   * List drafts in Gmail.
   */
  async listDrafts(maxResults = 20) {
    const result = await this.gmail.users.drafts.list({
      userId: 'me',
      maxResults
    })
    return result.data.drafts ?? []
  }

  /**
   * Get a specific draft with its content.
   */
  async getDraft(draftId: string) {
    const result = await this.gmail.users.drafts.get({
      userId: 'me',
      id: draftId,
      format: 'full'
    })
    
    const message = result.data.message
    if (!message) throw new Error(`Draft ${draftId} has no message content`)

    const headers = message.payload?.headers ?? []
    const to = headers.find(h => h.name === 'To')?.value ?? ''
    const subject = headers.find(h => h.name === 'Subject')?.value ?? ''
    const body = this.extractBody(message.payload!)

    return {
      id: result.data.id,
      to,
      subject,
      body,
      threadId: message.threadId
    }
  }

  private buildRfc822(opts: {
    to: string
    subject: string
    body: string
    inReplyTo?: string
    references?: string
  }): string {
    const headers = [
      `To: ${opts.to}`,
      `Subject: ${opts.subject}`,
      'Content-Type: text/plain; charset=UTF-8'
    ]
    if (opts.inReplyTo) headers.push(`In-Reply-To: ${opts.inReplyTo}`)
    if (opts.references) headers.push(`References: ${opts.references}`)
    return `${headers.join('\r\n')}\r\n\r\n${opts.body}`
  }

  /**
   * Send a draft by ID.
   */
  async sendDraft(draftId: string): Promise<void> {
    await this.gmail.users.drafts.send({
      userId: 'me',
      requestBody: {
        id: draftId
      }
    })
  }

  /**
   * Delete a draft by ID.
   */
  async deleteDraft(draftId: string): Promise<void> {
    await this.gmail.users.drafts.delete({
      userId: 'me',
      id: draftId
    })
  }

  /**
   * Remove labels from a thread (e.g. UNREAD)
   */
  async removeLabel(threadId: string, labelIds: string[]): Promise<void> {
    await this.gmail.users.threads.modify({
      userId: 'me',
      id: threadId,
      requestBody: {
        removeLabelIds: labelIds
      }
    })
  }
}
