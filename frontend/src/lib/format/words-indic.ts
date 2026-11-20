/**
 * Amount-in-words for Hindi, Telugu, Kannada and Malayalam (Indian system: hundred, thousand, lakh, crore).
 * NEEDS NATIVE REVIEW before use on real invoices: Hindi 1–99 are the standard forms; te/kn/ml use
 * simplified, compositional joins (e.g. tens + ones as separate words) that a native reviewer should check.
 */
const HI_99 = ('शून्य एक दो तीन चार पाँच छह सात आठ नौ दस ग्यारह बारह तेरह चौदह पंद्रह सोलह सत्रह अठारह उन्नीस ' +
  'बीस इक्कीस बाईस तेईस चौबीस पच्चीस छब्बीस सत्ताईस अट्ठाईस उनतीस तीस इकतीस बत्तीस तैंतीस चौंतीस पैंतीस छत्तीस सैंतीस अड़तीस उनतालीस ' +
  'चालीस इकतालीस बयालीस तैंतालीस चवालीस पैंतालीस छियालीस सैंतालीस अड़तालीस उनचास पचास इक्यावन बावन तिरेपन चौवन पचपन छप्पन सत्तावन अट्ठावन उनसठ ' +
  'साठ इकसठ बासठ तिरेसठ चौंसठ पैंसठ छियासठ सड़सठ अड़सठ उनहत्तर सत्तर इकहत्तर बहत्तर तिहत्तर चौहत्तर पचहत्तर छिहत्तर सतहत्तर अठहत्तर उन्यासी ' +
  'अस्सी इक्यासी बयासी तिरासी चौरासी पचासी छियासी सत्तासी अट्ठासी नवासी नब्बे इक्यानबे बानबे तिरानबे चौरानबे पंचानबे छियानबे सत्तानबे अट्ठानबे निन्यानबे').split(' ');

interface Lang {
  zero: string;
  w99: (n: number) => string;
  hundred: (h: number, more: boolean) => string;
  scale: (mult: string, n: number, unit: 'thousand' | 'lakh' | 'crore', more: boolean) => string;
  rupees: string; paise: string; and: string; only: string;
}

function compose(ones: string[], teens: string[], tens: string[]) {
  return (n: number) => n < 10 ? ones[n] ?? '' : n < 20 ? teens[n - 10] ?? '' : [tens[Math.floor(n / 10)], n % 10 ? ones[n % 10] : ''].filter(Boolean).join(' ');
}

const hi: Lang = {
  zero: 'शून्य', w99: (n) => HI_99[n] ?? '',
  hundred: (h) => `${HI_99[h]} सौ`,
  scale: (m, _n, u) => `${m} ${{ thousand: 'हज़ार', lakh: 'लाख', crore: 'करोड़' }[u]}`,
  rupees: 'रुपये', paise: 'पैसे', and: 'और', only: 'मात्र',
};

const TE_ONES = ['', 'ఒకటి', 'రెండు', 'మూడు', 'నాలుగు', 'ఐదు', 'ఆరు', 'ఏడు', 'ఎనిమిది', 'తొమ్మిది'];
const TE_MULT = ['', 'ఒక', 'రెండు', 'మూడు', 'నాలుగు', 'ఐదు', 'ఆరు', 'ఏడు', 'ఎనిమిది', 'తొమ్మిది'];
const te: Lang = {
  zero: 'సున్నా',
  w99: compose(TE_ONES, ['పది', 'పదకొండు', 'పన్నెండు', 'పదమూడు', 'పద్నాలుగు', 'పదిహేను', 'పదహారు', 'పదిహేడు', 'పద్దెనిమిది', 'పందొమ్మిది'],
    ['', '', 'ఇరవై', 'ముప్పై', 'నలభై', 'యాభై', 'అరవై', 'డెబ్బై', 'ఎనభై', 'తొంభై']),
  hundred: (h, more) => h === 1 ? (more ? 'నూట' : 'వంద') : `${TE_MULT[h]} ${more ? 'వందల' : 'వందలు'}`,
  scale: (m, n, u, more) => {
    const [one, many, comb] = ({ thousand: ['వెయ్యి', 'వేలు', 'వేల'], lakh: ['ఒక లక్ష', 'లక్షలు', 'లక్షల'], crore: ['ఒక కోటి', 'కోట్లు', 'కోట్ల'] } as const)[u];
    return n === 1 ? one : `${m} ${more ? comb : many}`;
  },
  rupees: 'రూపాయలు', paise: 'పైసలు', and: 'మరియు', only: 'మాత్రమే',
};

const KN_ONES = ['', 'ಒಂದು', 'ಎರಡು', 'ಮೂರು', 'ನಾಲ್ಕು', 'ಐದು', 'ಆರು', 'ಏಳು', 'ಎಂಟು', 'ಒಂಬತ್ತು'];
const kn: Lang = {
  zero: 'ಸೊನ್ನೆ',
  w99: compose(KN_ONES, ['ಹತ್ತು', 'ಹನ್ನೊಂದು', 'ಹನ್ನೆರಡು', 'ಹದಿಮೂರು', 'ಹದಿನಾಲ್ಕು', 'ಹದಿನೈದು', 'ಹದಿನಾರು', 'ಹದಿನೇಳು', 'ಹದಿನೆಂಟು', 'ಹತ್ತೊಂಬತ್ತು'],
    ['', '', 'ಇಪ್ಪತ್ತು', 'ಮೂವತ್ತು', 'ನಲವತ್ತು', 'ಐವತ್ತು', 'ಅರವತ್ತು', 'ಎಪ್ಪತ್ತು', 'ಎಂಬತ್ತು', 'ತೊಂಬತ್ತು']),
  hundred: (h) => h === 1 ? 'ನೂರು' : `${KN_ONES[h]} ನೂರು`,
  scale: (m, n, u) => { const w = { thousand: 'ಸಾವಿರ', lakh: 'ಲಕ್ಷ', crore: 'ಕೋಟಿ' }[u]; return n === 1 ? (u === 'thousand' ? w : `ಒಂದು ${w}`) : `${m} ${w}`; },
  rupees: 'ರೂಪಾಯಿ', paise: 'ಪೈಸೆ', and: 'ಮತ್ತು', only: 'ಮಾತ್ರ',
};

const ML_ONES = ['', 'ഒന്ന്', 'രണ്ട്', 'മൂന്ന്', 'നാല്', 'അഞ്ച്', 'ആറ്', 'ഏഴ്', 'എട്ട്', 'ഒമ്പത്'];
const ml: Lang = {
  zero: 'പൂജ്യം',
  w99: compose(ML_ONES, ['പത്ത്', 'പതിനൊന്ന്', 'പന്ത്രണ്ട്', 'പതിമൂന്ന്', 'പതിനാല്', 'പതിനഞ്ച്', 'പതിനാറ്', 'പതിനേഴ്', 'പതിനെട്ട്', 'പത്തൊമ്പത്'],
    ['', '', 'ഇരുപത്', 'മുപ്പത്', 'നാൽപത്', 'അമ്പത്', 'അറുപത്', 'എഴുപത്', 'എൺപത്', 'തൊണ്ണൂറ്']),
  hundred: (h) => h === 1 ? 'നൂറ്' : `${ML_ONES[h]} നൂറ്`,
  scale: (m, n, u) => { const w = { thousand: 'ആയിരം', lakh: 'ലക്ഷം', crore: 'കോടി' }[u]; return n === 1 ? (u === 'thousand' ? w : `ഒരു ${w}`) : `${m} ${w}`; },
  rupees: 'രൂപ', paise: 'പൈസ', and: 'ഉം', only: 'മാത്രം',
};

export const INDIC_WORDS = { hi, te, kn, ml } as const;
export type IndicWordsLocale = keyof typeof INDIC_WORDS;

function w999(L: Lang, n: number): string {
  const h = Math.floor(n / 100), r = n % 100;
  return [h ? L.hundred(h, r > 0) : '', r ? L.w99(r) : ''].filter(Boolean).join(' ');
}

export function integerToWordsIndic(n: bigint, locale: IndicWordsLocale): string {
  const L = INDIC_WORDS[locale];
  if (n === 0n) return L.zero;
  const crore = n / 10000000n, rest = Number(n % 10000000n);
  const lakh = Math.floor(rest / 100000), thousand = Math.floor((rest % 100000) / 1000), below = rest % 1000;
  return [
    crore ? L.scale(integerToWordsIndic(crore, locale), crore === 1n ? 1 : 2, 'crore', rest > 0) : '',
    lakh ? L.scale(L.w99(lakh), lakh, 'lakh', thousand + below > 0) : '',
    thousand ? L.scale(L.w99(thousand), thousand, 'thousand', below > 0) : '',
    below ? w999(L, below) : '',
  ].filter(Boolean).join(' ');
}

export function amountInWordsIndic(rupees: bigint, paise: number, locale: IndicWordsLocale): string {
  const L = INDIC_WORDS[locale];
  const r = `${integerToWordsIndic(rupees, locale)} ${L.rupees}`;
  return paise ? `${r} ${L.and} ${integerToWordsIndic(BigInt(paise), locale)} ${L.paise} ${L.only}` : `${r} ${L.only}`;
}
