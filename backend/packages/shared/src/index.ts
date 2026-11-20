import { registerAmountInWords } from './amount-in-words/registry';
import { taIN } from './amount-in-words/ta-IN';
import { enIN } from './amount-in-words/en-IN';
export * from './amount-in-words/registry';
registerAmountInWords(enIN);
registerAmountInWords(taIN);
export * from './format/fields';
export * from './secretbox';
