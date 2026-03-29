import nodemailer from 'nodemailer';
import { config } from './config.js';
import { esc } from './utils.js';

let transportPromise;

function getMailerSettings() {
  const configured = Boolean(config.smtpHost && config.smtpPort && config.smtpUser && config.smtpPass);
  if (!configured) {
    if (config.simulationMode) return null;
    throw new Error('SMTP no está configurado. Define SMTP_HOST, SMTP_PORT, SMTP_USER y SMTP_PASS.');
  }
  return {
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpPort === 465,
    auth: {
      user: config.smtpUser,
      pass: config.smtpPass,
    },
  };
}

async function getTransport() {
  const settings = getMailerSettings();
  if (!settings) return null;
  if (!transportPromise) {
    transportPromise = Promise.resolve(nodemailer.createTransport(settings));
  }
  return transportPromise;
}

async function sendMail({ to, subject, html, text }) {
  const transport = await getTransport();
  if (!transport) {
    console.log(`[mail:simulation] to=${to} subject="${subject}"`);
    console.log(text);
    return { simulated: true };
  }

  return transport.sendMail({
    from: config.smtpFrom,
    to,
    subject,
    text,
    html,
  });
}

export async function sendMagicLinkEmail({ to, bookingUrl, className, classDate, trainerName, locationName, seatLabels }) {
  const subject = `Tu acceso para ${className}`;
  const html = `
    <div style="font-family:Arial,sans-serif;color:#2f2924;line-height:1.6">
      <h2 style="margin-bottom:8px;">Tu acceso temporal ya está listo</h2>
      <p>Recibimos tu selección para <strong>${esc(className)}</strong>.</p>
      <ul>
        <li><strong>Horario:</strong> ${esc(classDate)}</li>
        <li><strong>Guía:</strong> ${esc(trainerName)}</li>
        <li><strong>Estudio:</strong> ${esc(locationName)}</li>
        <li><strong>Lugares:</strong> ${esc(seatLabels)}</li>
      </ul>
      <p>Usa este enlace privado para continuar tu reserva:</p>
      <p><a href="${bookingUrl}">${bookingUrl}</a></p>
      <p>El enlace vence en 30 minutos.</p>
    </div>
  `;
  const text = [
    'Tu acceso temporal ya está listo.',
    `Clase: ${className}`,
    `Horario: ${classDate}`,
    `Guía: ${trainerName}`,
    `Estudio: ${locationName}`,
    `Lugares: ${seatLabels}`,
    `Enlace: ${bookingUrl}`,
    'El enlace vence en 30 minutos.',
  ].join('\n');

  return sendMail({ to, subject, html, text });
}

export async function sendBookingConfirmationEmail({
  to,
  bookingRef,
  bookingUrl,
  className,
  classDate,
  trainerName,
  locationName,
  seatLabels,
  quantity,
  qrDataUrl,
}) {
  const subject = `QR de acceso ${bookingRef}`;
  const html = `
    <div style="font-family:Arial,sans-serif;color:#2f2924;line-height:1.6">
      <h2 style="margin-bottom:8px;">Tu reserva quedó confirmada</h2>
      <p>Referencia <strong>${esc(bookingRef)}</strong>.</p>
      <ul>
        <li><strong>Clase:</strong> ${esc(className)}</li>
        <li><strong>Horario:</strong> ${esc(classDate)}</li>
        <li><strong>Guía:</strong> ${esc(trainerName)}</li>
        <li><strong>Estudio:</strong> ${esc(locationName)}</li>
        <li><strong>Lugares:</strong> ${esc(seatLabels)}</li>
        <li><strong>Personas:</strong> ${quantity}</li>
      </ul>
      <p>Puedes presentar este QR al llegar o abrir el detalle completo de tu reserva:</p>
      <p><a href="${bookingUrl}">${bookingUrl}</a></p>
      <p><img alt="QR de acceso" src="${qrDataUrl}" style="width:180px;height:180px;border-radius:12px;background:#fff;padding:8px;" /></p>
    </div>
  `;
  const text = [
    'Tu reserva quedó confirmada.',
    `Referencia: ${bookingRef}`,
    `Clase: ${className}`,
    `Horario: ${classDate}`,
    `Guía: ${trainerName}`,
    `Estudio: ${locationName}`,
    `Lugares: ${seatLabels}`,
    `Personas: ${quantity}`,
    `Detalle: ${bookingUrl}`,
  ].join('\n');

  return sendMail({ to, subject, html, text });
}
