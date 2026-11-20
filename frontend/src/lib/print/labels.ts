import type { PrintLang } from './locales';

/**
 * Document labels for PRINTS, per print language (independent of the UI language, which is en/ta only).
 * hi/te/kn/ml strings need native review alongside amount-in-words.
 */
export type PrintLabel = 'tax_invoice' | 'estimate' | 'receipt' | 'credit_note' | 'notTaxInvoice' | 'item' | 'weight' | 'amount' | 'total'
  | 'amountInWords' | 'gstin' | 'docNo' | 'huid' | 'phone' | 'date';

export const PRINT_LABELS: Record<PrintLang, Record<PrintLabel, string>> = {
  en: { tax_invoice: 'Tax invoice', estimate: 'Estimate', receipt: 'Receipt', credit_note: 'Credit note', notTaxInvoice: 'This is an estimate, not a tax invoice.',
    item: 'Item', weight: 'Weight', amount: 'Amount', total: 'Total', amountInWords: 'Amount in words', gstin: 'GSTIN', docNo: 'No.', huid: 'HUID', phone: 'Phone', date: 'Date' },
  ta: { tax_invoice: 'வரி விலைப்பட்டியல்', estimate: 'மதிப்பீடு', receipt: 'ரசீது', credit_note: 'கடன் குறிப்பு', notTaxInvoice: 'இது மதிப்பீடு, வரி விலைப்பட்டியல் அல்ல.',
    item: 'பொருள்', weight: 'எடை', amount: 'தொகை', total: 'மொத்தம்', amountInWords: 'தொகை எழுத்தில்', gstin: 'GSTIN', docNo: 'எண்', huid: 'HUID', phone: 'தொலைபேசி', date: 'தேதி' },
  hi: { tax_invoice: 'कर बीजक', estimate: 'अनुमान', receipt: 'रसीद', credit_note: 'क्रेडिट नोट', notTaxInvoice: 'यह अनुमान है, कर बीजक नहीं।',
    item: 'वस्तु', weight: 'वज़न', amount: 'राशि', total: 'कुल', amountInWords: 'राशि शब्दों में', gstin: 'GSTIN', docNo: 'क्रमांक', huid: 'HUID', phone: 'फ़ोन', date: 'दिनांक' },
  te: { tax_invoice: 'పన్ను ఇన్వాయిస్', estimate: 'అంచనా', receipt: 'రసీదు', credit_note: 'క్రెడిట్ నోట్', notTaxInvoice: 'ఇది అంచనా మాత్రమే, పన్ను ఇన్వాయిస్ కాదు.',
    item: 'వస్తువు', weight: 'బరువు', amount: 'మొత్తం', total: 'మొత్తం', amountInWords: 'మొత్తం అక్షరాలలో', gstin: 'GSTIN', docNo: 'సంఖ్య', huid: 'HUID', phone: 'ఫోన్', date: 'తేదీ' },
  kn: { tax_invoice: 'ತೆರಿಗೆ ಸರಕುಪಟ್ಟಿ', estimate: 'ಅಂದಾಜು', receipt: 'ರಸೀದಿ', credit_note: 'ಕ್ರೆಡಿಟ್ ನೋಟ್', notTaxInvoice: 'ಇದು ಅಂದಾಜು, ತೆರಿಗೆ ಸರಕುಪಟ್ಟಿ ಅಲ್ಲ.',
    item: 'ವಸ್ತು', weight: 'ತೂಕ', amount: 'ಮೊತ್ತ', total: 'ಒಟ್ಟು', amountInWords: 'ಮೊತ್ತ ಅಕ್ಷರಗಳಲ್ಲಿ', gstin: 'GSTIN', docNo: 'ಸಂಖ್ಯೆ', huid: 'HUID', phone: 'ದೂರವಾಣಿ', date: 'ದಿನಾಂಕ' },
  ml: { tax_invoice: 'നികുതി ഇൻവോയ്സ്', estimate: 'എസ്റ്റിമേറ്റ്', receipt: 'രസീത്', credit_note: 'ക്രെഡിറ്റ് നോട്ട്', notTaxInvoice: 'ഇത് എസ്റ്റിമേറ്റ് ആണ്, നികുതി ഇൻവോയ്സ് അല്ല.',
    item: 'ഇനം', weight: 'തൂക്കം', amount: 'തുക', total: 'ആകെ', amountInWords: 'തുക അക്ഷരത്തിൽ', gstin: 'GSTIN', docNo: 'നമ്പർ', huid: 'HUID', phone: 'ഫോൺ', date: 'തീയതി' },
};

export const SAMPLE_ITEMS: Array<{ name: Record<PrintLang, string>; huid: string; wt: string; amt: string }> = [
  { name: { en: 'Necklace 22K 916', ta: 'நெக்லஸ் 22K 916', hi: 'हार 22K 916', te: 'నెక్లెస్ 22K 916', kn: 'ನೆಕ್ಲೆಸ್ 22K 916', ml: 'നെക്ലേസ് 22K 916' }, huid: 'AB12CD', wt: '23.500', amt: '312450.00' },
  { name: { en: 'Anklet 925', ta: 'கொலுசு 925', hi: 'पायल 925', te: 'పట్టీలు 925', kn: 'ಕಾಲ್ಗೆಜ್ಜೆ 925', ml: 'പാദസരം 925' }, huid: 'ZX98YW', wt: '62.100', amt: '11046.50' },
];
