import * as React from 'react';

type TooltipComponent = typeof import('./AnchoredTooltip').default;

type DeferredAnchoredTooltipProps = React.ComponentProps<TooltipComponent> & Readonly<{
    /** Existing trigger interaction state; a later hover/focus retries a failed fetch. */
    activationKey: string;
}>;

/** Optional tooltip loading stays local; the module loader owns successful import caching. */
export function DeferredAnchoredTooltip({ activationKey, ...tooltipProps }: DeferredAnchoredTooltipProps) {
    const [Component, setComponent] = React.useState<TooltipComponent | null>(null);
    React.useEffect(() => {
        if (Component) return;
        let active = true;
        void import('./AnchoredTooltip').then(
            (module) => { if (active) setComponent(() => module.default); },
            (error: unknown) => { console.warn('[Tooltip] Failed to load tooltip', error); },
        );
        return () => { active = false; };
    }, [activationKey, Component]);
    return Component ? <Component {...tooltipProps} /> : null;
}
