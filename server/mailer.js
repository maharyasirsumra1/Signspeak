import nodemailer from 'nodemailer';

let transport;

function getTransport() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD } = process.env;
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASSWORD) return null;

  if (!transport) {
    transport = nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT),
      secure: Number(SMTP_PORT) === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASSWORD },
      requireTLS: Number(SMTP_PORT) !== 465
    });
  }
  return transport;
}

export async function sendVerificationEmail({ email, displayName, verificationUrl }) {
  const mailTransport = getTransport();
  if (!mailTransport) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Email verification is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, and SMTP_PASSWORD.');
    }
    return { developmentUrl: verificationUrl };
  }

  await mailTransport.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: email,
    subject: 'Verify your SignSpeak account',
    text: `Hello ${displayName}, verify your SignSpeak account: ${verificationUrl}`,
    html: `<p>Hello ${escapeHtml(displayName)},</p><p><a href="${escapeHtml(verificationUrl)}">Verify your SignSpeak account</a></p><p>This link expires in 30 minutes.</p>`
  });

  return {};
}

export async function sendPasswordResetEmail({ email, displayName, resetUrl }) {
  const mailTransport = getTransport();
  if (!mailTransport) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Password reset email is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, and SMTP_PASSWORD.');
    }
    return { developmentUrl: resetUrl };
  }

  await mailTransport.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: email,
    subject: 'Reset your SignSpeak password',
    text: `Hello ${displayName}, reset your SignSpeak password: ${resetUrl}`,
    html: `<p>Hello ${escapeHtml(displayName)},</p><p><a href="${escapeHtml(resetUrl)}">Reset your SignSpeak password</a></p><p>This link expires in 30 minutes and can only be used once.</p>`
  });

  return {};
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}
