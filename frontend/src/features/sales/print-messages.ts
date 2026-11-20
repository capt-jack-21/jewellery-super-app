import en from './print.en-IN.v1.json';
import ta from './print.ta-IN.v1.json';
import { PRINT_LABELS } from '@/lib/print/labels';
import type { PrintLang } from '@/lib/print/locales';

// These print-only catalogues do not change the UI locale. hi/te/kn/ml require native-speaker acceptance.
const KEYS = [
  'sales.creditNote.kind.receipt_reversal', 'sales.print.original', 'sales.print.duplicate', 'sales.print.stamp.CANCELLED',
  'sales.print.stamp.DUPLICATE', 'sales.print.stamp.ESTIMATE', 'sales.print.footer', 'sales.print.pan', 'sales.print.placeOfSupply',
  'sales.print.sellerState', 'sales.print.originalInvoice', 'sales.print.missingSnapshot', 'sales.print.nonGst',
  'sales.gst.breakup', 'sales.gst.rate', 'sales.line.rate', 'sales.line.making', 'sales.totals.taxable', 'sales.totals.discount',
  'sales.loose.pieces', 'sales.totals.roundOff', 'sales.totals.billTotal', 'sales.totals.oldGold', 'sales.totals.payable', 'sales.totals.paid', 'sales.totals.balanceDue',
] as const;
const EXTRA: Record<Exclude<PrintLang, 'en' | 'ta'>, string[]> = {
  hi: ['भुगतान वापस', 'प्राप्तकर्ता के लिए मूल', 'प्रतिलिपि', 'रद्द', 'प्रतिलिपि', 'अनुमान — बिल नहीं', 'प्रिंट {no} · {at}', 'PAN ••••{last4}', 'आपूर्ति स्थान: {code}', 'राज्य: {state} · कोड {code}', 'मूल बीजक: {no} · {date}', 'मूल बीजक के विक्रेता या GST विवरण उपलब्ध नहीं हैं या मेल नहीं खाते।', 'भुगतान वापसी पर लौटाया स्टोर क्रेडिट। बिक्री वापसी या GST क्रेडिट नोट नहीं।', 'GST विवरण', 'दर', 'दर', 'बनवाई', 'कर योग्य मूल्य', 'छूट', 'संख्या', 'पूर्णांकन', 'बिल का कुल', 'पुराना सोना', 'देय राशि', 'भुगतान', 'बकाया'],
  te: ['చెల్లింపు వెనక్కి', 'గ్రహీత కోసం అసలు', 'నకలు', 'రద్దు', 'నకలు', 'అంచనా — బిల్లు కాదు', 'ముద్రణ {no} · {at}', 'PAN ••••{last4}', 'సరఫరా స్థలం: {code}', 'రాష్ట్రం: {state} · కోడ్ {code}', 'అసలు ఇన్వాయిస్: {no} · {date}', 'అసలు బిల్లు విక్రేత లేదా GST వివరాలు లేవు లేదా సరిపోలడం లేదు.', 'చెల్లింపు వెనక్కి తీసుకున్నందుకు తిరిగిచ్చిన స్టోర్ క్రెడిట్. అమ్మకాల వాపసు లేదా GST క్రెడిట్ నోట్ కాదు.', 'GST వివరాలు', 'రేటు', 'రేటు', 'తయారీ', 'పన్ను విలువ', 'తగ్గింపు', 'నగలు', 'రౌండ్ ఆఫ్', 'బిల్లు మొత్తం', 'పాత బంగారం', 'చెల్లించవలసిన మొత్తం', 'చెల్లించినది', 'బకాయి'],
  kn: ['ಪಾವತಿ ಹಿಂತಿರುಗಿದೆ', 'ಸ್ವೀಕರಿಸುವವರಿಗೆ ಮೂಲ', 'ನಕಲು', 'ರದ್ದು', 'ನಕಲು', 'ಅಂದಾಜು — ಬಿಲ್ ಅಲ್ಲ', 'ಮುದ್ರಣ {no} · {at}', 'PAN ••••{last4}', 'ಪೂರೈಕೆ ಸ್ಥಳ: {code}', 'ರಾಜ್ಯ: {state} · ಕೋಡ್ {code}', 'ಮೂಲ ಸರಕುಪಟ್ಟಿ: {no} · {date}', 'ಮೂಲ ಬಿಲ್ ಮಾರಾಟಗಾರ ಅಥವಾ GST ವಿವರಗಳು ಇಲ್ಲ ಅಥವಾ ಹೊಂದಿಕೆಯಾಗುತ್ತಿಲ್ಲ.', 'ಪಾವತಿ ಹಿಂತಿರುಗಿದಾಗ ಮರಳಿಸಿದ ಸ್ಟೋರ್ ಕ್ರೆಡಿಟ್. ಮಾರಾಟ ವಾಪಸ್ ಅಥವಾ GST ಕ್ರೆಡಿಟ್ ನೋಟ್ ಅಲ್ಲ.', 'GST ವಿವರ', 'ದರ', 'ದರ', 'ತಯಾರಿಕೆ', 'ತೆರಿಗೆ ಮೌಲ್ಯ', 'ರಿಯಾಯಿತಿ', 'ಎಣಿಕೆ', 'ಪೂರ್ಣಾಂಕ', 'ಬಿಲ್ ಒಟ್ಟು', 'ಹಳೆಯ ಚಿನ್ನ', 'ಪಾವತಿಸಬೇಕಾದ ಮೊತ್ತ', 'ಪಾವತಿಸಿದ್ದು', 'ಬಾಕಿ'],
  ml: ['പണം തിരികെ നൽകി', 'സ്വീകർത്താവിനുള്ള അസൽ', 'പകർപ്പ്', 'റദ്ദാക്കി', 'പകർപ്പ്', 'എസ്റ്റിമേറ്റ് — ബിൽ അല്ല', 'പ്രിന്റ് {no} · {at}', 'PAN ••••{last4}', 'വിതരണ സ്ഥലം: {code}', 'സംസ്ഥാനം: {state} · കോഡ് {code}', 'അസൽ ഇൻവോയ്സ്: {no} · {date}', 'അസൽ ബില്ലിലെ വിൽപ്പനക്കാരന്റെയോ GSTയുടെയോ വിവരങ്ങൾ ലഭ്യമല്ല അല്ലെങ്കിൽ പൊരുത്തപ്പെടുന്നില്ല.', 'പണം തിരികെ നൽകിയപ്പോൾ മടക്കിനൽകിയ സ്റ്റോർ ക്രെഡിറ്റ്. വിൽപ്പന മടക്കമോ GST ക്രെഡിറ്റ് നോട്ടോ അല്ല.', 'GST വിശദാംശം', 'നിരക്ക്', 'നിരക്ക്', 'പണിക്കൂലി', 'നികുതി മൂല്യം', 'കിഴിവ്', 'എണ്ണം', 'റൗണ്ട് ഓഫ്', 'ബിൽ ആകെ', 'പഴയ സ്വർണം', 'അടയ്ക്കേണ്ട തുക', 'അടച്ചത്', 'ബാക്കി'],
};
export function salesPrintMessages(lang: PrintLang): Record<string, string> {
  if (lang === 'en') return en;
  if (lang === 'ta') return ta;
  const labels = PRINT_LABELS[lang];
  return { ...en, ...Object.fromEntries(KEYS.map((k, i) => [k, EXTRA[lang][i]])),
    'sales.print.taxInvoice': labels.tax_invoice, 'sales.print.creditNote': labels.credit_note, 'sales.print.estimate': labels.estimate,
    'sales.print.creditTotal': labels.total, 'sales.print.item': labels.item, 'sales.line.netWt': labels.weight,
    'sales.line.huid': labels.huid, 'sales.print.gstin': labels.gstin,
  };
}
