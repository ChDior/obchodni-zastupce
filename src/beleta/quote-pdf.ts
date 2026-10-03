import { join } from 'node:path';
import PDFDocument from 'pdfkit';
import type { Db, PolicyReader } from '../ai-core/index.js';
import { DomainError } from '../ai-core/index.js';
import { ROOT } from './bootstrap.js';

const FONT = join(ROOT, 'assets/fonts/DejaVuSans.ttf');
const BOLD = join(ROOT, 'assets/fonts/DejaVuSans-Bold.ttf');
const FINAL = new Set(['ready', 'sent', 'accepted']);

const money = (n: number, cur: string) => `${new Intl.NumberFormat('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)} ${cur === 'CZK' ? 'Kč' : cur}`;
const date = (d: unknown) => d ? new Date(d as any).toLocaleDateString('cs-CZ', { timeZone: 'UTC' }) : '–';

/** PDF nabídky z dat v DB (ceny, DPH i termíny se jen vykreslují – nic se nepočítá v PDF). Nefinální stavy dostanou značku NÁVRH. */
export async function renderQuotePdf(db: Db, policy: PolicyReader, quoteId: string): Promise<{ filename: string; buffer: Buffer }> {
  const qr = await db.query<any>(
    `select q.*, c.name as c_name, c.company_name, c.ico, c.email, c.street, c.city, c.postal_code as c_zip
     from quotes q join customers c on c.id=q.customer_id where q.id=$1`, [quoteId]);
  if (!qr.length) throw new DomainError('quote_not_found', 'Nabídka neexistuje');
  const q = qr[0];
  const items = await db.query<any>(`select sku, name, unit, qty::float8 qty, unit_price_net::float8 price, vat_rate::float8 vat, line_net::float8 line from quote_items where quote_id=$1 order by name`, [quoteId]);
  const seller = String(await policy.get('quote.pdf_seller', 'BELETA Plus s.r.o.')).split('|').map((s) => s.trim()).filter(Boolean);
  const footer = String(await policy.get('quote.pdf_footer', ''));
  const cur = q.currency as string;
  const total_net = Number(q.total_net), total_vat = Number(q.total_vat), total_gross = Number(q.total_gross);
  const shipping = Number(q.shipping_net), discount = Number(q.discount_pct);

  const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `Nabídka ${q.number}`, Author: seller[0] ?? '' } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((r) => doc.on('end', () => r()));

  doc.font(BOLD).fontSize(18).text(`Nabídka ${q.number}`);
  doc.font(FONT).fontSize(9).fillColor('#555').text(`Vystaveno: ${date(q.created_at)}   Platnost do: ${date(q.valid_until)}`);
  doc.moveDown();
  const top = doc.y;
  doc.fillColor('#000').font(BOLD).fontSize(10).text('Dodavatel', 50, top);
  doc.font(FONT).text(seller.join('\n') || '–', 50, doc.y);
  doc.font(BOLD).text('Odběratel', 320, top);
  const cust = [q.c_name, q.company_name, q.ico ? `IČO: ${q.ico}` : '', q.street, [q.c_zip, q.city].filter(Boolean).join(' '), q.email].filter(Boolean);
  doc.font(FONT).text(cust.join('\n'), 320, top + 14);
  doc.y = Math.max(doc.y, top + 80); doc.x = 50;
  doc.moveDown();

  const cols = [50, 130, 330, 375, 450, 520]; // sku, název, mn., cena/j., celkem
  const row = (y: number, v: string[], bold = false) => {
    doc.font(bold ? BOLD : FONT).fontSize(8.5);
    doc.text(v[0], cols[0], y, { width: 78 });
    doc.text(v[1], cols[1], y, { width: 195 });
    doc.text(v[2], cols[2], y, { width: 43, align: 'right' });
    doc.text(v[3], cols[3], y, { width: 70, align: 'right' });
    doc.text(v[4], cols[4], y, { width: 95, align: 'right' });
  };
  let y = doc.y;
  row(y, ['Kód', 'Položka', 'Množ.', 'Cena/j. bez DPH', 'Celkem bez DPH'], true);
  y += 14; doc.moveTo(50, y - 2).lineTo(545, y - 2).strokeColor('#999').stroke();
  for (const it of items) {
    if (y > 740) { doc.addPage(); y = 50; }
    const h = Math.max(doc.heightOfString(it.name, { width: 195 }), 12);
    row(y, [it.sku, it.name, `${it.qty} ${it.unit}`, money(it.price, cur), money(it.line, cur)]);
    y += h + 4;
  }
  doc.moveTo(50, y).lineTo(545, y).stroke();
  y += 8;
  const sum = (label: string, v: string, bold = false) => { doc.font(bold ? BOLD : FONT).fontSize(bold ? 10 : 9).text(label, 330, y, { width: 120 }).text(v, 450, y, { width: 95, align: 'right' }); y += bold ? 16 : 13; };
  if (discount > 0) sum('Sleva', `${discount} %`);
  if (shipping > 0) sum('Doprava bez DPH', money(shipping, cur));
  sum('Celkem bez DPH', money(total_net, cur));
  sum('DPH', money(total_vat, cur));
  sum('Celkem s DPH', money(total_gross, cur), true);

  doc.x = 50; doc.y = y + 10;
  doc.font(FONT).fontSize(9);
  if (q.earliest_delivery_date) doc.text(`Nejbližší možný termín dodání: ${date(q.earliest_delivery_date)}`);
  if (q.custom_terms) doc.moveDown(0.5).font(BOLD).text('Zvláštní podmínky').font(FONT).text(String(q.custom_terms));
  if (footer) doc.moveDown().fillColor('#555').fontSize(8).text(footer);

  if (!FINAL.has(q.status)) {
    doc.save().rotate(-35, { origin: [300, 420] }).font(BOLD).fontSize(90).fillColor('#cc0000').opacity(0.12)
      .text('NÁVRH', 120, 380, { lineBreak: false }).restore();
  }
  doc.end();
  await done;
  return { filename: `${String(q.number).replace(/[^A-Za-z0-9_-]/g, '_')}.pdf`, buffer: Buffer.concat(chunks) };
}
