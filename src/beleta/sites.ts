/** Profily webů, které AI poradce obsluhuje. Přepíná se politikou `site.profile` (administrace → Pravidla AI). */
export interface SiteProfile { id: string; brand: string; domain: string; origins: string[]; greeting: string }

export const SITES: Record<string, SiteProfile> = {
  cihlovestavby: {
    id: 'cihlovestavby', brand: 'CIHLOVESTAVBY.CZ', domain: 'www.cihlovestavby.cz',
    origins: ['https://www.cihlovestavby.cz', 'https://cihlovestavby.cz'],
    greeting: 'Dobrý den, jsem AI poradce CIHLOVESTAVBY.CZ. S čím vám mohu pomoci?',
  },
  beleta: {
    id: 'beleta', brand: 'BELETA Plus', domain: 'www.beleta.cz',
    origins: ['https://www.beleta.cz', 'https://beleta.cz'],
    greeting: 'Dobrý den, jsem AI poradce BELETA Plus. S čím vám mohu pomoci?',
  },
};
export const DEFAULT_SITE = 'cihlovestavby';

export const siteById = (id: unknown): SiteProfile => SITES[String(id)] ?? SITES[DEFAULT_SITE];

/** Kontext pro AI poradce: na jakém webu běží (bez obchodních dat). */
export const siteContext = (s: SiteProfile) =>
  `\n\n## Kontext nasazení\nKomunikujete s návštěvníky webu ${s.brand} (${s.domain}), který provozuje firma BELETA Plus s.r.o. Představujte se jako AI poradce ${s.brand}.`;
