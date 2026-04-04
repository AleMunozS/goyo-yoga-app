import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import nodemailer from 'nodemailer';
import { config } from './config.js';

let transportPromise;

const templatesDir = fileURLToPath(new URL('./views/email', import.meta.url));

function getMailerSettings() {
  const configured = Boolean(config.smtpHost && config.smtpPort && config.smtpUser && config.smtpPass);
  if (!configured) {
    return null;
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

async function renderEmailTemplate(templateName, data) {
  const templatePath = path.join(templatesDir, `${templateName}.ejs`);
  return ejs.renderFile(templatePath, data);
}

function attachmentFromDataUrl(dataUrl, filename, contentId) {
  const match = String(dataUrl || '').match(/^data:(.+?);base64,(.+)$/);
  if (!match) return null;

  return {
    filename,
    content: Buffer.from(match[2], 'base64'),
    contentType: match[1],
    cid: contentId,
  };
}

async function sendMail({ to, subject, html, text, attachments = [] }) {
  const transport = await getTransport();
  if (!transport) {
    console.log(`[mail:skipped] to=${to} subject="${subject}" smtp_configured=false simulation_mode=${config.simulationMode}`);
    console.log(text);
    return { skipped: true };
  }

  try {
    return await transport.sendMail({
      from: config.smtpFrom,
      to,
      subject,
      text,
      html,
      attachments,
    });
  } catch (error) {
    console.error(`[mail:error] to=${to} subject="${subject}" message=${error.message}`);
    return {
      failed: true,
      error: error.message,
    };
  }
}

export async function sendMagicLinkEmail({ to, bookingUrl, className, classDate, trainerName, locationName, seatLabels }) {
  const subject = `Tu acceso para ${className}`;
  const html = await renderEmailTemplate('magic-link', {
    previewText: `Continúa tu reservación para ${className}.`,
    accentLabel: 'ACCESO PRIVADO',
    title: 'Tu acceso temporal ya está listo',
    intro: `Recibimos tu selección para ${className}. Usa este enlace privado para continuar tu reservación sin volver a empezar.`,
    bookingUrl,
    ctaLabel: 'Continuar reservación',
    chips: ['Enlace privado', 'Validez 30 min', 'Flujo directo'],
    details: [
      { label: 'Clase', value: className },
      { label: 'Horario', value: classDate },
      { label: 'Guía', value: trainerName },
      { label: 'Estudio', value: locationName },
      { label: 'Lugares', value: seatLabels },
    ],
    note: 'Este enlace vence en 30 minutos. Si el tiempo se agota, solo crea una nueva selección desde la agenda.',
    footerText: 'TISA Studio System',
  });
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
  const qrAttachment = qrDataUrl ? attachmentFromDataUrl(qrDataUrl, `${bookingRef}-qr.png`, `qr-${bookingRef}@tisa.local`) : null;
  const html = await renderEmailTemplate('booking-confirmation', {
    previewText: `Tu reserva ${bookingRef} ya está confirmada.`,
    accentLabel: 'PAGO CONFIRMADO',
    title: 'Tu reserva quedó confirmada',
    intro: 'Tu pago ya quedó aplicado y el QR de acceso está listo. Presenta este correo al llegar o abre el detalle completo de tu reservación.',
    bookingRef,
    bookingUrl,
    ctaLabel: 'Abrir detalle de la reservación',
    chips: ['QR activo', 'Reserva asegurada', 'Acceso listo'],
    details: [
      { label: 'Referencia', value: bookingRef },
      { label: 'Clase', value: className },
      { label: 'Horario', value: classDate },
      { label: 'Guía', value: trainerName },
      { label: 'Estudio', value: locationName },
      { label: 'Lugares', value: seatLabels },
      { label: 'Personas', value: String(quantity) },
    ],
    qrImageSrc: qrAttachment ? `cid:${qrAttachment.cid}` : null,
    qrCaption: 'Escanea este QR en recepción para validar tu acceso.',
    note: 'Si necesitas soporte, responde a este correo y menciona tu referencia.',
    footerText: 'TISA Studio System',
  });
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

  return sendMail({
    to,
    subject,
    html,
    text,
    attachments: qrAttachment ? [qrAttachment] : [],
  });
}
