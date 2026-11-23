export const STAGES = ['product', 'cart', 'checkout', 'shipping', 'payment'] as const;

export type Stage = (typeof STAGES)[number];

export const STAGE_LABEL: Record<Stage, string> = {
  product: 'Found product',
  cart: 'Built cart',
  checkout: 'Reached guest checkout',
  shipping: 'Details accepted',
  payment: 'Reached payment',
};

export const stageRank = (stage: Stage | null | undefined) => (stage ? STAGES.indexOf(stage) : -1);

export const isStage = (value: unknown): value is Stage =>
  typeof value === 'string' && (STAGES as readonly string[]).includes(value);

export function furthest(stages: Iterable<Stage>): Stage | null {
  let best: Stage | null = null;
  for (const stage of stages) {
    if (stageRank(stage) > stageRank(best)) best = stage;
  }
  return best;
}
