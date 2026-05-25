import nodemailer from 'nodemailer';

function getTransporter() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

export async function sendAlertEmail(subject: string, body: string): Promise<void> {
  const to = process.env.ALERT_EMAIL;
  if (!to || !process.env.SMTP_USER) {
    console.log('Email not configured, skipping alert email:', subject);
    return;
  }

  const transporter = getTransporter();
  await transporter.sendMail({
    from: process.env.SMTP_USER,
    to,
    subject,
    text: body,
    html: `<pre style="font-family: sans-serif;">${body}</pre>`,
  });

  console.log(`Alert email sent: ${subject}`);
}

export async function sendWeeklySummaryEmail(summary: object): Promise<void> {
  const to = process.env.ALERT_EMAIL;
  if (!to || !process.env.SMTP_USER) {
    console.log('Email not configured, skipping weekly summary email');
    return;
  }

  const s = summary as any;

  const topPerformersRows = (s.topPerformers ?? [])
    .map((p: any) => `<tr><td>${p.name}</td><td>${p.ticker ?? '-'}</td><td>${p.cagr?.toFixed(2) ?? '-'}%</td></tr>`)
    .join('');

  const worstPerformersRows = (s.worstPerformers ?? [])
    .map((p: any) => `<tr><td>${p.name}</td><td>${p.ticker ?? '-'}</td><td>${p.cagr?.toFixed(2) ?? '-'}%</td></tr>`)
    .join('');

  const upcomingEarningsRows = (s.upcomingEarnings ?? [])
    .map((e: any) => `<tr><td>${e.company_name}</td><td>${e.period}</td><td>${e.call_date ?? 'TBD'}</td></tr>`)
    .join('');

  const html = `
    <h2>Tiza Weekly Portfolio Summary</h2>
    <p>Week of ${s.weekStart ?? new Date().toISOString().slice(0, 10)}</p>

    <h3>Portfolio Overview</h3>
    <ul>
      <li>Total companies tracked: ${s.totalCompanies ?? 0}</li>
      <li>Active positions: ${s.activePositions ?? 0}</li>
      <li>Average conviction: ${s.avgConviction?.toFixed(2) ?? '-'}</li>
    </ul>

    <h3>Top Performers (by CAGR)</h3>
    <table border="1" cellpadding="4" cellspacing="0">
      <thead><tr><th>Name</th><th>Ticker</th><th>CAGR</th></tr></thead>
      <tbody>${topPerformersRows || '<tr><td colspan="3">No data</td></tr>'}</tbody>
    </table>

    <h3>Worst Performers</h3>
    <table border="1" cellpadding="4" cellspacing="0">
      <thead><tr><th>Name</th><th>Ticker</th><th>CAGR</th></tr></thead>
      <tbody>${worstPerformersRows || '<tr><td colspan="3">No data</td></tr>'}</tbody>
    </table>

    <h3>Upcoming Earnings (Next 30 Days)</h3>
    <table border="1" cellpadding="4" cellspacing="0">
      <thead><tr><th>Company</th><th>Period</th><th>Date</th></tr></thead>
      <tbody>${upcomingEarningsRows || '<tr><td colspan="3">None scheduled</td></tr>'}</tbody>
    </table>
  `;

  const transporter = getTransporter();
  await transporter.sendMail({
    from: process.env.SMTP_USER,
    to,
    subject: `Tiza Weekly Summary - ${s.weekStart ?? new Date().toISOString().slice(0, 10)}`,
    html,
  });

  console.log('Weekly summary email sent');
}
