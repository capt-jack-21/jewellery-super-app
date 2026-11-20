/** Public facade of the rates module. Other modules import only this file. */
export const MODULE = 'rates' as const;
export { RatesModule } from './internal/rates.module';
