// Email sending is optional. This implementation uses Resend (https://resend.com/).
// If RESEND_API_KEY is not set, sending is skipped.

export async function sendThankYouEmail({ to, amountGrosze, currency, publicRef, p24OrderId, paidAtIso }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;

  if (!apiKey || !from) {
    return { skipped: true, reason: 'Missing RESEND_API_KEY or EMAIL_FROM' };
  }

  const amountPln = (Number(amountGrosze) / 100).toFixed(2);
  const subject = process.env.EMAIL_SUBJECT || 'Dziękujemy za wsparcie!';

  const orgName = process.env.ORG_NAME || 'Fundacja';
  const supportUrl = process.env.SUPPORT_URL || '';

  const lines = [
    `Dziękujemy za wsparcie ${orgName}.`,
    '',
    `Kwota: ${amountPln} ${currency}`,
    `Data potwierdzenia: ${paidAtIso}`,
    `Numer wpłaty: ${publicRef}`,
    p24OrderId ? `Id transakcji Przelewy24: ${p24OrderId}` : null,
    '',
    supportUrl ? `Kontakt: ${supportUrl}` : null,
    '',
    'Pozdrawiamy,',
    orgName,
  ].filter(Boolean);

  const payload = {
    from,
    to,
    subject,
    text: lines.join('\n'),
  };

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const json = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    const msg = json?.message || 'Email send failed';
    const err = new Error(msg);
    err.email_response = json;
    throw err;
  }

  return { ok: true, id: json?.id };
}
