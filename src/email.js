import nodemailer from 'nodemailer';

// Returns null when no mail server is set, so the app still runs without email.
export function createMailer(env = process.env) {
  if (!env.SMTP_HOST) return null;
  const port = Number(env.SMTP_PORT ?? 587);
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  });
  const from = env.EMAIL_FROM ?? env.SMTP_USER;
  return {
    send: ({ to, subject, text }) => transport.sendMail({ from, to, subject, text }),
  };
}
