import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { checkContrast, resolveTokens, sampleBrands, type TokenOverride } from '@/design-tokens';
import { useT } from '@/i18n';
import { useBrand } from '@/lib/brand/context';

type Choice = 'platform' | keyof typeof sampleBrands;

export function TokensPage() {
  const t = useT();
  const { brand, setBrand } = useBrand();
  const [choice, setChoice] = useState<Choice>('platform');
  const issues = checkContrast(brand.tokens);
  const apply = (c: Choice) => {
    setChoice(c);
    const override: TokenOverride | null = c === 'platform' ? null : sampleBrands[c];
    setBrand({ ...brand, tokens: resolveTokens(override) });
  };
  const swatches = ['bg-primary', 'bg-accent', 'bg-success', 'bg-warning', 'bg-destructive', 'bg-info', 'bg-metal-gold', 'bg-metal-silver', 'bg-muted', 'bg-card'];
  return (
    <Card>
      <CardHeader><CardTitle>{t('tokens.title')}</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2" role="group" aria-label={t('tokens.sampleBrand')}>
          {(['platform', 'light', 'darkPrimary', 'highContrast'] as Choice[]).map((c) => (
            <Button key={c} variant={choice === c ? 'default' : 'outline'} size="sm" onClick={() => apply(c)}>
              {c === 'platform' ? t('tokens.platform') : c}
            </Button>
          ))}
        </div>
        <div className="grid grid-cols-5 gap-2">
          {swatches.map((s) => <div key={s} className={`${s} h-12 rounded-md border border-border`} title={s} />)}
        </div>
        {issues.length === 0
          ? <Badge variant="success">{t('tokens.contrastOk')}</Badge>
          : <Badge variant="destructive">{t('tokens.contrastIssues', { count: issues.length })}</Badge>}
      </CardContent>
    </Card>
  );
}
