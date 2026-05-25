import pool from '../db';
import { sendAlertEmail } from './email';
import { calculateCAGR } from './marketData';

export async function checkAndFireAlerts(): Promise<void> {
  // Get all active alerts joined with their company's current price and target
  const alertsResult = await pool.query(`
    SELECT
      pa.id,
      pa.company_id,
      pa.alert_type,
      pa.threshold,
      pa.label,
      pa.last_notified_at,
      c.name AS company_name,
      c.ticker,
      c.current_price,
      c.target_price
    FROM price_alerts pa
    JOIN companies c ON c.id = pa.company_id
    WHERE pa.is_active = TRUE
      AND c.current_price IS NOT NULL
  `);

  for (const alert of alertsResult.rows) {
    const { current_price, target_price, alert_type, threshold } = alert;
    let triggered = false;
    let reason = '';

    if (alert_type === 'target_pct') {
      // Fire when upside to target is less than threshold%
      if (target_price && target_price > 0) {
        const upside = ((target_price - current_price) / current_price) * 100;
        if (upside < threshold) {
          triggered = true;
          reason = `${alert.company_name} (${alert.ticker ?? 'N/A'}): upside to target is ${upside.toFixed(1)}%, below alert threshold of ${threshold}%`;
        }
      }
    } else if (alert_type === 'price_above') {
      if (current_price >= threshold) {
        triggered = true;
        reason = `${alert.company_name} (${alert.ticker ?? 'N/A'}): price ${current_price} is above alert level ${threshold}`;
      }
    } else if (alert_type === 'price_below') {
      if (current_price <= threshold) {
        triggered = true;
        reason = `${alert.company_name} (${alert.ticker ?? 'N/A'}): price ${current_price} is below alert level ${threshold}`;
      }
    }

    if (triggered) {
      // Avoid spamming: check if notified in the last 24 hours
      const lastNotified = alert.last_notified_at ? new Date(alert.last_notified_at).getTime() : 0;
      const hoursSinceNotified = (Date.now() - lastNotified) / (1000 * 60 * 60);

      if (hoursSinceNotified >= 24) {
        await pool.query(
          `UPDATE price_alerts SET triggered_at = NOW(), last_notified_at = NOW() WHERE id = $1`,
          [alert.id]
        );

        const subject = `Tiza Alert: ${alert.label ?? alert.company_name}`;
        await sendAlertEmail(subject, reason);
      }
    }
  }
}

export async function generateWeeklySummary(): Promise<object> {
  // All companies
  const companiesResult = await pool.query(`
    SELECT id, name, ticker, status, conviction, current_price, entry_price, entry_date, target_price
    FROM companies
    ORDER BY name
  `);
  const companies = companiesResult.rows;

  const totalCompanies = companies.length;
  const activePositions = companies.filter((c: any) => c.status === 'active').length;

  const convictions = companies.filter((c: any) => c.conviction != null).map((c: any) => c.conviction as number);
  const avgConviction = convictions.length > 0
    ? convictions.reduce((a: number, b: number) => a + b, 0) / convictions.length
    : null;

  // Calculate CAGR for companies with entry price and entry date
  const companiesWithCagr = companies
    .filter((c: any) => c.entry_price && c.current_price && c.entry_date)
    .map((c: any) => ({
      ...c,
      cagr: calculateCAGR(
        parseFloat(c.entry_price),
        parseFloat(c.current_price),
        c.entry_date
      ),
    }))
    .sort((a: any, b: any) => b.cagr - a.cagr);

  const topPerformers = companiesWithCagr.slice(0, 5);
  const worstPerformers = [...companiesWithCagr].sort((a: any, b: any) => a.cagr - b.cagr).slice(0, 5);

  // Upcoming earnings in the next 30 days
  const earningsResult = await pool.query(`
    SELECT ec.period, ec.call_date, c.name AS company_name, c.ticker
    FROM earnings_calls ec
    JOIN companies c ON c.id = ec.company_id
    WHERE ec.call_date IS NOT NULL
      AND ec.call_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days'
    ORDER BY ec.call_date ASC
  `);
  const upcomingEarnings = earningsResult.rows;

  const weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - weekStart.getDay() + 1); // Monday
  const weekStartStr = weekStart.toISOString().slice(0, 10);

  return {
    weekStart: weekStartStr,
    generatedAt: new Date().toISOString(),
    totalCompanies,
    activePositions,
    avgConviction,
    topPerformers,
    worstPerformers,
    upcomingEarnings,
  };
}
