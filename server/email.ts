/**
 * Email transport for verify / reset / magic-link flows.
 *
 * Production: SMTP via nodemailer. Configure with env vars
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
 * If any of HOST/USER/PASS is missing the transport falls back to "console
 * mode" — every email gets logged to stdout with the link surfaced clearly,
 * so dev/test environments can verify flows without setting up SMTP.
 *
 * Templates are intentionally plain — text-only, single-link, no marketing.
 * Spam filters love these; users can read them; the lab brand is implied by
 * the From address and the LAB_PUBLIC_URL host in the link.
 */

import nodemailer from "nodemailer";
import { log } from "./log.ts";

const HOST = process.env.SMTP_HOST ?? "";
const PORT = Number(process.env.SMTP_PORT ?? "587");
const USER = process.env.SMTP_USER ?? "";
const PASS = process.env.SMTP_PASS ?? "";
const FROM = process.env.SMTP_FROM ?? "Cloudwise Lab <noreply@cloudwise.local>";

const SMTP_CONFIGURED = !!(HOST && USER && PASS);

let transporter: nodemailer.Transporter | null = null;
if (SMTP_CONFIGURED) {
  transporter = nodemailer.createTransport({
    host: HOST,
    port: PORT,
    secure: PORT === 465,
    auth: { user: USER, pass: PASS },
  });
  log.info("SMTP configured", { host: HOST, port: PORT });
} else {
  log.warn(
    "SMTP not configured — auth emails will log to stdout instead of being sent. Set SMTP_HOST + SMTP_USER + SMTP_PASS in .env to deliver real mail."
  );
}

export type EmailKind = "verify" | "reset" | "magic";

type SendArgs = {
  to: string;
  subject: string;
  text: string;
  /** The link the email is centered around — surfaced separately in the
   * console fallback so devs can grab it from stdout without parsing. */
  link?: string;
  kind: EmailKind;
};

export async function sendAuthEmail(args: SendArgs): Promise<void> {
  if (!transporter) {
    // Dev mode — make the link impossible to miss in the terminal.
    const banner = "═".repeat(72);
    log.info(`AUTH EMAIL (dev console)`, {
      to: args.to,
      kind: args.kind,
      subject: args.subject,
    });
    console.log(`\n${banner}`);
    console.log(`AUTH EMAIL  (dev mode — no SMTP configured)`);
    console.log(`To:      ${args.to}`);
    console.log(`Subject: ${args.subject}`);
    if (args.link) {
      console.log(`Link:    ${args.link}`);
    }
    console.log(`${banner}\n`);
    return;
  }

  try {
    await transporter.sendMail({
      from: FROM,
      to: args.to,
      subject: args.subject,
      text: args.text,
    });
    log.info("auth email sent", { to: args.to, kind: args.kind });
  } catch (err: any) {
    log.error("auth email failed", {
      to: args.to,
      kind: args.kind,
      err: err?.message ?? String(err),
    });
    throw err;
  }
}

/** Convenience builders for the three flows. */

export function verifyEmail(args: {
  to: string;
  link: string;
}): SendArgs {
  return {
    to: args.to,
    subject: "Verify your Cloudwise Lab email",
    text:
      `Welcome to Cloudwise Lab.\n\n` +
      `Click the link below to verify your email address:\n\n` +
      `${args.link}\n\n` +
      `This link expires in 1 hour. If you didn't create an account, you can ignore this message.`,
    link: args.link,
    kind: "verify",
  };
}

export function resetEmail(args: { to: string; link: string }): SendArgs {
  return {
    to: args.to,
    subject: "Reset your Cloudwise Lab password",
    text:
      `Someone requested a password reset for your Cloudwise Lab account.\n\n` +
      `Click the link below to set a new password:\n\n` +
      `${args.link}\n\n` +
      `This link expires in 1 hour. If you didn't request a reset, you can ignore this message — your password is unchanged.`,
    link: args.link,
    kind: "reset",
  };
}

export function magicEmail(args: { to: string; link: string }): SendArgs {
  return {
    to: args.to,
    subject: "Your Cloudwise Lab sign-in link",
    text:
      `Click the link below to sign in to Cloudwise Lab:\n\n` +
      `${args.link}\n\n` +
      `This link expires in 15 minutes and can only be used once. If you didn't request it, you can ignore this message.`,
    link: args.link,
    kind: "magic",
  };
}

export function isSmtpConfigured(): boolean {
  return SMTP_CONFIGURED;
}
