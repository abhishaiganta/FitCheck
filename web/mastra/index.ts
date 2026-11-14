// Mastra entry point. `npx mastra dev --dir mastra` opens Studio with live traces of the agent.
import { Mastra } from '@mastra/core/mastra';
import { getShopperAgent } from './agents/liveroomShopper';
import { furnishCorner } from './workflows/furnishCorner';

type G = typeof globalThis & { __lr_mastra?: Mastra };
const g = globalThis as G;

export const mastra = (g.__lr_mastra ??= new Mastra({
  agents: { liveroomShopper: getShopperAgent() },
  workflows: { furnishCorner },
}));
