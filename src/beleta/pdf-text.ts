import { extractText, getDocumentProxy } from 'unpdf';
import { DomainError } from '../ai-core/index.js';

/** Text z PDF s textovou vrstvou (bez OCR). Skenované PDF bez textu se odmítne. */
export async function pdfToText(buf: Uint8Array): Promise<{ text: string; pages: number }> {
  if (buf.length < 8 || Buffer.from(buf.subarray(0, 5)).toString() !== '%PDF-') throw new DomainError('validation_error', 'Soubor není PDF');
  let r: { text: string; totalPages: number };
  try {
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    r = await extractText(pdf, { mergePages: true }) as any;
  } catch { throw new DomainError('validation_error', 'PDF se nepodařilo přečíst (poškozené nebo chráněné heslem)'); }
  const text = r.text.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (text.length < 20) throw new DomainError('no_text', 'PDF neobsahuje text (zřejmě sken) – OCR není podporováno, nahrajte textovou verzi');
  return { text, pages: r.totalPages };
}
