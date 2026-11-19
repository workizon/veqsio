import { describe, test, expect } from 'bun:test'
import { parseRawMessage, htmlToText } from './mime'
import { cleanBody, detectLoop, stripQuotedReply } from './inbound-email'

const CRLF = (s: string) => s.replace(/\n/g, '\r\n')

const plain = CRLF(`From: Jane Doe <Jane@Example.com>
To: help@desk.io
Subject: Re: [IT-12] Printer broken
Message-ID: <abc123@example.com>
In-Reply-To: <req.IT-12.deadbeef@desk.io>
References: <req.IT-12.root@desk.io> <req.IT-12.deadbeef@desk.io>
Content-Type: text/plain; charset=utf-8
Content-Transfer-Encoding: quoted-printable

It works again, thanks =E2=80=93 great job!

On Mon, 3 Jun 2024 at 10:00, Support <help@desk.io> wrote:
> Did you try turning it off and on again?
> --
> Support team
`)

describe('parseRawMessage', () => {
  test('decodes headers, threading ids and the plain body', async () => {
    const m = await parseRawMessage(plain)
    expect(m.messageId).toBe('<abc123@example.com>')
    expect(m.from).toBe('Jane Doe <Jane@Example.com>')
    expect(m.subject).toBe('Re: [IT-12] Printer broken')
    expect(m.inReplyTo).toEqual(['<req.IT-12.deadbeef@desk.io>'])
    expect(m.references).toEqual(['<req.IT-12.root@desk.io>', '<req.IT-12.deadbeef@desk.io>'])
    expect(m.text).toContain('It works again, thanks – great job!')
    expect(cleanBody(m.text)).toBe('It works again, thanks – great job!')
  })

  test('collects attachments, drops inline related images, flattens loop headers', async () => {
    const raw = CRLF(`From: bot@x.io
To: help@desk.io
Subject: Delivery Status Notification (Failure)
Message-ID: <b1@x.io>
Auto-Submitted: auto-replied
Content-Type: multipart/mixed; boundary="BND"

--BND
Content-Type: text/plain

see file
--BND
Content-Type: text/plain; name="log.txt"
Content-Disposition: attachment; filename="log.txt"
Content-Transfer-Encoding: base64

aGVsbG8gd29ybGQ=
--BND--
`)
    const m = await parseRawMessage(raw)
    expect(m.attachments).toHaveLength(1)
    expect(m.attachments[0].filename).toBe('log.txt')
    expect(Buffer.from(m.attachments[0].content).toString()).toBe('hello world')
    expect(m.headers['auto-submitted']).toBe('auto-replied')
    expect(detectLoop({ headers: m.headers, subject: m.subject, from: 'bot@x.io' })).toBe('auto-submitted')
  })

  test('html-only mail becomes text with quotes marked', async () => {
    const raw = CRLF(`From: a@b.io
Subject: Hi
Content-Type: text/html; charset=utf-8

<html><body><p>Hello&nbsp;there &amp; thanks</p><div>Line two</div><blockquote><p>old quoted text</p></blockquote><script>alert(1)</script></body></html>
`)
    const m = await parseRawMessage(raw)
    expect(m.text).toContain('Hello there & thanks')
    expect(m.text).not.toContain('alert')
    expect(m.text).toContain('> old quoted text')
    expect(cleanBody(m.text)).toBe('Hello there & thanks\nLine two')
    // generated id when the mail has none
    expect(m.messageId).toMatch(/^<[0-9a-f]{32}@no-message-id\.veqsio>$/)
  })

  test('garbage input does not throw', async () => {
    const m = await parseRawMessage('\u0000\u0001 not a mail')
    expect(typeof m.messageId).toBe('string')
  })
})

describe('htmlToText', () => {
  test('nested blockquotes and entities', () => {
    expect(htmlToText('a<br>b &#65;&#x42; &lt;x&gt;')).toBe('a\nb AB <x>')
    expect(htmlToText('<blockquote>one<blockquote>two</blockquote></blockquote>')).toContain('> > two')
  })
})

describe('stripQuotedReply (more clients)', () => {
  test('Outlook header block', () => {
    const t = 'Thanks, fixed.\n\nFrom: Support <help@desk.io>\nSent: Monday, June 3, 2024 10:00 AM\nTo: Jane\nSubject: Re: x\n\nold text'
    expect(stripQuotedReply(t)).toBe('Thanks, fixed.')
    expect(stripQuotedReply('Danke!\n\nVon: Support\nGesendet: Montag\nAn: Jane\n\nalt')).toBe('Danke!')
  })
  test('does not cut a harmless "From:" line', () => {
    expect(stripQuotedReply('Data comes\nFrom: the sensor\nand it is fine')).toBe('Data comes\nFrom: the sensor\nand it is fine')
  })
  test('signature, "wrote:" and quoted lines', () => {
    expect(stripQuotedReply('Hi\n\n-- \nJane\nCEO')).toBe('Hi')
    expect(stripQuotedReply('Yes\n> no\n\nAm 3. Juni schrieb Support <h@d.io>:\n> alt')).toBe('Yes')
  })
})

describe('detectLoop', () => {
  const base = { subject: 'Hello', from: 'jane@x.io' }
  test('ordinary mail passes', () => {
    expect(detectLoop({ ...base, headers: { 'content-type': 'text/plain' } })).toBeNull()
  })
  test('auto-replies and bulk mail', () => {
    expect(detectLoop({ ...base, headers: { 'auto-submitted': 'auto-replied' } })).toBe('auto-submitted')
    expect(detectLoop({ ...base, headers: { 'auto-submitted': 'no' } })).toBeNull()
    expect(detectLoop({ ...base, headers: { precedence: 'bulk' } })).toBe('precedence')
    expect(detectLoop({ ...base, headers: { 'x-auto-response-suppress': 'All' } })).toBe('x-autoreply')
    expect(detectLoop({ ...base, subject: 'Automatic reply: out' })).toBe('subject')
  })
  test('bounces and delivery reports', () => {
    expect(detectLoop({ ...base, headers: { 'content-type': 'multipart/report; report-type=delivery-status' } })).toBe('bounce')
    expect(detectLoop({ ...base, headers: { 'return-path': '<>' } })).toBe('bounce')
    expect(detectLoop({ ...base, from: 'MAILER-DAEMON@mx.x.io' })).toBe('bounce')
    expect(detectLoop({ ...base, subject: 'Undelivered Mail Returned to Sender' })).toBe('bounce')
    expect(detectLoop({ ...base, subject: 'Mail delivery failed: returning message' })).toBe('bounce')
  })
  test('mailing lists, own addresses and own message ids', () => {
    expect(detectLoop({ ...base, headers: { 'list-id': '<l.x.io>' } })).toBe('mailing-list')
    expect(detectLoop({ ...base, from: 'help@desk.io', ownAddresses: ['Desk <HELP@desk.io>', null] })).toBe('self')
    expect(detectLoop({ ...base, ownAddresses: ['help@desk.io'] })).toBeNull()
    expect(detectLoop({ ...base, messageId: '<req.IT-1.abc@desk.io>' })).toBe('own-message')
    expect(detectLoop({ ...base, messageId: '<other@desk.io>' })).toBeNull()
  })
})
